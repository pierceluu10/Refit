import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { readCommittedRepository } from './committed-repository.ts';
import { readPreparationInputs } from './dependency-inputs.ts';
import { prepareDependencies } from './dependency-preparation.ts';
import { dockerSandboxArguments, removeDockerContainer } from './docker-sandbox.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A dependency-free npm project committed with the given packageManager field.
async function project(packageManager?: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-npm-pin-'));
  roots.push(root);
  const repository = join(root, 'repository');
  await mkdir(repository);
  const manifest = { name: 'app', version: '1.0.0', private: true, packageManager };
  await writeFile(join(repository, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    join(repository, 'package-lock.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'app', version: '1.0.0' } },
    }),
  );
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
    '-q',
    '-m',
    'test: npm pin fixture',
  ]);
  return { root, repository };
}

const inputs = async (packageManager?: string) =>
  (
    await readPreparationInputs(
      await readCommittedRepository((await project(packageManager)).repository),
    )
  ).inputs;

it('pins npm only for an exact packageManager version', async () => {
  expect(await inputs('npm@10.8.2')).toMatchObject({ manager: 'npm', managerVersion: '10.8.2' });
  expect(await inputs(`npm@10.8.2+sha512.${'a'.repeat(128)}`)).toMatchObject({
    managerVersion: '10.8.2',
    managerIntegrity: `sha512-${Buffer.from('a'.repeat(128), 'hex').toString('base64')}`,
  });
  // A checksum npm cannot compare with registry integrity is ignored; npm still verifies the tarball.
  expect(await inputs(`npm@10.8.2+sha1.${'a'.repeat(40)}`)).not.toHaveProperty('managerIntegrity');
  // Without an exact pin, preparation keeps using the image's own npm, as before.
  for (const packageManager of [undefined, 'npm@10', 'npm@^10.8.0'])
    expect(await inputs(packageManager), String(packageManager)).not.toHaveProperty(
      'managerVersion',
    );
});

it('installs the pinned npm, runs npm ci with it and requires its version evidence', async () => {
  const { root, repository } = await project('npm@10.8.2');
  const log = join(root, 'docker.jsonl');
  await mkdir(join(root, 'bin'));
  await writeFile(
    join(root, 'bin', 'docker'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image') { console.log('sha256:${'a'.repeat(64)}'); process.exit(0); }
if (args[0] === 'run') {
  process.stderr.write('REFIT_NODE_VERSION=v22.23.3\\nREFIT_NPM_VERSION=10.9.9\\n');
  // An empty tar archive: everything but the pinned npm's evidence is present.
  process.stdout.write(Buffer.alloc(1024));
}
`,
  );
  await chmod(join(root, 'bin', 'docker'), 0o755);
  vi.stubEnv('PATH', join(root, 'bin') + delimiter + process.env.PATH);
  await expect(
    prepareDependencies({
      repository,
      image: 'node:22-alpine',
      cacheDirectory: join(root, 'cache'),
    }),
  ).rejects.toThrow(
    'npm did not provide the expected pinned manager version and integrity evidence.',
  );
  const run = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[])
    .find((args) => args[0] === 'run')!;
  const script = run.find((argument) => argument.includes('REFIT_NODE_VERSION'))!;
  expect(script).toContain('--registry=https://registry.npmjs.org "npm@$refit_tool_version"');
  expect(script).toContain('"$refit_tool" ci --ignore-scripts --include=dev --engine-strict');
  expect(script).not.toMatch(/(^|; )npm ci /);
  expect(script).toContain(
    'mkdir -p node_modules; mv /workspace/.refit-tools node_modules/.refit-tools;',
  );
});

it.skipIf(!process.env.REFIT_NPM_PREPARE || !process.env.REFIT_DOCKER_IMAGE)(
  'prepares with the pinned npm and gives the offline checks that npm',
  async () => {
    const { root, repository } = await project('npm@10.8.2');
    const prepared = await prepareDependencies({
      repository,
      image: process.env.REFIT_DOCKER_IMAGE!,
      cacheDirectory: join(root, 'cache'),
    });
    expect(prepared.environment).toMatchObject({ manager: 'npm', npmToolVersion: '10.8.2' });
    expect(prepared.environment.npmToolIntegrity).toMatch(/^sha512-/);
    const input = join(root, 'input');
    await mkdir(input);
    const name = `refit-npm-pin-${randomUUID()}`;
    try {
      const result = await execute(
        'docker',
        dockerSandboxArguments({
          name,
          directory: input,
          image: String(prepared.environment.image),
          dependencies: prepared.archive,
          network: 'none',
          command: ['npm', '--version'],
          timeoutMs: 60_000,
        }),
        { timeout: 60_000 },
      );
      expect(result.stdout.trim()).toBe('10.8.2');
    } finally {
      await removeDockerContainer(name);
    }
    expect(
      (
        await prepareDependencies({
          repository,
          image: process.env.REFIT_DOCKER_IMAGE!,
          cacheDirectory: join(root, 'cache'),
        })
      ).reused,
    ).toBe(true);
  },
  300_000,
);
