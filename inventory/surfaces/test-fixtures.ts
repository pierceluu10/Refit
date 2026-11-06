// Helpers for surfaces unit tests: a temporary repository and a scripted fake model.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SurfaceAgentRequest, SurfaceAgentRunner } from './agent.ts';
import { runTool } from './tools.ts';

export async function makeRepo(files: Record<string, string>): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'surfaces-test-'));
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
    result: 'Fake model summary.',
    is_error: false,
    num_turns: 4,
    duration_ms: 10,
    duration_api_ms: 8,
    total_cost_usd: 0.03,
    modelUsage: {
      'claude-sonnet-5-5': { costUSD: 0.02 },
      'claude-haiku-5-5': { costUSD: 0.01 },
    },
    ...overrides,
  } as unknown as SDKResultMessage;
}

// Plays the model: calls the given tools in order through the same handlers the SDK uses, records
// every output, then yields the result message (or throws, to play a crashed run).
export function fakeModel(
  calls: ScriptedCall[],
  result: SDKResultMessage | Error = fakeResult(),
): { runner: SurfaceAgentRunner; requests: SurfaceAgentRequest[]; outputs: string[] } {
  const requests: SurfaceAgentRequest[] = [];
  const outputs: string[] = [];
  const runner: SurfaceAgentRunner = async function* (request) {
    requests.push(request);
    for (const call of calls) {
      const surfaceTool = request.tools.find((candidate) => candidate.name === call.tool);
      if (!surfaceTool) throw new Error(`Fake model called an unknown tool: ${call.tool}`);
      outputs.push((await runTool(surfaceTool, call.input)).text);
    }
    if (result instanceof Error) throw result;
    yield result as SDKMessage;
  };
  return { runner, requests, outputs };
}
