import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  aiBudgetConfiguration,
  reserveAiBudget,
  responseUsage,
  usageCostUsd,
} from './ai-budget.ts';
import { MAX_OUTPUT_TOKENS, requestStructuredOutput } from './openai.ts';

const roots: string[] = [];
const MODEL = 'gpt-5.4-mini';
const REQUEST = {
  evidence: { file: 'example.ts' },
  instructions: 'Produce a scoped proposal.',
  name: 'test',
  schema: { type: 'object', properties: {}, additionalProperties: false },
};

// Enough for one gpt-5.4-mini request of 1,000 input tokens and the maximum output, not two.
const ONE_REQUEST_USD = 0.2;

async function budget(limitUsd = ONE_REQUEST_USD) {
  const directory = await mkdtemp(join(tmpdir(), 'refit-budget-test-'));
  roots.push(directory);
  return { directory, limitUsd };
}

function completed(usage: unknown) {
  return new Response(
    JSON.stringify({
      id: 'resp_budget',
      model: MODEL,
      status: 'completed',
      usage,
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] },
      ],
    }),
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('reserves before generation, measures cached and reasoning usage, and settles the durable budget', async () => {
  const configuration = await budget();
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith('/input_tokens')
      ? new Response(JSON.stringify({ input_tokens: 1000 }))
      : completed({
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 500 },
          output_tokens: 100,
          output_tokens_details: { reasoning_tokens: 40 },
        }),
  );
  vi.stubGlobal('fetch', fetcher);
  const result = await requestStructuredOutput(REQUEST, {
    apiKey: 'local-secret',
    model: MODEL,
    budget: configuration,
  });
  expect(result.usage).toEqual({
    inputTokens: 1000,
    cachedInputTokens: 500,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningTokens: 40,
  });
  expect(result.budget?.costUsd).toBeCloseTo(0.0008625);
  const state = JSON.parse(await readFile(join(configuration.directory, 'budget.json'), 'utf8'));
  expect(state.reservations).toEqual({});
  expect(state.spentNano).toBe(862500);
  expect(JSON.stringify(state)).not.toContain('local-secret');
  expect(fetcher.mock.calls[0][0]).toContain('/input_tokens');
});

it('refuses generation when its maximum output would exceed the remaining budget', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ input_tokens: 1000 })));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    requestStructuredOutput(REQUEST, { apiKey: 'key', model: MODEL, budget: await budget(0.001) }),
  ).rejects.toThrow(/budget exhausted/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('retains an uncertain request reservation across restarts instead of spending again after an outage', async () => {
  const configuration = await budget();
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/input_tokens')) return new Response(JSON.stringify({ input_tokens: 1000 }));
    throw new TypeError('Connection lost after request dispatch');
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(
    requestStructuredOutput(REQUEST, { apiKey: 'key', model: MODEL, budget: configuration }),
  ).rejects.toThrow(/Connection lost/);
  await expect(
    requestStructuredOutput(REQUEST, { apiKey: 'key', model: MODEL, budget: { ...configuration } }),
  ).rejects.toThrow(/budget exhausted/);
  expect(fetcher.mock.calls.filter(([url]) => !url.endsWith('/input_tokens'))).toHaveLength(1);
  const ledger = JSON.parse(await readFile(join(configuration.directory, 'budget.json'), 'utf8'));
  // gpt-5.4-mini: $0.75 per million input and $4.50 per million output tokens, in nano-dollars.
  expect(Object.values(ledger.reservations)).toEqual([1000 * 750 + MAX_OUTPUT_TOKENS * 4500]);
});

it('bounds input tokens before a generation and rejects inconsistent provider usage', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ input_tokens: 40000 })));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    requestStructuredOutput(REQUEST, { apiKey: 'key', model: MODEL, budget: await budget() }),
  ).rejects.toThrow(/token limit/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(() =>
    responseUsage({
      input_tokens: 2,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 3 },
    }),
  ).toThrow(/inconsistent/);
});

it('serializes competing reservations and fails closed on unpriced models or changed allowance', async () => {
  const configuration = await budget();
  const reservations = await Promise.allSettled([
    reserveAiBudget(configuration, MODEL, 1000, 4096),
    reserveAiBudget(configuration, MODEL, 1000, 4096),
  ]);
  expect(reservations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  await expect(reserveAiBudget(configuration, 'unpriced-model', 1000, 4096)).rejects.toThrow(
    /explicit token prices/,
  );
  await expect(
    reserveAiBudget({ ...configuration, limitUsd: 1 }, MODEL, 1000, 4096),
  ).rejects.toThrow(/limit changed/);
  expect(aiBudgetConfiguration({ REFIT_AI_BUDGET_DIRECTORY: '' }).directory).not.toBe(
    process.cwd(),
  );
});

it('prices gpt-5.6-luna and its dated snapshots, and refuses a response from a differently priced model', async () => {
  const configuration = await budget();
  const settle = await reserveAiBudget(configuration, 'gpt-5.6-luna', 1000, 4096);
  const usage = {
    inputTokens: 1000,
    cachedInputTokens: 500,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningTokens: 40,
  };
  // 500 × $0.20 + 500 × $0.02 + 100 × $1.20, per million tokens.
  expect((await settle(usage, 'gpt-5.6-luna-2026-09-24')).costUsd).toBeCloseTo(0.00023);
  const mismatched = await reserveAiBudget(configuration, 'gpt-5.6-luna', 1000, 4096);
  await expect(mismatched(usage, 'gpt-5.4-mini-2026-03-17')).rejects.toThrow(/unpriced model/);
});

it('prices reported usage with cached input and cache writes at their own rates', () => {
  // gpt-5.6-terra: $2 input, $0.20 cached input, $2 cache write, $12 output per million tokens.
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 500_000,
    cacheWriteInputTokens: 100_000,
    outputTokens: 100_000,
    reasoningTokens: 40_000,
  };
  expect(usageCostUsd('gpt-5.6-terra', usage)).toBeCloseTo(0.8 + 0.1 + 0.2 + 1.2, 9);
  expect(usageCostUsd('gpt-5.6-terra-2026-10-01', usage)).toBeCloseTo(2.3, 9);
  expect(() => usageCostUsd('gpt-unpriced', usage)).toThrow(/No verified token prices/);
});
