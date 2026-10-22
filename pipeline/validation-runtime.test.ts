import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { readCommittedRepository } from './committed-repository.ts';
import { validateSourcePatch } from './validation.ts';
import {
  nodeDeclarations,
  satisfiesNodeDeclarations,
  selectValidationRuntime,
  type NodeDeclaration,
} from './validation-runtime.ts';

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const files = (contents: Record<string, string>) => async (path: string) => contents[path];
const engines = (value: string): NodeDeclaration[] => [{ source: 'engines.node', value }];

it('reads every declaration form from the repository root', async () => {
  expect(
    await nodeDeclarations(
      files({
        '.nvmrc': '# pinned for CI\n\nv18.17.0\n',
        '.node-version': '18\n',
        'package.json': JSON.stringify({
          engines: { node: ' >=18 <21 ', npm: '>=9' },
          volta: { node: '18.20.4', npm: '10.0.0' },
        }),
        '.tool-versions': '# tools\npython 3.12.1\nnodejs 18.19.0 16.20.0 # fallback\n',
      }),
    ),
  ).toEqual([
    { source: '.nvmrc', value: 'v18.17.0' },
    { source: '.node-version', value: '18' },
    { source: 'engines.node', value: '>=18 <21' },
    { source: 'volta.node', value: '18.20.4' },
    { source: '.tool-versions', value: '18.19.0' },
  ]);
  expect(await nodeDeclarations(files({ '.tool-versions': 'node 20.11.1\n' }))).toEqual([
    { source: '.tool-versions', value: '20.11.1' },
  ]);
  // Absent files, an empty engines range and a manifest without engines declare nothing.
  expect(await nodeDeclarations(files({}))).toEqual([]);
  expect(
    await nodeDeclarations(files({ 'package.json': '{"engines":{"node":""}}', '.nvmrc': '\n' })),
  ).toEqual([]);
  expect(await nodeDeclarations(files({ 'package.json': '{"name":"app"}' }))).toEqual([]);
});

it('stops on a declaration it cannot read', async () => {
  for (const contents of <Record<string, string>[]>[
    { '.nvmrc': 'v22/*' },
    { '.nvmrc': 'lts/unknown' },
    { '.node-version': 'system' },
    { '.tool-versions': 'nodejs ref:main' },
    { 'package.json': '{"engines":{"node":"node >= 18"}}' },
    { 'package.json': '{"engines":{"node":">=18.0.0-rc.1"}}' },
    { 'package.json': '{"volta":{"node":"latest-lts"}}' },
  ])
    await expect(nodeDeclarations(files(contents)), JSON.stringify(contents)).rejects.toThrow(
      /^Validation cannot read (\.nvmrc|\.node-version|\.tool-versions|engines\.node|volta\.node) ".+" as a Node\.js version or range\.$/,
    );
  await expect(
    nodeDeclarations(files({ 'package.json': '{"engines":{"node":18}}' })),
  ).rejects.toThrow('Validation cannot read a non-string engines.node.');
});

