import { expect, it } from 'vitest';
import { parseWebhook } from './github-webhooks.ts';
import {
  customerReason,
  outcomeRates,
  pullOutcome,
  recordPullOutcome,
  recordReverts,
  revertedCommits,
} from './pull-outcomes.ts';

const PUSHED = 'a'.repeat(40);
const MERGE = 'c'.repeat(40);
const body = (value: object) => new TextEncoder().encode(JSON.stringify(value));
const closed = (pull: object, sender: object = { login: 'dev', type: 'User' }) =>
  parseWebhook(
    body({
      action: 'closed',
      sender,
      installation: { id: 456 },
      repository: { full_name: 'Acme/Shop' },
      pull_request: {
        number: 12,
        merged: true,
        merge_commit_sha: MERGE,
        closed_at: '2026-10-28T12:00:00Z',
        body: `Refit draft\n<!-- refit-pushed: ${PUSHED} -->`,
        user: { login: 'refit[bot]', type: 'Bot' },
        head: { ref: 'refit/stripe-endive', sha: PUSHED, repo: { full_name: 'Acme/Shop' } },
        base: { sha: 'b'.repeat(40) },
        ...pull,
      },
    }),
    'pull_request',
    123,
  );

it('classifies a closed Refit pull request by whether its head is the commit Refit pushed', () => {
  expect(closed({})).toEqual({
    kind: 'pull_request_closed',
    installation: 456,
    repository: 'acme/shop',
    number: 12,
    head: PUSHED,
    merged: true,
    mergeCommit: MERGE,
    pushed: PUSHED,
    closedAt: '2026-10-28T12:00:00Z',
  });
  expect(pullOutcome({ merged: true, head: PUSHED, pushed: PUSHED })).toBe('merged-without-edits');
  expect(pullOutcome({ merged: true, head: 'd'.repeat(40), pushed: PUSHED })).toBe(
    'merged-with-edits',
  );
  // No record of what Refit pushed: counted as edited, never as an unedited merge.
  expect(pullOutcome({ merged: true, head: PUSHED, pushed: null })).toBe('merged-with-edits');
  expect(pullOutcome({ merged: false, head: PUSHED, pushed: PUSHED })).toBe('closed-unmerged');
  // Other pull requests, and the validation workflow's own, are not Refit migrations.
  expect(closed({ head: { ref: 'feature/x', sha: PUSHED } })).toEqual({ kind: 'ignored' });
  // A person's branch named refit/*, or one from a fork, is not a Refit pull request.
  expect(closed({ user: { login: 'dev', type: 'User' } })).toEqual({ kind: 'ignored' });
  expect(
    closed({ head: { ref: 'refit/x', sha: PUSHED, repo: { full_name: 'someone/shop' } } }),
  ).toEqual({ kind: 'ignored' });
  // Refit closing its own draft (superseded, or a CI regression) is not the customer's decision.
  expect(closed({ merged: false }, { login: 'refit[bot]', type: 'Bot' })).toEqual({
    kind: 'ignored',
  });
  expect(closed({ head: { ref: 'refit/validation-workflow', sha: PUSHED } })).toEqual({
    kind: 'ignored',
  });
  expect(() => closed({ merged: 'yes' })).toThrow('Pull request webhook is incomplete.');
});

it('finds reverts in a push to the default branch', () => {
  const push = parseWebhook(
    body({
      ref: 'refs/heads/main',
      after: 'e'.repeat(40),
      installation: { id: 456 },
      repository: { full_name: 'Acme/Shop', default_branch: 'main' },
      commits: [
        { message: `Revert "Refit: move to endive"\n\nThis reverts commit ${MERGE}.` },
        { message: 'fix: unrelated' },
      ],
    }),
    'push',
    123,
  );
  expect(push).toMatchObject({ kind: 'push', reverts: [MERGE] });
  expect(revertedCommits(undefined)).toEqual([]);
});

it("takes the customer's newest comment as the reason, never a bot's", () => {
  expect(
    customerReason([
      { user: { login: 'dev', type: 'User' }, body: 'Looks wrong for annual plans.' },
      { user: { login: 'dev', type: 'User' }, body: 'We moved to a different SDK.' },
      { user: { login: 'refit[bot]', type: 'Bot' }, body: 'Superseded.' },
    ]),
  ).toBe('We moved to a different SDK.');
  expect(customerReason([{ user: { type: 'Bot' }, body: 'x' }])).toBeNull();
});

it('computes the merge rate and the wrong-fix rate', () => {
  expect(
    outcomeRates([
      { outcome: 'merged-without-edits', count: 6 },
      { outcome: 'merged-with-edits', count: 1 },
      { outcome: 'reverted', count: 1 },
      { outcome: 'closed-unmerged', count: 2 },
    ]),
  ).toEqual({
    counts: {
      'merged-without-edits': 6,
      'merged-with-edits': 1,
      'closed-unmerged': 2,
      reverted: 1,
    },
    mergeRate: 0.8,
    wrongFixRate: 0.25,
  });
  expect(outcomeRates([])).toMatchObject({ mergeRate: null, wrongFixRate: null });
});

it('stores the outcome in the delivery transaction and marks reverted merges', async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rowCount: 1, rows: [] };
    },
  } as never;
  const change = closed({});
  if (change.kind !== 'pull_request_closed') throw new Error('not a closed pull request');
  expect(await recordPullOutcome(client, change)).toBe('accepted');
  expect(queries[0].values).toEqual([
    456,
    'acme/shop',
    12,
    'merged-without-edits',
    PUSHED,
    MERGE,
    PUSHED,
    '2026-10-28T12:00:00Z',
  ]);
  expect(await recordReverts(client, 'acme/shop', [MERGE])).toBe(1);
  expect(queries[1].text).toContain("outcome = 'reverted'");
  expect(await recordReverts(client, 'acme/shop', [])).toBe(0);
  expect(queries).toHaveLength(2);
});
