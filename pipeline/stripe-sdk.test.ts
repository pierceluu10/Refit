import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { runPipeline } from './run.ts';

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
