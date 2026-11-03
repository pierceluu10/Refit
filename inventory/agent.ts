// inventoryRepo: ordinary code scans the repository first and records every plain SDK and API-host
// usage it can prove (scan.ts). Then a Claude agent on the Agent SDK, with read-only tools and the
// scan as evidence, settles what the scan could not and hunts for what no scan sees. The model
// chooses what to read, when to fan out to area readers, and when it is done; this file only wires
// the scan, tools, budget, the commit cache and output.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ApiUsage, InventoryRepo } from '../shared/types.ts';
import { BudgetLedger } from './budget.ts';
import {
  cleanCommit,
  defaultInventoryCache,
  readCachedInventory,
  writeCachedInventory,
} from './cache.ts';
import { UsageCollector } from './collector.ts';
import type { RecordedUsage } from './collector.ts';
import { emptyScanResult, SCAN_VERSION, scanEvidence, scanRepo, type ScanResult } from './scan.ts';
import {
  AREA_READER,
  AREA_READER_DESCRIPTION,
  AREA_READER_PROMPT,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  taskPrompt,
} from './prompt.ts';
import { summarize } from './summary.ts';
import { buildServer, mcpToolName, readTools, recordTools, SERVER_NAME } from './tools.ts';
import type { InventoryTool } from './tools.ts';

export const MAIN_MODEL = 'claude-sonnet-5-5';
export const AREA_MODEL = 'claude-haiku-5-5';
export const DEFAULT_RUN_CAP_USD = 0.6;
// Kept back from the SDK's own cap because it stops only after the call that crossed it.
export const CALL_RESERVE_USD = 0.05;
const MAX_TURNS = 120;
const SUBAGENT_TOOL = 'Agent';
// The runtime exposes the subagent tool as 'Task'; allow both names so dontAsk never denies it.
const SUBAGENT_TOOL_NAMES = [SUBAGENT_TOOL, 'Task'];
// Variables of an enclosing Claude Code session that must not leak into the nested agent.
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/;

export type AgentRequest = { prompt: string; options: Options; tools: InventoryTool[] };
export type AgentRunner = (request: AgentRequest) => AsyncIterable<SDKMessage>;

export type InventoryOptions = {
  ledger?: BudgetLedger;
  runCapUsd?: number;
  runner?: AgentRunner;
  transcriptPath?: string;
  /** Where finished reports are kept by commit; false keeps none. Default: REFIT_INVENTORY_CACHE. */
  cacheDir?: string | false;
  /** The commit the checkout is at, when the caller knows it is clean; read from git otherwise. */
  commit?: string;
  /** The code scan; tests swap it. */
  scan?: (repoDir: string, repo: string) => Promise<ScanResult>;
};

// A cached report is reused only by the same prompt and scan.
export const INVENTORY_VERSION = `${PROMPT_VERSION}+${SCAN_VERSION}`;

export type InventoryReport = {
  repo: string;
  promptVersion: string;
  model: string;
  usages: ApiUsage[];
  purposes: Record<string, string>;
  summary: string;
  agentSummary: string;
  outcome: SDKResultMessage['subtype'];
  costUsd: number;
  costByModel: Record<string, number>;
  turns: number;
  durationMs: number;
  /** What the code scan recorded before the agent ran, and the leads it handed the agent. */
  scan?: { version: string; usages: number; callSites: number; leads: number; failed?: string };
  commit?: string;
  /** Set when the report came from the commit cache: no model ran, so it cost $0. */
  cached?: { cachedAt: string; costUsd: number };
};

const sdkRunner: AgentRunner = ({ prompt, options }) => query({ prompt, options });

export function agentOptions(repoDir: string, tools: InventoryTool[], budgetUsd: number): Options {
  const toolNames = tools.map((inventoryTool) => mcpToolName(inventoryTool.name));
  return {
    cwd: repoDir,
    model: MAIN_MODEL,
    effort: 'medium',
    systemPrompt: SYSTEM_PROMPT,
    tools: [SUBAGENT_TOOL],
    allowedTools: [...SUBAGENT_TOOL_NAMES, ...toolNames],
    permissionMode: 'dontAsk',
    settingSources: [],
    persistSession: false,
    mcpServers: { [SERVER_NAME]: buildServer(tools) },
    agents: {
      [AREA_READER]: {
        description: AREA_READER_DESCRIPTION,
        prompt: AREA_READER_PROMPT,
        model: AREA_MODEL,
        effort: 'low',
        tools: toolNames.filter((name) => !name.endsWith('__remove_usage')),
      },
    },
    maxTurns: MAX_TURNS,
    maxBudgetUsd: budgetUsd,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !PARENT_SESSION_ENV.test(name)),
    ),
  };
}

