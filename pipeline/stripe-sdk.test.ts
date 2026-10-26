import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';
import { runWorkflow } from './workflow.ts';
import { verifyArtifacts } from './verification.ts';
import { readEvidence } from './state-files.ts';

const execute = promisify(execFile);
const fixture = resolve('pipeline/fixtures/stripe-sdk');
const directories: string[] = [];
const SDK_VERSIONS = ['10.17.0', '19.1.0'];
const INSTALL_TIMEOUT_MS = 120_000;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.skipIf(!process.env.REFIT_STRIPE_SDK).each(SDK_VERSIONS)(
  'migrates real Stripe SDK %s HTTP requests across the simulated API removal',
  async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'refit-stripe-sdk-'));
    directories.push(root);
    const repository = join(root, 'repository');
    await cp(join(fixture, 'repository'), repository, { recursive: true });
    await execute(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        `stripe@${version}`,
      ],
      { cwd: repository, timeout: INSTALL_TIMEOUT_MS },
    );
    const installed = JSON.parse(
      await readFile(join(repository, 'node_modules/stripe/package.json'), 'utf8'),
    );
    expect(installed.version).toBe(version);
    const clientPath = join(repository, 'client.js');
    await writeFile(
      clientPath,
      (await readFile(clientPath, 'utf8')).replace(
        "  host: '127.0.0.1',",
        "  apiVersion: '2022-08-01',\n  host: '127.0.0.1',",
      ),
    );
    const source = join(repository, 'billing.js');
    const original = await readFile(source, 'utf8');
    const harness = join(fixture, 'contract.mjs');
    const before = JSON.parse(
      (await execute(process.execPath, [harness, source, 'before'])).stdout,
    );
    expect(before.chargeIds).toEqual(['ch_first', 'ch_second']);
    expect(before.requests).toHaveLength(1);
    expect(before.apiVersions).toEqual(['2022-08-01']);
    await expect(execute(process.execPath, [harness, source, 'after'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('TypeError'),
    });
    const report = await runPipeline({
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      proposePatch: true,
      apiVersion: '2022-08-01',
      apiVersionPolicy: 'source-verified',
    });
    expect(report.repository.dependencies[0].version).toBe(version);
    expect(report.repository.dependencies[0].lock).toMatchObject({
      status: 'locked',
      version,
      file: 'package-lock.json',
    });
    expect(report.findings).toHaveLength(1);
    expect(report.apiVersion).toMatchObject({
      applicability: 'matches-before',
      source: { status: 'verified' },
    });
    expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
    if (!('diff' in report.patch)) throw new Error('Expected SDK migration proposal');
    const patch = join(root, 'migration.patch');
    await writeFile(patch, report.patch.diff);
    await execute('git', ['apply', '--check', patch], { cwd: repository });
    await execute('git', ['apply', patch], { cwd: repository });
    const after = JSON.parse((await execute(process.execPath, [harness, source, 'after'])).stdout);
    expect(after.chargeIds).toEqual(before.chargeIds);
    expect(after.apiVersions).toEqual(['2022-08-01', '2022-08-01']);
    expect(after.requests).toEqual([
      { method: 'GET', path: '/v1/payment_intents/pi_refit_contract' },
      { method: 'GET', path: '/v1/charges?payment_intent=pi_refit_contract' },
    ]);
    expect(await readFile(source, 'utf8')).not.toBe(original);
    expect(await readFile(join(fixture, 'repository/billing.js'), 'utf8')).toBe(original);
    await writeFile(
      source,
      original.replace(
        'stripe.paymentIntents.retrieve(paymentIntentId)',
        "stripe.paymentIntents.retrieve(paymentIntentId, { apiVersion: '2022-11-15' })",
      ),
    );
    const overridden = JSON.parse(
      (
        await execute(process.execPath, [harness, source, 'before'], {
          env: { ...process.env, REFIT_EXPECTED_API_VERSION: '2022-11-15' },
        })
      ).stdout,
    );
    expect(overridden.apiVersions).toEqual(['2022-11-15']);
    const conflicting = await runPipeline({
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      apiVersion: '2022-08-01',
      apiVersionPolicy: 'source-verified',
    });
    expect(conflicting.apiVersion).toMatchObject({
      applicability: 'conflicts-with-code',
      source: { status: 'conflict' },
    });
  },
  180_000,
);

