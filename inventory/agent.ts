// inventoryRepo: a Claude agent on the Agent SDK reads the repository with read-only tools and
// records every external API it finds. The model chooses what to read, when to fan out to area
// readers, and when it is done; this file only wires tools, budget and output.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ApiUsage, InventoryRepo } from '../shared/types.ts';
import { BudgetLedger } from './budget.ts';
import { UsageCollector } from './collector.ts';
import type { RecordedUsage } from './collector.ts';
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
};

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
  const ledger = options.ledger ?? (await BudgetLedger.fromEnv());
  const runCapUsd = Math.min(options.runCapUsd ?? DEFAULT_RUN_CAP_USD, ledger.remainingUsd);
  ledger.assertCanSpend(CALL_RESERVE_USD);
  const budgetUsd = Math.max(runCapUsd - CALL_RESERVE_USD, 0);

  const collector = new UsageCollector(repoDir, repo);
  const tools = [...readTools(repoDir), ...recordTools(collector)];
  const runner = options.runner ?? sdkRunner;
  const started = Date.now();
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
    if (!result) throw error;
  } finally {
    if (result) await recordSpend(ledger, repo, result);
  }
  if (!result) throw new InventoryRunError(`The agent run for ${repo} ended without a result`);

  const recorded = collector.list().map(({ usage }) => usage);
  const usages = collector.usagesForOutput();
  return {
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
  };
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
