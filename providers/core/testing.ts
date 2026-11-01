// Test doubles: a scripted model and a fixture-replay model. No network, no spend.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderChange } from '../../shared/types.ts';
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
