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
  return {
    observe(event: StreamEvent, parentToolUseId: string | null = null): void {
      const key = parentToolUseId ?? 'main';
      if (event.type === 'message_start') {
        const { model, usage } = event.message;
        open.set(key, { model: model || defaultModel, usage: { ...usage }, costUsd: 0 });
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
  };
}

export function toSdkTool(agentTool: AgentTool, repoDir: string) {
  const schema = z.fromJSONSchema(agentTool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  const shape = schema instanceof z.ZodObject ? schema.shape : {};
  return tool(agentTool.name, agentTool.description, shape, async (args) => ({
    content: [{ type: 'text' as const, text: await agentTool.run(args, { repoDir }) }],
  }));
}

export const claudeAgentSession: AgentSession = async (input) => {
  input.ledger.assertCanSpend();
  const server = createSdkMcpServer({
    name: 'aptitude',
    version: '1.0.0',
    tools: input.tools.map((agentTool) => toSdkTool(agentTool, input.sandbox.dir)),
  });
  const result: SessionResult = { sessionId: input.resume, finalText: '', stopReason: 'error' };
  const meter = streamMeter(input.ledger, input.model);
  try {
    for await (const message of query({
      prompt: input.prompt,
      options: {
        model: input.model,
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
        // Second guard behind the ledger. The SDK checks it only between turns, so the caller
        // leaves a reserve for the turn that crosses it.
        maxBudgetUsd: input.budgetUsd,
        // Stream events carry each model call's usage, so the ledger is charged while the call runs.
        includePartialMessages: true,
      },
    })) {
      // Stream events go to the meter, not the transcript: the assistant messages already hold their text.
      if (message.type === 'stream_event') {
        meter.observe(message.event, message.parent_tool_use_id);
        continue;
      }
      input.log(message);
      if (message.type === 'system' && message.subtype === 'init') {
        result.sessionId = message.session_id;
      }
      if (message.type !== 'result') continue;
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
  return result;
};
