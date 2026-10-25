import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareDependencies } from './dependency-preparation.ts';
import { digest } from './specifications.ts';
import type { CheckResult } from './validation.ts';
import { BASELINE_CHECK_CACHE_SETTING, baselineCheck } from './validation-baseline-cache.ts';
import { validateMigration } from './validation.ts';

vi.mock('./dependency-preparation.ts', async (original) => ({
  ...(await original<typeof import('./dependency-preparation.ts')>()),
  prepareDependencies: vi.fn(),
}));

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'refit-baseline-cache-'));
  roots.push(root);
  return root;
}

// Commits of odota/core and Kanba-co/kanba (docs/benchmarks/subsets/l2-push-249.json).
const ODOTA = 'b877fd1c169c84e4dfc2651a3f2fcdd68b5fef08';
const KANBA = 'd5dfe822a503dcf87e14e687e4a13a0baffc9fe3';
const inputs = (fields: Record<string, unknown> = {}) => ({
  revision: ODOTA,
  command: ['npm', 'test'],
  image: `sha256:${'e'.repeat(64)}`,
  dependencies: 'a'.repeat(64),
  limits: { timeoutMs: 120_000, workspace: '2g', memory: '3g' },
  ...fields,
});
const result = (status: CheckResult['status'], exitCode: number | null): CheckResult => ({
  status,
  exitCode,
  stdout: `${status} output`,
  stderr: '',
});

it('runs every baseline when the setting is unset', async () => {
  const run = vi.fn(async () => result('passed', 0));
  expect(await baselineCheck(inputs(), run)).toEqual({ check: result('passed', 0) });
  expect(await baselineCheck(inputs(), run)).toEqual({ check: result('passed', 0) });
  expect(run).toHaveBeenCalledTimes(2);
});

it('reuses a decided result only under the same revision, command, image, dependencies and limits', async () => {
  const directory = join(await temporary(), 'cache');
  vi.stubEnv(BASELINE_CHECK_CACHE_SETTING, directory);
  const run = vi.fn(async () => result('failed', 1));
  expect(await baselineCheck(inputs(), run)).toEqual({ check: result('failed', 1) });
  const reused = await baselineCheck(inputs(), run);
  expect(reused.check).toEqual(result('failed', 1));
  expect(Date.parse(reused.recordedAt!)).not.toBeNaN();
  expect(run).toHaveBeenCalledTimes(1);
  for (const changed of [
    { revision: KANBA },
    { command: ['npx', '--no-install', 'tsc', '--noEmit'] },
    { image: `sha256:${'f'.repeat(64)}` },
    { dependencies: null },
    { limits: { timeoutMs: 120_000, workspace: '4g', memory: '5g' } },
  ]) {
    expect((await baselineCheck(inputs(changed), run)).recordedAt).toBeUndefined();
  }
  expect(run).toHaveBeenCalledTimes(6);
  expect(await readdir(directory)).toHaveLength(6);
});

it('never stores errors or skips, and ignores entries it cannot trust', async () => {
  const directory = join(await temporary(), 'cache');
  vi.stubEnv(BASELINE_CHECK_CACHE_SETTING, directory);
  const error = vi.fn(async () => ({
    ...result('error', null),
    error: 'Check exceeded 120 seconds',
  }));
  await baselineCheck(inputs(), error);
  await baselineCheck(inputs(), error);
  expect(error).toHaveBeenCalledTimes(2);

  const run = vi.fn(async () => result('passed', 0));
  await baselineCheck(inputs({ revision: KANBA }), run);
  const [file] = await readdir(directory);
  const stored = JSON.parse(await readFile(join(directory, file), 'utf8'));
  for (const tampered of [
    'not json',
    JSON.stringify({ ...stored, key: { ...stored.key, revision: ODOTA } }),
    JSON.stringify({ ...stored, check: { ...stored.check, status: 'error' } }),
    JSON.stringify({ ...stored, recordedAt: undefined }),
  ]) {
    await writeFile(join(directory, file), tampered);
    expect((await baselineCheck(inputs({ revision: KANBA }), run)).recordedAt).toBeUndefined();
  }
  expect(run).toHaveBeenCalledTimes(5);
  // The rerun's result replaced the entry it could not trust.
  expect((await baselineCheck(inputs({ revision: KANBA }), run)).recordedAt).toBeDefined();
});

