import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrationTask, ToolPack } from '../shared/types.ts';
import { scriptedSession, type ScriptedTurn } from './fake-session.ts';
import {
  checksTouchChange,
  labelFix,
  repoTask,
  type DeadApiEntry,
  type Finding,
  type ScanResult,
} from './findings.ts';
import { ESCALATION_MODEL, MODEL, decideOutcome, runTask } from './run.ts';
import { createSandbox } from './sandbox.ts';
import type { Plan } from './prepare.ts';

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
    proofTest: 'test',
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
  planPreparation: async () => ({ steps: [], env: {}, reasoning: '' }),
  budgetUsd,
  // The fake session's costs are exact, so no overshoot reserve is needed.
  turnReserveUsd: 0,
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

  it('summarises every tool call and the checks after each iteration, for memory', async () => {
    const { outDir, ...rest } = deps([breakIt, fixIt]);
    const record = await runTask(task, fixtureRepo(), { ...rest, outDir });
    const lines = record.summary.split('\n');
    expect(lines[0]).toBe('# fixture-stripe-charges: verified, $0.0200');
    expect(lines).toContain('Baseline checks: test pass');
    expect(record.summary).toMatch(
      /## Iteration 1 \(claude-sonnet-5-5, done\)\n1\. edit_file path=src\/pay\.js .*→ edited src\/pay\.js \(1 replacement\)\nChecks after: test pass → fail \(1\) \(new: /,
    );
    expect(record.summary).toContain(
      '2. stripe__check_params operation=paymentIntents.create → params valid for paymentIntents.create',
    );
    expect(record.summary).toMatch(/1\. write_file path=src\/pay\.js content=<\d+ chars>/);
    expect(lines).toContain('Files changed: src/pay.js');
    expect(lines).toContain(
      'Verdict: migrated. Replaced charges.create with paymentIntents.create.',
    );
    expect(readFileSync(join(outDir, 'summary.md'), 'utf8')).toBe(record.summary);
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
        add: [{ name: 'test', command: 'npm run verify' }],
      });
      expect(output).toContain('registered test; on the original code it passes');
      await fixIt(call, {} as never);
    };
    const record = await runTask(task, fixtureRepo({ verify: 'node check.js' }), deps([addVerify]));
    expect(record.outcome).toBe('verified');
    expect(record.checks).toEqual([{ name: 'test', before: 'pass', after: 'pass' }]);
  });

  it('drops a check the agent added and gave up on, but never a detected one', async () => {
    const giveUp: ScriptedTurn = async (call) => {
      // Passes on the original code and fails after the edit: a new failure, until it is removed.
      await call('run_checks', {
        add: [
          { name: 'test', command: 'true' },
          { name: 'attempt', command: 'grep -q charges.create src/pay.js' },
        ],
      });
      const out = await call('run_checks', { remove: ['attempt', 'nope'] });
      expect(out).toContain('removed attempt');
      expect(out).toContain('nope was not removed');
      await fixIt(call, {} as never);
    };
    const record = await runTask(task, fixtureRepo({}), deps([giveUp]));
    expect(record.outcome).toBe('verified');
    expect(record.agentChecks.map((check) => check.name)).toEqual(['test']);
  });

  it('shows a vacuous agent-added check verbatim instead of hiding it', async () => {
    const addTrue: ScriptedTurn = async (call) => {
      await call('run_checks', { add: [{ name: 'test', command: 'true' }] });
      await fixIt(call, {} as never);
    };
    const record = await runTask(task, fixtureRepo({}), deps([addTrue]));
    expect(record.outcome).toBe('verified');
    expect(record.agentChecks).toEqual([
      { name: 'test', command: 'true', before: 'pass', after: 'pass' },
    ]);
    expect(record.prBody).toContain('- test, added by the agent: `true` (pass → pass)');
  });

  it('feeds a failure back once, then ends when the agent explains what still fails', async () => {
    const explain: ScriptedTurn = async (call, input) => {
      await breakIt(call, input);
      await call('finish', {
        verdict: 'migrated',
        summary: 'Started the move to paymentIntents.create.',
        why: 'Charges is being replaced.',
        validators: [],
        unproven: ['The test fails because the fixture needs a live key.'],
        behaviourChanges: [],
        noProofTestReason: 'The only test needs a live key.',
      });
    };
    const record = await runTask(task, fixtureRepo(), deps([explain]));
    expect(record.outcome).toBe('needs-review');
    expect(record.costUsd).toBeCloseTo(0.02);
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
    expect(record.outcome).toBe('failed');
  });

  it('escalates to the bigger model when an iteration makes no progress', async () => {
    const record = await runTask(task, fixtureRepo(), deps([breakIt, async () => {}, fixIt]));
    expect(record.models).toEqual([MODEL, ESCALATION_MODEL]);
    expect(record.outcome).toBe('verified');
  });

  it('stays on the first model when the checks pass and only the report is missing', async () => {
    const fixWithoutReport: ScriptedTurn = async (call) => {
      await call('write_file', {
        path: 'src/pay.js',
        content: ORIGINAL.replace('charges.create', 'paymentIntents.create'),
      });
    };
    const record = await runTask(
      task,
      fixtureRepo(),
      deps([fixWithoutReport, async () => {}, fixIt]),
    );
    expect(record.models).toEqual([MODEL]);
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

  it('records a crashing model call that changed nothing as failed, after retrying', async () => {
    const record = await runTask(task, fixtureRepo(), {
      ...deps([]),
      session: async () => {
        throw new Error('model unavailable');
      },
      maxIterations: 2,
    });
    expect(record.outcome).toBe('failed');
    expect(record.diff).toBe('');
    // Opus only after a failed check: a session that crashed is not one.
    expect(record.models).toEqual([MODEL]);
  });

  it('runs the agent’s own checks with the placeholder env', async () => {
    const addEnvCheck: ScriptedTurn = async (call) => {
      await call('run_checks', {
        add: [{ name: 'test', command: 'node -e "process.exit(process.env.X ? 0 : 1)"' }],
      });
      await fixIt(call, {} as never);
    };
    const record = await runTask(task, fixtureRepo({}), {
      ...deps([addEnvCheck]),
      planPreparation: async (): Promise<Plan> => ({ steps: [], env: { X: '1' }, reasoning: '' }),
    });
    expect(record.agentChecks[0]).toMatchObject({ name: 'test', before: 'pass', after: 'pass' });
    expect(record.outcome).toBe('verified');
  });

  it('plans again with the failing baseline in hand, and checks run with the placeholder env', async () => {
    const seen: string[] = [];
    const record = await runTask(
      task,
      fixtureRepo({ test: 'node -e "process.exit(process.env.WEBHOOK_SECRET ? 0 : 1)"' }),
      {
        ...deps([fixIt]),
        planPreparation: async (evidence): Promise<Plan> => {
          seen.push(evidence);
          return evidence.includes('failed before any edit')
            ? { steps: [], env: { WEBHOOK_SECRET: 'placeholder' }, reasoning: 'read at test time' }
            : { steps: [], env: {}, reasoning: '' };
        },
      },
    );
    expect(seen).toHaveLength(2);
    expect(record.checks[0]).toMatchObject({ name: 'test', before: 'pass', after: 'pass' });
    expect(record.prBody).toContain('Checks ran with placeholder env: WEBHOOK_SECRET.');
  });

  it('reports spend through chargeRun as it happens, even when the run then throws', async () => {
    const charges: [number, string][] = [];
    const run = runTask(task, fixtureRepo(), {
      ...deps([breakIt]),
      maxIterations: 1,
      chargeRun: (usd, label) => charges.push([usd, label]),
      createSandbox: async (dir: string) => ({
        ...(await createSandbox(dir, { mode: 'local' })),
        diff: async () => {
          throw new Error('git is broken');
        },
      }),
    });
    await expect(run).rejects.toThrow('git is broken');
    expect(charges).toEqual([[0.01, `harness ${MODEL}: fake turn 0`]]);
  });

  it('keeps a reserve below the cap: no query starts inside it and each gets the rest', async () => {
    const budgets: number[] = [];
    const record = await runTask(task, fixtureRepo(), {
      ...deps([]),
      budgetUsd: 1.5,
      turnReserveUsd: 1,
      session: async (input) => {
        budgets.push(input.budgetUsd);
        input.ledger.charge({ model: input.model, costUsd: 0.3, note: 'turn' });
        return { finalText: '', stopReason: 'done' as const };
      },
    });
    expect(budgets).toEqual([0.5, expect.closeTo(0.2)]);
    expect(record.costUsd).toBeCloseTo(0.6);
    expect(record.outcome).toBe('failed');
  });
});

