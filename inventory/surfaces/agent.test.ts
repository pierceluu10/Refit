import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DependencyUsage } from '../../shared/types.ts';
import { BudgetConfigError, BudgetExceededError, BudgetLedger } from '../budget.ts';
import {
  agentOptions,
  CALL_RESERVE_USD,
  createInventorySurfaces,
  inventorySurfaces,
  MAIN_MODEL,
  runSurfaceInventory,
  SPECIALIST_MODEL,
  SurfaceRunError,
} from './agent.ts';
import { DEMO_NEXT_WEB, DEMO_NODE_API, DEMO_PYTHON_APP, lineOf } from './fixtures.ts';
import type { FixtureRepo } from './fixtures.ts';
import { SPECIALISTS } from './prompt.ts';
import { fakeModel, fakeResult, makeRepo, removeRepo } from './test-fixtures.ts';
import type { ScriptedCall } from './test-fixtures.ts';
import { readTools } from './tools.ts';

const dirs: Record<string, string> = {};
let scratch: string;
beforeAll(async () => {
  for (const fixture of [DEMO_NODE_API, DEMO_PYTHON_APP, DEMO_NEXT_WEB]) {
    dirs[fixture.repo] = await makeRepo(fixture.files);
  }
  scratch = await makeRepo({ 'keep.txt': '' });
});
afterAll(async () => {
  for (const dir of [...Object.values(dirs), scratch]) await removeRepo(dir);
});

const ledger = () => new BudgetLedger({ capUsd: 3 });

function record(
  fixture: FixtureRepo,
  surface: {
    kind: string;
    name: string;
    ecosystem?: string;
    version?: string;
    at: [string, string][];
    notes: string;
  },
): ScriptedCall {
  const { at, ...rest } = surface;
  return {
    tool: 'record_surface',
    input: {
      ...rest,
      locations: at.map(([file, needle]) => ({ file, line: lineOf(fixture, file, needle) })),
    },
  };
}

const find = (surfaces: DependencyUsage[], name: string) =>
  surfaces.find((surface) => surface.name === name);

