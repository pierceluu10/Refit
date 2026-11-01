import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrationTask, ToolPack } from '../shared/types.ts';
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

function fixtureRepo(scripts: Record<string, string> = { test: 'node check.js' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'aptitude-fixture-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts }),
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

const finishMigrated = (call: Parameters<ScriptedTurn>[0]) =>
  call('finish', {
    verdict: 'migrated',
    summary: 'Replaced charges.create with paymentIntents.create.',
    why: 'The Charges API is being replaced by Payment Intents.',
    validators: [{ name: 'check_params', passed: true, detail: 'params accepted' }],
    unproven: [],
    behaviourChanges: [],
  });

const fixIt: ScriptedTurn = async (call) => {
  await call('write_file', {
    path: 'src/pay.js',
    content: ORIGINAL.replace('charges.create', 'paymentIntents.create'),
  });
  await call('stripe__check_params', { operation: 'paymentIntents.create' });
  await finishMigrated(call);
};

// Illustrative provider validator standing in for F2's ToolPack.
const toolPack: ToolPack = {
  provider: 'stripe',
  playbooks: {},
  tools: [
    {
      name: 'check_params',
      description: 'Check params against the API',
      inputSchema: { type: 'object', properties: { operation: { type: 'string' } } },
      run: async () => 'params valid for paymentIntents.create',
    },
  ],
};

const deps = (turns: ScriptedTurn[], budgetUsd = 1) => ({
  session: scriptedSession(turns),
  createSandbox: (dir: string) => createSandbox(dir, { mode: 'local' }),
  loadToolPack: async () => toolPack,
  budgetUsd,
  // A path that doesn't exist yet: runTask creates it.
  outDir: join(mkdtempSync(join(tmpdir(), 'aptitude-run-test-')), 'nested', 'out'),
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

  it('grades a validator the agent claims but never ran as needs-review', async () => {
    const claimOnly: ScriptedTurn = async (call) => {
      await call('write_file', {
        path: 'src/pay.js',
        content: ORIGINAL.replace('charges.create', 'paymentIntents.create'),
      });
      await finishMigrated(call);
    };
    const record = await runTask(task, fixtureRepo(), deps([claimOnly]));
    expect(record.outcome).toBe('needs-review');
    expect(record.prBody).toContain(
      'Validator check_params was claimed by the agent, but the harness recorded no call of it.',
    );
    expect(record.prBody).toContain('not proof');
  });

  it('counts a check the agent registers toward proof', async () => {
    const addVerify: ScriptedTurn = async (call) => {
      const output = await call('run_checks', {
        add: [{ name: 'verify', command: 'npm run verify' }],
      });
      expect(output).toContain('registered verify; on the original code it passes');
      await fixIt(call, {} as never);
    };
    const record = await runTask(task, fixtureRepo({ verify: 'node check.js' }), deps([addVerify]));
    expect(record.outcome).toBe('verified');
    expect(record.checks).toEqual([{ name: 'verify', before: 'pass', after: 'pass' }]);
  });

  it('shows a vacuous agent-added check verbatim instead of hiding it', async () => {
    const addTrue: ScriptedTurn = async (call) => {
      await call('run_checks', { add: [{ name: 'smoke', command: 'true' }] });
      await fixIt(call, {} as never);
    };
    const record = await runTask(task, fixtureRepo({}), deps([addTrue]));
    expect(record.outcome).toBe('verified');
    expect(record.agentChecks).toEqual([
      { name: 'smoke', command: 'true', before: 'pass', after: 'pass' },
    ]);
    expect(record.prBody).toContain('- smoke, added by the agent: `true` (pass → pass)');
  });

  it('ends when the agent finishes with an explanation of what is still failing', async () => {
    const explain: ScriptedTurn = async (call, input) => {
      await breakIt(call, input);
      await call('finish', {
        verdict: 'migrated',
        summary: 'Started the move to paymentIntents.create.',
        why: 'Charges is being replaced.',
        validators: [],
        unproven: ['The test fails because the fixture needs a live key.'],
        behaviourChanges: [],
      });
    };
    const record = await runTask(task, fixtureRepo(), deps([explain]));
    expect(record.outcome).toBe('needs-review');
    expect(record.costUsd).toBeCloseTo(0.01);
  });

  it('has no fixed iteration cap: it keeps going until the budget runs out', async () => {
    const record = await runTask(task, fixtureRepo(), deps([breakIt], 0.055));
    expect(record.costUsd).toBeCloseTo(0.06);
    expect(record.models).toEqual([MODEL, ESCALATION_MODEL]);
    expect(record.outcome).toBe('needs-review');
  });

  it('stops a loop of model calls that error without spending', async () => {
    let calls = 0;
    const record = await runTask(task, fixtureRepo(), {
      ...deps([]),
      session: async () => {
        calls++;
        return { finalText: '', stopReason: 'error' as const, error: 'auth failed' };
      },
    });
    expect(calls).toBe(3);
    expect(record.outcome).toBe('needs-review');
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