export async function runInventory(
  repoDir: string,
  repo: string,
  options: InventoryOptions = {},
): Promise<InventoryReport> {
  const started = Date.now();
  const cacheDir =
    options.cacheDir === false ? undefined : (options.cacheDir ?? defaultInventoryCache());
  const commit = cacheDir ? (options.commit ?? (await cleanCommit(repoDir))) : options.commit;
  if (cacheDir && commit) {
    const cached = await readCachedInventory<InventoryReport>(
      cacheDir,
      repo,
      commit,
      INVENTORY_VERSION,
    );
    if (cached) {
      const { report } = cached;
      return {
        ...report,
        costUsd: 0,
        costByModel: {},
        turns: 0,
        durationMs: Date.now() - started,
        commit,
        cached: { cachedAt: cached.cachedAt, costUsd: report.costUsd },
      };
    }
  }

  const ledger = options.ledger ?? (await BudgetLedger.fromEnv());
  const runCapUsd = Math.min(options.runCapUsd ?? DEFAULT_RUN_CAP_USD, ledger.remainingUsd);
  ledger.assertCanSpend(CALL_RESERVE_USD);
  const budgetUsd = Math.max(runCapUsd - CALL_RESERVE_USD, 0);

  const collector = new UsageCollector(repoDir, repo);
  // The scan's usages go in first, through the same line checks the agent's records get.
  // The scan is a shortcut: if it fails, the agent reads the whole repository itself, as before.
  let scanFailure: string | undefined;
  const scan = await (options.scan ?? scanRepo)(repoDir, repo).catch((error: unknown) => {
    scanFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return emptyScanResult();
  });
  for (const usage of scan.usages) {
    await collector.record(
      {
        provider: usage.provider,
        via: usage.via,
        ...(usage.sdk ? { sdk: usage.sdk } : {}),
        ...(usage.pinnedVersion ? { pinnedVersion: usage.pinnedVersion } : {}),
        callSites: usage.callSites,
        ...(usage.hints ? { hints: usage.hints } : {}),
      },
      { python: usage.ecosystem === 'python' },
    );
  }
  const tools = [...readTools(repoDir), ...recordTools(collector)];
  const runner = options.runner ?? sdkRunner;
  let result: SDKResultMessage | undefined;
  try {
    for await (const message of runner({
      prompt: taskPrompt(
        repo,
        scanFailure
          ? `## The code scan failed (${scanFailure})\n\nNothing is recorded yet and there are no leads: map the repository with repo_map and the helper scanners, and read it yourself.`
          : scanEvidence(scan),
      ),
      options: agentOptions(repoDir, tools, budgetUsd),
      tools,
    })) {
      if (options.transcriptPath) await appendTranscript(options.transcriptPath, message);
      if (message.type === 'result') result = message;
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result; that result is still the outcome.
    if (!result) throw error;
  } finally {
    if (result) await recordSpend(ledger, repo, result);
  }
  if (!result) throw new InventoryRunError(`The agent run for ${repo} ended without a result`);

  const recorded = collector.list().map(({ usage }) => usage);
  const usages = collector.usagesForOutput();
  const report: InventoryReport = {
    repo,
    promptVersion: PROMPT_VERSION,
    model: MAIN_MODEL,
    usages,
    purposes: purposesOf(recorded),
    summary: summarize(repo, recorded, result.subtype),
    agentSummary: result.subtype === 'success' ? result.result : result.errors.join('\n'),
    outcome: result.subtype,
    costUsd: result.total_cost_usd,
    costByModel: Object.fromEntries(
      Object.entries(result.modelUsage).map(([model, usage]) => [model, usage.costUSD]),
    ),
    turns: result.num_turns,
    durationMs: Date.now() - started,
    scan: {
      version: SCAN_VERSION,
      usages: scan.usages.length,
      callSites: scan.usages.reduce((sum, usage) => sum + usage.callSites.length, 0),
      leads: scan.leads.reduce((sum, lead) => sum + lead.items.length + lead.more, 0),
      ...(scanFailure ? { failed: scanFailure } : {}),
    },
    ...(commit ? { commit } : {}),
  };
  // A run that ended early (on its budget or turns) may be incomplete, so it is never reused.
  if (cacheDir && commit && result.subtype === 'success') {
    await writeCachedInventory(cacheDir, {
      version: INVENTORY_VERSION,
      repo,
      commit,
      cachedAt: new Date().toISOString(),
      report,
    }).catch(() => {});
  }
  return report;
}

export const inventoryRepo: InventoryRepo = async (repoDir, repo) =>
  (await runInventory(repoDir, repo)).usages;

export class InventoryRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryRunError';
  }
}

function purposesOf(usages: RecordedUsage[]): Record<string, string> {
  return Object.fromEntries(
    usages
      .filter((usage) => usage.purpose)
      .map((usage) => [usage.provider, usage.purpose as string]),
  );
}

async function recordSpend(ledger: BudgetLedger, repo: string, result: SDKResultMessage) {
  let attributed = 0;
  for (const [model, usage] of Object.entries(result.modelUsage)) {
    await ledger.record({ repo, model, costUsd: usage.costUSD });
    attributed += usage.costUSD;
  }
  // Charge any cost the per-model breakdown does not cover, so the ledger never undercounts.
  const unattributed = result.total_cost_usd - attributed;
  if (unattributed > 0) await ledger.record({ repo, model: MAIN_MODEL, costUsd: unattributed });
}

async function appendTranscript(transcriptPath: string, message: SDKMessage) {
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await appendFile(transcriptPath, `${JSON.stringify(message)}\n`);
}
