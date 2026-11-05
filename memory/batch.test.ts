import { describe, expect, it, vi } from 'vitest';
import { Budget } from './ai.ts';
import { BatchModel } from './batch.ts';

const answer = (customId: string, text: string, stop = 'end_turn') => ({
  custom_id: customId,
  result: {
    type: 'succeeded',
    message: {
      content: [{ type: 'text', text }],
      stop_reason: stop,
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    },
  },
});

function fakeClient(results: unknown[]) {
  const create = vi.fn(async () => ({ id: 'batch-1' }));
  const client = {
    messages: {
      batches: {
        create,
        retrieve: async () => ({ processing_status: 'ended' }),
        results: async () =>
          (async function* () {
            yield* results;
          })(),
      },
    },
  };
  return { create, client: client as unknown as ConstructorParameters<typeof BatchModel>[0] };
}

const request = { system: 's', prompt: 'p', schema: {}, maxTokens: 100 };

describe('BatchModel', () => {
  it('sends queued calls as one batch and settles each from its own result, at half price', async () => {
    const budget = new Budget(1);
    const { client, create } = fakeClient([answer('1', '{"b":2}'), answer('0', '{"a":1}')]);
    const model = new BatchModel(client, budget, 0);
    const first = model.json<{ a: number }>(request);
    const second = model.json<{ b: number }>(request);
    expect(model.queued).toBe(2);
    await model.flush();
    expect(await first).toEqual({ a: 1 });
    expect(await second).toEqual({ b: 2 });
    expect(create).toHaveBeenCalledTimes(1);
    // Haiku 5.5 long rate: $0.50 in, $2.50 out, halved: ($0.50 + $0.25) / 2, twice.
    expect(budget.spentUsd).toBeCloseTo(0.75);
  });

  it('refuses a batch its own budget cannot cover, before sending anything', async () => {
    const { client, create } = fakeClient([]);
    const model = new BatchModel(client, new Budget(0), 0);
    const call = model.json(request);
    await model.flush();
    await expect(call).rejects.toThrow(/AI budget/);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a cut-off answer and one with no result', async () => {
    const { client } = fakeClient([answer('0', '{"a":', 'max_tokens')]);
    const model = new BatchModel(client, new Budget(1), 0);
    const cut = model.json(request);
    const lost = model.json(request);
    await model.flush();
    await expect(cut).rejects.toThrow(/max_tokens/);
    await expect(lost).rejects.toThrow(/no result/);
  });
});
