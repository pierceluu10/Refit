import { describe, expect, it } from 'vitest';
import type { MigrationTask } from '../shared/types.ts';
import { filesFromDiff, writePrBody, type PrBodyInput } from './pr.ts';

// Illustrative fixture, not a real customer repo. The key is fake but matches Stripe's shape.
const fakeKey = 'sk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2';

const task: MigrationTask = {
  id: 'task-1',
  repo: 'example/shop',
  priority: 1,
  change: {
    provider: 'stripe',
    id: 'stripe-2026-10',
    kind: 'field-renamed',
    title: 'Charge.source renamed to Charge.payment_source',
    source: { url: 'https://example.com/changelog#source', quote: 'The source field is renamed.' },
    affects: { fields: ['source'] },
  },
  usages: [],
};

const diff = [
  'diff --git a/src/pay.ts b/src/pay.ts',
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  `-const key = '${fakeKey}';`,
  'diff --git a/src/old.ts b/src/new.ts',
  'rename from src/old.ts',
  'diff --git a/src/pay.ts b/src/pay.ts',
].join('\n');

const base: PrBodyInput = {
  task,
  outcome: 'needs-review',
  report: {
    verdict: 'migrated',
    summary: 'Renamed source to payment_source in charges.create.',
    why: `The API removes source. Old key was ${fakeKey}.`,
    validators: [
      { name: 'openapi-params', passed: true, detail: 'params match 2026-10-01' },
      { name: 'live-call', passed: false, detail: 'no test key' },
    ],
    unproven: ['Webhook handler not exercised.'],
    behaviourChanges: [],
  },
  comparisons: [
    { name: 'typecheck', before: 'pass', after: 'pass', newFailures: [] },
    {
      name: 'test',
      before: 'fail (1 failure)',
      after: 'fail (2 failures)',
      newFailures: ['pay.test.ts > charges'],
    },
    { name: 'build', before: 'pass', after: 'not run', newFailures: [] },
  ],
  validatorRuns: [
    { tool: 'stripe__openapi-params', output: 'params match 2026-10-01', passed: true },
    { tool: 'stripe__live-call', output: 'no test key', passed: false },
  ],
  diff,
  costUsd: 0.123456,
  models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
  promptVersion: 'harness-prompt/2026-11-01.1',
  sandboxNote: 'Docker container, network off',
};

describe('filesFromDiff', () => {
  it('lists each touched file once, using the new path', () => {
    expect(filesFromDiff(diff)).toEqual(['src/pay.ts', 'src/new.ts']);
    expect(filesFromDiff('')).toEqual([]);
  });
});

describe('writePrBody', () => {
  const body = writePrBody(base);

  it('has the title, badge and five sections in order', () => {
    expect(
      body.startsWith('## Charge.source renamed to Charge.payment_source [Needs review]'),
    ).toBe(true);
    const headings = [
      '### Change',
      '### Why',
      '### Proof',
      '### Unproven',
      '### Behaviour changes',
    ];
    const positions = headings.map((heading) => body.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('shows the change, why, proof and footer', () => {
    expect(body).toContain('Renamed source to payment_source');
    expect(body).toContain('`src/pay.ts`');
    expect(body).toContain('> The source field is renamed.');
    expect(body).toContain('https://example.com/changelog#source');
    expect(body).toContain('| test | fail (1 failure) | fail (2 failures) | 1 |');
    expect(body).toContain('New failures: 1');
    expect(body).toContain('openapi-params: pass');
    expect(body).toContain('live-call: fail');
    expect(body).toContain('Where checks ran: Docker container, network off');
    expect(body).toContain('None intended.');
    expect(body).toContain('harness-prompt/2026-11-01.1');
    expect(body).toContain('claude-sonnet-5-5, claude-opus-5-5');
    expect(body).toContain('$0.1235');
  });

  it('adds new failures, missing checks, failing validators and old failures to Unproven', () => {
    const unproven = body.slice(
      body.indexOf('### Unproven'),
      body.indexOf('### Behaviour changes'),
    );
    expect(unproven).toContain('Webhook handler not exercised.');
    expect(unproven).toContain('test: new failure `pay.test.ts > charges`');
    expect(unproven).toContain('build was not run after the change.');
    expect(unproven).toContain('Validator live-call failed: no test key');
    expect(unproven).toContain('test was already failing before the change and still fails.');
    expect(unproven).not.toContain('typecheck');
    expect(unproven).not.toContain('Nothing known.');
  });

  it('flags a missing report and missing checks', () => {
    const bare = writePrBody({ ...base, outcome: 'failed', report: undefined, comparisons: [] });
    expect(bare).toContain('[Failed]');
    expect(bare).toContain('The agent did not call finish');
    expect(bare).toContain('No checks were run.');
    expect(bare).toContain('No provider validator was run.');
  });

  it('says "Nothing known." only when nothing is unproven', () => {
    const clean = writePrBody({
      ...base,
      outcome: 'verified',
      report: {
        ...base.report!,
        unproven: [],
        validators: [{ name: 'v', passed: true, detail: '' }],
      },
      validatorRuns: [{ tool: 'stripe__v', output: 'ok', passed: true }],
      comparisons: [{ name: 'test', before: 'pass', after: 'pass', newFailures: [] }],
    });
    expect(clean).toContain('[Verified]');
    expect(clean).toContain('### Unproven\n\nNothing known.');
  });

  it('redacts secrets and has no attribution text', () => {
    expect(body).not.toContain(fakeKey);
    expect(body).toContain('[redacted]');
    expect(body).not.toMatch(/generated with|co-authored-by|claude code/i);
  });
});
