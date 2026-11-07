import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExternalTask,
  MigrationKindMvp,
  MigrationTask,
  Recipe,
  ToolPack,
} from '../shared/types.ts';
import { upgradePlaybook } from '../providers/upgrades/index.ts';
import { runChecks } from './checks.ts';
import { scriptedSession, type ScriptedTurn } from './fake-session.ts';
import { ESCALATION_MODEL, MODEL, decideOutcome, runExternalTask, runTask } from './run.ts';
import { createSandbox, dockerAvailable } from './sandbox.ts';
import type { RuntimeRunner, Sandbox } from './types.ts';

const docker = await dockerAvailable();

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
  const dir = mkdtempSync(join(tmpdir(), 'refit-fixture-'));
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
  // The fake session's costs are exact, so no overshoot reserve is needed.
  turnReserveUsd: 0,
  // A path that doesn't exist yet: runTask creates it.
  outDir: join(mkdtempSync(join(tmpdir(), 'refit-run-test-')), 'nested', 'out'),
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
    expect(record.models).toEqual([MODEL, ESCALATION_MODEL]);
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
});

// Upgrades (MVP 2026-11-06). An illustrative fixture shaped like the demo-node-api sample repo:
// Node 18 everywhere, an old checkout action, a retired model id. Not a real customer repo.
function upgradeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refit-upgrade-fixture-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  const manifest = {
    name: 'demo-node-api-fixture',
    version: '1.0.0',
    type: 'module',
    engines: { node: '>=18' },
    scripts: { test: 'node check.js' },
    dependencies: { express: '^4.21.0', stripe: '^14.0.0', lodash: '4.17.20' },
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'demo-node-api-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'demo-node-api-fixture', version: '1.0.0' } },
    }),
  );
  writeFileSync(join(dir, '.nvmrc'), '18\n');
  writeFileSync(join(dir, 'Dockerfile'), 'FROM node:18-bookworm\nWORKDIR /app\nCOPY . .\n');
  writeFileSync(
    join(dir, '.github/workflows/ci.yml'),
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v2',
      '      - uses: actions/setup-node@v3',
      '        with:',
      '          node-version: 18',
      '      - run: npm test',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src/ai.js'),
    "export const MODEL = 'example-model-0613';\nexport const ask = (client, q) => client.chat({ model: MODEL, q });\n",
  );
  // The check passes on the default runtime, and on a switched runtime only when .nvmrc matches it,
  // so a runtime upgrade is proven only when every declared version moved.
  writeFileSync(
    join(dir, 'check.js'),
    `import { readFileSync } from 'node:fs';
const runtime = process.env.REFIT_FAKE_RUNTIME;
const nvmrc = readFileSync('.nvmrc', 'utf8').trim();
if (runtime && runtime !== 'node' + nvmrc) throw new Error('.nvmrc says ' + nvmrc + ' but checks ran on ' + runtime);
console.log('ok');
`,
  );
  return dir;
}

// No network in tests: installs and package-manager upgrades succeed without touching the registry.
async function offlineSandbox(dir: string): Promise<Sandbox> {
  const box = await createSandbox(dir, { mode: 'local' });
  return {
    ...box,
    exec: (command, options) =>
      /^npm (ci|install)\b/.test(command)
        ? Promise.resolve({
            code: 0,
            stdout: 'offline install (test stub)',
            stderr: '',
            timedOut: false,
          })
        : box.exec(command, options),
  };
}

const fakeRuntimes = (available = true): RuntimeRunner => ({
  runChecks: (sandbox, runtime, checks) =>
    runChecks(
      sandbox,
      checks.map(({ name, command }) => ({
        name,
        command: `REFIT_FAKE_RUNTIME=${runtime.name}${runtime.version} ${command}`,
      })),
    ),
  probe: async (_sandbox, runtime) =>
    available
      ? { ok: true, detail: `fake ${runtime.name} ${runtime.version}` }
      : { ok: false, detail: `${runtime.name} ${runtime.version} not available (fake)` },
});

