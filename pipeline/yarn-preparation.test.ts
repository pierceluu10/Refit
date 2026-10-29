import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { readCommittedRepository } from './committed-repository.ts';
import { readPreparationInputs } from './dependency-inputs.ts';
import {
  installTimeoutSeconds,
  prepareDependencies,
  yarnPlatformPackageMode,
} from './dependency-preparation.ts';
import { dockerSandboxArguments, removeDockerContainer } from './docker-sandbox.ts';
import { YARN_BERRY_INSTALL_COMMAND, YARN_SKIP_PLATFORM_PACKAGES } from './manager-install.ts';
import { DEFAULT_YARN_VERSION, validateBerryInputs, validateYarnInputs } from './yarn-inputs.ts';

const execute = promisify(execFile);
const FIXTURES = 'pipeline/fixtures/yarn-locks';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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
    ['negated workspaces', { ...manifest, workspaces: ['packages/*', '!packages/old'] }, classic],
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

it('names each Yarn 2+ setup it does not prepare', async () => {
  const { manifest, berry, classic } = await fixture();
  const pinned = { ...manifest, packageManager: 'yarn@4.9.2' };
  const refusal = (value: Record<string, unknown>, rc: string | undefined, lock = berry) => {
    try {
      validateBerryInputs(JSON.stringify(value), lock, rc);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('accepted');
  };
  expect(refusal(pinned, undefined)).toBe(
    "Yarn Plug'n'Play needs the repository install: Refit prepares Yarn 2+ only with nodeLinker: node-modules in .yarnrc.yml, and without nodeLinker Yarn uses Plug'n'Play.",
  );
  expect(refusal(pinned, 'nodeLinker: pnp\n')).toBe(
    "Yarn Plug'n'Play needs the repository install: Refit prepares Yarn 2+ only with nodeLinker: node-modules in .yarnrc.yml.",
  );
  expect(refusal(pinned, 'nodeLinker: pnpm\n')).toBe(
    'Yarn\'s "pnpm" linker needs the repository install; Refit prepares Yarn 2+ only with nodeLinker: node-modules.',
  );
  expect(
    refusal(
      pinned,
      `${BERRY_RC}plugins:\n  - path: .yarn/plugins/@yarnpkg/plugin-workspace-tools.cjs\n`,
    ),
  ).toBe(
    'Yarn plugins (plugins in .yarnrc.yml) run their own code during installs, so they need the repository install.',
  );
  expect(refusal(pinned, `${BERRY_RC}checksumBehavior: ignore\nnmMode: hardlinks-global\n`)).toBe(
    '.yarnrc.yml sets checksumBehavior, nmMode, which Refit does not apply; validating with them needs the repository install.',
  );
  expect(refusal({ ...manifest, packageManager: 'yarn@1.22.19' }, BERRY_RC)).toBe(
    'packageManager pins yarn@1.22.19, but yarn.lock is a Yarn 2+ lockfile. Pin the Yarn release that wrote the lockfile, or regenerate it with Yarn 1.',
  );
  expect(refusal(manifest, BERRY_RC)).toBe(
    'Yarn 2+ preparation requires an exact packageManager pin such as yarn@4.9.2 (optionally with a Corepack checksum), or a committed yarnPath release named yarn-<version>.cjs.',
  );
  expect(refusal(pinned, `${BERRY_RC}yarnPath: .yarn/releases/yarn-4.9.2.cjs\n`)).toBe(
    'yarnPath in .yarnrc.yml must name a committed Yarn release under .yarn/releases.',
  );
  expect(() => validateYarnInputs(JSON.stringify(pinned), classic)).toThrow(
    'packageManager pins yarn@4.9.2, but yarn.lock is a Yarn 1 lockfile. Run yarn install with that release and commit the lockfile it writes.',
  );
});

it('verifies a committed yarnPath release by digest and takes its version from the name', async () => {
  const { manifest, berry } = await fixture();
  const release = {
    path: '.yarn/releases/yarn-4.9.2.cjs',
    content: Buffer.from('// yarn 4.9.2\n'),
  };
  const digest = createHash('sha512').update(release.content).digest('hex');
  const rc = `${BERRY_RC}yarnPath: ${release.path}\n`;
  expect(validateBerryInputs(JSON.stringify(manifest), berry, rc, release)).toMatchObject({
    managerVersion: '4.9.2',
    managerBundleSha512: digest,
  });
  expect(
    validateBerryInputs(
      JSON.stringify({ ...manifest, packageManager: `yarn@4.9.2+sha512.${digest}` }),
      berry,
      rc,
      release,
    ),
  ).toMatchObject({ managerVersion: '4.9.2', managerBundleSha512: digest });
  // A release named without its version takes the version from packageManager.
  const unnamed = { ...release, path: '.yarn/releases/yarn-berry.cjs' };
  expect(
    validateBerryInputs(
      JSON.stringify({ ...manifest, packageManager: 'yarn@4.9.2' }),
      berry,
      `${BERRY_RC}yarnPath: ${unnamed.path}\n`,
      unnamed,
    ),
  ).toMatchObject({ managerVersion: '4.9.2', managerBundleSha512: digest });
  expect(() =>
    validateBerryInputs(
      JSON.stringify({ ...manifest, packageManager: 'yarn@4.10.0' }),
      berry,
      rc,
      release,
    ),
  ).toThrow('packageManager pins Yarn 4.10.0, but yarnPath names Yarn 4.9.2.');
  expect(() =>
    validateBerryInputs(
      JSON.stringify({ ...manifest, packageManager: `yarn@4.9.2+sha512.${'c'.repeat(128)}` }),
      berry,
      rc,
      release,
    ),
  ).toThrow('The packageManager checksum differs from the committed yarnPath release.');
});

it('accepts Yarn 2 and 3 built-in compatibility patches', async () => {
  const { manifest, berry } = await fixture();
  const lock = `${berry}
"resolve@patch:resolve@npm%3A^1.22.1#~builtin<compat/resolve>":
  version: 1.22.1
  resolution: "resolve@patch:resolve@npm%3A1.22.1#~builtin<compat/resolve>::version=1.22.1&hash=07638b"
  checksum: ${'d'.repeat(128)}
  languageName: node
  linkType: hard
`;
  expect(() =>
    validateBerryInputs(
      JSON.stringify({ ...manifest, packageManager: 'yarn@3.2.3' }),
      lock,
      BERRY_RC,
    ),
  ).not.toThrow();
  expect(() =>
    validateBerryInputs(
      JSON.stringify({ ...manifest, packageManager: 'yarn@3.2.3' }),
      lock.replace('~builtin<compat/resolve>::', '~.yarn/patches/resolve.patch::'),
      BERRY_RC,
    ),
  ).toThrow();
});

it('accepts Yarn 2+ workspaces recorded in the lockfile and refuses unrecorded ones', async () => {
  const { manifest, berry } = await fixture();
  const root = JSON.stringify({
    ...manifest,
    packageManager: 'yarn@4.9.2',
    workspaces: ['packages/*'],
    dependencies: { ...manifest.dependencies, shared: 'workspace:^' },
  });
  const workspace = JSON.stringify({
    name: 'shared',
    version: '1.0.0',
    dependencies: { qs: '~6.13.0' },
  });
  const lock = `${berry}
"shared@workspace:^, shared@workspace:packages/shared":
  version: 0.0.0-use.local
  resolution: "shared@workspace:packages/shared"
  dependencies:
    qs: "npm:~6.13.0"
  languageName: unknown
  linkType: soft
`;
  const contents = new Map([['packages/shared', workspace]]);
  expect(validateBerryInputs(root, lock, BERRY_RC, undefined, contents)).toMatchObject({
    workspaceHashes: { 'packages/shared': expect.any(String) },
    workspaceOptionalLinks: { 'node_modules/shared': 'packages/shared' },
  });
  expect(() => validateBerryInputs(root, berry, BERRY_RC, undefined, contents)).toThrow(
    'yarn.lock has no entry for workspace packages/shared; run yarn install and commit the lockfile it writes.',
  );
  expect(() =>
    validateBerryInputs(
      root,
      lock.replaceAll('packages/shared', 'packages/other'),
      BERRY_RC,
      undefined,
      contents,
    ),
  ).toThrow(
    'yarn.lock records workspace shared@workspace:packages/other, which the committed workspace manifests do not declare; run yarn install and commit the lockfile it writes.',
  );
  expect(() =>
    validateBerryInputs(
      root,
      lock,
      BERRY_RC,
      undefined,
      new Map([
        ['packages/shared', JSON.stringify({ name: 'shared', dependencies: { lodash: '^4.0.0' } })],
      ]),
    ),
  ).toThrow(
    'lodash@^4.0.0 in packages/shared/package.json is not a public registry dependency or a sibling workspace recorded in yarn.lock; regenerate the lockfile or let Refit run the repository install.',
  );
  // Yarn records a plain range it resolved to a sibling workspace without the npm: prefix.
  expect(() =>
    validateBerryInputs(
      JSON.stringify({ ...JSON.parse(root), dependencies: { shared: '1.0.0' } }),
      lock.replace('"shared@workspace:^, ', '"shared@1.0.0, '),
      BERRY_RC,
      undefined,
      contents,
    ),
  ).not.toThrow();
  // A workspace: range must name a sibling workspace.
  expect(() =>
    validateBerryInputs(
      JSON.stringify({ ...JSON.parse(root), dependencies: { other: 'workspace:^' } }),
      lock,
      BERRY_RC,
      undefined,
      contents,
    ),
  ).toThrow('other@workspace:^ in package.json is not a public registry dependency');
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

it('names a Yarn 2+ project that commits no lockfile', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'refit-yarn-no-lock-'));
  roots.push(repository);
  await writeFile(join(repository, 'package.json'), '{"name":"app","packageManager":"yarn@4.9.2"}');
  await writeFile(join(repository, '.yarnrc.yml'), BERRY_RC);
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
    'test: no lockfile',
  ]);
  await expect(readPreparationInputs(await readCommittedRepository(repository))).rejects.toThrow(
    'The repository commits .yarnrc.yml but no yarn.lock, so the dependency versions to verify are unknown. Run yarn install and commit the yarn.lock it writes.',
  );
});

