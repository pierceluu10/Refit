// inventorySurfaces: a Claude agent on the Agent SDK reads the repository with read-only tools and
// records every platform, infrastructure, security-standard and regulated surface it finds. The
// model chooses what to read, when to fan out to specialist readers, and when it is done; this
// file only wires tools, budget and output.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { InventorySurfaces } from '../../shared/types.ts';
import { BudgetLedger } from '../budget.ts';
import { SurfaceCollector } from './collector.ts';
import type { SurfaceUsage } from './collector.ts';
import {
  PROMPT_VERSION,
  SPECIALISTS,
  specialistPrompt,
  SYSTEM_PROMPT,
  taskPrompt,
} from './prompt.ts';
import type { SpecialistName } from './prompt.ts';
import { buildServer, mcpToolName, readTools, recordTools, SERVER_NAME } from './tools.ts';
import type { SurfaceTool } from './tools.ts';

export const MAIN_MODEL = 'claude-sonnet-5-5';
export const SPECIALIST_MODEL = 'claude-haiku-5-5';
// Three sample repos share P5's $3 cap, so one repo gets at most $1 unless the caller says otherwise.
export const DEFAULT_RUN_CAP_USD = 1;
// Kept back from the SDK's own cap because it stops only after the call that crossed it.
export const CALL_RESERVE_USD = 0.05;
const MAX_TURNS = 120;
const SUBAGENT_TOOL = 'Agent';
// The runtime exposes the subagent tool as 'Task'; allow both names so dontAsk never denies it.
const SUBAGENT_TOOL_NAMES = [SUBAGENT_TOOL, 'Task'];
// Variables of an enclosing Claude Code session that must not leak into the nested agent.
const PARENT_SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/;

export type SurfaceAgentRequest = { prompt: string; options: Options; tools: SurfaceTool[] };
export type SurfaceAgentRunner = (request: SurfaceAgentRequest) => AsyncIterable<SDKMessage>;

export type SurfaceInventoryOptions = {
  ledger?: BudgetLedger;
  runCapUsd?: number;
  runner?: SurfaceAgentRunner;
  transcriptPath?: string;
};

export type SurfaceInventoryReport = {
  repo: string;
  promptVersion: string;
  model: string;
  surfaces: SurfaceUsage[];
  summary: string;
  agentSummary: string;
  outcome: SDKResultMessage['subtype'] | 'no-result';
  errors: string[]; // what went wrong, said honestly; surfaces recorded before it are kept
  costUsd: number;
  costByModel: Record<string, number>;
  turns: number;
  durationMs: number;
};

const sdkRunner: SurfaceAgentRunner = ({ prompt, options }) => query({ prompt, options });

export function agentOptions(repoDir: string, tools: SurfaceTool[], budgetUsd: number): Options {
  const toolNames = tools.map((surfaceTool) => mcpToolName(surfaceTool.name));
  const specialistTools = toolNames.filter((name) => !name.endsWith('__remove_surface'));
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
    agents: Object.fromEntries(
      (Object.keys(SPECIALISTS) as SpecialistName[]).map((name) => [
        name,
        {
          description: SPECIALISTS[name].description,
          prompt: specialistPrompt(name),
          model: SPECIALIST_MODEL,
          effort: 'low' as const,
          tools: specialistTools,
        },
      ]),
    ),
    maxTurns: MAX_TURNS,
    maxBudgetUsd: budgetUsd,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !PARENT_SESSION_ENV.test(name)),
    ),
  };
}

export async function runSurfaceInventory(
  repoDir: string,
  repo: string,
  options: SurfaceInventoryOptions = {},
): Promise<SurfaceInventoryReport> {
  // The dollar cap is a hard limit: with no ledger and no REFIT_AI_BUDGET_USD this throws.
  const ledger = options.ledger ?? (await BudgetLedger.fromEnv());
  const runCapUsd = Math.min(options.runCapUsd ?? DEFAULT_RUN_CAP_USD, ledger.remainingUsd);
  ledger.assertCanSpend(CALL_RESERVE_USD);
  const budgetUsd = Math.max(runCapUsd - CALL_RESERVE_USD, 0);

  const collector = new SurfaceCollector(repoDir, repo);
  const tools = [...readTools(repoDir), ...recordTools(collector)];
  const runner = options.runner ?? sdkRunner;
  const started = Date.now();
  const errors: string[] = [];
  let result: SDKResultMessage | undefined;
  try {
    for await (const message of runner({
      prompt: taskPrompt(repo),
      options: agentOptions(repoDir, tools, budgetUsd),
      tools,
    })) {
      if (options.transcriptPath) await appendTranscript(options.transcriptPath, message);
      if (message.type === 'result') result = message;
    }
  } catch (error) {
    // A single-shot query() throws after yielding an error result; that result is still the outcome.
    if (!result) errors.push(`The agent run stopped: ${(error as Error).message}`);
  } finally {
    if (result) await recordSpend(ledger, repo, result);
  }
  if (result && result.subtype !== 'success') errors.push(...result.errors);

  const surfaces = collector.surfacesForOutput();
  return {
    repo,
    promptVersion: PROMPT_VERSION,
    model: MAIN_MODEL,
    surfaces,
    summary: summarize(repo, surfaces, result?.subtype ?? 'no-result'),
    agentSummary: result?.subtype === 'success' ? result.result : errors.join('\n'),
    outcome: result?.subtype ?? 'no-result',
    errors,
    costUsd: result?.total_cost_usd ?? 0,
    costByModel: Object.fromEntries(
      Object.entries(result?.modelUsage ?? {}).map(([model, usage]) => [model, usage.costUSD]),
    ),
    turns: result?.num_turns ?? 0,
    durationMs: Date.now() - started,
  };
}

// The entry point P2's inventoryDependencies merges. A run that found nothing and failed throws,
// so the caller can put the reason in ScanReport.errors instead of reporting an empty repo.
// A failed run that recorded something returns what it has; the full report carries the errors.
export function createInventorySurfaces(options: SurfaceInventoryOptions = {}): InventorySurfaces {
  return async (repoDir, repo) => {
    const report = await runSurfaceInventory(repoDir, repo, options);
    if (report.surfaces.length === 0 && report.errors.length > 0) {
      throw new SurfaceRunError(
        `Surfaces inventory for ${repo} failed: ${report.errors.join('; ')}`,
      );
    }
    return report.surfaces;
  };
}

export const inventorySurfaces: InventorySurfaces = createInventorySurfaces();

export class SurfaceRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceRunError';
  }
}

export function summarize(repo: string, surfaces: SurfaceUsage[], outcome: string): string {
  const header = `${repo}: ${surfaces.length} surface${surfaces.length === 1 ? '' : 's'} (${outcome})`;
  const lines = surfaces.map((surface) => {
    const version = surface.version ? ` ${surface.version}` : '';
    const places = surface.declaredIn.map((place) => `${place.file}:${place.line}`).join(', ');
    return `- [${surface.kind}] ${surface.name}${version}: ${places}`;
  });
  return [header, ...lines].join('\n');
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