it('resolves npm engines ranges the way npm does for release versions', () => {
  const cases: [string, string[], string[]][] = [
    ['>=18', ['18.0.0', '22.23.3'], ['16.20.2']],
    ['>= 18.17.0', ['18.17.0', '24.1.0'], ['18.16.9']],
    ['>18', ['19.0.0'], ['18.20.8']],
    ['>18.17.0', ['18.17.1'], ['18.17.0']],
    ['<20', ['18.20.8'], ['20.0.0']],
    ['<=20', ['20.20.2'], ['21.0.0']],
    ['<=20.10.0', ['20.10.0'], ['20.10.1']],
    ['18', ['18.0.0', '18.20.8'], ['19.0.0', '17.9.9']],
    ['18.x', ['18.20.8'], ['20.0.0']],
    ['20.*', ['20.1.0'], ['22.0.0']],
    ['v20', ['20.19.5'], ['18.20.8']],
    ['=22.14.0', ['22.14.0'], ['22.23.3']],
    ['22.14.0', ['22.14.0'], ['22.23.3']],
    ['~18.17', ['18.17.9'], ['18.18.0']],
    ['~18', ['18.20.8'], ['19.0.0']],
    ['^18.17.0', ['18.20.8'], ['18.16.0', '20.0.0']],
    ['^20.19.0 || >=22.12.0', ['20.19.5', '24.0.0'], ['20.18.0', '22.11.0', '21.0.0']],
    ['^0.12.0', ['0.12.18'], ['0.13.0']],
    ['18.17.0 - 20', ['18.17.0', '20.20.2'], ['18.16.0', '21.0.0']],
    ['18 - 20.5.0', ['18.0.0', '20.5.0'], ['20.5.1']],
    ['>=16.0.0 <=20.x.x', ['20.20.2', '16.0.0'], ['22.0.0']],
    ['>=18 <21', ['20.20.2'], ['22.23.3']],
    ['*', ['4.0.0', '26.0.0'], []],
    ['x || <0', ['24.0.0'], []],
  ];
  for (const [range, accepted, refused] of cases) {
    for (const version of accepted)
      expect(satisfiesNodeDeclarations(version, engines(range)), `${range} ${version}`).toBe(true);
    for (const version of refused)
      expect(satisfiesNodeDeclarations(version, engines(range)), `${range} ${version}`).toBe(false);
  }
});

it('treats version-manager pins as their release line and needs every declaration to hold', () => {
  const pinned = (source: NodeDeclaration['source'], value: string) => [{ source, value }];
  expect(satisfiesNodeDeclarations('18.20.8', pinned('.nvmrc', 'v18.17.0'))).toBe(true);
  expect(satisfiesNodeDeclarations('20.20.2', pinned('.nvmrc', 'v18.17.0'))).toBe(false);
  expect(satisfiesNodeDeclarations('18.20.8', pinned('.nvmrc', 'lts/hydrogen'))).toBe(true);
  expect(satisfiesNodeDeclarations('24.22.1', pinned('.node-version', 'lts-krypton'))).toBe(true);
  for (const any of ['lts/*', 'node', 'stable', 'latest', 'current', 'lts'])
    expect(satisfiesNodeDeclarations('22.23.3', pinned('.nvmrc', any)), any).toBe(true);
  expect(satisfiesNodeDeclarations('22.23.3', pinned('volta.node', '22.14.0'))).toBe(true);
  expect(satisfiesNodeDeclarations('22.23.3', pinned('.tool-versions', '20.11.1'))).toBe(false);
  const both = [...pinned('.nvmrc', '20'), ...engines('>=20.19 <23')];
  expect(satisfiesNodeDeclarations('20.20.2', both)).toBe(true);
  expect(satisfiesNodeDeclarations('22.23.3', both)).toBe(false);
});