it('accepts platform-specific Yarn packages without checksums and installs none of them', async () => {
  const { manifest, berry } = await fixture();
  const pinned = { ...manifest, packageManager: 'yarn@4.9.2' };
  // Yarn 4 writes platform packages with conditions and never with a checksum.
  const lock = `${berry}
"@esbuild/linux-x64@npm:0.25.0":
  version: 0.25.0
  resolution: "@esbuild/linux-x64@npm:0.25.0"
  conditions: os=linux & cpu=x64
  languageName: node
  linkType: hard

"@esbuild/darwin-arm64@npm:0.25.0":
  version: 0.25.0
  resolution: "@esbuild/darwin-arm64@npm:0.25.0"
  conditions: os=darwin & cpu=arm64
  languageName: node
  linkType: hard
`;
  expect(validateBerryInputs(JSON.stringify(pinned), lock, BERRY_RC)).toMatchObject({
    platformPackages: 2,
  });
  expect(validateBerryInputs(JSON.stringify(pinned), berry, BERRY_RC)).not.toHaveProperty(
    'platformPackages',
  );
  // Without conditions, a missing checksum still refuses the lockfile.
  expect(() =>
    validateBerryInputs(
      JSON.stringify(pinned),
      lock.replace(/^ {2}conditions: .*\n/m, ''),
      BERRY_RC,
    ),
  ).toThrow('Every Yarn 2+ lock entry must resolve an exact npm version with a checksum');
  // Yarn 2+ builds package zips in the temporary directory; the sandbox's /tmp holds 64 MiB.
  expect(YARN_BERRY_INSTALL_COMMAND).toMatch(
    /^mkdir -p \/workspace\/\.yarn-tmp; export TMPDIR=\/workspace\/\.yarn-tmp /,
  );
  expect(YARN_SKIP_PLATFORM_PACKAGES).toBe(
    "printf 'supportedArchitectures:\\n  os: [refit-none]\\n  cpu: [refit-none]\\n  libc: [refit-none]\\n' > /workspace/.yarnrc.yml; ",
  );
});

