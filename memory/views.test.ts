import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writePrBody } from '../harness/pr.ts';
import { storedRuns } from './fixtures/runs.ts';
import { makeRecord, makeTask } from './fixtures/tasks.ts';
import { listRunViews, toRunView } from './index.ts';
import { JsonMemoryStore } from './store.ts';

async function fixtureStore() {
  const store = new JsonMemoryStore(await mkdtemp(join(tmpdir(), 'aptitude-views-')));
  for (const run of storedRuns) await store.saveRun(run);
  return store;
}

describe('listRunViews', () => {
  it('lists stored runs newest first as RunView', async () => {
    const views = await listRunViews({}, await fixtureStore());

    expect(views.map((view) => view.id)).toEqual([
      'other-repo',
      'no-report',
      'secret',
      'sandbox',
      'pr-failed',
      'budget',
      'not-affected',
      'needs-review',
      'verified',
    ]);
    expect(views.at(-1)).toEqual({
      id: 'verified',
      repo: 'example-org/shop',
      taskId: 'task-verified',
      provider: 'stripe',
      changeId: 'stripe-charges-to-payment-intents',
      outcome: 'verified',
      pr: 'https://github.com/example-org/shop/pull/1',
      costUsd: 0.42,
      summary:
        'Moved both charges.create calls to paymentIntents.create with confirm: true. A human merged the PR.',
      finishedAt: '2026-11-01T12:01:00.000Z',
    });
    expect(views.find((view) => view.id === 'budget')).not.toHaveProperty('pr');
  });

  it('sums up each run in one line: what changed, or why nothing did', async () => {
    const views = await listRunViews({}, await fixtureStore());
    const summary = Object.fromEntries(views.map((view) => [view.id, view.summary]));

    expect(summary['needs-review']).toBe('Started the move to PaymentIntents.');
    expect(summary['budget']).toBe(
      'not attempted: $1.20 of the run cap left, below the $2 a task needs',
    );
    expect(summary['pr-failed']).toBe(
      'harness outcome was verified; opening the PR failed: HTTP 422',
    );
    expect(summary['sandbox']).toBe(
      'The harness could not create a sandbox: docker is not running',
    );
    expect(summary['no-report']).toBe(
      'Changed 2 files for "Charges API calls should move to PaymentIntents".',
    );
    expect(summary['other-repo']).toBe(
      'Replaced the charges.create call in the invoice job. A human closed the PR without merging.',
    );
    expect(summary['not-affected']).toMatch(/^The repo only reads charge objects .*…$/);
    expect(summary['not-affected']).toHaveLength(200);
    expect(summary['secret']).toContain('[redacted]');
    expect(summary['secret']).not.toContain('ghs_');
    for (const line of Object.values(summary)) expect(line).not.toContain('\n');
  });

  it('filters by repo and limits the count', async () => {
    const store = await fixtureStore();

    expect((await listRunViews({ repo: 'example-org/billing' }, store)).map((v) => v.id)).toEqual([
      'other-repo',
    ]);
    expect((await listRunViews({ limit: 2 }, store)).map((v) => v.id)).toEqual([
      'other-repo',
      'no-report',
    ]);
    expect(await listRunViews({ repo: 'example-org/none' }, store)).toEqual([]);
  });
});

describe('toRunView', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redacts a secret before cutting the line, even one the cut would split', () => {
    vi.stubEnv('EXAMPLE_DEPLOY_TOKEN', 'correct-horse-battery-staple-plain-words');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEexample\n-----END RSA PRIVATE KEY-----';
    const view = (note: string) => {
      const record = { ...makeRecord({ outcome: 'failed', diff: '' }), note };
      return toRunView({
        id: 'run-1',
        recordedAt: '2026-11-01T12:00:00.000Z',
        task: makeTask(),
        record,
        transcript: '',
        usedRecipeIds: [],
      }).summary;
    };

    const nearTheCut = view(`${'x'.repeat(180)} correct-horse-battery-staple-plain-words`);
    expect(nearTheCut).not.toContain('correct-horse');
    expect(view(`clone failed: ${pem}`)).toBe('clone failed: [redacted]');
  });

  // Built with the harness's own PR writer, so a change to its format fails here, not on the dashboard.
  it("reads the agent's summary out of a real harness PR body", () => {
    const task = makeTask();
    const prBody = writePrBody({
      task,
      outcome: 'needs-review',
      report: {
        verdict: 'migrated',
        summary: 'Moved checkout to paymentIntents.create.\nRefunds still need a look.',
        why: 'The Charges API is going away.',
        validators: [],
        unproven: ['Refunds were not tested.'],
        behaviourChanges: [],
      },
      comparisons: [],
      diff: 'diff --git a/src/checkout.ts b/src/checkout.ts\n',
      costUsd: 0.5,
      models: ['claude-sonnet-5-5'],
      promptVersion: 'test',
      sandboxNote: 'local',
    });
    const record = { ...makeRecord({ outcome: 'needs-review' }), prBody };

    const view = toRunView({
      id: 'run-1',
      recordedAt: '2026-11-01T12:00:00.000Z',
      task,
      record,
      transcript: '',
      usedRecipeIds: [],
    });

    expect(view.summary).toBe('Moved checkout to paymentIntents.create.');
  });
});
