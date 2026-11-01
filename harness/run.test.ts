import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrationTask } from '../shared/types.ts';
import { scriptedSession, type ScriptedTurn } from './fake-session.ts';
import { ESCALATION_MODEL, MODEL, runTask } from './run.ts';
import { createSandbox } from './sandbox.ts';

// Illustrative fixture task, not a real customer.
const task: MigrationTask = {
  id: 'fixture-stripe-charges',
  repo: 'example/fixture-shop',
  change: {
    provider: 'stripe',
    id: 'charges-to-payment-intents',
    kind: 'endpoint-removed',
    title: 'Move from the Charges API to Payment Intents',
    source: {
      url: 'https://docs.stripe.com/payments/payment-intents/migration',
      quote: 'Use the Payment Intents API instead of Charges.',
    },
    affects: { operations: ['charges.create'] },
  },
  usages: [
    {
      repo: 'example/fixture-shop',
      provider: 'stripe',
      via: 'sdk',
      callSites: [{ file: 'src/pay.js', line: 2, operation: 'charges.create' }],
    },
  ],
  priority: 1,
};

const ORIGINAL = `export function createPayment(stripe, amount) {
  return stripe.charges.create({ amount, currency: 'usd' });
}
`;

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aptitude-fixture-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node check.js' },
    }),
  );
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }),
  );
  writeFileSync(join(dir, 'src/pay.js'), ORIGINAL);
  writeFileSync(
    join(dir, 'check.js'),
    `import { createPayment } from './src/pay.js';
const echo = { create: (params) => params };
const result = createPayment({ charges: echo, paymentIntents: echo }, 500);
if (result.amount !== 500) throw new Error('amount lost');
console.log('ok');
`,
  );
  return dir;
}

const breakIt: ScriptedTurn = async (call) => {
  await call('edit_file', {
    path: 'src/pay.js',
    old: "stripe.charges.create({ amount, currency: 'usd' });",
    new: "stripe.paymentIntents.create({ amount, currency: 'usd' ;",
  });
};

const fixIt: ScriptedTurn = async (call) => {
  await call('write_file', {
    path: 'src/pay.js',
    content: ORIGINAL.replace('charges.create', 'paymentIntents.create'),
  });
  await call('finish', {
    verdict: 'migrated',
    summary: 'Replaced charges.create with paymentIntents.create.',
    why: 'The Charges API is being replaced by Payment Intents.',
    validators: [{ name: 'fixture check', passed: true, detail: 'node check.js passes' }],
    unproven: [],
    behaviourChanges: [],
  });
};

const deps = (turns: ScriptedTurn[], budgetUsd = 1) => ({
  session: scriptedSession(turns),
  createSandbox: (dir: string) => createSandbox(dir, { mode: 'local' }),
  budgetUsd,
  outDir: mkdtempSync(join(tmpdir(), 'aptitude-run-test-')),
});

describe('runTask with a fake model', () => {
  it('iterates on a new failure until the checks pass, then verifies', async () => {
    const record = await runTask(task, fixtureRepo(), deps([breakIt, fixIt]));
    expect(record.outcome).toBe('verified');
    expect(record.models).toEqual([MODEL]);
    expect(record.diff).toContain('+  return stripe.paymentIntents.create');
    expect(record.checks.find((check) => check.name === 'test')).toMatchObject({
      before: 'pass',
      after: 'pass',
    });
    expect(record.costUsd).toBeCloseTo(0.02);
    expect(record.prBody).toContain('Replaced charges.create');
    expect(readFileSync(record.transcriptPath, 'utf8')).toContain('"phase":"iteration"');
  });

  it('escalates to the bigger model when an iteration makes no progress', async () => {
    const record = await runTask(task, fixtureRepo(), deps([breakIt, async () => {}, fixIt]));
    expect(record.models).toEqual([MODEL, ESCALATION_MODEL]);
    expect(record.outcome).toBe('verified');
  });

  it('stops spending at the budget cap and still returns a needs-review record', async () => {
    const record = await runTask(task, fixtureRepo(), deps([breakIt], 0.005));
    expect(record.outcome).toBe('needs-review');
    expect(record.costUsd).toBeCloseTo(0.01);
    expect(record.diff).toContain('paymentIntents');
    expect(record.prBody).toContain('budget');
  });

  it('reports not-affected when the agent finds nothing to change', async () => {
    const notAffected: ScriptedTurn = async (call) => {
      await call('finish', {
        verdict: 'not-affected',
        summary: 'No change needed.',
        why: 'The repo does not call the removed endpoint.',
        validators: [],
        unproven: [],
        behaviourChanges: [],
      });
    };
    const record = await runTask(task, fixtureRepo(), deps([notAffected]));
    expect(record.outcome).toBe('not-affected');
    expect(record.diff).toBe('');
  });

  it('turns a crashing model call into a needs-review record instead of stopping', async () => {
    const record = await runTask(task, fixtureRepo(), {
      ...deps([]),
      session: async () => {
        throw new Error('model unavailable');
      },
      maxIterations: 2,
    });
    expect(record.outcome).toBe('needs-review');
    expect(record.models).toEqual([MODEL, ESCALATION_MODEL]);
  });
});
