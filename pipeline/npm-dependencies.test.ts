import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cacheLimitBytes,
  DEPENDENCY_TREE_CHECK,
  evictDependencies,
  GLIBC_PACKAGE_PRUNE,
  prepareDependencies,
} from './dependency-preparation.ts';
import {
  dockerSandboxArguments,
  removeDockerContainer,
  preparationProfile,
  validationProfile,
} from './docker-sandbox.ts';
import { legacyPeerDeps } from './dependency-inputs.ts';
import { withStateLock } from './state-files.ts';
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
let inputFiles;
if(args[0]==='run') {
 const mount=args[args.indexOf('--mount')+1];
 const directory=mount.slice('type=bind,src='.length,mount.indexOf(',dst='));
 inputs=fs.readdirSync(directory);
 const files=(prefix='')=>fs.readdirSync(directory+'/'+prefix,{withFileTypes:true}).flatMap(entry=>{const name=prefix+entry.name;return entry.isDirectory()?files(name+'/'):[name]});
 inputFiles=files();
}
fs.appendFileSync(log,JSON.stringify({args,inputs,inputFiles})+'\\n');
if(args[0]==='image'){console.log(${JSON.stringify(IMAGE)});process.exit(0)}
if(args[0]==='rm'||args[0]==='ps')process.exit(0);
if(process.env.REFIT_TEST_INSTALL_MODE==='wait'){setInterval(()=>{},1000)}
else if(process.env.REFIT_TEST_INSTALL_MODE==='fail'){process.stderr.write('REFIT_NODE_VERSION=v22.23.3\\nREFIT_NPM_VERSION=10.9.9\\nsimulated npm failure\\n');process.exitCode=42}
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
    const prepared = await prepareDependencies(fixture.options);
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
        '5g',
        '--tmpfs',
        '/workspace:rw,exec,size=4g,uid=65534,gid=65534,mode=0700',
      ]),
    );
    expect(prepared.environment.installation).toMatchObject({ workspace: '4g' });
    expect(
      run.args.find((argument: string) => argument.includes('npm ci --ignore-scripts')),
    ).toContain('npm ci --ignore-scripts --include=dev --engine-strict --no-audit --no-fund');
    // Tarballs a lockfile resolved through a public mirror are fetched from the public registry.
    expect(run.args.find((argument: string) => argument.includes('npm ci'))).toContain(
      '--registry=https://registry.npmjs.org --replace-registry-host=always',
    );
    expect(JSON.stringify(run.args)).not.toContain(fixture.repository);
    expect((await prepareDependencies(fixture.options)).reused).toBe(true);
    expect((await fixture.calls()).filter((call) => call.args[0] === 'run')).toHaveLength(1);
  },
  NATIVE_PROCESS_TEST_TIMEOUT_MS,
);

it('honours only legacy-peer-deps from a committed .npmrc and keys the cache on it', async () => {
  const fixture = await setup();
  const command = (call: { args: string[] }) =>
    call.args.find((argument) => argument.includes('npm ci --ignore-scripts'))!;
  const plain = await prepareDependencies(fixture.options);
  await writeFile(
    join(fixture.repository, '.npmrc'),
    'registry=http://127.0.0.1:1\n; comment\nlegacy-peer-deps = true\n',
  );
  await commit(fixture.repository);
  const relaxed = await prepareDependencies(fixture.options);
  expect(relaxed.directory).not.toBe(plain.directory);
  const [first, second] = (await fixture.calls()).filter((call) => call.args[0] === 'run');
  expect(command(first)).toContain('REFIT_LEGACY_PEER_DEPS=1');
  expect(command(second)).not.toContain('REFIT_LEGACY_PEER_DEPS=1');
  expect(command(second)).toContain(
    '--cache=/workspace/.npm-cache --legacy-peer-deps >&2; mkdir -p node_modules;',
  );
  expect(command(second)).toContain('--registry=https://registry.npmjs.org');
  expect(second.inputs.sort()).toEqual(['package-lock.json', 'package.json']);
  expect(legacyPeerDeps('legacy-peer-deps=false\n#legacy-peer-deps=true')).toBe(false);
  expect(legacyPeerDeps('legacy-peer-deps=true\r\n')).toBe(true);
});