it
  .skipIf(
    !process.env.REFIT_STRIPE_SDK ||
      !process.env.REFIT_DOCKER_IMAGE ||
      !process.env.REFIT_NPM_PREPARE,
  )
  .each(
    SDK_VERSIONS.flatMap((version) =>
      ['esm-default', 'commonjs-factory'].map((format) => ({ version, format })),
    ),
  )(
  'validates guarded $format history with real Stripe $version across pages and empty lists in offline Docker',
  async ({ version, format }) => {
    const root = await mkdtemp(join(tmpdir(), 'refit-client-module-sdk-'));
    directories.push(root);
    const repository = join(root, 'repository');
    await cp(join(fixture, 'repository'), repository, { recursive: true });
    await rm(join(repository, 'billing.js'));
    const commonjs = format === 'commonjs-factory';
    const extension = commonjs ? 'cjs' : 'js';
    const source = join(repository, `billing.${extension}`);
    const originalClient = (await readFile(join(repository, 'client.js'), 'utf8')).replace(
      "  host: '127.0.0.1',",
      "  apiVersion: '2022-08-01',\n  host: '127.0.0.1',",
    );
    const client = commonjs
      ? originalClient
          .replace("import Stripe from 'stripe';", "const Stripe = require('stripe');")
          .replace('export const stripe = new Stripe', 'const stripe = Stripe') +
        '\nmodule.exports = stripe;\n'
      : originalClient.replace('export const stripe', 'const stripe') +
        '\nexport default stripe;\n';
    await rm(join(repository, 'client.js'));
    await writeFile(join(repository, `client.${extension}`), client);
    await writeFile(
      join(repository, `payments.${extension}`),
      commonjs
        ? `const stripe = require('./client.cjs'); function retrieve(id) { return stripe.paymentIntents.retrieve(id); } module.exports = {retrieve};`
        : `import stripe from './client.js'; export function retrieve(id) { return stripe.paymentIntents.retrieve(id); }`,
    );
    const application = `${commonjs ? "const {retrieve} = require('./payments.cjs');" : "import {retrieve} from './payments.js';"}
class MissingHistory extends Error {}
${commonjs ? '' : 'export '}async function chargeHistory(id) {
  const intent = await retrieve(id);
  if (!intent.charges) { throw new MissingHistory('Missing history'); }
  return intent.charges.data;
}
${commonjs ? 'exports.chargeHistory = chargeHistory;' : ''}`;
    await writeFile(source, application);
    await writeFile(join(repository, '.gitignore'), 'node_modules/\n');
    await mkdir(join(repository, 'simulator'));
    await cp(join(fixture, 'contract.mjs'), join(repository, 'simulator/contract.mjs'));
    await execute(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        `stripe@${version}`,
      ],
      { cwd: repository, timeout: INSTALL_TIMEOUT_MS },
    );
    const harness = join(repository, 'simulator/contract.mjs');
    for (const empty of ['0', '1']) {
      const env = {
        ...process.env,
        REFIT_FIXTURE_PAGINATION: '1',
        REFIT_FIXTURE_EMPTY: empty,
        REFIT_EXPECTED_API_VERSION: '2022-08-01',
      };
      const before = JSON.parse(
        (await execute(process.execPath, [harness, source, 'before'], { env })).stdout,
      );
      expect(before.chargeIds).toEqual(empty === '1' ? [] : ['ch_first', 'ch_second']);
      await expect(
        execute(process.execPath, [harness, source, 'after'], { env }),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Missing history') });
    }
    const git = (args: string[]) =>
      execute('git', ['-C', repository, '-c', 'commit.gpgsign=false', ...args]);
    await git(['init', '-b', 'main']);
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Refit Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'test: seed guarded module fixture',
    ]);
    const checks = (mode: string) => [
      'sh',
      '-c',
      `REFIT_FIXTURE_PAGINATION=1 REFIT_EXPECTED_API_VERSION=2022-08-01 node simulator/contract.mjs billing.${extension} ${mode} && REFIT_FIXTURE_EMPTY=1 REFIT_EXPECTED_API_VERSION=2022-08-01 node simulator/contract.mjs billing.${extension} ${mode}`,
    ];
    const result = await runWorkflow({
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      image: process.env.REFIT_DOCKER_IMAGE!,
      prepareDependencies: true,
      baselineCommand: checks('before'),
      command: checks('after'),
      apiVersion: '2022-08-01',
      apiVersionPolicy: 'source-verified',
      output: join(root, 'run'),
    });
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse((await readEvidence(result.directory, 'report.json'))!);
    expect(report.apiVersion.source.status).toBe('verified');
    expect(report.patch).toMatchObject({ generator: 'deterministic', unresolvedFindings: 0 });
    expect(report.validation).toMatchObject({
      baseline: { status: 'passed' },
      patched: { status: 'passed' },
    });
    expect(report.validation.patched.stdout).toContain('starting_after=ch_first');
    expect(report.validation.patched.stdout).toContain('"chargeIds":[]');
    expect(report.publicationFiles.map((file: { path: string }) => file.path)).toEqual([
      `billing.${extension}`,
    ]);
    expect(await readFile(source, 'utf8')).toBe(application);
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
    expect((await verifyArtifacts(result.directory)).status).toBe('integrity-verified');
  },
  180_000,
);
