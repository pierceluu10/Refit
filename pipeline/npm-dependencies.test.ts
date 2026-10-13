import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { DEPENDENCY_TREE_CHECK, prepareNpmDependencies } from './npm-dependencies.ts';
import { dockerSandboxArguments, removeDockerContainer } from './docker-sandbox.ts';
import { verifyArtifacts } from './verification.ts';
import { runWorkflow } from './workflow.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const IMAGE = `sha256:${'a'.repeat(64)}`;
const NATIVE_PROCESS_TEST_TIMEOUT_MS = 30_000;
const INITIAL_MANIFEST = {
  name: 'dependency-preparation-test',
  version: '1.0.0',
  dependencies: {},
};

async function commit(repository: string) {
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
    '-m',
    'test: record dependency preparation inputs',
  ]);
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'refit-dependencies-test-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const binary = join(root, 'bin');
  const log = join(root, 'docker-calls.jsonl');
  await mkdir(repository);
  await mkdir(binary);
  await writeFile(join(repository, 'package.json'), JSON.stringify(INITIAL_MANIFEST));
  await writeFile(
    join(repository, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { '': INITIAL_MANIFEST } }),
  );
  await writeFile(join(repository, '.npmrc'), 'registry=http://127.0.0.1:1\n');
  await writeFile(join(repository, '.env'), 'DO_NOT_COPY=private-fixture-value\n');
  await execute('git', ['init', repository]);
  await commit(repository);
  const fake = `#!/usr/bin/env node
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
const log=${JSON.stringify(log)};
let inputs;
if(args[0]==='run') {
 const mount=args[args.indexOf('--mount')+1];
 inputs=fs.readdirSync(mount.slice('type=bind,src='.length,mount.indexOf(',dst=')));
}
fs.appendFileSync(log,JSON.stringify({args,inputs})+'\\n');
if(args[0]==='image'){console.log(${JSON.stringify(IMAGE)});process.exit(0)}
if(args[0]==='rm')process.exit(0);
if(process.env.REFIT_TEST_INSTALL_MODE==='wait'){setInterval(()=>{},1000)}
else if(process.env.REFIT_TEST_INSTALL_MODE==='fail'){process.stderr.write('simulated npm failure\\n');process.exitCode=42}
else if(process.env.REFIT_TEST_INSTALL_MODE==='verbose'){process.stderr.write(Buffer.alloc(1024*1024+1,120));setInterval(()=>{},1000)}
else {
 process.stderr.write('REFIT_NODE_VERSION=v22.23.3\\nREFIT_NPM_VERSION=10.9.9\\n');
 fs.mkdirSync(${JSON.stringify(join(root, 'archive-input', 'node_modules'))},{recursive:true});
 process.stdout.write(execFileSync('tar',['-cf','-','node_modules'],{cwd:${JSON.stringify(join(root, 'archive-input'))}}));
}
`;
  await writeFile(join(binary, 'docker'), fake);
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  const calls = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    root,
    repository,
    log,
    calls,
    options: { repository, image: 'local-node:test', cacheDirectory: join(root, 'cache') },
  };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('accepts dependency links inside node_modules and rejects links that escape its physical root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-dependency-tree-test-'));
  roots.push(root);
  const nodeModules = join(root, 'node_modules');
  const packageDirectory = join(nodeModules, 'package');
  const outside = join(root, 'outside');
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(outside);
  await writeFile(join(packageDirectory, 'index.js'), 'export {};');
  await symlink(packageDirectory, join(nodeModules, 'internal'), 'dir');
  const check = () =>
    execute(process.execPath, ['--input-type=module', '-e', DEPENDENCY_TREE_CHECK], { cwd: root });
  await check();
  await symlink(outside, join(nodeModules, 'escape'), 'dir');
  await expect(check()).rejects.toThrow(/Dependency link escapes node_modules/);
  await rm(nodeModules, { recursive: true });
  await symlink(outside, nodeModules, 'dir');
  await expect(check()).rejects.toThrow(/node_modules must be a physical directory/);
});