// A committed repository with the given root files, read as Refit reads one for validation.
async function snapshot(contents: Record<string, string>) {
  const repository = await mkdtemp(join(tmpdir(), 'refit-runtime-'));
  roots.push(repository);
  for (const [path, content] of Object.entries(contents))
    await writeFile(join(repository, path), content);
  const git = (...args: string[]) =>
    execute('git', [
      '-C',
      repository,
      '-c',
      'user.name=Refit Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ]);
  await git('init', '-q');
  await git('add', '-A');
  await git('commit', '-q', '--allow-empty', '-m', 'test: runtime fixture');
  return readCommittedRepository(repository);
}

// Stands in for `docker image inspect`, answering with each installed image's NODE_VERSION.
async function installedImages(versions: Record<string, string>) {
  const binary = await mkdtemp(join(tmpdir(), 'refit-runtime-docker-'));
  roots.push(binary);
  await mkdir(binary, { recursive: true });
  await writeFile(
    join(binary, 'docker'),
    `#!/usr/bin/env node
const versions = ${JSON.stringify(versions)};
const image = process.argv.at(-1);
if (process.argv[2] !== 'image' || !(image in versions)) {
  process.stderr.write('Error response from daemon: No such image: ' + image + '\\n');
  process.exit(1);
}
const env = ['PATH=/usr/local/bin'];
if (versions[image]) env.push('NODE_VERSION=' + versions[image]);
console.log(JSON.stringify(env));
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
}

it('keeps the configured image and reports whether it satisfies the declarations', async () => {
  await installedImages({ 'node:22-alpine': '22.23.3', 'node:20-alpine': '20.20.2' });
  expect(await selectValidationRuntime(await snapshot({}), 'node:22-alpine')).toEqual({
    configured: 'node:22-alpine',
    image: 'node:22-alpine',
    nodeVersion: '22.23.3',
    declarations: [],
    reason: 'The repository declares no Node.js version.',
  });
  expect(
    await selectValidationRuntime(
      await snapshot({ 'package.json': '{"engines":{"node":">=18"}}' }),
      'node:22-alpine',
    ),
  ).toMatchObject({
    image: 'node:22-alpine',
    nodeVersion: '22.23.3',
    reason: 'The configured image satisfies engines.node ">=18".',
  });
  // A declaration never switches the image, even when an installed allowed image would satisfy it.
  expect(
    await selectValidationRuntime(
      await snapshot({ '.nvmrc': '20\n', 'package.json': '{"engines":{"node":">=20.19 <23"}}' }),
      'node:22-alpine',
    ),
  ).toEqual({
    configured: 'node:22-alpine',
    image: 'node:22-alpine',
    nodeVersion: '22.23.3',
    declarations: [
      { source: '.nvmrc', value: '20' },
      { source: 'engines.node', value: '>=20.19 <23' },
    ],
    reason:
      'The configured image does not satisfy .nvmrc "20" and engines.node ">=20.19 <23"; only the approved configuration chooses the image, so the baseline check shows whether the repository works there.',
  });
  // An unreadable declaration is reported, not a stop.
  expect(
    await selectValidationRuntime(await snapshot({ '.nvmrc': 'v22/*\n' }), 'node:22-alpine'),
  ).toMatchObject({
    image: 'node:22-alpine',
    declarations: [],
    reason: 'Validation cannot read .nvmrc "v22/*" as a Node.js version or range.',
  });
});

it('does not read declarations for a custom image', async () => {
  expect(
    await selectValidationRuntime(
      await snapshot({ '.nvmrc': '20\n', 'package.json': '{"engines":{"node":1}}' }),
      'stripe-checks',
    ),
  ).toEqual({
    configured: 'stripe-checks',
    image: 'stripe-checks',
    nodeVersion: null,
    declarations: [],
    reason:
      'The configured image is not one of the Node.js images Refit compares declarations with.',
  });
});

it('prepares and checks the repository on the configured image and records the declarations', async () => {
  const binary = await mkdtemp(join(tmpdir(), 'refit-runtime-docker-'));
  roots.push(binary);
  const log = join(binary, 'calls.jsonl');
  const ids = {
    'node:20-alpine': `sha256:${'2'.repeat(64)}`,
    'node:22-alpine': `sha256:${'3'.repeat(64)}`,
  };
  await writeFile(
    join(binary, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const ids = ${JSON.stringify(ids)};
const versions = { 'node:20-alpine': '20.20.2', 'node:22-alpine': '22.23.3' };
if (args[0] === 'image') {
  const image = args.at(-1);
  if (!(image in ids)) { process.stderr.write('Error: No such image: ' + image + '\\n'); process.exit(1); }
  console.log(args[3] === '{{.Id}}' ? ids[image] : JSON.stringify(['NODE_VERSION=' + versions[image]]));
} else if (args[0] === 'run') console.log('checks ran');
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  const repository = (await snapshot({ '.nvmrc': '20\n', 'index.js': 'module.exports = 1;\n' }))
    .directory;
  const result = await validateSourcePatch({
    repository,
    propose: async () =>
      'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n',
    image: 'node:22-alpine',
    command: ['node', 'index.js'],
  });
  expect(result).toMatchObject({
    status: 'passed',
    image: ids['node:22-alpine'],
    runtime: { configured: 'node:22-alpine', image: 'node:22-alpine', nodeVersion: '22.23.3' },
  });
  const runs = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] === 'run');
  expect(runs).toHaveLength(2);
  for (const args of runs) {
    expect(args).toContain(ids['node:22-alpine']);
    expect(args).not.toContain(ids['node:20-alpine']);
  }
});
