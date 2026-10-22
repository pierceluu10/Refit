import { expect, it } from 'vitest';
import {
  GUARD_REASON,
  repositoryResult,
  scoreMetaPlatform,
} from '../scripts/meta-platform-score.mjs';

it('reads live calls, guarded lines and moved requests from Refit output', () => {
  expect(
    repositoryResult(
      {
        calls: [
          { file: 'src/wa.ts', line: 47, use: 'live' },
          { file: 'test/wa.test.ts', line: 3, use: 'test' },
          { file: 'src/ig.ts', line: 9, use: 'live' },
        ],
      },
      {
        stops: [
          { reasons: [`src/wa.ts:47: ${GUARD_REASON}, which the change list does not cover`] },
        ],
        moves: [{ requests: [{ file: 'src/ig.ts', line: 9 }] }],
      },
    ),
  ).toEqual({
    calls: ['src/ig.ts:9', 'src/wa.ts:47'],
    guarded: ['src/wa.ts:47'],
    moved: ['src/ig.ts:9'],
  });
});

it('scores found, guarded and moved requests, and counts guards no label names', () => {
  const score = scoreMetaPlatform(
    {
      labels: [
        {
          repo: 'a/one',
          requests: [
            { file: 'src/wa.ts', line: 47 },
            { file: 'src/wa.ts', line: 60 },
          ],
        },
        { repo: 'b/two', requests: [{ file: 'bot.js', line: 5 }] },
      ],
    },
    {
      repos: [
        {
          repo: 'a/one',
          calls: ['src/wa.ts:47', 'src/wa.ts:60'],
          guarded: ['src/wa.ts:47', 'src/x.ts:1'],
          moved: ['src/wa.ts:60'],
        },
        { repo: 'b/two', calls: [], guarded: [], moved: [], error: 'scan limits' },
      ],
    },
  );
  expect(score).toMatchObject({
    repositories: 1,
    failed: ['b/two'],
    labelled: 2,
    found: 2,
    guarded: 1,
    moved: 1,
    falseGuards: 1,
    foundRecall: 1,
    guardRecall: 0.5,
    guardPrecision: 0.5,
  });
  expect(score.misses.map((miss) => `${miss.line} ${miss.error}`)).toEqual([
    'src/wa.ts:60 not guarded',
    'src/wa.ts:60 moved',
    'src/x.ts:1 guarded, not labelled',
  ]);
});
