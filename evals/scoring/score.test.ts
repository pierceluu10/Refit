import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../shared/types.ts';
import type { RepoResult, TaskResult } from '../runner/types.ts';
import { formatReport, scoreResults } from './score.ts';
import {
  diffFiles,
  handCheckSummary,
  missingHandChecks,
  readReviews,
  syncReviews,
  writeReviews,
} from './reviews.ts';

const task = (
  taskId: string,
  outcome: RunRecord['outcome'],
  extra: Partial<TaskResult> = {},
): TaskResult => ({
  taskId,
  changeId: 'c',
  kind: 'api-version',
  attempted: true,
  record: {
    taskId,
    outcome,
    diff: outcome === 'not-affected' ? '' : '+x',
    checks: [],
    costUsd: 0.1,
    transcriptPath: '',
    ...(outcome === 'verified' ? { pr: `https://github.com/o/r/pull/${taskId}` } : {}),
  },
  ...extra,
});

const repo = (
  name: string,
  verdict: RepoResult['verdict'],
  tasks: TaskResult[],
  costUsd = 1,
): RepoResult => ({
  set: 'dev',
  index: 0,
  repo: name,
  commit: 'c'.repeat(40),
  provider: 'stripe',
  usages: 1,
  changes: 1,
  verdict,
  tasks,
  costUsd,
  durationMs: 1,
});

describe('scoreResults', () => {
  const results = [
    repo('o/verified', 'tasks', [task('1', 'verified'), task('2', 'verified')]),
    repo('o/mixed', 'tasks', [task('3', 'verified'), task('4', 'needs-review')]),
    repo('o/clean', 'not-affected', []),
    repo('o/unrun', 'unrun', [], 0),
  ];

  it('computes rates over tasks plus not-affected repos', () => {
    const score = scoreResults(results);
    expect(score.units).toBe(5);
    expect(score.counts).toEqual({ verified: 3, 'needs-review': 1, 'not-affected': 1, failed: 0 });
    expect(score.rates.verified).toBeCloseTo(0.6);
    expect(score.repoCounts).toMatchObject({
      verified: 1,
      'needs-review': 1,
      'not-affected': 1,
      unrun: 1,
    });
  });

  it('tells started repos from those the cap never started or stopped at every task', () => {
    const score = scoreResults([
      ...results,
      repo('o/stopped', 'tasks', [
        { taskId: '9', changeId: 'c', kind: 'other', attempted: false, unrun: 'budget' },
      ]),
    ]);
    expect(score).toMatchObject({ repos: 5, startedRepos: 4, capStoppedRepos: 1 });
    expect(formatReport(score)).toContain(
      'Repos: 5: 4 started, 1 never started (dollar cap); in 1 of the started, the cap stopped every task',
    );
  });

  it('reports cost per repo over the repos that ran', () => {
    const score = scoreResults(results);
    expect(score.costUsd).toBe(3);
    expect(score.costPerRepoUsd).toBe(1);
  });

  it('adds up the cost by part and prints it per repo', () => {
    const score = scoreResults([
      { ...repo('o/a', 'not-affected', [], 0.75), costByPart: { inventory: 0.5, match: 0.25 } },
      {
        ...repo('o/b', 'tasks', [task('1', 'verified')], 2),
        costByPart: { inventory: 0.5, harness: 1.5 },
      },
    ]);
    expect(score.costByPart).toEqual({ inventory: 1, match: 0.25, harness: 1.5 });
    const report = formatReport(score);
    expect(report).toContain('| Repo | inventory | match | harness | Total |');
    expect(report).toContain('| o/b | $0.5000 | $0.0000 | $1.5000 | $2.0000 |');
    expect(report).toContain('| All repos | $1.0000 | $0.2500 | $1.5000 | $2.7500 |');
  });

  it('holds attempted at 100% and lists every unattempted task as a bug', () => {
    expect(scoreResults(results).attemptedRate).toBe(1);
    const broken = scoreResults([
      repo('o/a', 'tasks', [
        task('1', 'verified'),
        task('2', 'needs-review', { attempted: false, noAttemptReason: 'empty diff' }),
      ]),
      repo('o/b', 'error', [], 0),
    ]);
    expect(broken.attemptedRate).toBeCloseTo(1 / 3);
    expect(broken.attemptBugs.map((bug) => bug.reason)).toEqual([
      'empty diff',
      'repo ended with no verdict',
    ]);
    expect(formatReport(broken)).toContain('BUG: o/a 2: empty diff');
  });

  it('never lets the advisory reviewer change a grade', () => {
    const reviewed = [
      repo('o/r', 'tasks', [
        task('1', 'verified', {
          review: {
            opinion: 'has-concerns',
            summary: 'looks wrong',
            concerns: [],
            costUsd: 0,
            model: 'fake',
          },
        }),
      ]),
    ];
    const score = scoreResults(reviewed);
    expect(score.counts.verified).toBe(1);
    expect(score.reviewerOpinions).toEqual({ 'has-concerns': 1 });
  });

  it('does not count tasks the cap stopped as attempts or bugs', () => {
    const score = scoreResults([
      repo('o/a', 'tasks', [
        task('1', 'verified'),
        { taskId: '2', changeId: 'c', kind: 'other', attempted: false, unrun: 'budget' },
      ]),
    ]);
    expect(score.attemptedRate).toBe(1);
    expect(score.unrunTasks).toBe(1);
  });
});

describe('hand-check log', () => {
  const results = [
    repo('o/a', 'tasks', [
      task('1', 'verified', {
        review: {
          opinion: 'looks-right',
          summary: 'fine',
          concerns: [],
          costUsd: 0,
          model: 'fake',
        },
      }),
      task('2', 'needs-review'),
    ]),
  ];

  it('adds one pending entry per verified or needs-review PR and keeps existing entries untouched', () => {
    const first = syncReviews([], results, '2026-11-01T00:00:00Z');
    expect(first.added).toHaveLength(2);
    expect(first.added[0]).toMatchObject({
      key: 'dev/o/a/1',
      grade: 'verified',
      pr: 'https://github.com/o/r/pull/1',
      aiReview: { opinion: 'looks-right' },
      handCheck: { status: 'pending' },
    });
    expect(first.added[1]).toMatchObject({ key: 'dev/o/a/2', grade: 'needs-review' });
    const checked = first.reviews.map((entry) => ({
      ...entry,
      handCheck: { status: 'agree' as const, reviewer: 'furqan' },
    }));
    const second = syncReviews(checked, results);
    expect(second.added).toHaveLength(0);
    expect(second.reviews[0]?.handCheck.status).toBe('agree');
    expect(missingHandChecks(second.reviews, results)).toEqual([]);
    expect(missingHandChecks([], results)).toEqual(['dev/o/a/1', 'dev/o/a/2']);
    expect(handCheckSummary(second.reviews)).toMatchObject({ agree: 2, agreementRate: 1 });
  });

  it('names the files each diff touches', () => {
    expect(
      diffFiles(
        '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n--- /dev/null\n+++ b/new.ts\n+z',
      ),
    ).toEqual(['src/a.ts', 'new.ts']);
  });

  it('round-trips through a file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aptitude-reviews-')), 'reviews.json');
    expect(readReviews(path)).toEqual([]);
    writeReviews(syncReviews([], results).reviews, path);
    expect(readReviews(path)).toHaveLength(2);
  });

  it('ships an empty, valid evals/reviews.json', () => {
    expect(Array.isArray(readReviews())).toBe(true);
  });
});