describe('decideOutcome', () => {
  const report = {
    verdict: 'migrated' as const,
    summary: 'Moved to v2.',
    why: 'v1 is gone.',
    validators: [],
    unproven: [],
    behaviourChanges: [],
    proofTest: 'build',
  };
  const check = (ok: boolean) => ({
    name: 'build',
    command: 'npm run build',
    ok,
    output: '',
    failures: ok ? [] : ['Error: OPENAI_API_KEY is missing'],
  });
  const comparisons = [{ name: 'build', before: 'fail (1)', after: 'fail (1)', newFailures: [] }];
  const input = { diff: 'diff --git a/a.ts b/a.ts', report, comparisons, validatorRuns: [] };

  it('needs a check that passes: checks failing alike before and after prove nothing', () => {
    expect(decideOutcome({ ...input, after: [check(false)] })).toBe('needs-review');
    expect(decideOutcome({ ...input, after: [check(true), check(false)] })).toBe('verified');
  });

  it('needs the agent’s test of the change to pass, or a reason none can be written', () => {
    const untested = { ...report, proofTest: undefined };
    expect(decideOutcome({ ...input, report: untested, after: [check(true)] })).toBe(
      'needs-review',
    );
    expect(
      decideOutcome({
        ...input,
        report: { ...untested, noProofTestReason: 'only a CSS change' },
        after: [check(true)],
      }),
    ).toBe('verified');
    const failingTest = { ...check(false), name: 'change-test' };
    expect(
      decideOutcome({
        ...input,
        report: { ...report, proofTest: 'change-test' },
        after: [check(true), failingTest],
      }),
    ).toBe('needs-review');
  });

  it("is not verified while a provider check's latest call failed, even one the agent left out", () => {
    const failing = {
      tool: 'stripe__stripe_check_params',
      output: 'Unknown params',
      passed: false,
    };
    expect(decideOutcome({ ...input, after: [check(true)], validatorRuns: [failing] })).toBe(
      'needs-review',
    );
    const lookup = {
      tool: 'openai__openai_model_lookup',
      output: 'Status: deprecated',
      passed: false,
    };
    expect(decideOutcome({ ...input, after: [check(true)], validatorRuns: [lookup] })).toBe(
      'verified',
    );
  });

  it('verifies a proven change the agent still lists caveats for: those go to the PR', () => {
    const caveats = { ...report, unproven: ['The Dashboard webhook version is not checked.'] };
    expect(decideOutcome({ ...input, report: caveats, after: [check(true)] })).toBe('verified');
  });
});

