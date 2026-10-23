import { expect, it } from 'vitest';
import { scoreGo, type GoResult } from './benchmark.ts';

const labels = {
  repos: [
    {
      repo: 'a/one',
      commit: 'c1',
      calls: [
        { file: 'pay.go', line: 10, provider: 'stripe' },
        { file: 'pay.go', line: 20, provider: 'stripe' },
        { file: 'llm.go', line: 5, provider: 'openai' },
        { file: 'llm.go', line: 9, provider: 'anthropic' },
      ],
      sent: [
        { file: 'llm.go', line: 3, model: 'gpt-4o' },
        { file: 'llm.go', line: 8, model: 'claude-opus-4-8' },
      ],
      ambiguous: [{ file: 'llm.go', line: 30, model: 'o1' }],
    },
  ],
};

const result: GoResult = {
  repo: 'a/one',
  commit: 'c1',
  status: 'scanned',
  calls: [
    { file: 'pay.go', line: 10, provider: 'stripe', call: 'paymentintent.New', client: 'module' },
    { file: 'pay.go', line: 40, provider: 'stripe', call: 'customer.New', client: 'module' },
    {
      file: 'llm.go',
      line: 5,
      provider: 'openai',
      call: 'Chat.Completions.New',
      client: 'constructor',
    },
  ],
  sites: [
    { file: 'llm.go', line: 3, model: 'gpt-4o' },
    { file: 'llm.go', line: 30, model: 'o1' },
    { file: 'llm.go', line: 31, model: 'o3' },
  ],
  stops: [],
  modules: [],
};

it('scores Stripe call lines and model sites together, with recall for each', () => {
  const score = scoreGo(labels, [result]);
  expect(score.counts).toEqual({
    correct: 2,
    wrong: 2,
    stripeCalls: 2,
    stripeTraced: 1,
    sent: 2,
    sentFound: 1,
    modelCalls: 2,
    modelCallsTraced: 1,
  });
  expect(score.linePrecision).toBe(0.5);
  expect(score.stripeCallRecall).toBe(0.5);
  expect(score.modelSiteRecall).toBe(0.5);
  expect(score.modelCallRecall).toBe(0.5);
  expect(score.wrong).toEqual(['a/one pay.go:40 stripe call', 'a/one llm.go:31 o3']);
  expect(score.missed).toEqual(['a/one pay.go:20 stripe call', 'a/one llm.go:8 claude-opus-4-8']);
});

it('refuses missing or mismatched results', () => {
  expect(() => scoreGo(labels, [])).toThrow('a/one was not scanned.');
  expect(() => scoreGo(labels, [{ ...result, commit: 'c2' }])).toThrow(
    'a/one was scanned at c2, not c1.',
  );
});
