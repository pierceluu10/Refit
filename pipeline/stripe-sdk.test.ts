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
    const source = join(repository, 'billing.js');
    const original = await readFile(source, 'utf8');
    const harness = join(fixture, 'contract.mjs');
    const before = JSON.parse(
      (await execute(process.execPath, [harness, source, 'before'])).stdout,
    );
    expect(before.chargeIds).toEqual(['ch_first', 'ch_second']);
    expect(before.requests).toHaveLength(1);
    await expect(execute(process.execPath, [harness, source, 'after'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('TypeError'),
    });
    const report = await runPipeline({
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      proposePatch: true,
    });
    expect(report.repository.dependencies[0].version).toBe(version);
    expect(report.findings).toHaveLength(1);
    expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
    if (!('diff' in report.patch)) throw new Error('Expected SDK migration proposal');
    const patch = join(root, 'migration.patch');
    await writeFile(patch, report.patch.diff);
    await execute('git', ['apply', '--check', patch], { cwd: repository });
    await execute('git', ['apply', patch], { cwd: repository });
    const after = JSON.parse((await execute(process.execPath, [harness, source, 'after'])).stdout);
    expect(after.chargeIds).toEqual(before.chargeIds);
    expect(after.requests).toEqual([
      { method: 'GET', path: '/v1/payment_intents/pi_refit_contract' },
      { method: 'GET', path: '/v1/charges?payment_intent=pi_refit_contract' },
    ]);
    expect(await readFile(source, 'utf8')).not.toBe(original);
    expect(await readFile(join(fixture, 'repository/billing.js'), 'utf8')).toBe(original);
  },
  180_000,
);