describe('runSurfaceInventory with a fake model on the sample repos', () => {
  it('demo-node-api: the removed Ingress API, the retired Lambda runtime and the chatbot', async () => {
    const fixture = DEMO_NODE_API;
    const budget = ledger();
    const { runner, outputs } = fakeModel([
      { tool: 'find_surface_leads', input: {} },
      { tool: 'read_file', input: { path: 'k8s/ingress.yaml' } },
      record(fixture, {
        kind: 'infrastructure',
        name: 'kubernetes Ingress',
        ecosystem: 'kubernetes',
        version: 'extensions/v1beta1',
        at: [
          ['k8s/ingress.yaml', 'apiVersion'],
          ['k8s/ingress.yaml', 'kind: Ingress'],
        ],
        notes:
          'Ingress on extensions/v1beta1, removed in Kubernetes 1.22; needs networking.k8s.io/v1 and the new backend shape.',
      }),
      record(fixture, {
        kind: 'infrastructure',
        name: 'kubernetes Deployment',
        ecosystem: 'kubernetes',
        version: 'apps/v1',
        at: [['k8s/deployment.yaml', 'apiVersion']],
        notes: 'apps/v1 Deployment is current; listed so cluster upgrades can be checked.',
      }),
      record(fixture, {
        kind: 'infrastructure',
        name: 'aws-lambda',
        ecosystem: 'aws',
        version: 'nodejs16.x',
        at: [
          ['serverless.yml', 'runtime:'],
          ['serverless.yml', 'handler'],
        ],
        notes: 'Serverless Framework function on nodejs16.x, a Lambda runtime AWS has deprecated.',
      }),
      record(fixture, {
        kind: 'regulated-surface',
        name: 'ai-chatbot',
        ecosystem: 'openai',
        at: [
          ['src/server.js', "app.post('/chat'"],
          ['src/server.js', 'model:'],
        ],
        notes:
          'End users chat with an OpenAI model; the EU AI Act transparency duty may require telling them it is an AI. Nothing in the response says so.',
      }),
    ]);
    const report = await runSurfaceInventory(dirs[fixture.repo], fixture.repo, {
      ledger: budget,
      runner,
    });

    expect(outputs[0]).toContain('k8s/ingress.yaml:1: apiVersion: extensions/v1beta1');
    expect(report.outcome).toBe('success');
    expect(report.errors).toEqual([]);
    expect(report.surfaces.map((surface) => surface.kind)).toEqual([
      'infrastructure',
      'infrastructure',
      'infrastructure',
      'regulated-surface',
    ]);
    expect(find(report.surfaces, 'kubernetes Ingress')).toEqual({
      repo: fixture.repo,
      kind: 'infrastructure',
      name: 'kubernetes Ingress',
      ecosystem: 'kubernetes',
      version: 'extensions/v1beta1',
      declaredIn: [
        { file: 'k8s/ingress.yaml', line: 1, text: 'apiVersion: extensions/v1beta1' },
        { file: 'k8s/ingress.yaml', line: 2, text: 'kind: Ingress' },
      ],
      notes: expect.stringContaining('removed in Kubernetes 1.22'),
    });
    expect(find(report.surfaces, 'aws-lambda')?.declaredIn[0].text).toBe('runtime: nodejs16.x');
    expect(report.summary).toContain('[infrastructure] aws-lambda nodejs16.x: serverless.yml:');
    expect(budget.spentUsd).toBeCloseTo(0.03);
  });

  it('demo-python-app: the Stripe charge flow and its checkout page', async () => {
    const fixture = DEMO_PYTHON_APP;
    const { runner } = fakeModel([
      { tool: 'find_surface_leads', input: { area: 'regulated' } },
      record(fixture, {
        kind: 'regulated-surface',
        name: 'checkout',
        ecosystem: 'stripe',
        at: [
          ['app.py', '@app.route("/checkout"'],
          ['app.py', 'stripe.Charge.create'],
          ['templates/checkout.html', 'js.stripe.com/v2'],
          ['templates/checkout.html', 'data-stripe="number"'],
        ],
        notes:
          'Card payments in EUR through the legacy Charges API and Stripe.js v2 with card fields on the page: no 3-D Secure, so SCA under PSD2 applies; PCI DSS 4.0 script rules apply to the checkout page.',
      }),
      record(fixture, {
        kind: 'regulated-surface',
        name: 'checkout-form',
        ecosystem: 'web',
        at: [
          ['templates/checkout.html', 'type="email"'],
          ['templates/checkout.html', 'Card number'],
        ],
        notes:
          'Inputs have placeholders but no labels (WCAG 1.3.1, 3.3.2); the page has no lang attribute.',
      }),
    ]);
    const report = await runSurfaceInventory(dirs[fixture.repo], fixture.repo, {
      ledger: ledger(),
      runner,
    });
    expect(report.surfaces).toHaveLength(2);
    expect(find(report.surfaces, 'checkout')?.declaredIn.map((place) => place.file)).toEqual([
      'app.py',
      'app.py',
      'templates/checkout.html',
      'templates/checkout.html',
    ]);
    expect(find(report.surfaces, 'checkout')?.notes).toContain('SCA');
  });

  it('demo-next-web: checkout, cookie banner, signup form and browser targets', async () => {
    const fixture = DEMO_NEXT_WEB;
    const { runner, outputs } = fakeModel([
      { tool: 'find_surface_leads', input: {} },
      record(fixture, {
        kind: 'regulated-surface',
        name: 'checkout',
        ecosystem: 'stripe',
        at: [
          ['pages/checkout.tsx', 'redirectToCheckout'],
          ['pages/checkout.tsx', 'googletagmanager'],
          ['pages/checkout.tsx', '<div onClick={pay}>'],
        ],
        notes:
          'Stripe Checkout redirect; a Google Tag Manager script loads on the payment page (PCI DSS 4.0 6.4.3 script inventory); the pay control is a div, not a button.',
      }),
      record(fixture, {
        kind: 'regulated-surface',
        name: 'cookie-consent',
        ecosystem: 'web',
        at: [
          ['components/CookieBanner.tsx', 'document.cookie'],
          ['components/CookieBanner.tsx', "gtag?.('config'"],
          ['pages/_app.tsx', '<CookieBanner />'],
        ],
        notes:
          'Sets an analytics cookie and starts gtag before the visitor chooses; GDPR and ePrivacy want consent first. The banner has no reject option.',
      }),
      record(fixture, {
        kind: 'regulated-surface',
        name: 'signup-form',
        ecosystem: 'web',
        at: [
          ['pages/signup.tsx', '<img'],
          ['pages/signup.tsx', 'type="email"'],
          ['pages/signup.tsx', 'name="birthday"'],
          ['pages/signup.tsx', 'Create account'],
        ],
        notes:
          'Collects email, password and birthday. Image without alt, inputs without labels, a div used as the submit button (WCAG 1.1.1, 1.3.1, 2.1.1; European Accessibility Act).',
      }),
      record(fixture, {
        kind: 'platform',
        name: 'web-browser-targets',
        ecosystem: 'browserslist',
        version: 'defaults, ie 11',
        at: [
          ['package.json', '"browserslist"'],
          ['package.json', '"ie 11"'],
        ],
        notes: 'Targets Internet Explorer 11, which Microsoft retired and Next.js 13 dropped.',
      }),
      { tool: 'list_recorded_surfaces', input: {} },
    ]);
    const report = await runSurfaceInventory(dirs[fixture.repo], fixture.repo, {
      ledger: ledger(),
      runner,
    });
    expect(JSON.parse(outputs.at(-1) as string)).toHaveLength(4);
    expect(report.surfaces.map((surface) => surface.name)).toEqual([
      'web-browser-targets',
      'checkout',
      'cookie-consent',
      'signup-form',
    ]);
    const cookie = find(report.surfaces, 'cookie-consent');
    expect(cookie?.declaredIn.map((place) => place.file)).toEqual([
      'components/CookieBanner.tsx',
      'components/CookieBanner.tsx',
      'pages/_app.tsx',
    ]);
    expect(find(report.surfaces, 'signup-form')?.declaredIn).toContainEqual({
      file: 'pages/signup.tsx',
      line: lineOf(fixture, 'pages/signup.tsx', '<img'),
      text: '<img src="/logo.png" />',
    });
  });
});

