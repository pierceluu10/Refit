import type { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { AgentSdkModel, Budget, DegradedOutputError } from './ai.ts';

const output = { prompt: 'ok' };
const result = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.01,
  structured_output: output,
};
// Shape of the notice the SDK sent the model in the real Shopify run on 2026-11-01.
const classifierNotice = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Your response above was stopped by a safety classifier — this is not a tool or API error. The rest of it was withheld.',
      },
    ],
  },
};

// A fake Agent SDK query() that replays a fixed message stream. No real calls.
function fakeQuery(messages: unknown[]): typeof query {
  return (() =>
    (async function* () {
      yield* messages;
    })()) as unknown as typeof query;
}

const request = { system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 100 };

describe('AgentSdkModel', () => {
  it('returns the structured output and charges the SDK cost', async () => {
    const budget = new Budget(3);
    const model = new AgentSdkModel(budget, fakeQuery([result]));

    expect(await model.json(request)).toEqual(output);
    expect(budget.spentUsd).toBe(0.01);
  });

  it('distrusts an answer a safety classifier interrupted, even if it later succeeded', async () => {
    const budget = new Budget(3);
    const model = new AgentSdkModel(budget, fakeQuery([classifierNotice, result]));

    await expect(model.json(request)).rejects.toBeInstanceOf(DegradedOutputError);
    expect(budget.spentUsd).toBe(0.01);
  });

  it('treats a refusal message as degraded', async () => {
    const refusal = { type: 'system', subtype: 'model_refusal_no_fallback', content: 'refused' };
    const model = new AgentSdkModel(new Budget(3), fakeQuery([refusal, result]));

    await expect(model.json(request)).rejects.toThrow(/interrupted: refused/);
  });
});
