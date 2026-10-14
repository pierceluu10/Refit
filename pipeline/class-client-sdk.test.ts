import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { verifyArtifacts } from './verification.ts';

const execute = promisify(execFile);
const TIMEOUT_MS = 120_000;
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const STRIPE_FIXTURE = resolve('pipeline/fixtures/stripe-sdk');
const OPENAI_FIXTURE = resolve('pipeline/fixtures/openai');
const API_VERSION = '2022-08-01';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(name: string, dependency: string, version: string, typed = false) {
  const root = await mkdtemp(join(tmpdir(), `refit-${name}-`));
  roots.push(root);
  const app = join(root, 'application');
  await mkdir(app);
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({
      name,
      private: true,
      type: 'module',
      dependencies: { [dependency]: version },
      ...(typed ? { devDependencies: { typescript: '5.9.3', '@types/node': '22.15.30' } } : {}),
    }),
  );
  await writeFile(join(app, '.gitignore'), 'node_modules/\nbuild/\n');
  const git = (args: string[]) =>
    execute('git', ['-C', app, '-c', 'commit.gpgsign=false', ...args]);
  const commit = async () => {
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: app,
      timeout: TIMEOUT_MS,
    });
    await git(['init', '-b', 'main']);
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '-m',
      'test: seed unmigrated class-based API application',
    ]);
  };
  return { root, app, git, commit };
}

it.skipIf(!IMAGE || !process.env.REFIT_STRIPE_SDK || !process.env.REFIT_NPM_PREPARE).each([
  { version: '10.17.0', format: 'constructor' },
  { version: '19.1.0', format: 'private-field' },
  { version: '10.17.0', format: 'typescript-arrow' },
])(
  'validates $format history with real Stripe $version, pagination and empty histories in offline Docker',
  async ({ version, format }) => {
    const typed = format === 'typescript-arrow';
    const sample = await repository('stripe-class-client', 'stripe', version, typed);
    const options = `{
    host: '127.0.0.1', port: Number(process.env.REFIT_FIXTURE_PORT), protocol: 'http',
    maxNetworkRetries: 0, timeout: REQUEST_TIMEOUT_MS, apiVersion: '${API_VERSION}'
  }`;
    const field = format === 'private-field' || typed ? '#stripe' : 'stripe';
    const initializer = `new Stripe('sk_test_refit_local_fixture', ${options})`;
    const declaration =
      format === 'constructor'
        ? `stripe; constructor() { this.stripe = ${initializer}; }`
        : `${field} = ${initializer};`;
    const history = `async history(id${typed ? ': string' : ''}) {
    const intent = await this.${field}.paymentIntents.retrieve(id);
    if (!intent.charges) { throw new MissingHistory('Missing history'); }
    return intent.charges.data;
  }`;
    const source = `import Stripe from 'stripe';
const REQUEST_TIMEOUT_MS = 1000;
export class MissingHistory extends Error {}
export class Billing {
  ${declaration}
  ${typed ? history.replace('async history', 'history = async').replace(`(id: string)`, '(id: string) =>') : history}
}
const billing = new Billing();
export const chargeHistory = (id${typed ? ': string' : ''}) => billing.history(id);
`;
    const extension = typed ? 'ts' : 'js';
    await writeFile(join(sample.app, `billing.${extension}`), source);
    await mkdir(join(sample.app, 'simulator'));
    await cp(join(STRIPE_FIXTURE, 'contract.mjs'), join(sample.app, 'simulator/contract.mjs'));
    if (typed)
      await writeFile(
        join(sample.app, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            skipLibCheck: true,
            outDir: 'build',
          },
          include: ['billing.ts'],
        }),
      );
    await sample.commit();
    const module = typed ? 'build/billing.js' : 'billing.js';
    if (typed)
      await execute(process.execPath, ['node_modules/typescript/bin/tsc'], {
        cwd: sample.app,
        timeout: TIMEOUT_MS,
      });
    const env = {
      ...process.env,
      REFIT_FIXTURE_PAGINATION: '1',
      REFIT_EXPECTED_API_VERSION: API_VERSION,
    };
    const harness = join(sample.app, 'simulator/contract.mjs');
    await execute(process.execPath, [harness, join(sample.app, module), 'before'], { env });
    await expect(
      execute(process.execPath, [harness, join(sample.app, module), 'after'], { env }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Missing history') });
    const checks = (mode: string) => [
      'sh',
      '-c',
      `${typed ? 'node node_modules/typescript/bin/tsc && ' : ''}REFIT_FIXTURE_PAGINATION=1 REFIT_EXPECTED_API_VERSION=${API_VERSION} node simulator/contract.mjs ${module} ${mode} && REFIT_FIXTURE_EMPTY=1 REFIT_EXPECTED_API_VERSION=${API_VERSION} node simulator/contract.mjs ${module} ${mode}`,
    ];
    const result = await runWorkflow({
      repository: sample.app,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      apiVersion: API_VERSION,
      apiVersionPolicy: 'source-verified',
      image: IMAGE!,
      prepareDependencies: true,
      baselineCommand: checks('before'),
      command: checks('after'),
      output: join(sample.root, 'run'),
    });
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse(await readFile(join(result.directory, 'report.json'), 'utf8'));
    expect(report.patch).toMatchObject({ generator: 'deterministic', unresolvedFindings: 0 });
    expect(report.patch.diff).toContain(
      `for await (const refitCharge of this.${field}.charges.list`,
    );
    expect(report.validation).toMatchObject({
      baseline: { status: 'passed' },
      patched: { status: 'passed' },
    });
    expect(report.validation.patched.stdout).toContain('starting_after=ch_first');
    expect(report.validation.patched.stdout).toContain('"chargeIds":[]');
    expect(report.publicationFiles.map((file: { path: string }) => file.path)).toEqual([
      `billing.${extension}`,
    ]);
    expect((await verifyArtifacts(result.directory)).status).toBe('integrity-verified');
    expect(await readFile(join(sample.app, `billing.${extension}`), 'utf8')).toBe(source);
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
  },
  180_000,
);

