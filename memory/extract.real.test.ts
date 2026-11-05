import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiUsage, ProviderChange } from '../shared/types.ts';
import { AgentSdkModel, AnthropicModel, Budget } from './ai.ts';
import { extractRecipe } from './extract.ts';
import { makeRecord, makeTask } from './fixtures/tasks.ts';
import { JsonMemoryStore } from './store.ts';

// Real model calls on illustrative transcripts, run only with REFIT_REAL_AI=1. One cap for the whole
// file, from REFIT_AI_BUDGET_USD; unset, nothing is spent.
const budget = Budget.fromEnv();

// Illustrative changes matching the transcript fixtures; not real customer tasks.
const cases: {
  file: string;
  repo: string;
  change: ProviderChange;
  usage: Pick<ApiUsage, 'via' | 'sdk' | 'callSites'>;
  expected: RegExp;
}[] = [
  {
    file: 'stripe-payment-intents.txt',
    repo: 'example-org/shop',
    change: makeTask().change,
    usage: makeTask().usages[0],
    expected: /paymentIntents/,
  },
  {
    file: 'openai-model-retirement.txt',
    repo: 'example-org/support-bot',
    change: {
      provider: 'openai',
      id: 'openai-gpt-4-0613-retirement',
      kind: 'model-retirement',
      title: 'gpt-4-0613 is retired; move to gpt-4.1 on the Responses API',
      source: {
        url: 'https://platform.openai.com/docs/deprecations',
        quote: 'Example quote: gpt-4-0613 will be retired; use gpt-4.1.',
      },
      affects: { operations: ['chat.completions.create'], fields: ['model'] },
    },
    usage: {
      via: 'sdk',
      sdk: { name: 'openai', version: '4.20.0' },
      callSites: [{ file: 'src/reply.ts', line: 10, operation: 'chat.completions.create' }],
    },
    expected: /gpt-4\.1/,
  },
  {
    file: 'shopify-product-update.txt',
    repo: 'example-org/catalog-sync',
    change: {
      provider: 'shopify',
      id: 'shopify-rest-products-legacy',
      kind: 'rest-to-graphql',
      title: 'REST product endpoints are legacy; use the Admin GraphQL productUpdate mutation',
      source: {
        url: 'https://shopify.dev/docs/apps/build/graphql/migrate',
        quote: 'Example quote: the REST Admin API is legacy; migrate to GraphQL.',
      },
      affects: { operations: ['PUT /products/{id}.json'], fields: ['body_html'] },
    },
    usage: {
      via: 'http',
      callSites: [{ file: 'src/sync.ts', line: 8, operation: 'PUT /products/{id}.json' }],
    },
    expected: /productUpdate/,
  },
];

describe.skipIf(process.env.REFIT_REAL_AI !== '1')('extractRecipe with the real model', () => {
  // An API key when present, else the logged-in Claude Code credentials through the Agent SDK.
  const model = process.env.ANTHROPIC_API_KEY
    ? new AnthropicModel(budget)
    : new AgentSdkModel(budget);

  afterAll(() => {
    console.log(`extract.real.test.ts spent $${budget.spentUsd.toFixed(4)}`);
  });

  for (const { file, repo, change, usage, expected } of cases) {
    it(`distils ${file}`, { timeout: 120_000 }, async () => {
      const transcript = await readFile(
        join(import.meta.dirname, 'fixtures/transcripts', file),
        'utf8',
      );
      const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'refit-extract-real-')));
      const task = makeTask({
        id: `task-${change.id}`,
        repo,
        change,
        usages: [{ ...usage, repo, provider: change.provider }],
      });
      const run = await store.recordRun({
        task,
        record: makeRecord({
          taskId: task.id,
          diff: transcript.slice(transcript.indexOf('diff --git')),
        }),
        transcript,
      });

      const recipe = await extractRecipe(run, { store, model });

      expect(recipe).toBeDefined();
      for (const field of ['preconditions', 'steps', 'pitfalls', 'diffSketch'] as const) {
        expect(recipe![field].trim()).not.toBe('');
      }
      expect(`${recipe!.steps}\n${recipe!.diffSketch}`).toMatch(expected);
      expect(recipe!.sourceRuns).toEqual([run.id]);
      expect(recipe!.repos).toEqual([repo]);
      expect(await store.getRecipe(recipe!.id)).toEqual(recipe);
    });
  }
});
