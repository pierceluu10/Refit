// Shared helpers for inventory unit tests: a temporary repository and a scripted fake model.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRequest, AgentRunner } from './agent.ts';
import { runTool } from './tools.ts';

export async function makeRepo(files: Record<string, string>): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'inventory-test-'));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
    await writeFile(path.join(repoDir, file), text);
  }
  return repoDir;
}

export async function removeRepo(repoDir: string): Promise<void> {
  await rm(repoDir, { recursive: true, force: true });
}

export type ScriptedCall = { tool: string; input: Record<string, unknown> };

export function fakeResult(overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: 'Stripe for payments.',
    is_error: false,
    num_turns: 3,
    duration_ms: 10,
    duration_api_ms: 8,
    total_cost_usd: 0.02,
    modelUsage: {
      'claude-sonnet-5-5': { costUSD: 0.015 },
      'claude-haiku-5-5': { costUSD: 0.005 },
    },
    ...overrides,
  } as unknown as SDKResultMessage;
}

// Plays the model: calls the given tools in order through the same handlers the SDK uses, records
// every output, then yields the result message.
export function fakeModel(
  calls: ScriptedCall[],
  result: SDKResultMessage = fakeResult(),
): { runner: AgentRunner; requests: AgentRequest[]; outputs: string[] } {
  const requests: AgentRequest[] = [];
  const outputs: string[] = [];
  const runner: AgentRunner = async function* (request) {
    requests.push(request);
    for (const call of calls) {
      const inventoryTool = request.tools.find((candidate) => candidate.name === call.tool);
      if (!inventoryTool) throw new Error(`Fake model called an unknown tool: ${call.tool}`);
      outputs.push((await runTool(inventoryTool, call.input)).text);
    }
    yield result as SDKMessage;
  };
  return { runner, requests, outputs };
}