describe('a repo session', () => {
  const entry: DeadApiEntry = {
    id: 'stripe-charges',
    provider: 'stripe',
    what: 'the Charges API',
    diedOn: '2026-01-01',
    source: { url: 'https://example.com/changelog', checkedOn: '2026-11-04' },
    lookFor: ['charges.create'],
    replacement: 'paymentIntents.create',
    requires: [],
  };
  const live = (file: string, line = 2): Finding => ({
    entryId: entry.id,
    file,
    line,
    matchClass: 'live',
  });
  const scanOf = (findings: Finding[]): ScanResult => ({
    findings,
    unlistedProviders: [],
    clean: findings.length === 0,
  });
  const repoTaskFor = (findings: Finding[]) =>
    repoTask('example/fixture-shop', scanOf(findings), [entry]);
  // What a scan of the working copy finds: the dead call, in src/pay.js, until it's gone.
  const rescan = async (dir: string) =>
    scanOf(
      readFileSync(join(dir, 'src/pay.js'), 'utf8').includes('charges') ? [live('src/pay.js')] : [],
    );
  const fix: ScriptedTurn = async (call) => {
    await call('edit_file', {
      path: 'src/pay.js',
      old: 'stripe.charges.create',
      new: 'stripe.paymentIntents.create',
    });
  };
  const finish =
    (extra: Record<string, unknown> = {}): ScriptedTurn =>
    async (call) => {
      await call('finish', {
        verdict: 'migrated',
        summary: 'Moved to paymentIntents.create.',
        why: 'Charges died.',
        validators: [],
        unproven: [],
        behaviourChanges: [],
        noProofTestReason: 'A smoke fixture.',
        ...extra,
      });
    };
  const both =
    (...turns: ScriptedTurn[]): ScriptedTurn =>
    async (call, input) => {
      for (const turn of turns) await turn(call, input);
    };

  it('labels a clean rescan with checks no worse as fixed, and says what it proves', async () => {
    const record = await runTask(repoTaskFor([live('src/pay.js')]), fixtureRepo(), {
      ...deps([both(fix, finish({ personMustDo: ['Set STRIPE_PRICE_ID.'] }))]),
      rescan,
    });
    expect(record.outcome).toBe('verified');
    expect(record.prBody).toContain('[Fixed]');
    expect(record.prBody).toContain('### What died');
    expect(record.prBody).toContain('https://example.com/changelog');
    expect(record.prBody).toContain(
      'A clean rescan shows the dead thing is gone, not that a live call succeeds.',
    );
    expect(record.prBody).toContain('Set STRIPE_PRICE_ID.');
  });

  it('sends what the rescan still finds back to the session', async () => {
    const seen: string[] = [];
    const record = await runTask(repoTaskFor([live('src/pay.js')]), fixtureRepo(), {
      ...deps([]),
      session: scriptedSession([
        async (call, input) => {
          seen.push(input.prompt);
          await finish()(call, input);
        },
        async (call, input) => {
          seen.push(input.prompt);
          await both(fix, finish())(call, input);
        },
      ]),
      rescan,
    });
    expect(seen[1]).toContain('stripe-charges at src/pay.js:2');
    expect(record.outcome).toBe('verified');
  });

  it("calls it couldn't fix when every use is still there", async () => {
    const edit: ScriptedTurn = async (call) => {
      await call('write_file', { path: 'README.md', content: 'notes' });
    };
    const record = await runTask(repoTaskFor([live('src/pay.js')]), fixtureRepo(), {
      ...deps([both(edit, finish())]),
      rescan,
    });
    expect(record.outcome).toBe('failed');
    expect(record.note).toContain('still finds 1 of 1');
  });

  it('calls a partly clean rescan needs a look', () => {
    const label = labelFix({
      findings: [live('a.js'), live('b.js')],
      rescan: scanOf([live('b.js')]),
      newFailures: 0,
      changed: true,
      touched: true,
    });
    expect(label).toEqual({
      outcome: 'needs-review',
      reason: 'Partly clean: the rescan still finds 1 of 2 uses.',
    });
  });

  it("calls new failures couldn't fix, even with a clean rescan", () => {
    const label = labelFix({
      findings: [live('a.js')],
      rescan: scanOf([]),
      newFailures: 2,
      changed: true,
      touched: true,
    });
    expect(label.outcome).toBe('failed');
  });

  it('calls a clean rescan needs a look when no passing check touches the change', () => {
    const label = labelFix({
      findings: [live('a.py')],
      rescan: scanOf([]),
      newFailures: 0,
      changed: true,
      touched: checksTouchChange(['a.py'], ['typecheck', 'build'], undefined),
    });
    expect(label.outcome).toBe('needs-review');
  });

  it('counts a passing proof test, or a check in the language that changed', () => {
    expect(checksTouchChange(['a.py'], ['proof'], 'proof')).toBe(true);
    expect(checksTouchChange(['a.py'], ['pytest'], undefined)).toBe(true);
    expect(checksTouchChange(['a.ts'], ['build'], undefined)).toBe(true);
    expect(checksTouchChange(['config.yaml'], ['build'], undefined)).toBe(false);
  });
});
