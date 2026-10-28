import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { DependencyPreparationError } from './dependency-preparation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const REFUSAL =
  'Automatic preparation supports public npm registry dependencies only; package.json declares kit as "github:acme/kit#v1". Local, Git and URL dependencies need the repository install.';

vi.mock('./dependency-preparation.ts', async (original) => {
  const actual = await original<typeof import('./dependency-preparation.ts')>();
  return {
    ...actual,
    prepareDependencies: vi.fn(async (options: { repository: string }) =>
      process.env.REFIT_TEST_REAL_PREPARATION
        ? actual.prepareDependencies(options as never)
        : Promise.reject(new actual.DependencyPreparationError(REFUSAL)),
    ),
  };
});
const { prepareEnvironment, buildRepositoryEnvironment } =
  await import('./repository-environment.ts');

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function commit(files: Record<string, string>) {
  const repository = await mkdtemp(join(tmpdir(), 'refit-repository-install-'));
  roots.push(repository);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await execute('git', ['init', '-q', repository]);
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=refit@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  return repository;
}

it('keeps the preparation refusal when the repository install is off or cannot start', async () => {
  vi.stubEnv('REFIT_REPOSITORY_INSTALL', '0');
  await expect(
    prepareEnvironment({ repository: '/nowhere', image: 'node:22-alpine' }),
  ).rejects.toThrow(REFUSAL);
  vi.stubEnv('REFIT_REPOSITORY_INSTALL', '1');
  // Not a Git repository: the sandbox never starts, so the original refusal stands.
  const progress: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'refit-not-git-'));
  roots.push(directory);
  await expect(
    prepareEnvironment({
      repository: directory,
      image: 'node:22-alpine',
      onProgress: (message) => progress.push(message),
    }),
  ).rejects.toThrow(REFUSAL);
  expect(progress.at(-1)).toMatch(/^The build sandbox did not run/);
  // A nested package keeps Refit's own preparation only.
  await expect(
    prepareEnvironment({ repository: directory, image: 'node:22-alpine', packageDirectory: 'web' }),
  ).rejects.toBeInstanceOf(DependencyPreparationError);
});

it('refuses a repository that commits no install it recognises', async () => {
  const repository = await commit({ 'README.md': '# none\n' });
  await expect(buildRepositoryEnvironment({ repository, image: 'node:22-alpine' })).rejects.toThrow(
    'commits no install Refit recognises',
  );
});

// Needs Docker and the network: REFIT_DOCKER_IMAGE=node:22-alpine REFIT_NPM_PREPARE=1.
it.runIf(process.env.REFIT_DOCKER_IMAGE && process.env.REFIT_NPM_PREPARE === '1')(
  'installs a GitHub dependency with scripts on, and the proxy refuses a host no file names',
  { timeout: 600_000 },
  async () => {
    vi.stubEnv('REFIT_REPOSITORY_INSTALL', '1');
    const manifest = {
      name: 'git-dependency',
      private: true,
      scripts: {
        postinstall:
          "node -e \"fetch('https://example.com').then(() => 'reached', () => 'refused').then((r) => require('fs').writeFileSync('node_modules/.egress', r))\"",
      },
      dependencies: {
        'is-number': 'github:jonschlinkert/is-number#98e8ff1da1a89f93d1397a24d7413ed15421c139',
      },
    };
    // Written by npm 11 from the manifest above, 2026-10-28.
    const lockfile = {
      name: 'git-dependency',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'git-dependency', hasInstallScript: true, dependencies: manifest.dependencies },
        'node_modules/is-number': {
          version: '7.0.0',
          resolved:
            'git+ssh://git@github.com/jonschlinkert/is-number.git#98e8ff1da1a89f93d1397a24d7413ed15421c139',
          integrity:
            'sha512-zBKG4vl6Xb28YBfMrUK4gYROd7KUrLg5kRs7UqzqFmR8CvEw8vY6FrcDtXeepYb5s0+A2H6oCfv/VCi/KOZgjQ==',
          license: 'MIT',
          engines: { node: '>=0.12.0' },
        },
      },
    };
    const repository = await commit({
      'package.json': JSON.stringify(manifest, null, 2),
      'package-lock.json': JSON.stringify(lockfile, null, 2),
    });
    const archive = join(repository, '..', `${Date.now()}-dependencies.tar`);
    roots.push(archive);
    const built = await prepareEnvironment({
      repository,
      image: process.env.REFIT_DOCKER_IMAGE!,
      copyArchiveTo: archive,
    });
    expect(built.environment).toMatchObject({
      kind: 'refit-repository-environment',
      installation: {
        source: 'lockfile',
        command: ['npm', 'ci'],
        lifecycleScripts: true,
        secrets: false,
        egress: expect.arrayContaining(['registry.npmjs.org', 'github.com', 'codeload.github.com']),
      },
      validation: { network: 'none' },
    });
    const listed = (await execute('tar', ['-tf', archive])).stdout;
    expect(listed).toContain('./node_modules/is-number/package.json');
    const egress = await execute('tar', ['-xOf', archive, './node_modules/.egress']);
    expect(egress.stdout).toBe('refused');
    expect((await readFile(archive)).length).toBe(built.environment.archiveBytes);
  },
);

it('refuses hosts off the allowlist, and allowlisted names that resolve to private addresses', async () => {
  const { spawn } = await import('node:child_process');
  const { connect } = await import('node:net');
  const { PROXY_SCRIPT } = await import('./repository-environment.ts');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const proxy = spawn(process.execPath, [
    '-e',
    PROXY_SCRIPT,
    JSON.stringify(['localhost']),
    String(port),
  ]);
  let log = '';
  proxy.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
  try {
    for (let attempt = 0; attempt < 100 && !log.includes('REFIT_PROXY_READY'); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const tunnel = (target: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(port, '127.0.0.1', () =>
          socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
        );
        let reply = '';
        socket.on('data', (chunk) => (reply += chunk.toString()));
        socket.on('close', () => resolve(reply));
        socket.on('error', () => resolve(reply));
      });
    // localhost is allowlisted but resolves to a loopback address.
    expect(await tunnel('localhost:443')).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel('example.org:443')).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel('127.0.0.1:443')).toMatch(/^HTTP\/1\.1 403/);
    expect(log).toContain('REFIT_DENIED=localhost');
    expect(log).toContain('REFIT_DENIED=example.org');
  } finally {
    proxy.kill();
    await new Promise((resolve) => proxy.once('exit', resolve));
  }
});
