// The real AgentSession: one Claude Agent SDK query over the harness tool registry.
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentTool } from '../shared/types.ts';
import type { AgentSession, SessionResult } from './types.ts';

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
        // Second guard behind the ledger: the SDK stops the query once this is spent.
        maxBudgetUsd: input.ledger.remainingUsd,
      },
    })) {
      input.log(message);
      if (message.type === 'system' && message.subtype === 'init') {
        result.sessionId = message.session_id;
      }
      if (message.type !== 'result') continue;
      result.sessionId = message.session_id;
      input.ledger.chargeCumulative(message.session_id, message.total_cost_usd, {
        model: input.model,
        note: `agent query (${message.num_turns} turns, ${message.subtype})`,
      });
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