it('invalidates dependencies when committed inputs or the immutable image change and refuses tampered cache bytes', async () => {
  const fixture = await setup();
  const first = await prepareDependencies(fixture.options);
  await writeFile(
    join(fixture.repository, 'package.json'),
    JSON.stringify({ ...INITIAL_MANIFEST, scripts: { test: 'node --version' } }),
  );
  await commit(fixture.repository);
  const changed = await prepareDependencies(fixture.options);
  const otherImage = await prepareDependencies({
    ...fixture.options,
    image: `sha256:${'b'.repeat(64)}`,
  });
  expect(new Set([first.directory, changed.directory, otherImage.directory]).size).toBe(3);
  await writeFile(otherImage.archive, 'tampered archive');
  await expect(
    prepareDependencies({ ...fixture.options, image: `sha256:${'b'.repeat(64)}` }),
  ).rejects.toThrow(/hash or byte count mismatch/);
  expect((await fixture.calls()).filter((call) => call.args[0] === 'run')).toHaveLength(3);
});

it('refuses an incomplete existing cache instead of silently reinstalling it', async () => {
  const fixture = await setup();
  const prepared = await prepareDependencies(fixture.options);
  await rm(prepared.archive);
  await expect(prepareDependencies(fixture.options)).rejects.toThrow(/cache is incomplete/);
  expect((await fixture.calls()).filter((call) => call.args[0] === 'run')).toHaveLength(1);
});

