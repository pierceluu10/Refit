// The real AgentSession: one Claude Agent SDK query over the harness tool registry.
import { createSdkMcpServer, query, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentTool } from '../shared/types.ts';
import { usageCostUsd, type BudgetLedger, type TokenUsage } from './ledger.ts';
import type { AgentSession, SessionResult } from './types.ts';

type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];

// Charges each model call as it streams: input and cache tokens at message_start, output as
// message_delta reports it. The query's result then charges only what the stream did not show
// (calls made inside tools, such as WebSearch's own model call).
export function streamMeter(ledger: BudgetLedger, defaultModel: string) {
  // The open call per stream: the main loop, or a subagent keyed by its parent tool use.
  const open = new Map<string, { model: string; usage: TokenUsage; costUsd: number }>();
  let liveUsd = 0;
  let searches = 0;
  return {
    observe(event: StreamEvent, parentToolUseId: string | null = null): void {
      const key = parentToolUseId ?? 'main';
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use' && block.name === 'WebSearch') searches++;
        return;
      }
      if (event.type === 'message_start') {
        const { model, usage } = event.message;
        open.set(key, { model: model || defaultModel, usage: { ...usage }, costUsd: 0 });
        ledger.noteInput(usage);
      } else if (event.type === 'message_delta') {
        const call = open.get(key);
        // message_delta counts are cumulative for the message; null means unchanged.
        const reported = Object.entries(event.usage).filter(([, value]) => value !== null);
        if (call) Object.assign(call.usage, Object.fromEntries(reported));
      } else {
        return;
      }
      const call = open.get(key);
      if (!call) return;
      const costUsd = usageCostUsd(call.model, call.usage);
      if (costUsd <= call.costUsd) return;
      ledger.charge({ model: call.model, costUsd: costUsd - call.costUsd, note: 'model call' });
      liveUsd += costUsd - call.costUsd;
      call.costUsd = costUsd;
    },
    get liveUsd(): number {
      return liveUsd;
    },
    // WebSearch makes its own model call, which the stream does not show.
    get searches(): number {
      return searches;
    },
  };
}

// shortcut: about 20k tokens of results per search at the session model's input rate is a guess;
// it is charged only when no result arrives, since the SDK's total replaces it otherwise.
const SEARCH_USAGE = { input_tokens: 20_000, server_tool_use: { web_search_requests: 1 } };

export function toSdkTool(agentTool: AgentTool, repoDir: string) {
  const schema = z.fromJSONSchema(agentTool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  const shape = schema instanceof z.ZodObject ? schema.shape : {};
  return tool(agentTool.name, agentTool.description, shape, async (args) => ({
    content: [{ type: 'text' as const, text: await agentTool.run(args, { repoDir }) }],
  }));
}

// One call's output is what the query can overshoot its grant by, so it stays below TURN_RESERVE_USD
// at Sonnet's $10 per million. Edits are small and a file write this long is rare; a cut-off call
// makes the agent split its work.
const MAX_OUTPUT_TOKENS = '12000';
// Medium on Sonnet: the recommended start for agentic coding, and most of a session is small edits.
const effortFor = (model: string) => (model.includes('opus') ? 'high' : 'medium');

export const claudeAgentSession: AgentSession = async (input) => {
  input.ledger.assertCanSpend();
  const server = createSdkMcpServer({
    name: 'aptitude',
    version: '1.0.0',
    tools: input.tools.map((agentTool) => toSdkTool(agentTool, input.sandbox.dir)),
  });
  const result: SessionResult = { sessionId: input.resume, finalText: '', stopReason: 'error' };
  const meter = streamMeter(input.ledger, input.model);
  // The SDK checks maxBudgetUsd only between turns; the meter sees each call as it streams, so the
  // query stops the moment its grant is spent and can overshoot by at most the call in flight.
  const abortController = new AbortController();
  let reconciled = false;
  try {
    for await (const message of query({
      prompt: input.prompt,
      options: {
        model: input.model,
        effort: effortFor(input.model),
        env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS },
        systemPrompt: input.systemPrompt,
        // Built-in file and shell tools stay off: repo code runs only through the sandboxed tools.
        tools: ['WebSearch'],
        mcpServers: { aptitude: server },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        cwd: input.sandbox.dir,
        resume: input.resume,
        maxTurns: input.maxTurns,
        // Second guard: it also counts calls the stream does not show (inside tools), between turns.
        maxBudgetUsd: input.budgetUsd,
        abortController,
        // Stream events carry each model call's usage, so the ledger is charged while the call runs.
        includePartialMessages: true,
      },
    })) {
      // Stream events go to the meter, not the transcript: the assistant messages already hold their text.
      if (message.type === 'stream_event') {
        meter.observe(message.event, message.parent_tool_use_id);
        if (meter.liveUsd >= input.budgetUsd) abortController.abort();
        continue;
      }
      input.log(message);
      if (message.type === 'system' && message.subtype === 'init') {
        result.sessionId = message.session_id;
      }
      if (message.type !== 'result') continue;
      reconciled = true;
      result.sessionId = message.session_id;
      input.ledger.chargeCumulative(
        message.session_id,
        message.total_cost_usd,
        {
          model: input.model,
          note: `agent query beyond its live charges (${message.num_turns} turns, ${message.subtype})`,
        },
        meter.liveUsd,
      );
      if (message.subtype === 'success') {
        result.stopReason = 'done';
        result.finalText = message.result;
      } else {
        result.stopReason =
          message.subtype === 'error_max_turns'
            ? 'max-turns'
            : message.subtype === 'error_max_budget_usd'
              ? 'budget'
              : 'error';
        result.error = message.subtype;
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  // Stopped or crashed before its result, the query never reports its total, so the calls the
  // stream did not show are estimated instead of lost.
  if (!reconciled && meter.searches > 0) {
    input.ledger.charge({
      model: input.model,
      costUsd: meter.searches * usageCostUsd(input.model, SEARCH_USAGE),
      note: `${meter.searches} web search${meter.searches === 1 ? '' : 'es'}, estimated`,
    });
  }
  if (abortController.signal.aborted) {
    result.stopReason = 'budget';
    result.error = `stopped mid-turn: $${meter.liveUsd.toFixed(4)} spent of this query's $${input.budgetUsd.toFixed(4)}`;
  }
  return result;
};
