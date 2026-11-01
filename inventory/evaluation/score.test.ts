import { describe, expect, it } from 'vitest';
import { scoreRecall } from './score.ts';

describe('scoreRecall', () => {
  it('matches by file within the line tolerance and ignores client inits', () => {
    const report = {
      usages: [
        {
          repo: 'a/b',
          provider: 'stripe',
          via: 'sdk' as const,
          callSites: [
            { file: 'src/pay.ts', line: 12, operation: 'charges.create' },
            { file: 'src/other.ts', line: 3, operation: 'x' },
          ],
        },
      ],
    };
    const truth = {
      repo: 'a/b',
      commit: 'abc',
      callSites: [
        {
          provider: 'stripe',
          via: 'sdk',
          file: 'src/pay.ts',
          line: 10,
          operation: 'charges.create',
        },
        {
          provider: 'stripe',
          via: 'sdk',
          file: 'src/pay.ts',
          line: 30,
          operation: 'refunds.create',
        },
        {
          provider: 'stripe',
          via: 'sdk',
          file: 'src/client.ts',
          line: 1,
          operation: 'client init',
        },
      ],
    };
    const score = scoreRecall(report, truth);
    expect(score).toMatchObject({ expected: 2, hits: 1, recall: 0.5 });
    expect(score.misses.map((miss) => miss.line)).toEqual([30]);
  });
});