it('refuses a cache-key directory symlink into a repository before writing its lock or bundle', async () => {
  const fixture = await setup();
  const prepared = await prepareDependencies(fixture.options);
  const keyDirectory = dirname(prepared.directory);
  await rm(keyDirectory, { recursive: true });
  await symlink(fixture.repository, keyDirectory);
  await expect(prepareDependencies(fixture.options)).rejects.toThrow(/physical directories/);
  await expect(stat(join(fixture.repository, 'prepare.lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each(['fail', 'verbose'])(
  'cleans up failed or excessive installation output without publishing a cache: %s',
  async (mode) => {
    const fixture = await setup();
    vi.stubEnv('REFIT_TEST_INSTALL_MODE', mode);
    await expect(prepareDependencies(fixture.options)).rejects.toThrow(
      mode === 'fail'
        ? /^npm dependency preparation failed \(42\)\. simulated npm failure\n$/
        : /output exceeds 1 MiB/,
    );
    const [key] = await readdir(fixture.options.cacheDirectory);
    expect(await readdir(join(fixture.options.cacheDirectory, key))).toEqual([]);
    expect((await fixture.calls()).some((call) => call.args[0] === 'rm')).toBe(true);
  },
);

it(
  'cancels an in-flight Docker client, removes its container and leaves no reusable partial bundle',
  async () => {
    const fixture = await setup();
    vi.stubEnv('REFIT_TEST_INSTALL_MODE', 'wait');
    const controller = new AbortController();
    const preparation = prepareDependencies({ ...fixture.options, signal: controller.signal });
    const rejection = expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    await expect
      .poll(
        async () => (await fixture.calls().catch(() => [])).some((call) => call.args[0] === 'run'),
        // The fake Docker client starts after git and image checks; under full-suite load that can
        // exceed poll's 1 s default, abandoning a preparation whose fixture is then deleted.
        { timeout: NATIVE_PROCESS_TEST_TIMEOUT_MS },
      )
      .toBe(true);
    controller.abort();
    await rejection;
    const [key] = await readdir(fixture.options.cacheDirectory);
    expect(await readdir(join(fixture.options.cacheDirectory, key))).toEqual([]);
    expect((await fixture.calls()).some((call) => call.args[0] === 'rm')).toBe(true);
  },
  NATIVE_PROCESS_TEST_TIMEOUT_MS,
);

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
    const prepared = await prepareDependencies({
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
          timeoutMs: 120_000,
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
        await prepareDependencies({
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

it('allows only exact locked workspace links and checks nested dependency roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-workspace-tree-'));
  roots.push(root);
  const workspace = join(root, 'packages', 'billing');
  const nodeModules = join(root, 'node_modules');
  await mkdir(join(nodeModules, '@demo'), { recursive: true });
  await mkdir(join(workspace, 'node_modules', 'dependency'), { recursive: true });
  await mkdir(join(root, 'packages', 'other'), { recursive: true });
  const linked = join(nodeModules, '@demo', 'billing');
  await symlink('../../packages/billing', linked, 'dir');
  const metadata = {
    links: { 'node_modules/@demo/billing': 'packages/billing' },
    directories: ['packages/billing'],
  };
  const check = (value: { links: Record<string, string>; directories: string[] } = metadata) =>
    execute(
      process.execPath,
      ['--input-type=module', '-e', DEPENDENCY_TREE_CHECK, JSON.stringify(value)],
      { cwd: root },
    );
  await check();
  await rm(linked);
  await symlink('../../packages/other', linked, 'dir');
  await expect(check()).rejects.toThrow(/Workspace link differs/);
  await rm(linked);
  await symlink('../../packages/billing', linked, 'dir');
  await expect(check({ links: {}, directories: ['packages/billing'] })).rejects.toThrow(
    /escapes node_modules/,
  );
  await symlink(join(root, 'packages', 'other'), join(workspace, 'node_modules', 'escape'), 'dir');
  await expect(check()).rejects.toThrow(/escapes node_modules/);
});

it('copies only committed workspace manifests to the networked install input', async () => {
  const sample = await setup();
  const manifest = { ...INITIAL_MANIFEST, workspaces: ['packages/*'] };
  const workspace = { name: '@demo/library', version: '1.0.0' };
  await mkdir(join(sample.repository, 'packages/library'), { recursive: true });
  await writeFile(join(sample.repository, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    join(sample.repository, 'packages/library/package.json'),
    JSON.stringify(workspace),
  );
  await writeFile(
    join(sample.repository, 'packages/library/source.ts'),
    'export const source = true;',
  );
  await writeFile(
    join(sample.repository, 'packages/library/.npmrc'),
    'registry=http://127.0.0.1:1',
  );
  await writeFile(join(sample.repository, 'packages/library/.env'), 'PRIVATE_FIXTURE=value');
  await writeFile(
    join(sample.repository, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': manifest,
        'packages/library': workspace,
        'node_modules/@demo/library': { link: true, resolved: 'packages/library' },
      },
    }),
  );
  await commit(sample.repository);
  await prepareDependencies(sample.options);
  const install = (await sample.calls()).find((call) => call.args[0] === 'run');
  expect(install.inputFiles.sort()).toEqual([
    'package-lock.json',
    'package.json',
    'packages/library/package.json',
  ]);
});

it('runs validation containers on the default 4 GiB workspace and 5 GiB memory, offline', () => {
  const args = dockerSandboxArguments({
    name: 'refit-check',
    directory: '/input',
    image: IMAGE,
    command: ['npm', 'test'],
    network: 'none',
    timeoutMs: 120_000,
  });
  expect(args).toContain('/workspace:rw,exec,size=4g,uid=65534,gid=65534,mode=0700');
  expect(args[args.indexOf('--memory') + 1]).toBe('5g');
  expect(args[args.indexOf('--network') + 1]).toBe('none');
  expect(args[args.indexOf('--env') + 1]).toBe('CI=true');
});

it('sizes validation only through a known REFIT_VALIDATION_WORKSPACE profile', () => {
  expect(validationProfile(undefined)).toEqual({
    workspace: '4g',
    memory: '5g',
    archiveBytes: 2048 * 1024 * 1024,
  });
  expect(validationProfile('512m')).toEqual({
    workspace: '512m',
    memory: '1g',
    archiveBytes: 256 * 1024 * 1024,
  });
  expect(validationProfile('2g')).toEqual({
    workspace: '2g',
    memory: '3g',
    archiveBytes: 1024 * 1024 * 1024,
  });
  expect(validationProfile('4g')).toEqual({
    workspace: '4g',
    memory: '5g',
    archiveBytes: 2048 * 1024 * 1024,
  });
  for (const value of ['8g', '512', 'large'])
    expect(() => validationProfile(value), value).toThrow('REFIT_VALIDATION_WORKSPACE');
  const previous = process.env.REFIT_VALIDATION_WORKSPACE;
  process.env.REFIT_VALIDATION_WORKSPACE = '1g';
  try {
    const args = dockerSandboxArguments({
      name: 'refit-check',
      directory: '/input',
      image: IMAGE,
      command: ['npm', 'test'],
      network: 'none',
      timeoutMs: 120_000,
    });
    expect(args).toContain('/workspace:rw,exec,size=1g,uid=65534,gid=65534,mode=0700');
    expect(args[args.indexOf('--memory') + 1]).toBe('2g');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(preparationProfile()).toEqual({ workspace: '2g', memory: '3g' });
    process.env.REFIT_VALIDATION_WORKSPACE = '4g';
    expect(preparationProfile()).toEqual({ workspace: '4g', memory: '5g' });
    const large = dockerSandboxArguments({
      name: 'refit-check',
      directory: '/input',
      image: IMAGE,
      command: ['npm', 'test'],
      network: 'none',
      timeoutMs: 120_000,
    });
    expect(large).toContain('/workspace:rw,exec,size=4g,uid=65534,gid=65534,mode=0700');
    expect(large[large.indexOf('--memory') + 1]).toBe('5g');
    expect(large[large.indexOf('--network') + 1]).toBe('none');
    for (const flag of ['--read-only', '--cap-drop', '--pids-limit', '--cpus'])
      expect(large).toContain(flag);
  } finally {
    if (previous === undefined) delete process.env.REFIT_VALIDATION_WORKSPACE;
    else process.env.REFIT_VALIDATION_WORKSPACE = previous;
  }
});

const GIB = 1024 ** 3;
const imageId = (character: string) => `sha256:${character.repeat(64)}`;

// Prepares one bundle per image and dates their last use in the given order, oldest first.
async function bundles(fixture: Awaited<ReturnType<typeof setup>>, characters: string[]) {
  const prepared = [];
  for (const [index, character] of characters.entries()) {
    const bundle = await prepareDependencies({ ...fixture.options, image: imageId(character) });
    const used = new Date(Date.UTC(2026, 0, 1 + index));
    await utimes(bundle.directory, used, used);
    prepared.push(bundle);
  }
  return prepared;
}
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)),
  );

it('parses REFIT_DEPENDENCY_CACHE_GIB as whole GiB and refuses a bad value before installing', async () => {
  expect(cacheLimitBytes(undefined)).toBe(8 * GIB);
  expect(cacheLimitBytes('  ')).toBe(8 * GIB);
  expect(cacheLimitBytes('1')).toBe(GIB);
  expect(cacheLimitBytes(' 16 ')).toBe(16 * GIB);
  expect(cacheLimitBytes('1024')).toBe(1024 * GIB);
  for (const value of ['0', '1025', '-1', '1.5', '8g', '8GiB', '0x10', '1e1', '08.0', 'eight'])
    expect(() => cacheLimitBytes(value), value).toThrow(
      'REFIT_DEPENDENCY_CACHE_GIB must be a whole number of GiB from 1 to 1024.',
    );
  const fixture = await setup();
  vi.stubEnv('REFIT_DEPENDENCY_CACHE_GIB', '0.5');
  await expect(prepareDependencies(fixture.options)).rejects.toThrow(/REFIT_DEPENDENCY_CACHE_GIB/);
  await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('evicts least recently used bundles until the cache fits, counting a reuse as use', async () => {
  const fixture = await setup();
  const [a, b, c, d] = await bundles(fixture, ['a', 'b', 'c', 'd']);
  // Reusing the oldest makes it the most recently used.
  expect((await prepareDependencies({ ...fixture.options, image: imageId('a') })).reused).toBe(
    true,
  );
  const bytes = (await lstat(a.archive)).size;
  const cache = await realpath(fixture.options.cacheDirectory);
  const keep = dirname(d.directory);
  // Room for a little over two bundles: b, then c, must go; a was just used and d is kept.
  const result = await evictDependencies(cache, keep, bytes * 2 + bytes / 2);
  console.log('eviction', { bytes, result });
  expect(result.evicted).toEqual([dirname(b.directory), dirname(c.directory)]);
  expect(result.bytes).toBeLessThanOrEqual(bytes * 2 + bytes / 2);
  expect(await exists(b.directory)).toBe(false);
  expect(await exists(c.directory)).toBe(false);
  expect(await readdir(dirname(b.directory))).toEqual([]);
  expect((await verifyArtifacts(a.directory)).kind).toBe('refit-npm-environment');
  // The kept entry survives even a limit it alone exceeds.
  expect((await evictDependencies(cache, keep, 0)).evicted).toEqual([dirname(a.directory)]);
  expect((await verifyArtifacts(d.directory)).kind).toBe('refit-npm-environment');
  // An evicted bundle is rebuilt, not refused as an incomplete cache.
  const rebuilt = await prepareDependencies({ ...fixture.options, image: imageId('b') });
  expect(rebuilt.reused).toBe(false);
  expect((await fixture.calls()).filter((call) => call.args[0] === 'run')).toHaveLength(5);
});

it('never evicts a bundle whose lock another live process holds, and evicts it once released', async () => {
  const fixture = await setup();
  const [a, b] = await bundles(fixture, ['a', 'b']);
  const cache = await realpath(fixture.options.cacheDirectory);
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    // The lock file another job process leaves while it prepares, reuses or copies the bundle.
    await writeFile(
      join(dirname(a.directory), 'prepare.lock'),
      JSON.stringify({ pid: holder.pid, host: hostname(), nonce: randomUUID() }),
    );
    const result = await evictDependencies(cache, dirname(b.directory), 0);
    expect(result.evicted).toEqual([]);
    expect((await verifyArtifacts(a.directory)).kind).toBe('refit-npm-environment');
  } finally {
    holder.kill('SIGKILL');
  }
  await new Promise((resolve) => holder.once('exit', resolve));
  // A dead owner's lock is recovered, so the bundle is no longer in use.
  expect((await evictDependencies(cache, dirname(b.directory), 0)).evicted).toEqual([
    dirname(a.directory),
  ]);
  expect(await exists(a.directory)).toBe(false);
});

it('skips a bundle reused between listing and eviction', async () => {
  const fixture = await setup();
  const [a, b] = await bundles(fixture, ['a', 'b']);
  const cache = await realpath(fixture.options.cacheDirectory);
  const root = dirname(a.directory);
  // Hold a's lock as a reader would, and touch the bundle once eviction has listed it.
  let release!: () => void;
  const reading = withStateLock(root, 'prepare', async () => {
    await new Promise<void>((resolve) => (release = resolve));
    const now = new Date();
    await utimes(a.directory, now, now);
  });
  const eviction = evictDependencies(cache, dirname(b.directory), 0);
  await expect.poll(() => typeof release).toBe('function');
  release();
  await reading;
  // Either eviction met the lock, or it found a later use than it listed: a stays either way.
  expect((await eviction).evicted).toEqual([]);
  expect((await verifyArtifacts(a.directory)).kind).toBe('refit-npm-environment');
});

it('keeps concurrent reuse and eviction safe: a reader copies a whole archive, rebuilds or meets the lock', async () => {
  const fixture = await setup();
  // A 900 KiB archive (the fake Docker client buffers at most 1 MiB) keeps the reader inside its
  // lock (verify, touch, copy) long enough to race.
  await mkdir(join(fixture.root, 'archive-input', 'node_modules'), { recursive: true });
  await writeFile(
    join(fixture.root, 'archive-input', 'node_modules', 'large.bin'),
    Buffer.alloc(900 * 1024, 7),
  );
  const [a] = await bundles(fixture, ['a', 'b']);
  const expected = await readFile(a.archive);
  const cache = await realpath(fixture.options.cacheDirectory);
  const lock = join(dirname(a.directory), 'prepare.lock');
  const outcomes: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    const destination = join(fixture.root, `copy-${round}.tar`);
    const readerFirst = round % 2 === 0;
    const reuse = prepareDependencies({
      ...fixture.options,
      image: imageId('a'),
      copyArchiveTo: destination,
    });
    let held = false;
    if (readerFirst)
      while (!(held = await exists(lock)))
        if (await Promise.race([reuse.then(() => true), new Promise((r) => setImmediate(r))]))
          break;
    const [reused, eviction] = await Promise.allSettled([
      reuse,
      evictDependencies(cache, join(cache, 'none'), 0),
    ]);
    if (eviction.status === 'rejected') throw eviction.reason;
    let outcome;
    if (reused.status === 'fulfilled') {
      // Whatever eviction did afterwards, the copy made under the lock is complete.
      expect(await readFile(destination)).toEqual(expected);
      outcome = reused.value.reused ? 'reused' : 'rebuilt';
    } else {
      // The evictor held the lock for its rename: the reader stops, and nothing is corrupted.
      expect(reused.reason.message).toMatch(/State is locked by active process/);
      outcome = 'locked';
    }
    const kept = !eviction.value.evicted.includes(dirname(a.directory));
    outcomes.push(
      `${readerFirst ? 'reader first' : 'together'}: ${outcome}, ${kept ? 'kept' : 'evicted'}${held ? ' (lock seen)' : ''}`,
    );
    // No round leaves a partial bundle behind: the next preparation reuses or rebuilds.
    const next = await prepareDependencies({ ...fixture.options, image: imageId('a') });
    expect((await verifyArtifacts(next.directory)).kind).toBe('refit-npm-environment');
  }
  console.log('concurrent reuse and eviction outcomes', outcomes);
  // At least one eviction ran while a reader held the bundle and left it in place.
  expect(outcomes).toContainEqual(
    expect.stringMatching(/^reader first: reused, kept \(lock seen\)$/),
  );
}, 60_000);

it('evicts old bundles after preparing a new one, under REFIT_DEPENDENCY_CACHE_GIB', async () => {
  const fixture = await setup();
  const cache = fixture.options.cacheDirectory;
  // A stale entry larger than the 1 GiB limit (sparse, so it uses no disk).
  const stale = join(cache, 'f'.repeat(64));
  await mkdir(join(stale, 'bundle'), { recursive: true });
  await writeFile(join(stale, 'bundle', 'dependencies.tar'), '');
  await truncate(join(stale, 'bundle', 'dependencies.tar'), GIB + 1);
  const old = new Date(Date.UTC(2026, 0, 1));
  await utimes(join(stale, 'bundle'), old, old);
  await writeFile(join(cache, 'not-an-entry.txt'), 'left alone');
  vi.stubEnv('REFIT_DEPENDENCY_CACHE_GIB', '1');
  const messages: string[] = [];
  const prepared = await prepareDependencies({
    ...fixture.options,
    onProgress: (message) => messages.push(message),
  });
  expect(prepared.reused).toBe(false);
  expect(await readdir(stale)).toEqual([]);
  expect(await readFile(join(cache, 'not-an-entry.txt'), 'utf8')).toBe('left alone');
  expect(messages).toContainEqual(
    expect.stringMatching(
      /^Evicted 1 least recently used dependency bundles; the cache holds 0\.0 GiB\.$/,
    ),
  );
  expect((await prepareDependencies(fixture.options)).reused).toBe(true);
});

it('removes glibc-only native packages npm installed on a musl image, and nothing else', async () => {
  // nizzyabi/nizzy-starter at 66afada: its lockfile records no libc, so npm ci on node:22-alpine
  // installed @next/swc and @swc/core for both libcs (253 of 1205 MiB), twice for react-email's Next.
  const root = await mkdtemp(join(tmpdir(), 'refit-glibc-prune-test-'));
  roots.push(root);
  const manifests: Record<string, object> = {
    'node_modules/@next/swc-linux-x64-gnu': {
      name: '@next/swc-linux-x64-gnu',
      os: ['linux'],
      cpu: ['x64'],
      libc: ['glibc'],
    },
    'node_modules/@next/swc-linux-x64-musl': {
      name: '@next/swc-linux-x64-musl',
      os: ['linux'],
      cpu: ['x64'],
      libc: ['musl'],
    },
    'node_modules/@swc/core-linux-x64-gnu': { name: '@swc/core-linux-x64-gnu', libc: ['glibc'] },
    'node_modules/react-email/node_modules/@next/swc-linux-x64-gnu': {
      name: '@next/swc-linux-x64-gnu',
      libc: ['glibc'],
    },
    'node_modules/react-email/node_modules/next': { name: 'next', bin: { next: 'dist/bin/next' } },
    'node_modules/not-musl': { name: 'not-musl', libc: ['!musl'] },
    'node_modules/not-glibc': { name: 'not-glibc', libc: ['!glibc'] },
    'node_modules/glibc-tool': { name: 'glibc-tool', libc: ['glibc'], bin: 'cli.js' },
    'node_modules/stripe': { name: 'stripe', version: '17.7.0' },
  };
  for (const [directory, manifest] of Object.entries(manifests)) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, 'package.json'), JSON.stringify(manifest));
  }
  await mkdir(join(root, 'node_modules', 'broken'));
  await writeFile(join(root, 'node_modules', 'broken', 'package.json'), '{');
  const { stderr } = await execute(
    process.execPath,
    ['--input-type=module', '-e', GLIBC_PACKAGE_PRUNE],
    { cwd: root },
  );
  console.log(stderr);
  expect(stderr).toContain('REFIT_PRUNED_GLIBC_PACKAGES=4');
  const remaining = async (directory: string) =>
    stat(join(root, directory)).then(
      () => true,
      () => false,
    );
  const kept = Object.fromEntries(
    await Promise.all(
      [...Object.keys(manifests), 'node_modules/broken'].map(async (directory) => [
        directory,
        await remaining(directory),
      ]),
    ),
  );
  expect(kept).toEqual({
    'node_modules/@next/swc-linux-x64-gnu': false,
    'node_modules/@next/swc-linux-x64-musl': true,
    'node_modules/@swc/core-linux-x64-gnu': false,
    'node_modules/react-email/node_modules/@next/swc-linux-x64-gnu': false,
    'node_modules/react-email/node_modules/next': true,
    'node_modules/not-musl': false,
    'node_modules/not-glibc': true,
    'node_modules/glibc-tool': true,
    'node_modules/stripe': true,
    'node_modules/broken': true,
  });
});