it.skipIf(!IMAGE || !process.env.REFIT_OPENAI_SDK || !process.env.REFIT_NPM_PREPARE)(
  'validates a class-held actual OpenAI client through the generic adapter and simulated rename',
  async () => {
    const sample = await repository('openai-class-client', 'openai', '7.32.0');
    const classSource = `import OpenAI from 'openai';
const REQUEST_TIMEOUT_MS = 5000;
export class ModelService {
  #client = new OpenAI({ apiKey: 'refit-offline-test', baseURL: process.env.REFIT_SIMULATOR_URL, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  async owner(id) { const model = await this.#client.models.retrieve(id); return model.owned_by.toLowerCase(); }
}
const service = new ModelService();
export const getModelOwner = (id) => service.owner(id);
`;
    await writeFile(join(sample.app, 'models.js'), classSource);
    await mkdir(join(sample.app, 'simulator'));
    await cp(join(OPENAI_FIXTURE, 'contract.mjs'), join(sample.app, 'simulator/contract.mjs'));
    const contract = {
      openapi: '3.0.3',
      info: { title: 'Simulated OpenAI ownership rename', version: 'before' },
      paths: {},
      components: {
        schemas: {
          Model: {
            type: 'object',
            properties: { owned_by: { type: 'string' } } as Record<string, { type: string }>,
          },
        },
      },
    };
    const after = structuredClone(contract);
    after.info.version = 'after';
    after.components.schemas.Model.properties = {
      owner_name: { type: 'string' },
    };
    const beforePath = join(sample.root, 'before.json');
    const afterPath = join(sample.root, 'after.json');
    await writeFile(beforePath, JSON.stringify(contract));
    await writeFile(afterPath, JSON.stringify(after));
    await sample.commit();
    const harness = join(sample.app, 'simulator/contract.mjs');
    await execute(process.execPath, [harness, join(sample.app, 'models.js'), 'before']);
    await expect(
      execute(process.execPath, [harness, join(sample.app, 'models.js'), 'after']),
    ).rejects.toMatchObject({ code: 1 });
    const result = await runWorkflow({
      repository: sample.app,
      before: beforePath,
      after: afterPath,
      providerConfig: join(OPENAI_FIXTURE, 'provider-renames.json'),
      apiVersion: 'before',
      image: IMAGE!,
      prepareDependencies: true,
      baselineCommand: ['node', 'simulator/contract.mjs', 'models.js', 'before'],
      command: ['node', 'simulator/contract.mjs', 'models.js', 'after'],
      output: join(sample.root, 'run'),
    });
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse(await readFile(join(result.directory, 'report.json'), 'utf8'));
    expect(report.patch).toMatchObject({ generator: 'deterministic', unresolvedFindings: 0 });
    expect(report.patch.diff).toContain('model.owner_name.toLowerCase()');
    expect(report.validation).toMatchObject({
      baseline: { status: 'passed' },
      patched: { status: 'passed' },
    });
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
  },
  180_000,
);

it('stops unstable class clients before paid work or validation, including a mixed safe finding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-class-review-'));
  roots.push(root);
  const before = resolve('pipeline/fixtures/stripe-webhooks/before.json');
  const after = resolve('pipeline/fixtures/stripe-webhooks/after.json');
  const source = `import Stripe from 'stripe';
class SubscriptionService {
  stripe = new Stripe('fixture', {apiVersion:'2025-02-24.acacia'});
  reset() { this.stripe = alternate; }
  async period(id) { const subscription = await this.stripe.subscriptions.retrieve(id); return subscription.current_period_end; }
}
const stripe = new Stripe('fixture', {apiVersion:'2025-02-24.acacia'});
async function period(id) { const subscription = await stripe.subscriptions.retrieve(id); return subscription.current_period_end; }
`;
  await writeFile(join(root, 'service.ts'), source);
  const providerConfig = join(root, 'adapter.json');
  await writeFile(
    providerConfig,
    JSON.stringify({
      id: 'stripe-class-review',
      packageName: 'stripe',
      defaultImport: true,
      namedExport: 'Stripe',
      constructorCalls: true,
      operations: [{ resource: 'subscriptions', method: 'retrieve', schema: 'subscription' }],
    }),
  );
  const fetch = vi.fn(() => {
    throw new Error('Unstable class clients must not call a model.');
  });
  vi.stubGlobal('fetch', fetch);
  const options = {
    repository: root,
    before,
    after,
    providerConfig,
    apiVersion: '2025-02-24.acacia',
  };
  const report = await runPipeline({
    ...options,
    aiPatch: { apiKey: 'unused', model: 'unused' },
    assessment: { apiKey: 'unused', model: 'unused' },
  });
  expect(report.patch).toMatchObject({
    status: 'not-generated',
    reason: expect.stringContaining('stable class-client provenance'),
  });
  expect(report.assessment).toMatchObject({ status: 'blocked' });
  expect(report.findings.some((finding) => finding.confidence === 'confirmed')).toBe(true);
  const workflow = await runWorkflow({
    ...options,
    image: 'must-not-inspect',
    command: ['must-not-execute'],
    output: join(tmpdir(), `${root.split('/').at(-1)}-output`),
  });
  roots.push(workflow.directory);
  expect(workflow.manifest).toMatchObject({ status: 'needs-review', stage: 'scan' });
  expect(fetch).not.toHaveBeenCalled();
});
