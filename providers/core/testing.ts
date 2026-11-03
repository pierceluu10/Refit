// Test doubles: a scripted model and a fixture-replay model. No network, no spend.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderChange } from '../../shared/types.ts';
import type { TurnLog } from './agent.ts';
import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from './model.ts';
import type { LoadedProvider } from './types.ts';

export type ScriptStep = ContentBlock[] | ((request: ModelRequest) => ContentBlock[]);

/** Returns each scripted step in turn and records every request. */
export function scriptedModel(
  steps: ScriptStep[],
  model = 'fake-model',
): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    model,
    requests,
    async complete(request): Promise<ModelResponse> {
      requests.push(structuredClone(request));
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      const content = typeof step === 'function' ? step(request) : step;
      return {
        content,
        stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { inputTokens: 1000, outputTokens: 200 },
      };
    },
  };
}

export type ExpectedFixture = {
  note: string;
  /** What a model is expected to submit for the saved snapshot. Quotes must be in the snapshot text. */
  changes: Omit<ProviderChange, 'provider'>[];
};

export function fixtureDir(provider: LoadedProvider): string {
  return join(provider.dir, 'fixtures', 'live');
}

export function loadExpected(provider: LoadedProvider): ExpectedFixture | undefined {
  const path = join(provider.dir, 'fixtures', 'expected.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ExpectedFixture) : undefined;
}

/** Tools whose calls a replay re-issues: they show the agent page text, so they decide what a fixture keeps. */
const READING_TOOLS = new Set([
  'list_sources',
  'read_page',
  'search_page',
  'list_links',
  'diff_pages',
  'lookup_package',
]);

/**
 * Replays a recorded run offline: re-issues each turn's reading calls with the
 * inputs the log kept, then submits `changes` (the run's, or hand-checked ones).
 * Server-side calls (web search) and quote checks are not replayed.
 */
export function replayRunModel(
  log: TurnLog[],
  changes: Omit<ProviderChange, 'provider'>[],
): ModelClient & { requests: ModelRequest[] } {
  const steps: ScriptStep[] = [];
  log.forEach((turn, t) => {
    const calls: ContentBlock[] = [];
    turn.calls.forEach((call, c) => {
      if (!READING_TOOLS.has(call.tool)) return;
      try {
        calls.push({
          type: 'tool_use',
          id: `replay-${t}-${c}`,
          name: call.tool,
          input: JSON.parse(call.input),
        });
      } catch {
        // The log cuts inputs at 300 characters; a cut one cannot be replayed.
      }
    });
    if (calls.length) steps.push(calls);
  });
  steps.push([
    {
      type: 'tool_use',
      id: 'replay-submit',
      name: 'submit_changes',
      input: {
        changes: changes.map((change) => ({ ...change, id: change.id.replace(/^[^:]+:/, '') })),
      },
    },
  ]);
  steps.push([{ type: 'text', text: 'Submitted.' }]);
  return scriptedModel(steps);
}

/**
 * Stands in for Claude on a saved snapshot: reads every source, then submits
 * the expected changes. It tests the plumbing (prompting, reading, quote
 * checks, normalising), not the model's judgement.
 */
export function replayModel(provider: LoadedProvider, expected: ExpectedFixture) {
  return scriptedModel([
    [
      { type: 'text', text: 'Reading the sources.' },
      ...provider.sources.map((source, i): ContentBlock => ({
        type: 'tool_use',
        id: `read-${i}`,
        name: 'read_page',
        input: { source_id: source.id },
      })),
    ],
    [
      {
        type: 'tool_use',
        id: 'submit-1',
        name: 'submit_changes',
        input: {
          changes: expected.changes.map((change) => ({
            ...change,
            id: change.id.replace(/^[^:]+:/, ''),
          })),
        },
      },
    ],
    [{ type: 'text', text: 'Submitted.' }],
  ]);
}