it('removes the glibc-only sharp and Next.js builds a second lockfile without libc installs', async () => {
  // alanagoyal/branded at cf8f84c: package-lock.json v3 records @next/swc 15.5.25 and @img/sharp
  // 0.35.4 for both libcs without "libc"; the published manifests declare libc glibc or musl.
  const root = await mkdtemp(join(tmpdir(), 'refit-glibc-prune-test-'));
  roots.push(root);
  const manifests: Record<string, { libc: string[] }> = {
    'node_modules/@next/swc-linux-x64-gnu': { libc: ['glibc'] },
    'node_modules/@next/swc-linux-x64-musl': { libc: ['musl'] },
    'node_modules/@img/sharp-linux-x64': { libc: ['glibc'] },
    'node_modules/@img/sharp-libvips-linux-x64': { libc: ['glibc'] },
    'node_modules/@img/sharp-linuxmusl-x64': { libc: ['musl'] },
    'node_modules/@img/sharp-libvips-linuxmusl-x64': { libc: ['musl'] },
  };
  for (const [directory, manifest] of Object.entries(manifests)) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(
      join(root, directory, 'package.json'),
      JSON.stringify({ name: directory.slice('node_modules/'.length), os: ['linux'], ...manifest }),
    );
  }
  const { stderr } = await execute(
    process.execPath,
    ['--input-type=module', '-e', GLIBC_PACKAGE_PRUNE],
    { cwd: root },
  );
  expect(stderr).toContain('REFIT_PRUNED_GLIBC_PACKAGES=3');
  const kept = await Promise.all(
    Object.keys(manifests).map((directory) =>
      stat(join(root, directory)).then(
        () => directory,
        () => undefined,
      ),
    ),
  );
  expect(kept.filter(Boolean)).toEqual([
    'node_modules/@next/swc-linux-x64-musl',
    'node_modules/@img/sharp-linuxmusl-x64',
    'node_modules/@img/sharp-libvips-linuxmusl-x64',
  ]);
});
