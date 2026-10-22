import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { installTimeoutSeconds, prepareDependencies } from './dependency-preparation.ts';
import { dockerSandboxArguments, removeDockerContainer } from './docker-sandbox.ts';
import { DEFAULT_YARN_VERSION, validateBerryInputs, validateYarnInputs } from './yarn-inputs.ts';

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
  const weak = validateYarnInputs(
    JSON.stringify({ ...manifest, packageManager: `yarn@1.22.19+sha1.${'a'.repeat(40)}` }),
    classic,
  );
  expect(weak).toMatchObject({ managerVersion: '1.22.19' });
  expect(weak).not.toHaveProperty('managerIntegrity');
});

it('refuses Yarn inputs that need a custom image', async () => {
  const { manifest, classic, berry } = await fixture();
  const cases: [string, Record<string, unknown>, string][] = [
    ['Yarn 2+ lockfile', manifest, berry],
    ['Yarn 2+ pin', { ...manifest, packageManager: 'yarn@4.9.2' }, classic],
    [
      'nohoist workspaces',
      { ...manifest, workspaces: { packages: ['packages/*'], nohoist: ['**'] } },
      classic,
    ],
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
          timeoutMs: 120_000,
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

it('bounds an operator-configured installation deadline', () => {
  expect(installTimeoutSeconds(undefined)).toBe(300);
  expect(installTimeoutSeconds(' ')).toBe(300);
  expect(installTimeoutSeconds('900')).toBe(900);
  for (const value of ['59', '1801', '600.5', 'ten', '-1'])
    expect(() => installTimeoutSeconds(value), value).toThrow('REFIT_DEPENDENCY_TIMEOUT_SECONDS');
});

it.skipIf(!process.env.REFIT_NPM_PREPARE || !process.env.REFIT_DOCKER_IMAGE)(
  'prepares Yarn 1 workspaces with nested SDK versions and sibling links, then uses them offline',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-yarn-workspaces-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await cp('pipeline/fixtures/npm-workspaces/repository', repository, { recursive: true });
    await rm(join(repository, 'package-lock.json'));
    await writeFile(
      join(repository, 'yarn.lock'),
      await readFile(join(FIXTURES, 'workspaces.lock'), 'utf8'),
    );
    await execute('git', ['init', repository]);
    await execute('git', ['-C', repository, 'add', '--force', '.']);
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
      'test: record yarn workspace inputs',
    ]);
    const prepared = await prepareDependencies({
      repository,
      image: process.env.REFIT_DOCKER_IMAGE!,
      cacheDirectory: join(root, 'cache'),
    });
    expect(prepared.environment).toMatchObject({
      manager: 'yarn',
      workspaceLinks: {
        'node_modules/@refit-fixture/billing': 'packages/billing',
        'node_modules/@refit-fixture/ids': 'packages/ids',
      },
    });
    const name = `refit-offline-yarn-workspaces-${randomUUID()}`;
    try {
      const result = await execute(
        'docker',
        dockerSandboxArguments({
          name,
          directory: repository,
          image: String(prepared.environment.image),
          dependencies: prepared.archive,
          network: 'none',
          timeoutMs: 120_000,
          command: [
            'sh',
            '-c',
            `yarn --version && node -e "const assert=require('node:assert/strict');const fs=require('node:fs');const version=(path)=>JSON.parse(fs.readFileSync(path,'utf8')).version;assert.equal(version('node_modules/stripe/package.json'),'19.1.0');assert.equal(version('packages/billing/node_modules/stripe/package.json'),'10.17.0');assert.equal(typeof require('@refit-fixture/ids'),'object');for (const tripwire of ['node_modules/root-script-ran','node_modules/workspace-script-ran','packages/billing/node_modules/workspace-script-ran']) assert.equal(fs.existsSync(tripwire),false);console.log('Yarn workspaces work offline with both Stripe versions.');"`,
          ],
        }),
        { timeout: 30_000 },
      );
      expect(result.stdout).toContain('Yarn workspaces work offline with both Stripe versions.');
    } finally {
      await removeDockerContainer(name);
    }
  },
  180_000,
);

const BERRY_RC = 'nodeLinker: node-modules\n';

it('accepts a pinned Yarn 2+ project on the node-modules linker', async () => {
  const { manifest, berry } = await fixture();
  const pinned = { ...manifest, packageManager: 'yarn@4.9.2' };
  expect(validateBerryInputs(JSON.stringify(pinned), berry, BERRY_RC)).toMatchObject({
    manager: 'yarn',
    managerVersion: '4.9.2',
  });
  const checksum = 'b'.repeat(128);
  expect(
    validateBerryInputs(
      JSON.stringify({ ...pinned, packageManager: `yarn@4.9.2+sha512.${checksum}` }),
      berry,
      BERRY_RC,
    ),
  ).toMatchObject({ managerBundleSha512: checksum });
});

