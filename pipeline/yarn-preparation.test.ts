import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { prepareDependencies } from './dependency-preparation.ts';
import { dockerSandboxArguments, removeDockerContainer } from './docker-sandbox.ts';
import { DEFAULT_YARN_VERSION, validateYarnInputs } from './yarn-inputs.ts';

const execute = promisify(execFile);
const FIXTURES = 'pipeline/fixtures/yarn-locks';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  return {
    manifest: JSON.parse(await readFile(join(FIXTURES, 'package.json'), 'utf8')),
    classic: await readFile(join(FIXTURES, 'classic.lock'), 'utf8'),
    berry: await readFile(join(FIXTURES, 'berry.lock'), 'utf8'),
  };
}

it('accepts a generated Yarn 1 lockfile and pins the manager version', async () => {
  const { manifest, classic } = await fixture();
  const inputs = validateYarnInputs(JSON.stringify(manifest), classic);
  expect(inputs).toMatchObject({ manager: 'yarn', managerVersion: DEFAULT_YARN_VERSION });
  expect(inputs.packages).toBeGreaterThan(5);
  const pinned = validateYarnInputs(
    JSON.stringify({ ...manifest, packageManager: `yarn@1.22.19+sha512.${'a'.repeat(128)}` }),
    classic,
  );
  expect(pinned).toMatchObject({ managerVersion: '1.22.19', managerIntegrity: /^sha512-/ });
});

it('refuses Yarn inputs that need a custom image', async () => {
  const { manifest, classic, berry } = await fixture();
  const cases: [string, Record<string, unknown>, string][] = [
    ['Yarn 2+ lockfile', manifest, berry],
    ['Yarn 2+ pin', { ...manifest, packageManager: 'yarn@4.9.2' }, classic],
    ['workspaces', { ...manifest, workspaces: ['packages/*'] }, classic],
    ['undeclared range', { ...manifest, dependencies: { stripe: '^18.0.0' } }, classic],
    ['git source', { ...manifest, dependencies: { stripe: 'github:stripe/stripe-node' } }, classic],
    [
      'private tarball',
      manifest,
      classic.replace(/https:\/\/registry\.yarnpkg\.com\/stripe\//, 'https://npm.example/stripe/'),
    ],
    ['missing integrity', manifest, classic.replace(/^ {2}integrity .*$/m, '')],
  ];
  for (const [name, value, lock] of cases)
    expect(() => validateYarnInputs(JSON.stringify(value), lock), name).toThrow();
});

it.skipIf(!process.env.REFIT_NPM_PREPARE || !process.env.REFIT_DOCKER_IMAGE)(
  'prepares a Yarn 1 project without lifecycle scripts or repository rc files and uses it offline',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-yarn-docker-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await mkdir(repository);
    const { manifest, classic } = await fixture();
    manifest.scripts = {
      postinstall:
        "node -e \"require('node:fs').writeFileSync('node_modules/refit-script-ran', 'bad')\"",
    };
    await writeFile(join(repository, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(repository, 'yarn.lock'), classic);
    await writeFile(join(repository, '.yarnrc'), 'registry "http://127.0.0.1:1"\n');
    await execute('git', ['init', repository]);
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
      'test: record yarn preparation inputs',
    ]);
    const prepared = await prepareDependencies({
      repository,
      image: process.env.REFIT_DOCKER_IMAGE!,
      cacheDirectory: join(root, 'cache'),
    });
    expect(prepared.environment).toMatchObject({
      kind: 'refit-yarn-environment',
      manager: 'yarn',
      yarnVersion: DEFAULT_YARN_VERSION,
    });
    expect(prepared.environment.yarnIntegrity).toMatch(/^sha512-/);
    const input = join(root, 'empty-input');
    await mkdir(input);
    const name = `refit-offline-yarn-${randomUUID()}`;
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
            'sh',
            '-c',
            `test "$(yarn --version)" = "${DEFAULT_YARN_VERSION}" && node -e "const assert=require('node:assert/strict');assert.equal(JSON.parse(require('node:fs').readFileSync('node_modules/stripe/package.json','utf8')).version,'17.7.0');assert.equal(typeof require('stripe'),'function');assert.equal(require('node:fs').existsSync('node_modules/refit-script-ran'),false);console.log('Prepared Yarn dependencies work offline; install script did not run.');"`,
          ],
        }),
        { timeout: 30_000 },
      );
      console.log(result.stdout);
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
  180_000,
);