function externalTask(
  kind: MigrationKindMvp | 'model-retirement',
  change: Partial<ExternalTask['change']> &
    Pick<ExternalTask['change'], 'dependency' | 'dependencyKind'>,
  version?: string,
): ExternalTask {
  return {
    id: `fixture-${kind}`,
    repo: 'example/demo-node-api',
    priority: 1,
    deadline: '2027-04-30',
    usages: [],
    change: {
      provider: change.dependency,
      id: `fixture-${kind}-change`,
      kind,
      title: `Illustrative ${kind} change for ${change.dependency}`,
      source: { url: 'https://example.com/illustrative-source', quote: 'An illustrative quote.' },
      affects: {},
      ...change,
    },
    dependencies: [
      {
        repo: 'example/demo-node-api',
        kind: change.dependencyKind,
        name: change.dependency,
        version,
        declaredIn: [{ file: 'package.json', line: 6 }],
      },
    ],
  };
}

const finishUpgrade = (call: Parameters<ScriptedTurn>[0], summary: string) =>
  call('finish', {
    verdict: 'migrated',
    summary,
    why: 'The illustrative change forces it.',
    validators: [],
    unproven: [],
    behaviourChanges: [],
  });

const upgradeDeps = (turns: ScriptedTurn[], extra: Record<string, unknown> = {}) => ({
  session: scriptedSession(turns),
  createSandbox: offlineSandbox,
  loadToolPack: async (provider: string) => ({ provider, tools: [], playbooks: {} }),
  loadUpgradeKit: async () => ({ tools: [], playbooks: {} }),
  runtimes: fakeRuntimes(),
  budgetUsd: 1,
  turnReserveUsd: 0,
  outDir: mkdtempSync(join(tmpdir(), 'refit-upgrade-out-')),
  ...extra,
});

type KindCase = {
  task: ExternalTask;
  turn: ScriptedTurn;
  diffHas: string[];
  title: string;
  runtime?: string;
};

const kindCases: Record<string, KindCase> = {
  'runtime-eol': {
    task: externalTask(
      'runtime-eol',
      { dependency: 'node', dependencyKind: 'runtime', fromVersions: ['18'], toVersion: '22' },
      '18',
    ),
    turn: async (call) => {
      await call('bump_version', { dependency: 'node', to: '22', apply: true });
      await call('run_checks', { runtime: { name: 'node', version: '22' } });
      await finishUpgrade(call, 'Moved Node 18 to 22 everywhere it is declared.');
    },
    diffHas: ['+22', '+FROM node:22-bookworm', '+          node-version: 22', '"node": ">=22"'],
    title: 'Upgrade node 18 → 22',
    runtime: 'node 22',
  },
  'framework-major': {
    task: externalTask(
      'framework-major',
      { dependency: 'express', dependencyKind: 'framework', toVersion: '5.1.0' },
      '4.21.0',
    ),
    turn: async (call) => {
      await call('upgrade_package', { package: 'express@5.1.0' });
      await call('bump_version', { dependency: 'express', to: '5.1.0', apply: true });
      await finishUpgrade(call, 'Moved express 4 to 5.');
    },
    diffHas: ['+    "express": "^5.1.0"'],
    title: 'Upgrade express 4.21.0 → 5.1.0',
  },
  'dependency-major': {
    task: externalTask(
      'dependency-major',
      { dependency: 'stripe', dependencyKind: 'sdk', toVersion: '17.0.0' },
      '14.0.0',
    ),
    turn: async (call) => {
      await call('bump_version', { dependency: 'stripe', to: '17.0.0', apply: true });
      await finishUpgrade(call, 'Moved stripe 14 to 17.');
    },
    diffHas: ['+    "stripe": "^17.0.0"'],
    title: 'Upgrade stripe 14.0.0 → 17.0.0',
  },
  'security-fix': {
    task: externalTask(
      'security-fix',
      {
        dependency: 'lodash',
        dependencyKind: 'library',
        toVersion: '4.17.21',
        severity: 'security',
      },
      '4.17.20',
    ),
    turn: async (call) => {
      await call('bump_version', { dependency: 'lodash', to: '4.17.21', apply: true });
      await finishUpgrade(call, 'Moved lodash to the fixed release.');
    },
    diffHas: ['+    "lodash": "4.17.21"'],
    title: 'Upgrade lodash 4.17.20 → 4.17.21',
  },
  'container-image-eol': {
    task: externalTask(
      'container-image-eol',
      {
        dependency: 'node:18-bookworm',
        dependencyKind: 'container-image',
        toVersion: '22-bookworm',
      },
      '18-bookworm',
    ),
    turn: async (call) => {
      await call('bump_version', { dependency: 'node', to: '22', apply: true });
      await finishUpgrade(call, 'Moved the base image and the runtime with it.');
    },
    diffHas: ['+FROM node:22-bookworm'],
    title: 'Upgrade node:18-bookworm 18-bookworm → 22-bookworm',
    runtime: 'node 22',
  },
  'ci-deprecation': {
    task: externalTask(
      'ci-deprecation',
      { dependency: 'actions/checkout', dependencyKind: 'ci', toVersion: 'v4' },
      'v2',
    ),
    turn: async (call) => {
      await call('bump_version', { dependency: 'actions/checkout', to: 'v4', apply: true });
      await finishUpgrade(call, 'Moved actions/checkout to v4.');
    },
    diffHas: ['+      - uses: actions/checkout@v4'],
    title: 'Upgrade actions/checkout v2 → v4',
  },
  'model-retirement': {
    task: externalTask(
      'model-retirement',
      {
        dependency: 'example-model-0613',
        dependencyKind: 'ai-model',
        toVersion: 'example-model-2',
      },
      undefined,
    ),
    turn: async (call) => {
      await call('edit_file', {
        path: 'src/ai.js',
        old: "'example-model-0613'",
        new: "'example-model-2'",
      });
      await finishUpgrade(call, 'Replaced the retired model id.');
    },
    diffHas: ["+export const MODEL = 'example-model-2';"],
    title: 'Illustrative model-retirement change for example-model-0613',
  },
};