it('accepts legacy npm package names with capitals in a Yarn 2+ lockfile', async () => {
  const { manifest, berry } = await fixture();
  const lock = `${berry}
"JSONStream@npm:^1.3.5":
  version: 1.3.5
  resolution: "JSONStream@npm:1.3.5"
  checksum: ${'e'.repeat(128)}
  languageName: node
  linkType: hard
`;
  const pinned = JSON.stringify({ ...manifest, packageManager: 'yarn@4.9.2' });
  expect(() => validateBerryInputs(pinned, lock, BERRY_RC)).not.toThrow();
  // Scoped names stay lowercase.
  expect(() =>
    validateBerryInputs(pinned, lock.replaceAll('JSONStream', '@Scope/JSONStream'), BERRY_RC),
  ).toThrow('Every Yarn 2+ lock entry must resolve an exact npm version with a checksum');
});

it('explains running out of installer space by package manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-yarn-enospc-'));
  roots.push(root);
  await mkdir(join(root, 'bin'));
  await writeFile(
    join(root, 'bin', 'docker'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log('sha256:${'a'.repeat(64)}'); process.exit(0); }
if (args[0] === 'run') { process.stderr.write('ENOSPC: no space left on device, write\\n'); process.exit(1); }
`,
  );
  await chmod(join(root, 'bin', 'docker'), 0o755);
  vi.stubEnv('PATH', join(root, 'bin') + delimiter + process.env.PATH);
  const { manifest, berry } = await fixture();
  const commit = async (name: string, files: Record<string, string>) => {
    const repository = join(root, name);
    await mkdir(repository);
    for (const [path, content] of Object.entries(files))
      await writeFile(join(repository, path), content);
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
      'test: enospc',
    ]);
    return repository;
  };
  const berryRepository = await commit('berry', {
    'package.json': JSON.stringify({ ...manifest, packageManager: 'yarn@4.9.2' }),
    'yarn.lock': berry,
    '.yarnrc.yml': BERRY_RC,
  });
  await expect(
    prepareDependencies({
      repository: berryRepository,
      image: 'node:22-alpine',
      cacheDirectory: join(root, 'cache'),
    }),
  ).rejects.toThrow(
    'yarn dependency preparation ran out of space in its 4g workspace (ENOSPC). Yarn 2+ keeps a zip of every package in its cache beside the unpacked tree. The installed dependencies do not fit',
  );
  // Under a smaller operator profile the message names the default 4 GiB one.
  vi.stubEnv('REFIT_VALIDATION_WORKSPACE', '2g');
  const npmRepository = await commit('npm', {
    'package.json': '{"name":"app","version":"1.0.0"}',
    'package-lock.json': JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'app', version: '1.0.0' } },
    }),
  });
  await expect(
    prepareDependencies({
      repository: npmRepository,
      image: 'node:22-alpine',
      cacheDirectory: join(root, 'cache'),
    }),
  ).rejects.toThrow(
    'npm dependency preparation ran out of space in its 2g workspace (ENOSPC). An operator can set REFIT_VALIDATION_WORKSPACE=4g',
  );
});

it('reads the operator choice for platform packages and defaults to skipping them', () => {
  expect(yarnPlatformPackageMode(undefined)).toBe('skip');
  expect(yarnPlatformPackageMode(' ')).toBe('skip');
  expect(yarnPlatformPackageMode('install')).toBe('install');
  for (const value of ['yes', 'INSTALL', '1'])
    expect(() => yarnPlatformPackageMode(value), value).toThrow(
      'REFIT_YARN_PLATFORM_PACKAGES must be skip or install.',
    );
});
