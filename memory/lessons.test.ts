import { describe, expect, it } from 'vitest';
import { makeRecord, makeTask } from './fixtures/tasks.ts';
import { habitNotes, knownPlan, mergeHabits } from './habits.ts';
import { lessonsFrom } from './lessons.ts';
import type { StoredRun } from './types.ts';

const AT = '2026-11-05T00:00:00.000Z';
const run = (over: Partial<StoredRun> = {}, record = {}): StoredRun => ({
  id: 'run-1',
  recordedAt: AT,
  task: {
    ...makeTask({ repo: 'example-org/shop' }),
    findings: [{ entryId: 'AN-1', file: 'src/a.ts', line: 1, matchClass: 'live' }],
    entries: [{ id: 'AN-1', lookFor: ['claude-3-opus'] }],
  } as StoredRun['task'],
  record: { ...makeRecord(), ...record },
  transcript: '',
  usedRecipeIds: [],
  ...over,
});

describe('lessonsFrom', () => {
  it('turns a false alarm into a lesson for the scanner', () => {
    const report = { falseAlarms: [{ entryId: 'AN-1', file: 'src/b.ts', why: 'our own type' }] };
    expect(lessonsFrom(run({ commit: 'abc' }, { report }))).toEqual([
      {
        kind: 'false-alarm',
        entryId: 'AN-1',
        repo: 'example-org/shop',
        commit: 'abc',
        file: 'src/b.ts',
        why: 'our own type',
        runId: 'run-1',
      },
    ]);
  });

  it('turns a dead name a person removed from an unflagged file into a miss, once', () => {
    const humanDiff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '-model: "claude-3-opus"',
      'diff --git a/src/c.ts b/src/c.ts',
      '-model: "claude-3-opus"',
      '-other: "claude-3-opus"',
    ].join('\n');
    const lessons = lessonsFrom(run({ evidence: { merged: { at: AT, humanDiff } } }));
    expect(lessons.map(({ kind, file }) => [kind, file])).toEqual([['miss', 'src/c.ts']]);
  });

  it('keeps a closing comment as a rejection', () => {
    const lessons = lessonsFrom(run({ evidence: { closed: { at: AT, comment: 'wrong model' } } }));
    expect(lessons).toMatchObject([{ kind: 'rejected', why: 'wrong model' }]);
  });
});

describe('repo habits', () => {
  const preparation = {
    steps: [{ command: 'npx prisma generate', why: 'client', code: 0, output: '' }],
    env: { DATABASE_URL: 'postgresql://localhost/db' },
  };

  it('keeps setup that worked and checks that passed, and offers them to the next run', () => {
    const agentChecks = [
      { name: 'proof', command: 'node proof.js', before: 'fail', after: 'pass' },
      { name: 'flaky', command: 'node flaky.js', before: 'fail', after: 'fail (1)' },
    ];
    const habits = mergeHabits(undefined, run({}, { preparation, agentChecks }), AT);
    expect(knownPlan(habits)?.steps).toEqual([{ command: 'npx prisma generate', why: 'client' }]);
    expect(knownPlan(habits)?.env).toEqual(preparation.env);
    expect(habits.checks).toEqual([{ name: 'proof', command: 'node proof.js' }]);
    expect(habitNotes(habits)).toEqual(["An earlier run's check passed here: `node proof.js`"]);
  });

  it('does not keep setup that failed, and keeps the setup it already had', () => {
    const failed = { steps: [{ ...preparation.steps[0], code: 1 }], env: {} };
    const good = mergeHabits(undefined, run({}, { preparation }), AT);
    const after = mergeHabits(good, run({}, { preparation: failed }), AT);
    expect(after.setup).toEqual(good.setup);
    expect(mergeHabits(undefined, run({}, { preparation: failed }), AT).setup).toBeUndefined();
  });

  it('records what the team rejected once, however often the webhook comes', () => {
    const closed = { at: AT, comment: 'We pin this model on purpose.' };
    const once = mergeHabits(undefined, run({ evidence: { closed } }), AT);
    const twice = mergeHabits(once, run({ evidence: { closed } }), AT);
    expect(twice.rejected).toHaveLength(1);
    expect(habitNotes(twice)).toContain(
      'The team rejected an earlier PR here: We pin this model on purpose.',
    );
  });
});