it(
  'uses manifest-only input and restricted networked Docker, verifies cached bytes and does not reinstall unchanged inputs',
  async () => {
    const fixture = await setup();
    const prepared = await prepareNpmDependencies(fixture.options);
    expect(prepared).toMatchObject({ reused: false, environment: { image: IMAGE, packages: 0 } });
    expect((await verifyArtifacts(prepared.directory)).kind).toBe('refit-npm-environment');
    const run = (await fixture.calls()).find((call) => call.args[0] === 'run');
    expect(run.inputs.sort()).toEqual(['package-lock.json', 'package.json']);
    expect(run.args).toEqual(
      expect.arrayContaining([
        '--network',
        'bridge',
        '--read-only',
        '--pull',
        'never',
        '--user',
        '65534:65534',
        '--cap-drop',
        'ALL',
        '--memory',
        '1g',
      ]),
    );
    expect(run.args.at(-1)).toContain(
      'npm ci --ignore-scripts --include=dev --engine-strict --no-audit --no-fund',
    );
    expect(JSON.stringify(run.args)).not.toContain(fixture.repository);
    expect((await prepareNpmDependencies(fixture.options)).reused).toBe(true);
    expect((await fixture.calls()).filter((call) => call.args[0] === 'run')).toHaveLength(1);
  },
  NATIVE_PROCESS_TEST_TIMEOUT_MS,
);

it('invalidates dependencies when committed inputs or the immutable image change and refuses tampered cache bytes', async () => {
  const fixture = await setup();
  const first = await prepareNpmDependencies(fixture.options);
  await writeFile(
    join(fixture.repository, 'package.json'),
    JSON.stringify({ ...INITIAL_MANIFEST, scripts: { test: 'node --version' } }),
  );
  await commit(fixture.repository);
  const changed = await prepareNpmDependencies(fixture.options);
  const otherImage = await prepareNpmDependencies({
    ...fixture.options,
    image: `sha256:${'b'.repeat(64)}`,
  });
  expect(new Set([first.directory, changed.directory, otherImage.directory]).size).toBe(3);
  await writeFile(otherImage.archive, 'tampered archive');
  await expect(
    prepareNpmDependencies({ ...fixture.options, image: `sha256:${'b'.repeat(64)}` }),
  ).rejects.toThrow(/hash or byte count mismatch/);
  expect((await fixture.calls()).filter((call) => call.args[0] === 'run')).toHaveLength(3);
});

it('refuses an incomplete existing cache instead of silently reinstalling it', async () => {
  const fixture = await setup();
  const prepared = await prepareNpmDependencies(fixture.options);
  await rm(prepared.archive);
  await expect(prepareNpmDependencies(fixture.options)).rejects.toThrow(/cache is incomplete/);
  expect((await fixture.calls()).filter((call) => call.args[0] === 'run')).toHaveLength(1);
});

