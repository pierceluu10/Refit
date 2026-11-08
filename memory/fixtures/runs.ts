// Illustrative stored runs for listRunViews tests, one per kind of record the loop and harness write.
// Not real customers, repos or runs.
import type { RunRecord } from '../../shared/types.ts';
import type { StoredRun } from '../types.ts';
import { makeRecord, makeTask } from './tasks.ts';

type Written = Partial<RunRecord> & { prBody?: string; note?: string };

function stored(id: string, minute: number, record: Written, repo = 'example-org/shop'): StoredRun {
  return {
    id,
    recordedAt: `2026-11-01T12:0${minute}:00.000Z`,
    task: makeTask({ id: `task-${id}`, repo }),
    record: { ...makeRecord({ taskId: `task-${id}` }), ...record },
    transcript: '',
    usedRecipeIds: [],
  };
}

const prBody = (summary: string) =>
  `## Charges API calls should move to PaymentIntents [Verified]\n\n### Change\n\n${summary}\n\nFiles touched:\n- \`src/checkout.ts\``;

const diff = (...files: string[]) =>
  files.map((file) => `diff --git a/${file} b/${file}\n-old\n+new\n`).join('');

export const storedRuns: StoredRun[] = [
  stored('verified', 1, {
    pr: 'https://github.com/example-org/shop/pull/1',
    humanVerdict: 'merged',
    prBody: prBody('Moved both charges.create calls to paymentIntents.create with confirm: true.'),
  }),
  stored('needs-review', 2, {
    outcome: 'needs-review',
    pr: 'https://github.com/example-org/shop/pull/2',
    prBody: prBody('Started the move to PaymentIntents.\nThe refund path still uses charges.'),
  }),
  stored('not-affected', 3, {
    outcome: 'not-affected',
    diff: '',
    costUsd: 0,
    note: `The repo only reads charge objects from webhook payloads and never calls charges.create, so removing the endpoint changes nothing here. ${'It also pins an old API version, which is a separate change. '.repeat(3)}`,
  }),
  stored('budget', 4, {
    outcome: 'waiting-budget',
    diff: '',
    costUsd: 0,
    note: 'not attempted: $1.20 of the run cap left, below the $2 a task needs',
  }),
  stored('pr-failed', 5, {
    outcome: 'failed',
    prBody: prBody('Moved charges.create to paymentIntents.create.'),
    note: 'harness outcome was verified; opening the PR failed: HTTP 422',
  }),
  stored('sandbox', 6, {
    outcome: 'failed',
    diff: '',
    prBody: 'The harness could not create a sandbox: docker is not running',
  }),
  stored('secret', 7, {
    outcome: 'failed',
    diff: '',
    note: 'runTask failed after retries: could not fetch https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com/example-org/shop.git',
  }),
  stored('no-report', 8, {
    outcome: 'needs-review',
    diff: diff('src/checkout.ts', 'src/refund.ts'),
    prBody: prBody('The agent did not report a summary.'),
  }),
  stored(
    'other-repo',
    9,
    {
      pr: 'https://github.com/example-org/billing/pull/3',
      humanVerdict: 'closed',
      prBody: prBody('Replaced the charges.create call in the invoice job.'),
    },
    'example-org/billing',
  ),
];