it('accepts Yarn built-in compatibility patches but not repository patches', async () => {
  const { manifest, berry } = await fixture();
  const pinned = JSON.stringify({ ...manifest, packageManager: 'yarn@4.9.2' });
  const builtin = `${berry}
"fsevents@patch:fsevents@npm%3A~2.3.3#optional!builtin<compat/fsevents>":
  version: 2.3.3
  resolution: "fsevents@patch:fsevents@npm%3A2.3.3#optional!builtin<compat/fsevents>::version=2.3.3&hash=df0bf1"
  conditions: os=darwin
  languageName: node
  linkType: hard
`;
  expect(() => validateBerryInputs(pinned, builtin, BERRY_RC)).not.toThrow();
  for (const forged of [
    builtin.replace('compat/fsevents>::version=2.3.3', 'compat/fsevents>::version=2.3.4'),
    builtin.replace('fsevents@patch:fsevents@npm%3A2.3.3', 'fsevents@patch:other@npm%3A2.3.3'),
    builtin.replace('#optional!builtin<compat/fsevents>::', '#~/.yarn/patches/fsevents.patch::'),
  ])
    expect(() => validateBerryInputs(pinned, forged, BERRY_RC)).toThrow();
});

it('refuses Yarn 2+ projects that need a custom image', async () => {
  const { manifest, berry } = await fixture();
  const pinned = { ...manifest, packageManager: 'yarn@4.9.2' };
  const cases: [string, Record<string, unknown>, string, string | undefined][] = [
    ['unpinned', manifest, berry, BERRY_RC],
    ['Plug-n-Play default', pinned, berry, undefined],
    ['Plug-n-Play explicit', pinned, berry, 'nodeLinker: pnp\n'],
    ['custom settings', pinned, berry, `${BERRY_RC}npmRegistryServer: "https://npm.example"\n`],
    ['workspaces', { ...pinned, workspaces: ['packages/*'] }, berry, BERRY_RC],
    ['undeclared range', { ...pinned, dependencies: { stripe: '^18.0.0' } }, berry, BERRY_RC],
    ['missing checksum', pinned, berry.replace(/^ {2}checksum: .*$/m, ''), BERRY_RC],
    [
      'patched package',
      pinned,
      berry.replace(
        'resolution: "qs@npm:6.13.3"',
        'resolution: "qs@patch:qs@npm%3A6.13.3#~/.yarn/patches/qs.patch"',
      ),
      BERRY_RC,
    ],
  ];
  for (const [name, value, lock, rc] of cases)
    expect(() => validateBerryInputs(JSON.stringify(value), lock, rc), name).toThrow();
});

it.skipIf(!process.env.REFIT_NPM_PREPARE || !process.env.REFIT_DOCKER_IMAGE)(
  'prepares a pinned Yarn 4 project without scripts and runs yarn scripts offline',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-yarn-berry-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await mkdir(repository);
    const { manifest, berry } = await fixture();
    manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort());
    Object.assign(manifest, {
      packageManager: 'yarn@4.9.2',
      scripts: {
        postinstall:
          "node -e \"require('node:fs').writeFileSync('node_modules/refit-script-ran', 'bad')\"",
        check:
          "node -e \"const fs=require('node:fs');if(JSON.parse(fs.readFileSync('node_modules/stripe/package.json','utf8')).version!=='17.7.0'||fs.existsSync('node_modules/refit-script-ran'))process.exit(1);console.log('Yarn 4 script ran offline.')\"",
      },
    });
    // Yarn 2+ rewrites manifests that differ from its own formatting; inputs are read-only.
    await writeFile(join(repository, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(repository, 'yarn.lock'), berry);
    await writeFile(join(repository, '.yarnrc.yml'), BERRY_RC);
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
      'test: record yarn berry inputs',
    ]);
    const prepared = await prepareDependencies({
      repository,
      image: process.env.REFIT_DOCKER_IMAGE!,
      cacheDirectory: join(root, 'cache'),
    });
    expect(prepared.environment).toMatchObject({ manager: 'yarn', yarnVersion: '4.9.2' });
    const name = `refit-offline-yarn-berry-${randomUUID()}`;
    try {
      const result = await execute(
        'docker',
        dockerSandboxArguments({
          name,
          directory: repository,
          image: String(prepared.environment.image),
          dependencies: prepared.archive,
          network: 'none',
          timeoutMs: 120_000,
          command: ['sh', '-c', 'test "$(yarn --version)" = 4.9.2 && yarn run check'],
        }),
        { timeout: 60_000 },
      );
      expect(result.stdout).toContain('Yarn 4 script ran offline.');
    } finally {
      await removeDockerContainer(name);
    }
  },
  180_000,
);
