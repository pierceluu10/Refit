import { describe, expect, it } from 'vitest';
import { makeRecord, makeTask } from './fixtures/tasks.ts';
import { evidenceOf, ladderFrom, levelsOf, provenAllowed, type LadderEvidence } from './ladder.ts';
import type { StoredRun } from './types.ts';

const item = (kind: LadderEvidence['kind'], repo: string, day: number): LadderEvidence => ({
  kind,
  repo,
  runId: `${repo}-${day}`,
  at: `2026-11-0${day}T00:00:00.000Z`,
});

const run = (id: string, evidence: StoredRun['evidence'], extra = {}): StoredRun => ({
  id,
  recordedAt: '2026-11-05T00:00:00.000Z',
  task: { ...makeTask({ repo: `acme/${id}` }), entries: [{ id: 'GE-1' }] } as StoredRun['task'],
  record: { ...makeRecord(), ...extra },
  transcript: '',
  usedRecipeIds: [],
  evidence,
});

describe('levelsOf', () => {
  it('starts new, becomes a recipe on a merge and proven at 3 repos', () => {
    expect(levelsOf([]).level).toBe('new');
    const one = [item('merged', 'a', 1)];
    expect(levelsOf(one).level).toBe('recipe');
    const two = [...one, item('merged', 'b', 2)];
    expect(levelsOf(two).level).toBe('recipe');
    expect(levelsOf([...two, item('merged', 'c', 3)]).level).toBe('proven');
  });

  it('needs different repos and few edits', () => {
    expect(levelsOf(['a', 'a', 'a'].map((r, i) => item('merged', r, i + 1))).level).toBe('recipe');
    const edited = ['a', 'b', 'c'].map((r, i) => item(i ? 'edited' : 'merged', r, i + 1));
    expect(levelsOf(edited).level).toBe('recipe');
    const oneEdit = ['a', 'b', 'c'].map((r, i) => item(i === 2 ? 'edited' : 'merged', r, i + 1));
    expect(levelsOf(oneEdit).level).toBe('proven');
  });

  it('moves down a level on a close or revert, keeps the evidence and stays down at new', () => {
    const proven = ['a', 'b', 'c'].map((r, i) => item('merged', r, i + 1));
    const reverted = [...proven, item('reverted', 'a', 4)];
    expect(levelsOf(reverted).level).toBe('recipe');
    expect(levelsOf([...reverted, item('merged', 'd', 5)]).level).toBe('recipe');
    const closed = [item('closed', 'a', 1)];
    expect(levelsOf(closed).level).toBe('dropped');
  });

  it('gives the same level whatever order the events arrive in', () => {
    const events = ['a', 'b', 'c'].map((r, i) => item('merged', r, i + 1));
    expect(levelsOf([...events].reverse())).toEqual(levelsOf(events));
  });

  it('lets a locked test move only the benchmark level, never the customer level', () => {
    const tests = ['a', 'b', 'c'].map((r, i) => item('locked-test', r, i + 1));
    expect(levelsOf(tests)).toEqual({ level: 'new', benchmarkLevel: 'proven' });
  });
});

describe('the ladder from stored runs', () => {
  const at = '2026-11-05T00:00:00.000Z';

  it('takes evidence only from a clean rescan', () => {
    expect(evidenceOf(run('a', { merged: { at } }))).toEqual([]);
    expect(evidenceOf(run('a', { rescanClean: true, merged: { at } }))).toMatchObject([
      { kind: 'merged', repo: 'acme/a' },
    ]);
  });

  it('forgets a close once the PR merges', () => {
    const closed = { closed: { at }, rescanClean: true };
    expect(evidenceOf(run('a', { ...closed, merged: { at } }))).toMatchObject([{ kind: 'merged' }]);
    expect(evidenceOf(run('a', closed))).toMatchObject([{ kind: 'closed' }]);
  });

  it('counts an edited merge as edited, and a revert against the fix', () => {
    const [entry] = ladderFrom(
      [
        run('a', { rescanClean: true, edited: true, merged: { at } }),
        run('b', { rescanClean: true, merged: { at }, reverted: { at, via: 'rescan' } }),
      ],
      at,
    );
    expect(entry.evidence.map((e) => e.kind).sort()).toEqual(['edited', 'merged', 'reverted']);
  });

  it('rolls a proven fix out to a few repos before the rest', () => {
    const merged = ['a', 'b', 'c'].map((id) => run(id, { rescanClean: true, merged: { at } }));
    const [entry] = ladderFrom(merged, at);
    expect(entry.level).toBe('proven');
    expect(provenAllowed(entry, merged)).toBe(true);
    const waiting = ['d', 'e', 'f'].map((id) =>
      run(id, { rescanClean: true }, { provenFixes: ['GE-1'] }),
    );
    expect(provenAllowed(entry, [...merged, ...waiting])).toBe(false);
  });

  it('never allows a plain-code fix at any level below proven', () => {
    const merged = [run('a', { rescanClean: true, merged: { at } })];
    expect(provenAllowed(ladderFrom(merged, at)[0], merged)).toBe(false);
    expect(provenAllowed(undefined, merged)).toBe(false);
  });

  it('counts a locked test only for the entries it covered', () => {
    const task = {
      ...makeTask({ repo: 'acme/a' }),
      entries: [{ id: 'GE-1' }, { id: 'OA-3' }],
    } as StoredRun['task'];
    const covered = {
      ...run('a', { rescanClean: true, lockedTest: true, lockedEntries: ['GE-1'] }),
      task,
    };
    const ladder = ladderFrom([covered], at);
    expect(ladder.find((e) => e.entryId === 'GE-1')?.evidence).toHaveLength(1);
    expect(ladder.find((e) => e.entryId === 'OA-3')?.evidence).toHaveLength(0);
  });

  it('keeps benchmark evidence out of what customers may run', () => {
    const tests = ['a', 'b', 'c'].map((id) => run(id, { rescanClean: true, lockedTest: true }));
    const [entry] = ladderFrom(tests, at);
    expect(provenAllowed(entry, tests)).toBe(false);
    expect(provenAllowed(entry, tests, { benchmark: true })).toBe(true);
  });
});
