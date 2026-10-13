import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { readProviderAdapter, STRIPE, type ProviderAdapter } from './providers.ts';
import type { Repository } from './types.ts';

const OPENAI_CONFIG = resolve('pipeline/fixtures/openai/provider.json');

function analyze(content: string, provider: ProviderAdapter) {
  const repository: Repository = {
    root: '/virtual',
    files: [{ path: 'client.ts', content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  return analyzeRepository(repository, [], provider);
}

it('traces flat and dotted resources and serializes their first object argument', async () => {
  const provider = await readProviderAdapter(OPENAI_CONFIG);
  const result = analyze(
    `import OpenAI from 'openai';
const client = new OpenAI();
client.completions.create({ model: 'legacy-completion' });
client.chat.completions.create({
  model: selectedModel,
  messages: [],
});
client.chat.responses.create({ model: 'not-configured' });`,
    provider,
  );

  expect(result.calls.map(({ method }) => method)).toEqual([
    'completions.create',
    'chat.completions.create',
  ]);
  expect(result.calls[0].optionsArgument).toMatchObject({
    file: 'client.ts',
    line: 3,
    syntax: 'ObjectLiteralExpression',
    text: "{ model: 'legacy-completion' }",
  });
  expect(result.calls[1].optionsArgument).toMatchObject({
    file: 'client.ts',
    line: 4,
    syntax: 'ObjectLiteralExpression',
    text: '{\n  model: selectedModel,\n  messages: [],\n}',
  });
  expect(() => JSON.stringify(result.calls)).not.toThrow();
});

it('keeps flat Stripe call tracing and response analysis unchanged', () => {
  const result = analyze(
    `import Stripe from 'stripe';
const client = new Stripe('test');
async function read() {
  const intent = await client.paymentIntents.retrieve('pi_test');
  return intent.charges;
}`,
    STRIPE,
  );

  expect(result.calls).toEqual([
    expect.objectContaining({
      method: 'paymentIntents.retrieve',
      optionsArgument: null,
    }),
  ]);
});