describe('runExternalTask with a fake model, for every upgrade kind', () => {
  for (const [kind, c] of Object.entries(kindCases)) {
    it(`${kind}: edits, checks before and after, and writes the upgrade PR`, async () => {
      const record = await runExternalTask(c.task, upgradeRepo(), upgradeDeps([c.turn]));
      expect(record.outcome).toBe('verified');
      for (const line of c.diffHas) expect(record.diff).toContain(line);
      expect(record.prTitle).toBe(c.title);
      expect(record.prBody).toContain(`## ${c.title} [Verified]`);
      expect(record.prBody).toContain('Deadline: 2027-04-30');
      expect(record.prBody).toContain('Source: https://example.com/illustrative-source');
      expect(record.checks.find((check) => check.name === 'test')).toMatchObject({
        before: 'pass',
        after: 'pass',
      });
      expect(record.checksRuntime).toBe(c.runtime);
      if (c.runtime) expect(record.prBody).toContain(`after on ${c.runtime}`);
    });
  }

  it('catches a runtime bump that missed a declared place: the checks on the new runtime fail', async () => {
    const c = kindCases['runtime-eol'];
    const partial: ScriptedTurn = async (call) => {
      await call('bump_version', {
        dependency: 'node',
        to: '22',
        apply: true,
        places: ['Dockerfile:1'],
      });
      await finishUpgrade(call, 'Moved only the Dockerfile.');
    };
    const record = await runExternalTask(
      c.task,
      upgradeRepo(),
      upgradeDeps([partial], { maxIterations: 2 }),
    );
    expect(record.outcome).toBe('needs-review');
    expect(record.checks.find((check) => check.name === 'test')?.after).toMatch(/^fail/);
    expect(record.prBody).toContain('.nvmrc says 18 but checks ran on node22');
  });

  it('keeps an upgrade in needs-review, and says why, when the sandbox lacks the target runtime', async () => {
    const c = kindCases['runtime-eol'];
    const record = await runExternalTask(
      c.task,
      upgradeRepo(),
      upgradeDeps([c.turn], { runtimes: fakeRuntimes(false) }),
    );
    expect(record.outcome).toBe('needs-review');
    expect(record.checksRuntime).toBeUndefined();
    expect(record.prBody).toContain('The checks could not run on node 22 in this sandbox');
  });

  it('runs the baseline on the version the change leaves and the final checks on the new one', async () => {
    const c = kindCases['runtime-eol'];
    const ran: string[] = [];
    const fake = fakeRuntimes();
    const runtimes: RuntimeRunner = {
      ...fake,
      runChecks: (sandbox, runtime, checks) => {
        ran.push(runtime.version);
        return fake.runChecks(sandbox, runtime, checks);
      },
    };
    const record = await runExternalTask(
      c.task,
      upgradeRepo(),
      upgradeDeps([c.turn], { runtimes }),
    );
    expect(ran[0]).toBe('18');
    expect(ran.at(-1)).toBe('22');
    expect(record.baselineRuntime).toBe('node 18');
    expect(record.prBody).toContain('before on node 18 with the original code, after on node 22');
  });

  it('says the baseline stayed on the sandbox default when the old runtime is not available', async () => {
    const c = kindCases['runtime-eol'];
    const fake = fakeRuntimes();
    const runtimes: RuntimeRunner = {
      ...fake,
      probe: (sandbox, runtime) =>
        runtime.version === '18'
          ? Promise.resolve({ ok: false, detail: 'node 18 not available (fake)' })
          : fake.probe(sandbox, runtime),
    };
    const record = await runExternalTask(
      c.task,
      upgradeRepo(),
      upgradeDeps([c.turn], { runtimes }),
    );
    expect(record.outcome).toBe('verified');
    expect(record.baselineRuntime).toBeUndefined();
    expect(record.prBody).toContain('before on the sandbox default with the original code');
  });

  it('ends a change the code does not depend on as not-affected', async () => {
    const notAffected: ScriptedTurn = async (call) => {
      await call('finish', {
        verdict: 'not-affected',
        summary: 'No change.',
        why: 'This repo does not use the retired model.',
        validators: [],
        unproven: [],
        behaviourChanges: [],
      });
    };
    const record = await runExternalTask(
      kindCases['model-retirement'].task,
      upgradeRepo(),
      upgradeDeps([notAffected]),
    );
    expect(record.outcome).toBe('not-affected');
    expect(record.diff).toBe('');
  });

  it("gives the agent F2's real tools and the playbook for the task's kind and dependency", async () => {
    const requested: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(JSON.stringify([{ cycle: '22', eol: '2027-04-30', lts: '2024-10-29' }]));
    }) as typeof globalThis.fetch;
    let systemPrompt = '';
    const turn: ScriptedTurn = async (call, input) => {
      systemPrompt = input.systemPrompt;
      expect(await call('upgrades__end_of_life', { product: 'node', version: '18' })).toContain(
        '22',
      );
      await kindCases['runtime-eol'].turn(call, input);
    };
    const record = await runExternalTask(
      kindCases['runtime-eol'].task,
      upgradeRepo(),
      upgradeDeps([turn], { loadUpgradeKit: undefined, fetch }),
    );
    expect(requested).toEqual(['https://endoflife.date/api/nodejs.json']);
    expect(upgradePlaybook('runtime-eol', 'node').length).toBeGreaterThan(
      upgradePlaybook('runtime-eol').length,
    );
    expect(systemPrompt).toContain(
      `### Upgrade playbook: runtime-eol\n\n${upgradePlaybook('runtime-eol', 'node').trim()}`,
    );
    expect(record.prBody).toContain('`upgrades__end_of_life`: pass');
    expect(record.outcome).toBe('verified');
  });

  it('takes exactly what the orchestrator passes for an external task', async () => {
    const charged: number[] = [];
    const providers: string[] = [];
    const c = kindCases['framework-major'];
    const recipe = { id: 'illustrative-recipe' } as Recipe;
    const record = await runExternalTask(c.task, upgradeRepo(), {
      budgetUsd: 1,
      chargeRun: (usd) => charged.push(usd),
      loadToolPack: async (provider) => {
        providers.push(provider);
        return { provider, tools: [], playbooks: {} };
      },
      retrieveExternalRecipes: async (external) => (external.id === c.task.id ? [recipe] : []),
      // The rest stands in for the model and the registry; real runs leave them out.
      session: scriptedSession([c.turn]),
      createSandbox: offlineSandbox,
      turnReserveUsd: 0,
    });
    expect(record.outcome).toBe('verified');
    expect(charged).toEqual([0.01]);
    expect(record.costUsd).toBe(0.01);
    expect(providers).toEqual(['express']);
    expect(record.recipeIds).toEqual(['illustrative-recipe']);
  });

  it.skipIf(!docker)(
    'runs the after-checks in the target runtime image by default under Docker',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'refit-docker-runtime-'));
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node check.js' } }),
      );
      writeFileSync(join(dir, '.nvmrc'), '22\n');
      // Passes only on the node .nvmrc names, so a pass after the edit proves which image ran it.
      writeFileSync(
        join(dir, 'check.js'),
        `const want = 'v' + require('node:fs').readFileSync('.nvmrc', 'utf8').trim();
if (!process.version.startsWith(want + '.')) throw new Error(process.version + ' is not ' + want);
`,
      );
      const moveTo20: ScriptedTurn = async (call) => {
        await call('write_file', { path: '.nvmrc', content: '20\n' });
        await finishUpgrade(call, 'Moved Node 22 to 20 (illustrative).');
      };
      const record = await runExternalTask(
        externalTask(
          'runtime-eol',
          { dependency: 'node', dependencyKind: 'runtime', toVersion: '20' },
          '22',
        ),
        dir,
        upgradeDeps([moveTo20], {
          runtimes: undefined,
          createSandbox: (repo: string) => createSandbox(repo, { mode: 'docker' }),
        }),
      );
      expect(record.checks).toEqual([{ name: 'test', before: 'pass', after: 'pass' }]);
      expect(record.checksRuntime).toBe('node 20');
      expect(record.outcome).toBe('verified');
    },
    240_000,
  );

  it.each([
    ['failed', 'proof_check__proof_tls', 'tls: failed'],
    ['unknown', 'proof_check__proof_android_sdk', 'android-sdk: unknown'],
  ])(
    'keeps the run in needs-review when a real proof comes back %s',
    async (_verdict, tool, line) => {
      const turn: ScriptedTurn = async (call, input) => {
        await call('write_file', { path: 'nginx.conf', content: 'ssl_protocols TLSv1;\n' });
        expect((await call(tool, {})).split('\n')[0]).toContain(line);
        await kindCases['ci-deprecation'].turn(call, input);
      };
      const record = await runExternalTask(
        kindCases['ci-deprecation'].task,
        upgradeRepo(),
        upgradeDeps([turn]),
      );
      expect(record.outcome).toBe('needs-review');
      expect(record.prBody).toContain(`\`${tool}\`: fail`);
      expect(record.prBody).toContain(`Provider check ${tool} reported problems`);
    },
  );

  it('notes a secret in the diff in the PR, without printing it', async () => {
    const token = `ghp_${'a1'.repeat(20)}`;
    const turn: ScriptedTurn = async (call, input) => {
      await call('write_file', { path: 'config.js', content: `export const t = '${token}';\n` });
      await kindCases['ci-deprecation'].turn(call, input);
    };
    const record = await runExternalTask(
      kindCases['ci-deprecation'].task,
      upgradeRepo(),
      upgradeDeps([turn]),
    );
    expect(record.diff).not.toContain(token);
    expect(record.prBody).not.toContain(token);
    expect(record.prBody).toContain('A diff that adds a secret must not be committed as is.');
  });

  it('still runs API tasks through runTask unchanged', async () => {
    const record = await runTask(task, fixtureRepo(), deps([fixIt]));
    expect(record.outcome).toBe('verified');
    expect(record.prTitle).toBe(task.change.title);
    expect(record.checksRuntime).toBeUndefined();
  });
});