// A committed repository and a docker stand-in that logs each check it runs. The same commit is
// validated each time, as a rerun of one benchmark commit does.
async function fixture(baselineExit: number) {
  vi.stubEnv(BASELINE_CHECK_CACHE_SETTING, join(await temporary(), 'cache'));
  const root = await temporary();
  const repository = join(root, 'repository');
  const binary = join(root, 'bin');
  const log = join(root, 'checks.log');
  await cp(resolve('pipeline/fixtures/repository'), repository, { recursive: true });
  await mkdir(binary);
  await execute('git', ['init', '-q', repository]);
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'test: seed repository',
  ]);
  await writeFile(
    join(binary, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args[3] === '{{.Id}}' ? 'sha256:${'d'.repeat(64)}' : JSON.stringify(['NODE_VERSION=22.23.3'])); process.exit(0); }
if (args[0] === 'rm' || args[0] === 'create' || args[0] === 'ps' || args[0] === 'info') process.exit(0);
const side = args.find((arg) => arg.includes('dst=/input')).includes('/baseline,') ? 'baseline' : 'patched';
fs.appendFileSync(${JSON.stringify(log)}, side + '\\n');
console.log(side + ' checks ran');
process.exit(side === 'baseline' ? ${baselineExit} : 0);
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  return async (
    extra: { prepareDependencies?: boolean; onProgress?: (message: string) => void } = {},
  ) => {
    await rm(log, { force: true });
    const report = await validateMigration({
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      apiVersion: '2022-08-01',
      image: 'node:22-alpine',
      command: ['npm', 'test'],
      ...extra,
    });
    const checks = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return { report, checks };
  };
}

it('validates with the recorded baseline instead of running it again, and says so', async () => {
  const validate = await fixture(0);
  const first = await validate();
  expect(first.checks).toEqual(['baseline', 'patched']);
  expect(first.report.validation).not.toHaveProperty('baselineReused');
  const progress: string[] = [];
  const second = await validate({ onProgress: (message) => progress.push(message) });
  expect(second.checks).toEqual(['patched']);
  expect(progress.filter((message) => /baseline/i.test(message))).toEqual([
    expect.stringMatching(/^Reusing the baseline check result recorded \d{4}-/),
  ]);
  expect(second.report.validation).toMatchObject({
    status: 'passed',
    baseline: first.report.validation.baseline,
    baselineReused: { recordedAt: expect.any(String) },
  });
});

it('keeps a failed baseline failed when it is reused', async () => {
  const validate = await fixture(1);
  expect((await validate()).checks).toEqual(['baseline']);
  const second = await validate();
  expect(second.checks).toEqual([]);
  expect(second.report.validation).toMatchObject({
    status: 'baseline-failed',
    baseline: { status: 'failed', exitCode: 1, stdout: 'baseline checks ran\n' },
    patched: { status: 'not-run' },
  });
});

// prepareDependencies as validation calls it: it copies the bundle's archive to copyArchiveTo and
// returns the environment that records the archive's hash.
function bundle(signature: string, content: string) {
  return async (options: { copyArchiveTo?: string }) => {
    if (options.copyArchiveTo) await writeFile(options.copyArchiveTo, content);
    const environment = {
      signature,
      archiveHash: digest(content),
      archiveBytes: Buffer.byteLength(content),
    };
    return { directory: '', archive: '', environment, reused: false };
  };
}

it('reuses the baseline for a rebuilt bundle of the same signature, not for another signature', async () => {
  const validate = await fixture(0);
  vi.mocked(prepareDependencies).mockImplementation(bundle('a'.repeat(64), 'first install'));
  expect((await validate({ prepareDependencies: true })).checks).toEqual(['baseline', 'patched']);
  // A rebuild of the same lockfile, recipe and image: other archive bytes, same signature.
  vi.mocked(prepareDependencies).mockImplementation(bundle('a'.repeat(64), 'second install'));
  const rebuilt = await validate({ prepareDependencies: true });
  expect(rebuilt.checks).toEqual(['patched']);
  expect(rebuilt.report.validation).toHaveProperty('baselineReused');
  vi.mocked(prepareDependencies).mockImplementation(bundle('b'.repeat(64), 'second install'));
  expect((await validate({ prepareDependencies: true })).checks).toEqual(['baseline', 'patched']);
});