describe('agent wiring', () => {
  it('gives the main agent and three specialists read and record tools only', async () => {
    const { runner, requests } = fakeModel([]);
    await runSurfaceInventory(dirs[DEMO_NODE_API.repo], DEMO_NODE_API.repo, {
      ledger: ledger(),
      runner,
      runCapUsd: 0.5,
    });
    const options = requests[0].options;
    expect(options.model).toBe(MAIN_MODEL);
    expect(options.cwd).toBe(dirs[DEMO_NODE_API.repo]);
    expect(options.tools).toEqual(['Agent']);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.maxBudgetUsd).toBeCloseTo(0.5 - CALL_RESERVE_USD);
    expect(Object.keys(options.agents ?? {})).toEqual(Object.keys(SPECIALISTS));
    for (const specialist of Object.values(options.agents ?? {})) {
      expect(specialist.model).toBe(SPECIALIST_MODEL);
      expect(specialist.tools).toContain('mcp__surfaces__record_surface');
      expect(specialist.tools).not.toContain('mcp__surfaces__remove_surface');
    }
    const names = requests[0].tools.map((surfaceTool) => surfaceTool.name);
    expect(names).toEqual([
      'list_files',
      'read_file',
      'grep',
      'find_surface_leads',
      'record_surface',
      'list_recorded_surfaces',
      'remove_surface',
    ]);
    expect(options.allowedTools?.some((name) => /write|edit|bash/i.test(name))).toBe(false);
  });

  it('keeps the run cap under what the ledger has left', () => {
    const tools = readTools(scratch);
    expect(agentOptions(scratch, tools, 0.2).maxBudgetUsd).toBe(0.2);
  });

  it('read tools stay inside the repository', async () => {
    const { runner, outputs } = fakeModel([
      { tool: 'read_file', input: { path: '../../etc/passwd' } },
    ]);
    await runSurfaceInventory(scratch, 'acme/scratch', { ledger: ledger(), runner });
    expect(outputs[0]).toContain('OutsideRepoError');
  });
});

