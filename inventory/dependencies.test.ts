import { afterEach, describe, expect, it } from 'vitest';
import { CALL_RESERVE_USD } from './agent.ts';
import { BudgetExceededError, BudgetLedger } from './budget.ts';
import { DEFAULT_DEPENDENCY_RUN_CAP_USD, runDependencyInventory } from './dependencies.ts';
import type { DependencyOptions } from './dependencies.ts';
import { scannerGap } from './evaluation/scanner-gap.ts';
import { AREA_READER, DEPENDENCY_PROMPT_VERSION } from './prompt.ts';
import { DEMO_NEXT_WEB, DEMO_NODE_API, DEMO_PYTHON_APP, MONOREPO } from './sample-repos.ts';
import type { RepoFiles } from './sample-repos.ts';
import { fakeModel, fakeResult, makeRepo, removeRepo } from './test-fixtures.ts';
import type { ScriptedCall } from './test-fixtures.ts';

const noSurfaces = async () => [];
const repos: string[] = [];

async function repoWith(files: RepoFiles): Promise<string> {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return repoDir;
}

function record(...dependencies: Record<string, unknown>[]): ScriptedCall {
  return { tool: 'record_dependencies', input: { dependencies } };
}

async function run(files: RepoFiles, calls: ScriptedCall[], options: DependencyOptions = {}) {
  const repoDir = await repoWith(files);
  const model = fakeModel(calls);
  const report = await runDependencyInventory(repoDir, 'refit-dev/sample', {
    ledger: new BudgetLedger({ capUsd: 5 }),
    surfaces: noSurfaces,
    runner: model.runner,
    ...options,
  });
  console.log(JSON.stringify(report.dependencies, null, 1));
  return { report, repoDir, ...model };
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
});

