import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  IMAGE_PACKAGE_CHANGE,
  LINK_SCRIPT,
  linkImageNodeModules,
  validateImageNodeModules,
} from './customer-image.ts';
import { preparationStop } from './preparation-stops.ts';
import { readEvidence } from './state-files.ts';
import { validateMigration, validateSourcePatch } from './validation.ts';
import { parseWorkflowConfiguration } from './workflow-configuration.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const FAKE_IMAGE = `sha256:${'e'.repeat(64)}`;
const NODE_MODULES = '/opt/app/node_modules';

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'refit-customer-image-'));
  roots.push(root);
  return root;
}

async function commit(repository: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await execute('git', ['init', '-q', repository]);
  await execute('git', ['-C', repository, 'add', '--force', '.']);
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
}

// A docker stand-in whose checks exit 0; every run records its network and the arguments after
// the sandbox script.
async function fakeDocker(root: string) {
  const log = join(root, 'docker.jsonl');
  await mkdir(join(root, 'bin'));
  await writeFile(
    join(root, 'bin', 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args[3] === '{{.Id}}' ? '${FAKE_IMAGE}' : JSON.stringify(['NODE_VERSION=22.23.3'])); process.exit(0); }
if (args[0] !== 'run') process.exit(0);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  network: args[args.indexOf('--network') + 1],
  dependencies: args.some((arg) => arg.includes('dst=/dependencies.tar')),
  tail: args.slice(args.indexOf('refit-check')),
}) + '\\n');
`,
  );
  await chmod(join(root, 'bin', 'docker'), 0o755);
  vi.stubEnv('PATH', join(root, 'bin') + delimiter + process.env.PATH);
  return async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { network: string; dependencies: boolean; tail: string[] },
      );
}

const configuration = {
  formatVersion: 1,
  before: 'before.json',
  after: 'after.json',
  image: 'ghcr.io/refit-dev/example-validation@sha256:' + 'a'.repeat(64),
  imageNodeModules: NODE_MODULES,
  command: ['npm', 'test'],
};

it('reads imageNodeModules as an absolute node_modules path and refuses it beside preparation', () => {
  expect(
    parseWorkflowConfiguration(JSON.stringify(configuration), '/repository/.refit.json'),
  ).toMatchObject({ imageNodeModules: NODE_MODULES, command: ['npm', 'test'] });
  expect(
    parseWorkflowConfiguration(
      JSON.stringify({ ...configuration, imageNodeModules: undefined }),
      '/repository/.refit.json',
    ),
  ).not.toHaveProperty('imageNodeModules');
  for (const value of [
    'opt/app/node_modules',
    '/opt/app',
    '/opt/../etc/node_modules',
    '/opt/./node_modules',
    '/opt/app node_modules/node_modules',
    '/opt/$(id)/node_modules',
    '/opt//node_modules',
    7,
  ])
    expect(() => validateImageNodeModules(value)).toThrow('must be an absolute path');
  expect(() =>
    parseWorkflowConfiguration(
      JSON.stringify({ ...configuration, prepareDependencies: true }),
      '/repository/.refit.json',
    ),
  ).toThrow('remove prepareDependencies');
});

it('links the image directory before the check command, and stops on a node_modules already there', async () => {
  const root = await temporary();
  const image = join(root, 'image', 'node_modules');
  await mkdir(image, { recursive: true });
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const [binary, ...rest] = linkImageNodeModules(['node', '-e', 'console.log("ran")'], image);
  const linked = await execute(binary, rest, { cwd: workspace });
  expect(linked.stdout.trim()).toBe('ran');
  expect(await readlink(join(workspace, 'node_modules'))).toBe(image);
  // A second run finds node_modules, so it exits 125 (a check error) before the command runs.
  const again = await execute(binary, rest, { cwd: workspace }).catch((error) => error);
  expect(again).toMatchObject({ code: 125, stdout: '' });
  expect(again.stderr).toContain('node_modules already exists');
  expect(linkImageNodeModules(['npm', 'test'], undefined)).toEqual(['npm', 'test']);
});

it('points every named preparation stop at imageNodeModules instead of hand-written symlinks', () => {
  for (const message of [
    'Automatic preparation supports public npm registry dependencies only; local, Git and URL dependencies require a custom validation image.',
    'Dependency archive exceeds 1024 MiB.',
  ]) {
    const action = preparationStop(message)!.action;
    expect(action).toContain('"imageNodeModules"');
    expect(action).not.toContain('ln -s');
  }
});

it('validates in the customer image offline with the directory linked and no preparation', async () => {
  const root = await temporary();
  const calls = await fakeDocker(root);
  const repository = join(root, 'repository');
  const manifest = { name: 'billing', private: true, dependencies: { stripe: '^10.0.0' } };
  await commit(repository, {
    'package.json': JSON.stringify(manifest),
    // A Git dependency, which Refit's own preparation refuses (non-registry-dependency).
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': manifest,
        'node_modules/stripe': {
          version: '10.17.0',
          resolved: 'git+ssh://git@github.com/stripe/stripe-node.git#abc',
        },
      },
    }),
    'billing.ts': await readFile(resolve('pipeline/fixtures/repository/billing.ts'), 'utf8'),
  });
  const report = await validateMigration({
    repository,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    image: 'customer-validation:test',
    imageNodeModules: NODE_MODULES,
    command: ['npm', 'test'],
  });
  expect(report.validation.status).toBe('passed');
  const checks = await calls();
  expect(checks).toHaveLength(2);
  for (const check of checks)
    expect(check).toEqual({
      network: 'none',
      dependencies: false,
      tail: ['refit-check', '/bin/sh', '-c', LINK_SCRIPT, NODE_MODULES, 'npm', 'test'],
    });
  // refit run reads the setting from its configuration file, whose schema .refit.json shares.
  const path = join(root, 'run.json');
  await writeFile(
    path,
    JSON.stringify({
      ...configuration,
      repository,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      apiVersion: '2022-08-01',
      image: 'customer-validation:test',
    }),
  );
  const output = join(root, 'run');
  await execute(process.execPath, [
    resolve('bin/refit.mjs'),
    'run',
    '--config',
    path,
    '--output',
    output,
    '--quiet',
    '--json',
  ]).catch((error: unknown) => error);
  expect(JSON.parse((await readEvidence(output, 'report.json'))!).validation.status).toBe('passed');
  for (const check of (await calls()).slice(-2))
    expect(check.tail.slice(1, 5)).toEqual(['/bin/sh', '-c', LINK_SCRIPT, NODE_MODULES]);
});

it('never runs patched checks against the image dependencies when the patch changes package files', async () => {
  const root = await temporary();
  const calls = await fakeDocker(root);
  const repository = join(root, 'repository');
  await commit(repository, {
    'package.json': '{"name":"app","private":true,"dependencies":{"stripe":"10.17.0"}}\n',
    'index.js': 'module.exports = 1;\n',
  });
  const upgrade = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1 +1 @@',
    '-{"name":"app","private":true,"dependencies":{"stripe":"10.17.0"}}',
    '+{"name":"app","private":true,"dependencies":{"stripe":"18.0.0"}}',
    'diff --git a/index.js b/index.js',
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1 +1 @@',
    '-module.exports = 1;',
    '+module.exports = 2;',
    '',
  ].join('\n');
  await expect(
    validateSourcePatch({
      repository,
      propose: async () => upgrade,
      image: 'customer-validation:test',
      imageNodeModules: NODE_MODULES,
      command: ['npm', 'test'],
    }),
  ).rejects.toThrow(IMAGE_PACKAGE_CHANGE.message);
  // Only the baseline ran, in the image with the directory linked.
  expect((await calls()).map((check) => check.tail[4])).toEqual([NODE_MODULES]);
});
