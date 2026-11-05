import { describe, expect, it } from 'vitest';
import { makeRecord, makeTask } from './fixtures/tasks.ts';
import { learningMetrics } from './metrics.ts';
import type { StoredRun } from './types.ts';

const at = '2026-11-05T00:00:00.000Z';
const run = (evidence: StoredRun['evidence'], record = {}): StoredRun => ({
  id: 'r',
  recordedAt: at,
  task: makeTask(),
  record: { ...makeRecord(), models: ['claude-sonnet-5-5'], ...record } as StoredRun['record'],
  transcript: '',
  usedRecipeIds: [],
  evidence,
});

describe('learningMetrics', () => {
  it('counts the no-model share, merges with and without edits, reverts and scanner misses', () => {
    const metrics = learningMetrics(
      [
        run({ rescanClean: true, merged: { at } }, { models: [], provenFixes: ['GE-1'] }),
        run({ rescanClean: true, edited: true, merged: { at } }),
        run({ rescanClean: true, merged: { at }, reverted: { at, via: 'rescan' } }),
        run({ rescanClean: true }, { diff: '' }),
      ],
      [
        { kind: 'sweep-miss', repo: 'a', why: 'x' },
        { kind: 'miss', repo: 'a', why: 'y' },
        { kind: 'false-alarm', repo: 'a', why: 'z' },
      ],
    );
    expect(metrics).toMatchObject({
      fixes: 3,
      merged: 3,
      mergedWithoutEdits: 2,
      reverts: 1,
      scannerMisses: 2,
      sweepMisses: 1,
    });
    expect(metrics.noModelShare).toBeCloseTo(1 / 3);
  });

  it('is all zeros on an empty store', () => {
    expect(learningMetrics([], [])).toMatchObject({ fixes: 0, noModelShare: 0 });
  });
});
