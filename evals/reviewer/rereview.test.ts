import { describe, expect, it } from 'vitest';
import { BudgetExceededError as RunBudgetRefusal } from '../../orchestrator/budget.ts';
import type { ProviderChange } from '../../shared/types.ts';
import { BudgetLedger } from '../runner/budget.ts';
import type { RepoResult, ReviewPr, TaskResult } from '../runner/types.ts';
import { formatRereviews, rereview, taskFromResult } from './rereview.ts';

const change: ProviderChange = {
  provider: 'stripe',
  id: 'c1',
  kind: 'field-removed',
  title: 'example removal',
  source: { url: 'https://example.com/changelog', quote: 'example quote' },
  affects: { fields: ['old_name'] },
};

const task = (taskId: string, extra: Partial<TaskResult> = {}): TaskResult => ({
  taskId,
  changeId: 'c1',
  kind: 'field-removed',
  attempted: true,
  record: {
    taskId,
    outcome: 'needs-review',
    diff: '--- a/src/pay.ts\n+++ b/src/pay.ts\n-old_name\n+new_name',
    checks: [],
    costUsd: 0.3,
    transcriptPath: '',
  },
  review: { opinion: 'has-concerns', summary: 'first', concerns: [], costUsd: 0.04, model: 'x' },
  ...extra,
});

const repo = (tasks: TaskResult[]): RepoResult => ({
  set: 'dev',
  index: 0,
  repo: 'o/r',
  commit: 'c'.repeat(40),
  provider: 'stripe',
  usages: 1,
  changes: 1,
  verdict: 'tasks',
  tasks,
  costUsd: 1,
  durationMs: 1,
});

const checkouts: string[] = [];
const checkout = async ({ repo: name }: { repo: string }) => {
  checkouts.push(name);
  return { repoDir: '/checkout', cleanup: async () => undefined };
};
const meter = (name: string) => new BudgetLedger(1).meter(name);

describe('re-reviewing saved results', () => {
  it('rebuilds the task from what the result kept, call sites included', () => {
    const rebuilt = taskFromResult(
      repo([]),
      task('t1', {
        change,
        reasoning: 'sends old_name',
        callSites: [{ file: 'src/pay.ts', line: 12, why: 'sends old_name' }],
      }),
    );
    expect(rebuilt).toMatchObject({
      id: 't1',
      repo: 'o/r',
      change,
      notes: 'sends old_name',
      usages: [{ callSites: [{ file: 'src/pay.ts', line: 12, operation: 'sends old_name' }] }],
    });
    expect(taskFromResult(repo([]), task('t2'))).toBeUndefined();
  });

  it('reviews every PR with a diff again, and says which it could not', async () => {
    checkouts.length = 0;
    const seen: { id: string; repoDir?: string }[] = [];
    const review: ReviewPr = async ({ task: reviewed, repoDir }) => {
      seen.push({ id: reviewed.id, repoDir });
      return { opinion: 'looks-right', summary: 'second', concerns: [], costUsd: 0.05, model: 'y' };
    };
    const rows = await rereview(
      [
        repo([
          task('with-change', { change }),
          task('old-result'),
          task('empty', {
            change,
            record: { ...task('x').record!, diff: '' },
          }),
        ]),
      ],
      { review, checkout, meter },
    );
    expect(seen).toEqual([{ id: 'with-change', repoDir: '/checkout' }]);
    expect(rows.map((row) => [row.taskId, row.first?.opinion, row.second?.opinion])).toEqual([
      ['old-result', 'has-concerns', undefined],
      ['with-change', 'has-concerns', 'looks-right'],
    ]);
    expect(rows[0]?.skipped).toMatch(/no change/);
    expect(checkouts).toEqual(['o/r']);
    expect(formatRereviews(rows)).toContain(
      '| with-change | needs-review | has-concerns | looks-right | $0.0500 |',
    );
  });

  it('stops at the cap and says so', async () => {
    const review: ReviewPr = async () => {
      throw new RunBudgetRefusal(
        'AI budget: $0.01 of the $0.1 cap left; an advisory review needs $0.20.',
      );
    };
    const rows = await rereview([repo([task('a', { change }), task('b', { change })])], {
      review,
      checkout,
      meter,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skipped).toMatch(/advisory review needs/);
  });

  it('can be limited to one PR', async () => {
    const reviewed: string[] = [];
    const review: ReviewPr = async ({ task: t }) => {
      reviewed.push(t.id);
      return { opinion: 'unsure', summary: '', concerns: [], costUsd: 0, model: 'y' };
    };
    await rereview([repo([task('a:one', { change }), task('b:two', { change })])], {
      review,
      checkout,
      meter,
      only: 'b:two',
    });
    expect(reviewed).toEqual(['b:two']);
  });
});