describe('budget and failures', () => {
  it('refuses to spend without REFIT_AI_BUDGET_USD', async () => {
    const saved = process.env.REFIT_AI_BUDGET_USD;
    delete process.env.REFIT_AI_BUDGET_USD;
    try {
      await expect(inventorySurfaces(scratch, 'acme/scratch')).rejects.toBeInstanceOf(
        BudgetConfigError,
      );
    } finally {
      if (saved !== undefined) process.env.REFIT_AI_BUDGET_USD = saved;
    }
  });

  it('refuses a run once the ledger is spent', async () => {
    const { runner, requests } = fakeModel([]);
    const spent = new BudgetLedger({ capUsd: 3, spentUsd: 3 });
    await expect(
      runSurfaceInventory(scratch, 'acme/scratch', { ledger: spent, runner }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(requests).toHaveLength(0);
  });

  it('keeps what was recorded when the run crashes, and says why', async () => {
    const fixture = DEMO_NODE_API;
    const { runner } = fakeModel(
      [
        record(fixture, {
          kind: 'infrastructure',
          name: 'aws-lambda',
          version: 'nodejs16.x',
          at: [['serverless.yml', 'runtime:']],
          notes: 'Deprecated Lambda runtime.',
        }),
      ],
      new Error('socket hang up'),
    );
    const report = await runSurfaceInventory(dirs[fixture.repo], fixture.repo, {
      ledger: ledger(),
      runner,
    });
    expect(report.outcome).toBe('no-result');
    expect(report.errors).toEqual(['The agent run stopped: socket hang up']);
    expect(report.surfaces).toHaveLength(1);
    expect(report.summary).toContain('1 surface (no-result)');
  });

  it('reports a budget stop from the SDK as an error, not as an empty repo', async () => {
    const { runner } = fakeModel(
      [],
      fakeResult({ subtype: 'error_max_budget_usd', errors: ['Reached maximum budget'] } as never),
    );
    const report = await runSurfaceInventory(scratch, 'acme/scratch', { ledger: ledger(), runner });
    expect(report.errors).toEqual(['Reached maximum budget']);
    expect(report.agentSummary).toBe('Reached maximum budget');
  });

  it('the entry point throws when a failed run found nothing, and returns partial results', async () => {
    const failed = createInventorySurfaces({
      ledger: ledger(),
      runner: fakeModel([], new Error('socket hang up')).runner,
    });
    await expect(failed(scratch, 'acme/scratch')).rejects.toBeInstanceOf(SurfaceRunError);

    const partial = createInventorySurfaces({
      ledger: ledger(),
      runner: fakeModel(
        [
          record(DEMO_NODE_API, {
            kind: 'infrastructure',
            name: 'aws-lambda',
            at: [['serverless.yml', 'runtime:']],
            notes: 'Deprecated Lambda runtime.',
          }),
        ],
        new Error('socket hang up'),
      ).runner,
    });
    expect(await partial(dirs[DEMO_NODE_API.repo], DEMO_NODE_API.repo)).toHaveLength(1);
  });

  it('records spend in the shared log so parallel runs see it', async () => {
    const logPath = path.join(scratch, 'spend.jsonl');
    const shared = await BudgetLedger.open({ capUsd: 3, logPath });
    await runSurfaceInventory(scratch, 'acme/scratch', {
      ledger: shared,
      runner: fakeModel([]).runner,
    });
    const entries = (await readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(entries.at(-1).cumulativeUsd).toBeCloseTo(0.03);
  });
});