it('refuses a cache-key directory symlink into a repository before writing its lock or bundle', async () => {
  const fixture = await setup();
  const prepared = await prepareNpmDependencies(fixture.options);
  const keyDirectory = dirname(prepared.directory);
  await rm(keyDirectory, { recursive: true });
  await symlink(fixture.repository, keyDirectory);
  await expect(prepareNpmDependencies(fixture.options)).rejects.toThrow(/physical directories/);
  await expect(stat(join(fixture.repository, 'prepare.lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each(['fail', 'verbose'])(
  'cleans up failed or excessive installation output without publishing a cache: %s',
  async (mode) => {
    const fixture = await setup();
    vi.stubEnv('REFIT_TEST_INSTALL_MODE', mode);
    await expect(prepareNpmDependencies(fixture.options)).rejects.toThrow(
      mode === 'fail' ? /simulated npm failure/ : /output exceeds 1 MiB/,
    );
    const [key] = await readdir(fixture.options.cacheDirectory);
    expect(await readdir(join(fixture.options.cacheDirectory, key))).toEqual([]);
    expect((await fixture.calls()).some((call) => call.args[0] === 'rm')).toBe(true);
  },
);

it('cancels an in-flight Docker client, removes its container and leaves no reusable partial bundle', async () => {
  const fixture = await setup();
  vi.stubEnv('REFIT_TEST_INSTALL_MODE', 'wait');
  const controller = new AbortController();
  const preparation = prepareNpmDependencies({ ...fixture.options, signal: controller.signal });
  const rejection = expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
  await expect
    .poll(async () =>
      (await fixture.calls().catch(() => [])).some((call) => call.args[0] === 'run'),
    )
    .toBe(true);
  controller.abort();
  await rejection;
  const [key] = await readdir(fixture.options.cacheDirectory);
  expect(await readdir(join(fixture.options.cacheDirectory, key))).toEqual([]);
  expect((await fixture.calls()).some((call) => call.args[0] === 'rm')).toBe(true);
});

it.skipIf(!process.env.REFIT_NPM_PREPARE || !process.env.REFIT_BILLING_REPOSITORY)(
  'installs actual locked packages without root lifecycle scripts or repository npm configuration and uses them offline',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-npm-docker-evaluation-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await mkdir(repository);
    const original = resolve(process.env.REFIT_BILLING_REPOSITORY!);
    const manifest = JSON.parse(await readFile(join(original, 'package.json'), 'utf8'));
    manifest.scripts = {
      postinstall:
        "node -e \"require('node:fs').writeFileSync('node_modules/refit-script-ran', 'bad')\"",
    };
    await writeFile(join(repository, 'package.json'), JSON.stringify(manifest));
    await writeFile(
      join(repository, 'package-lock.json'),
      await readFile(join(original, 'package-lock.json')),
    );
    await writeFile(join(repository, '.npmrc'), 'registry=http://127.0.0.1:1\n');
    await execute('git', ['init', repository]);
    await commit(repository);
    const prepared = await prepareNpmDependencies({
      repository,
      image: process.env.REFIT_DOCKER_IMAGE ?? 'node:22-alpine',
      cacheDirectory: join(root, 'cache'),
    });
    expect(prepared.environment.packages).toBeGreaterThan(0);
    const input = join(root, 'empty-input');
    await mkdir(input);
    const name = `refit-offline-dependencies-${randomUUID()}`;
    try {
      const result = await execute(
        'docker',
        dockerSandboxArguments({
          name,
          directory: input,
          image: String(prepared.environment.image),
          dependencies: prepared.archive,
          network: 'none',
          command: [
            'node',
            '-e',
            `const assert=require('node:assert/strict');const fs=require('node:fs');assert.equal(typeof require('stripe'),'function');assert.equal(fs.existsSync('node_modules/refit-script-ran'),false);assert.equal(fs.existsSync('.npmrc'),false);console.log('Prepared Stripe dependencies work offline; install script did not run.');`,
          ],
        }),
        { timeout: 30_000 },
      );
      expect(result.stdout).toContain('install script did not run');
    } finally {
      await removeDockerContainer(name);
    }
    expect(
      (
        await prepareNpmDependencies({
          repository,
          image: String(prepared.environment.image),
          cacheDirectory: join(root, 'cache'),
        })
      ).reused,
    ).toBe(true);
  },
  120_000,
);

it.skipIf(!process.env.REFIT_NPM_PREPARE || !process.env.REFIT_BILLING_REPOSITORY)(
  'validates the independent billing migration with prepared dependencies, unchanged tests, 103 attempts and empty history',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-npm-billing-workflow-'));
    roots.push(root);
    vi.stubEnv('REFIT_DEPENDENCY_CACHE_DIRECTORY', join(root, 'cache'));
    const harness = await readFile(resolve('pipeline/fixtures/billing-pagination.mjs'), 'utf8');
    const repository = resolve(process.env.REFIT_BILLING_REPOSITORY!);
    const originalTest = await readFile(join(repository, 'test/billing.test.ts'), 'utf8');
    const result = await runWorkflow({
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      apiVersion: '2022-08-01',
      image: process.env.REFIT_DOCKER_IMAGE ?? 'node:22-alpine',
      prepareDependencies: true,
      output: join(root, 'evidence'),
      baselineCommand: [
        'sh',
        '-c',
        'npm test && node --import tsx --input-type=module --eval "$1" refit-harness before',
        'refit-checks',
        harness,
      ],
      command: [
        'sh',
        '-c',
        'npm test && npm run test:after && npm run typecheck && node --import tsx --input-type=module --eval "$1" refit-harness before && node --import tsx --input-type=module --eval "$1" refit-harness after',
        'refit-checks',
        harness,
      ],
      signal: AbortSignal.timeout(90_000),
    });
    expect(result.manifest.status).toBe('validated');
    const report = JSON.parse(await readFile(join(result.directory, 'report.json'), 'utf8'));
    expect(report.validation.environment).toMatchObject({
      installation: { lifecycleScripts: false, network: 'bridge' },
      validation: { network: 'none' },
    });
    expect(report.validation.baseline.stdout).toContain('103 attempts; empty history preserved');
    expect(report.validation.patched.stdout).toContain('103 attempts; empty history preserved');
    expect(report.validation.patched.stdout).toContain('pass 14');
    expect(await readFile(join(repository, 'test/billing.test.ts'), 'utf8')).toBe(originalTest);
    expect((await execute('git', ['-C', repository, 'status', '--porcelain'])).stdout).toBe('');
    expect((await verifyArtifacts(result.directory)).status).toBe('integrity-verified');
  },
  120_000,
);
