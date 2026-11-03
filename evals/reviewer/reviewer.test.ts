import type Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError as RunBudgetRefusal,
  createBudget,
} from '../../orchestrator/budget.ts';
import type { MigrationTask, RunRecord } from '../../shared/types.ts';
import { BudgetLedger } from '../runner/budget.ts';
import { anthropicModelClient, FakeModelClient, REVIEWER_MODEL } from './model.ts';

// The client's hold and charge tests below are written in Opus's prices.
const PRICED_AS = 'claude-opus-5-5';
import {
  buildReviewPrompt,
  contextPaths,
  createReviewer,
  MAX_CONTEXT_CHARS,
  parseReview,
  readContextFiles,
  REVIEW_SCHEMA,
  REVIEWER_SYSTEM,
} from './reviewer.ts';

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

  it('warns the model its API knowledge may be older than the change', () => {
    expect(REVIEWER_SYSTEM).toMatch(/could not confirm/i);
    expect(REVIEWER_SYSTEM).toMatch(/don't call it invented/i);
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
});

// A stand-in for the SDK client: records each request and answers like the Messages API.
function fakeAnthropic(answer: (params: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        return answer(params);
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>;
  return { client, calls };
}

const message = (text: string, extra: Record<string, unknown> = {}) => ({
  model: REVIEWER_MODEL,
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 10_000, output_tokens: 1_000 },
  ...extra,
});

describe('the Anthropic reviewer client', () => {
  const request = { system: 'sys', prompt: 'review this', maxTokens: 8000 };

  it('charges the run budget what the API reports and returns the text', async () => {
    const budget = createBudget(1);
    const { client, calls } = fakeAnthropic(() => message('{"opinion":"looks-right"}'));
    const response = await anthropicModelClient({ budget, client, model: PRICED_AS }).complete({
      ...request,
      jsonSchema: REVIEW_SCHEMA,
    });
    // 10k input tokens at $4/M plus 1k output tokens at $20/M.
    expect(response).toEqual({
      text: '{"opinion":"looks-right"}',
      costUsd: 0.06,
      model: REVIEWER_MODEL,
    });
    expect(budget.spentUsd()).toBeCloseTo(0.06);
    expect(budget.heldUsd()).toBe(0);
    expect(calls[0]).toMatchObject({
      model: PRICED_AS,
      max_tokens: 8000,
      system: 'sys',
      messages: [{ role: 'user', content: 'review this' }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
    });
  });

  it('refuses before any request when the run cannot hold the worst case', async () => {
    const budget = createBudget(0.1);
    const { client, calls } = fakeAnthropic(() => message('never'));
    // 8000 output tokens at $20/M alone is $0.16, more than the $0.10 cap.
    await expect(
      anthropicModelClient({ budget, client, model: PRICED_AS }).complete(request),
    ).rejects.toBeInstanceOf(RunBudgetRefusal);
    expect(calls).toHaveLength(0);
    expect(budget.spentUsd()).toBe(0);
  });

  it('charges nothing for an error the API answered, and the whole hold for a dropped call', async () => {
    const answered = createBudget(1);
    const rejected = fakeAnthropic(() => {
      throw Object.assign(new Error('overloaded'), { status: 529 });
    });
    await expect(
      anthropicModelClient({
        budget: answered,
        client: rejected.client,
        model: PRICED_AS,
      }).complete(request),
    ).rejects.toThrow(/overloaded/);
    expect(answered.spentUsd()).toBe(0);

    const dropped = createBudget(1);
    const reset = fakeAnthropic(() => {
      throw new Error('socket hang up');
    });
    await expect(
      anthropicModelClient({ budget: dropped, client: reset.client, model: PRICED_AS }).complete(
        request,
      ),
    ).rejects.toThrow(/socket hang up/);
    expect(dropped.spentUsd()).toBeGreaterThan(0.16);
  });

  it('keeps a refusal as the reviewer’s words, charged like any reply', async () => {
    const budget = createBudget(1);
    const { client } = fakeAnthropic(() =>
      message('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }),
    );
    const response = await anthropicModelClient({ budget, client, model: PRICED_AS }).complete(
      request,
    );
    expect(response.text).toMatch(
      /declined to review this PR \(stop_reason refusal, category cyber\)/,
    );
    expect(parseReview(response.text).opinion).toBe('unsure');
    expect(budget.spentUsd()).toBeCloseTo(0.06);
  });

  it('serves the reviewer end to end: a real-shaped reply becomes an advisory review', async () => {
    const budget = createBudget(1);
    const { client } = fakeAnthropic(() =>
      message(
        JSON.stringify({
          opinion: 'has-concerns',
          summary: 'one call site missed',
          concerns: [{ file: 'src/a.ts', issue: 'still old', severity: 'high' }],
          checkFirst: ['src/a.ts'],
        }),
      ),
    );
    const ledger = new BudgetLedger(1);
    const review = await createReviewer(anthropicModelClient({ budget, client, model: PRICED_AS }))(
      {
        task,
        record,
        meter: ledger.meter('o/r'),
      },
    );
    expect(review).toMatchObject({ opinion: 'has-concerns', costUsd: 0.06, model: REVIEWER_MODEL });
    expect(ledger.spentUsd).toBeCloseTo(budget.spentUsd());
  });
});

describe('repo context for the reviewer', () => {
  function checkout() {
    const root = mkdtempSync(join(tmpdir(), 'aptitude-review-ctx-'));
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/pay.ts'), 'stripe.customers.create({ old_name })\n');
    writeFileSync(join(repo, 'src/hooks.ts'), 'read(old_name)\n');
    writeFileSync(join(repo, '.env'), 'STRIPE_SECRET_KEY=not-for-the-reviewer\n');
    writeFileSync(join(root, 'outside.ts'), 'outside the checkout\n');
    symlinkSync(join(root, 'outside.ts'), join(repo, 'src/link.ts'));
    return repo;
  }

  it('names the touched files, then the call-site files, without lockfiles or env files', () => {
    const touched = {
      ...record,
      diff: '--- a/src/pay.ts\n+++ b/src/pay.ts\n-x\n+y\n--- a/package-lock.json\n+++ b/package-lock.json\n--- a/.env\n+++ b/.env\n',
    };
    const withSites = {
      ...task,
      usages: [
        {
          ...task.usages[0]!,
          callSites: [
            { file: 'src/pay.ts', line: 12, operation: 'customers.create' },
            { file: 'src/hooks.ts', line: 3, operation: 'webhook' },
          ],
        },
      ],
    };
    expect(contextPaths(withSites, touched)).toEqual(['src/pay.ts', 'src/hooks.ts']);
  });

  it('reads files inside the checkout only, and never an env file', async () => {
    const repo = checkout();
    const files = await readContextFiles(repo, [
      'src/pay.ts',
      '../outside.ts',
      'src/link.ts',
      '.env',
      'src/missing.ts',
    ]);
    expect(files).toEqual([
      { path: 'src/pay.ts', content: 'stripe.customers.create({ old_name })\n' },
    ]);
  });

  it('keeps the context within its cap', async () => {
    const repo = checkout();
    for (const name of ['a', 'b', 'c', 'd'])
      writeFileSync(join(repo, `${name}.ts`), 'x'.repeat(14_000));
    const files = await readContextFiles(repo, ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const total = files.reduce((sum, file) => sum + file.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 100);
    expect(files.at(-1)?.content).toMatch(/truncated/);
  });

  it('shows the model the files next to the diff', async () => {
    const repo = checkout();
    const client = new FakeModelClient('{"opinion":"looks-right","summary":"ok","concerns":[]}');
    await createReviewer(client)({
      task,
      record,
      meter: new BudgetLedger(1).meter('o/r'),
      repoDir: repo,
    });
    const prompt = client.requests[0]?.prompt ?? '';
    expect(prompt).toContain('--- src/pay.ts');
    expect(prompt).toContain('stripe.customers.create({ old_name })');
    expect(prompt).not.toContain('not-for-the-reviewer');
    expect(buildReviewPrompt(task, record)).not.toContain('Repository files before the change');
  });
});
