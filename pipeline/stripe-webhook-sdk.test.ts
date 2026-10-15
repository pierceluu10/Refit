import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { dockerSandboxArguments, removeDockerContainer } from './docker-sandbox.ts';
import { prepareDependencies } from './dependency-preparation.ts';
import { runPipeline } from './run.ts';

const execute = promisify(execFile);
const FIXTURE = resolve('pipeline/fixtures/stripe-webhooks');
const SDK_VERSIONS = ['17.7.0', '19.1.0'];
const API_VERSION = '2025-02-24.acacia';
const PROCESS_TIMEOUT_MS = 120_000;
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scenario(version: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-webhook-sdk-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await cp(join(FIXTURE, 'repository'), repository, { recursive: true });
  await cp(join(FIXTURE, 'contract.mjs'), join(root, 'contract.mjs'));
  await writeFile(join(repository, '.gitignore'), 'node_modules/\n');
  await execute(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `stripe@${version}`],
    { cwd: repository, timeout: PROCESS_TIMEOUT_MS },
  );
  const git = (args: string[]) =>
    execute('git', ['-C', repository, '-c', 'commit.gpgsign=false', ...args]);
  await git(['init', '-b', 'main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '-m',
    'test: seed independent webhook application',
  ]);
  return {
    root,
    repository,
    git,
    options: {
      repository,
      before: join(FIXTURE, 'before.json'),
      after: join(FIXTURE, 'after.json'),
      apiVersion: API_VERSION,
      apiVersionPolicy: 'source-verified' as const,
    },
  };
}

it.skipIf(!process.env.REFIT_STRIPE_SDK).each(SDK_VERSIONS)(
  'exercises signed historical subscription webhooks with actual Stripe %s and patches both payload versions',
  async (version) => {
    const sample = await scenario(version);
    expect(
      JSON.parse(
        await readFile(join(sample.repository, 'node_modules/stripe/package.json'), 'utf8'),
      ).version,
    ).toBe(version);
    const harness = join(sample.root, 'contract.mjs');
    const before = JSON.parse(
      (await execute(process.execPath, [harness, sample.repository, 'before'])).stdout,
    );
    expect(before.deliveries[0].status).toBe(200);
    await expect(
      execute(process.execPath, [harness, sample.repository, 'after']),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('missing-subscription-period'),
    });
    const regression = JSON.parse(
      (await execute(process.execPath, [harness, sample.repository, 'regression'])).stdout,
    );
    expect(regression.deliveries.map((delivery: { status: number }) => delivery.status)).toEqual([
      200, 422, 200, 400, 400, 400, 200,
    ]);
    expect(regression.outgoingClientVersion).toBe(API_VERSION);
    const fetch = vi.fn(() => {
      throw new Error('Webhook review must never contact a model or GitHub.');
    });
    vi.stubGlobal('fetch', fetch);
    const report = await runPipeline({
      ...sample.options,
      proposePatch: true,
      aiPatch: { apiKey: 'unused', model: 'unused' },
    });
    expect(report.apiVersion.source.status).toBe('verified');
    expect(report.findings).toHaveLength(4);
    expect(
      report.findings.every(
        (finding) =>
          finding.webhook?.schema === 'subscription' && finding.webhook.apiVersion === 'unverified',
      ),
    ).toBe(true);
    expect(report.findings.every((finding) => finding.confidence === 'confirmed')).toBe(true);
    expect(
      report.findings.every(
        (finding) =>
          finding.webhook?.migration?.rule === 'stripe-subscription-periods-either-version',
      ),
    ).toBe(true);
    expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
    // Previously rendered (old-version) signed events still succeed after the patch.
    const patch = join(sample.root, 'migration.patch');
    await writeFile(patch, 'diff' in report.patch ? report.patch.diff : '');
    await sample.git(['apply', patch]);
    const replay = JSON.parse(
      (await execute(process.execPath, [harness, sample.repository, 'before'])).stdout,
    );
    expect(replay.deliveries[0].status).toBe(200);
    await sample.git(['checkout', '--', '.']);
    expect(fetch).not.toHaveBeenCalled();
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
  },
  180_000,
);

it.skipIf(!process.env.REFIT_STRIPE_SDK || !IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'reproduces the original and changed signed webhook contracts in offline Docker',
  async () => {
    const sample = await scenario(SDK_VERSIONS[0]);
    const prepared = await prepareDependencies({
      repository: sample.repository,
      image: IMAGE!,
      cacheDirectory: join(sample.root, 'cache'),
    });
    const name = `refit-webhook-${randomUUID()}`;
    const input = join(sample.root, 'input');
    await mkdir(input);
    await cp(join(FIXTURE, 'repository'), join(input, 'application'), { recursive: true });
    await cp(join(FIXTURE, 'contract.mjs'), join(input, 'contract.mjs'));
    try {
      const result = await execute(
        'docker',
        dockerSandboxArguments({
          name,
          directory: input,
          image: String(prepared.environment.image),
          dependencies: prepared.archive,
          network: 'none',
          command: ['node', 'contract.mjs', './application', 'regression'],
        }),
        { timeout: PROCESS_TIMEOUT_MS },
      );
      const regression = JSON.parse(result.stdout);
      expect(regression.deliveries.map((delivery: { status: number }) => delivery.status)).toEqual([
        200, 422, 200, 400, 400, 400, 200,
      ]);
      expect(regression.simulated).toBe(true);
    } finally {
      await removeDockerContainer(name);
    }
    expect((await sample.git(['status', '--porcelain'])).stdout).toBe('');
  },
  180_000,
);
