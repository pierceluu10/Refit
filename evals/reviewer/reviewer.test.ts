import { describe, expect, it } from 'vitest';
import type { MigrationTask, RunRecord } from '../../shared/types.ts';
import { BudgetLedger } from '../runner/budget.ts';
import { FakeModelClient, unwiredModelClient } from './model.ts';
import { buildReviewPrompt, createReviewer, parseReview, REVIEWER_SYSTEM } from './reviewer.ts';

const task: MigrationTask = {
  id: 'o/r#c1',
  repo: 'o/r',
  priority: 1,
  change: {
    provider: 'stripe',
    id: 'c1',
    kind: 'field-renamed',
    title: 'Example rename',
    source: { url: 'https://example.com/changelog', quote: 'example quote' },
    affects: { fields: ['old_name'] },
  },
  usages: [
    {
      repo: 'o/r',
      provider: 'stripe',
      via: 'sdk',
      callSites: [{ file: 'src/pay.ts', line: 12, operation: 'customers.create' }],
    },
  ],
};

const record: RunRecord = {
  taskId: task.id,
  outcome: 'verified',
  diff: '--- a/src/pay.ts\n+++ b/src/pay.ts\n-old_name\n+new_name',
  checks: [{ name: 'tests', before: '3 pass', after: '3 pass' }],
  costUsd: 0.2,
  transcriptPath: '',
  pr: 'https://github.com/o/r/pull/9',
};

describe('advisory reviewer', () => {
  it('asks for an open second opinion, not a yes/no gate', () => {
    expect(REVIEWER_SYSTEM).toMatch(/advisory/i);
    expect(REVIEWER_SYSTEM).toMatch(/never changes the grade/i);
    expect(REVIEWER_SYSTEM).not.toMatch(/decline/i);
  });

  it('gives the model the change, quote, call sites, checks and diff', () => {
    const prompt = buildReviewPrompt(task, record);
    for (const part of [
      'o/r#c1',
      'example quote',
      'src/pay.ts:12',
      '3 pass',
      '+new_name',
      'verified',
    ]) {
      expect(prompt).toContain(part);
    }
  });

  it('parses the reply, charges the meter and leaves the record alone', async () => {
    const client = new FakeModelClient(
      JSON.stringify({
        opinion: 'has-concerns',
        summary: 'rename misses a webhook handler',
        concerns: [{ file: 'src/hooks.ts', issue: 'still reads old_name', severity: 'high' }],
        checkFirst: ['src/hooks.ts'],
      }),
      0.01,
    );
    const ledger = new BudgetLedger(1);
    const before = structuredClone(record);
    const review = await createReviewer(client)({ task, record, meter: ledger.meter('o/r') });
    expect(review).toMatchObject({ opinion: 'has-concerns', costUsd: 0.01, model: 'fake' });
    expect(review.concerns[0]).toEqual({
      file: 'src/hooks.ts',
      issue: 'still reads old_name',
      severity: 'high',
    });
    expect(ledger.spentUsd).toBeCloseTo(0.01);
    expect(record).toEqual(before);
    expect(client.requests).toHaveLength(1);
  });

  it('keeps a non-JSON reply as an unsure summary', () => {
    expect(parseReview('I think it is fine but the tests are thin.')).toEqual({
      opinion: 'unsure',
      summary: 'I think it is fine but the tests are thin.',
      concerns: [],
    });
    expect(
      parseReview('{"opinion":"maybe","concerns":[{"issue":"x","severity":"huge"}]}'),
    ).toMatchObject({
      opinion: 'unsure',
      concerns: [{ issue: 'x', severity: 'medium' }],
    });
  });

  it('has no real client wired, so nothing can spend by accident', async () => {
    await expect(
      unwiredModelClient.complete({ system: '', prompt: '', maxTokens: 1 }),
    ).rejects.toThrow(/no real model client/);
  });
});