describe('runDependencyInventory with a fake model', () => {
  it('keeps every checked declaration with its real line text, and rejects wrong lines', async () => {
    const { report, outputs } = await run(DEMO_NODE_API, [
      record({
        kind: 'runtime',
        name: 'node',
        ecosystem: 'node',
        version: '18',
        declaredIn: [
          { file: '.nvmrc', line: 1 },
          { file: 'package.json', line: 8 },
          { file: 'Dockerfile', line: 1 },
          { file: 'Dockerfile', line: 400 },
          { file: 'missing.txt', line: 1 },
        ],
        hints: { docsUrls: ['https://github.com/nodejs/Release', 'nodejs.org/about'] },
      }),
      record({
        kind: 'runtime',
        name: 'node',
        version: '16',
        declaredIn: [{ file: 'serverless.yml', line: 5 }],
        notes: 'Lambda disagrees with the 18 everywhere else',
      }),
    ]);
    const outcome = JSON.parse(outputs[0])[0];
    expect(outcome.accepted.map((place: { text: string }) => place.text)).toEqual([
      '18',
      '"node": "18.x"',
      'FROM node:18',
    ]);
    expect(outcome.rejected.map((place: { file: string }) => place.file)).toEqual([
      'Dockerfile',
      'missing.txt',
    ]);
    expect(outcome.hints.rejected.map((hint: { value: string }) => hint.value)).toEqual([
      'nodejs.org/about',
    ]);

    expect(report.dependencies).toHaveLength(2);
    const [node18, node16] = report.dependencies;
    expect(node18).toMatchObject({
      repo: 'refit-dev/sample',
      kind: 'runtime',
      name: 'node',
      version: '18',
      hints: { docsUrls: ['https://github.com/nodejs/Release'] },
    });
    expect(node18.declaredIn).toHaveLength(3);
    expect(node16.declaredIn).toEqual([
      { file: 'serverless.yml', line: 5, text: 'runtime: nodejs16.x' },
    ]);
    expect(report.promptVersion).toBe(DEPENDENCY_PROMPT_VERSION);
    expect(report.summary).toContain('runtime: node 18 (3 places), node 16 (1 place)');
  });

  it('adds repeat reports to one entry instead of duplicating them', async () => {
    const entry = { kind: 'library', name: 'express', ecosystem: 'npm', version: '4.18.2' };
    const { report } = await run(DEMO_NODE_API, [
      record({ ...entry, declaredIn: [{ file: 'package.json', line: 15 }] }),
      record({
        ...entry,
        declaredIn: [
          { file: 'package.json', line: 15 },
          { file: 'package-lock.json', line: 20 },
        ],
      }),
    ]);
    expect(report.dependencies).toHaveLength(1);
    expect(report.dependencies[0].declaredIn).toHaveLength(2);
  });

  it('joins an AI model, its SDK and the API inventory from one run', async () => {
    const { report } = await run(DEMO_NODE_API, [
      record(
        {
          kind: 'ai-model',
          name: 'text-davinci-003',
          ecosystem: 'openai',
          declaredIn: [{ file: 'src/summarize.js', line: 1 }],
          callSites: [{ file: 'src/summarize.js', line: 5, operation: 'completions.create' }],
        },
        {
          kind: 'sdk',
          name: 'openai',
          ecosystem: 'npm',
          version: '4.20.1',
          declaredIn: [{ file: 'package.json', line: 16 }],
        },
      ),
      {
        tool: 'record_usage',
        input: {
          provider: 'openai',
          via: 'sdk',
          purpose: 'summaries',
          sdk: { name: 'openai', version: '4.20.1', lockfile: 'package-lock.json' },
          callSites: [{ file: 'src/summarize.js', line: 5, operation: 'completions.create' }],
          hints: { packages: ['openai'], docsUrls: ['https://github.com/openai/openai-node'] },
        },
      },
    ]);
    expect(report.usages).toHaveLength(1);
    expect(report.purposes).toEqual({ openai: 'summaries' });
    const sdk = report.dependencies.find((dependency) => dependency.kind === 'sdk');
    expect(sdk).toMatchObject({
      name: 'openai',
      declaredIn: [{ file: 'package.json', line: 16 }],
      callSites: [{ file: 'src/summarize.js', line: 5 }],
      hints: { packages: ['openai'], docsUrls: ['https://github.com/openai/openai-node'] },
    });
    expect(report.dependencies.find((d) => d.kind === 'ai-model')?.callSites).toHaveLength(1);
  });

  it('keeps one entry per monorepo package, even when versions match', async () => {
    const next = { kind: 'framework', name: 'next', ecosystem: 'npm' };
    const { report } = await run(MONOREPO, [
      record(
        {
          ...next,
          version: '14.2.3',
          package: 'apps/web/',
          declaredIn: [{ file: 'apps/web/package.json', line: 4 }],
        },
        {
          ...next,
          version: '13.5.6',
          package: 'apps/admin',
          declaredIn: [{ file: 'apps/admin/package.json', line: 4 }],
        },
        {
          kind: 'runtime',
          name: 'node',
          version: '20',
          package: 'apps/web',
          declaredIn: [{ file: 'apps/web/package.json', line: 8 }],
        },
        {
          kind: 'runtime',
          name: 'node',
          version: '20',
          package: '.',
          declaredIn: [{ file: '.nvmrc', line: 1 }],
        },
      ),
    ]);
    expect(report.dependencies).toHaveLength(4);
    expect(
      report.dependencies
        .filter((dependency) => dependency.name === 'next')
        .map(({ version, package: owner }) => ({ version, owner })),
    ).toEqual([
      { version: '14.2.3', owner: 'apps/web' },
      { version: '13.5.6', owner: 'apps/admin' },
    ]);
    const roots = report.dependencies.filter((dependency) => dependency.name === 'node');
    expect(roots.map((dependency) => dependency.package)).toEqual(['apps/web', undefined]);
  });

  it('gives the scanners to the agent, reading real leads from each sample repo', async () => {
    const scanners: ScriptedCall[] = [
      'find_runtime_versions',
      'find_container_images',
      'find_ci_versions',
      'find_direct_dependencies',
      'find_ai_models',
    ].map((tool) => ({ tool, input: {} }));
    const node = await run(DEMO_NODE_API, scanners);
    expect(node.outputs[0]).toContain('nodejs16.x');
    expect(node.outputs[1]).toContain('FROM node:18');
    expect(node.outputs[3]).toContain('4.18.2');
    expect(node.outputs[4]).toContain('text-davinci-003');
    const python = await run(DEMO_PYTHON_APP, scanners);
    expect(python.outputs[0]).toContain('>=3.9,<3.10');
    expect(python.outputs[3]).toContain('stripe');
    const next = await run(DEMO_NEXT_WEB, scanners);
    expect(next.outputs[2]).toContain('actions/checkout');
    expect(next.outputs[3]).toContain('12.3.4');
    const mono = await run(MONOREPO, scanners);
    expect(mono.outputs[1]).toContain('python');
    expect(mono.outputs[3]).toContain('13.5.6');
    expect(mono.outputs[4]).toContain('claude-3-opus-20240229');
  });

  it('confines the agent: read-only tools, no shell, and area readers cannot remove', async () => {
    const { requests } = await run(DEMO_NODE_API, []);
    const { options, tools } = requests[0];
    expect(options.tools).toEqual(['Agent']);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.maxBudgetUsd).toBeCloseTo(DEFAULT_DEPENDENCY_RUN_CAP_USD - CALL_RESERVE_USD);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['record_dependencies', 'record_usage']));
    expect(names.some((name) => /write|edit|bash|shell/i.test(name))).toBe(false);
    const reader = options.agents?.[AREA_READER];
    expect(reader?.tools).toContain('mcp__inventory__record_dependencies');
    expect(reader?.tools?.some((name) => name.includes('__remove_'))).toBe(false);
    expect(reader?.prompt).toContain('record_dependencies');
  });

  it('adds surfaces to the result, and says so honestly when they could not be read', async () => {
    const surface = {
      repo: 'refit-dev/sample',
      kind: 'infrastructure' as const,
      name: 'extensions/v1beta1',
      declaredIn: [{ file: 'k8s/ingress.yaml', line: 1 }],
    };
    const { report } = await run(DEMO_NODE_API, [], { surfaces: async () => [surface] });
    expect(report.dependencies).toEqual([surface]);
    expect(report.errors).toEqual([]);

    const failed = await run(
      DEMO_NODE_API,
      [record({ kind: 'runtime', name: 'node', declaredIn: [{ file: '.nvmrc', line: 1 }] })],
      {
        surfaces: async () => {
          throw new Error('surface reader broke');
        },
      },
    );
    expect(failed.report.dependencies).toHaveLength(1);
    expect(failed.report.errors).toEqual([
      'Platform and regulated surfaces were not read: surface reader broke',
    ]);
  });

  it('reports rather than fails when P5 has not landed', async () => {
    const { report } = await run(DEMO_NODE_API, [], { surfaces: undefined });
    console.log(report.errors);
    // Passes either way once inventory/surfaces/ merges: the module loads, or the gap is stated.
    expect(report.errors.length === 0 || /surfaces were not read/.test(report.errors[0])).toBe(
      true,
    );
  });

  it('never returns secrets from line text, committed env files or notes', async () => {
    const fake = 'sk-' + 'a'.repeat(30);
    const { report } = await run(
      {
        '.env': `OPENAI_MODEL=${fake}\n`,
        '.env.example': 'OPENAI_MODEL=gpt-4\n',
        'config.js': `const client = new OpenAI({ apiKey: '${fake}', model: 'gpt-4' });\n`,
      },
      [
        record({
          kind: 'ai-model',
          name: 'gpt-4',
          declaredIn: [
            { file: '.env', line: 1 },
            { file: '.env.example', line: 1 },
            { file: 'config.js', line: 1 },
          ],
          notes: `seen with ${fake}`,
        }),
      ],
    );
    expect(JSON.stringify(report)).not.toContain(fake);
    expect(report.dependencies[0].declaredIn.map((place) => place.text)).toEqual([
      'OPENAI_MODEL',
      'OPENAI_MODEL=gpt-4',
      expect.stringContaining('[redacted]'),
    ]);
  });

  it('keeps partial results when the run stops at its budget, and states it', async () => {
    const repoDir = await repoWith(DEMO_NODE_API);
    const ledger = new BudgetLedger({ capUsd: 1 });
    const { runner } = fakeModel(
      [record({ kind: 'runtime', name: 'node', declaredIn: [{ file: '.nvmrc', line: 1 }] })],
      fakeResult({
        subtype: 'error_max_budget_usd',
        errors: ['Reached maximum budget'],
        total_cost_usd: 0.3,
        modelUsage: {},
      } as never),
    );
    const report = await runDependencyInventory(repoDir, 'refit-dev/sample', {
      ledger,
      runner,
      surfaces: noSurfaces,
    });
    expect(report.dependencies).toHaveLength(1);
    expect(report.outcome).toBe('error_max_budget_usd');
    expect(report.errors).toEqual(['The agent run ended early: error_max_budget_usd']);
    expect(report.summary).toContain('may be incomplete');
    expect(ledger.spentUsd).toBeCloseTo(0.3);
  });

  it('refuses to start without room in the budget', async () => {
    const repoDir = await repoWith(DEMO_NODE_API);
    const { runner, requests } = fakeModel([]);
    await expect(
      runDependencyInventory(repoDir, 'refit-dev/sample', {
        ledger: new BudgetLedger({ capUsd: 1, spentUsd: 0.99 }),
        runner,
        surfaces: noSurfaces,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(requests).toHaveLength(0);
  });
});

describe('scannerGap', () => {
  it('separates what the agent found alone from what scanners pointed at', async () => {
    const repoDir = await repoWith({
      '.nvmrc': '18\n',
      Makefile: 'install:\n\tcurl -fsSL https://nodejs.org/dist/v16.20.0/node.tar.gz | tar x\n',
      'README.md': 'Needs Node 18.\n',
    });
    const gap = await scannerGap(repoDir, [
      {
        repo: 'a/b',
        kind: 'runtime',
        name: 'node',
        version: '18',
        declaredIn: [
          { file: '.nvmrc', line: 1 },
          { file: 'README.md', line: 1 },
        ],
      },
      {
        repo: 'a/b',
        kind: 'runtime',
        name: 'node',
        version: '16',
        declaredIn: [{ file: 'Makefile', line: 2 }],
      },
    ]);
    expect(gap.findings).toEqual([{ kind: 'runtime', name: 'node', version: '16' }]);
    expect(gap.declarations.map(({ file }) => file)).toEqual(['README.md', 'Makefile']);
    expect(gap.unusedSignals).toEqual([]);
  });
});
