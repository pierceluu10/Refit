import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readCommittedRepository } from './committed-repository.ts';
import { readPreparationInputs } from './dependency-inputs.ts';
import { prepareDependencies } from './dependency-preparation.ts';
import {
  changesOutside,
  githubSources,
  keepSeedNames,
  lockfileResolutionEnabled,
  npmrcRefusal,
  onRegistryHost,
  RESOLVE_SCRIPT,
  resolvedLockfileSnapshot,
  resolveNpmLockfile,
} from './lockfile-resolution.ts';
import { validateNpmLock } from './npm-lock.ts';
import { stripePackageUpgrade } from './stripe-package-upgrade.ts';

vi.mock('./lockfile-resolution.ts', async (original) => {
  const actual = await original<typeof import('./lockfile-resolution.ts')>();
  return { ...actual, resolveNpmLockfile: vi.fn(actual.resolveNpmLockfile) };
});

const execute = promisify(execFile);
// Recorded with resolveNpmLockfile in node:22-alpine (npm 10) on 2026-10-27, as of 2026-09-15:
// committed-package-lock.json from package.json with no seed, and bumped-package-lock.json from
// bumped-package.json (stripe ^23.0.0, @types/node ^20.0.0) seeded with the committed lockfile.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'lockfile-resolution');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');
const BEFORE = '2026-09-15T00:00:00Z';
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const IMAGE = process.env.REFIT_DOCKER_IMAGE;

const roots: string[] = [];
beforeEach(() => {
  process.env.REFIT_LOCKFILE_RESOLUTION = 'on';
});
afterEach(async () => {
  delete process.env.REFIT_LOCKFILE_RESOLUTION;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(resolveNpmLockfile).mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>, commit = false) {
  const root = await mkdtemp(join(tmpdir(), 'refit-lock-resolution-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  if (commit) {
    const git = (...args: string[]) =>
      execute('git', ['-C', root, ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: BEFORE, GIT_COMMITTER_DATE: BEFORE },
      });
    await git('init', '-q');
    await git('add', '-A');
    await git(
      '-c',
      'user.name=Refit',
      '-c',
      'user.email=refit@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'fixture',
    );
  }
  return root;
}

// stripe 23.0.0's registry metadata, as registry.npmjs.org served it on 2026-10-27.
function registry() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'stripe',
            version: '23.0.0',
            license: 'MIT',
            dependencies: {},
            engines: { node: '>=18' },
            peerDependencies: { '@types/node': '>=20' },
            peerDependenciesMeta: { '@types/node': { optional: true } },
            dist: {
              tarball: 'https://registry.npmjs.org/stripe/-/stripe-23.0.0.tgz',
              integrity: INTEGRITY,
            },
          }),
        ),
    ),
  );
}

it('is on unless REFIT_LOCKFILE_RESOLUTION is off, and rejects other values', () => {
  expect(lockfileResolutionEnabled('')).toBe(true);
  expect(lockfileResolutionEnabled('off')).toBe(false);
  expect(lockfileResolutionEnabled('on')).toBe(true);
  expect(() => lockfileResolutionEnabled('yes')).toThrow(/must be on or off/);
});

it('records lockfiles the ordinary registry and integrity checks accept', async () => {
  const committed = validateNpmLock(
    await fixture('package.json'),
    await fixture('committed-package-lock.json'),
  );
  expect(committed.packages).toBe(4);
  const bumped = validateNpmLock(
    await fixture('bumped-package.json'),
    await fixture('bumped-package-lock.json'),
  );
  expect(bumped.packages).toBe(4);
});

it('finds no change outside stripe, the raised peer and the packages only they reach', async () => {
  const [before, after] = await Promise.all([
    fixture('committed-package-lock.json'),
    fixture('bumped-package-lock.json'),
  ]);
  // undici-types moves from 5.26.5 to 6.21.0, reached only through @types/node.
  expect(JSON.parse(after).packages['node_modules/undici-types'].version).toBe('6.21.0');
  expect(changesOutside(before, after, ['stripe', '@types/node'])).toEqual([]);
  // npm names an unnamed root after the directory it resolved in; the committed names are kept.
  const renamed = JSON.parse(after);
  const { name: _, ...root } = renamed.packages[''];
  renamed.name = 'workspace';
  renamed.packages[''] = root;
  const renamedText = `${JSON.stringify(renamed, null, 2)}\n`;
  expect(changesOutside(before, renamedText, ['stripe', '@types/node'])).toEqual(['']);
  expect(keepSeedNames(before, renamedText)).toBe(after);
  expect(keepSeedNames(before, after)).toBe(after);
  // Without @types/node as a raised peer, its move and undici-types' are outside.
  expect(changesOutside(before, after, ['stripe'])).toEqual([
    '',
    'node_modules/@types/node',
    'node_modules/undici-types',
  ]);
  const moved = JSON.parse(after);
  moved.packages['node_modules/typescript'].version = '5.4.6';
  moved.packages[''].devDependencies.typescript = '5.4.6';
  expect(changesOutside(before, JSON.stringify(moved), ['stripe', '@types/node'])).toEqual([
    '',
    'node_modules/typescript',
  ]);
});

it('counts a package another dependency also reaches as outside the upgrade', () => {
  const lock = (undici: string) =>
    JSON.stringify({
      packages: {
        '': { dependencies: { stripe: '^23.0.0', fetcher: '1.0.0' } },
        'node_modules/stripe': { version: '23.0.0', dependencies: { 'undici-types': '*' } },
        'node_modules/fetcher': { version: '1.0.0', dependencies: { 'undici-types': '*' } },
        'node_modules/undici-types': { version: undici },
      },
    });
  expect(changesOutside(lock('5.26.5'), lock('6.21.0'), ['stripe'])).toEqual([
    'node_modules/undici-types',
  ]);
});

it('raises @types/node with stripe and re-resolves the committed lockfile', async () => {
  registry();
  const [manifest, committed, bumpedManifest, bumped] = await Promise.all([
    fixture('package.json'),
    fixture('committed-package-lock.json'),
    fixture('bumped-package.json'),
    fixture('bumped-package-lock.json'),
  ]);
  const root = await directory({ 'package.json': manifest, 'package-lock.json': committed });
  expect(await stripePackageUpgrade(root, '2026-09-30.endive')).toEqual({
    reason:
      'stripe 23.0.0 needs @types/node >=20, which the lockfile does not provide; upgrade it first.',
  });
  vi.mocked(resolveNpmLockfile).mockResolvedValueOnce({
    lockfile: bumped,
    before: BEFORE,
    late: { stripe: { spec: '^23.0.0', published: '2026-10-01T00:52:07.438Z' } },
  });
  const result = await stripePackageUpgrade(root, '2026-09-30.endive', {
    image: 'node:22-alpine',
    before: BEFORE,
  });
  if (!('upgrade' in result)) throw new Error(result.reason);
  expect(resolveNpmLockfile).toHaveBeenCalledWith({
    manifest: bumpedManifest,
    seed: committed,
    before: BEFORE,
    legacyPeerDeps: false,
    image: 'node:22-alpine',
  });
  expect(result.upgrade.files).toEqual([
    { path: 'package.json', before: manifest, after: bumpedManifest },
    { path: 'package-lock.json', before: committed, after: bumped },
  ]);
  expect(result.upgrade.warning).toContain(
    "raises @types/node from ^18.19.0 to ^20.0.0, the lowest version in stripe 23.0.0's optional peer range >=20 (now @types/node 20.19.43)",
  );
  expect(result.upgrade.warning).toContain(
    'as of 2026-09-15T00:00:00Z, stripe ^23.0.0 as of 2026-10-01T00:52:07.438Z',
  );
});

it('keeps the refusal when the re-resolved lockfile changes another package', async () => {
  registry();
  const bumped = JSON.parse(await fixture('bumped-package-lock.json'));
  bumped.packages['node_modules/typescript'].version = '5.4.6';
  vi.mocked(resolveNpmLockfile).mockResolvedValueOnce({
    lockfile: JSON.stringify(bumped, null, 2),
    before: BEFORE,
    late: {},
  });
  const root = await directory({
    'package.json': await fixture('package.json'),
    'package-lock.json': await fixture('committed-package-lock.json'),
  });
  expect(
    await stripePackageUpgrade(root, '2026-09-30.endive', {
      image: 'node:22-alpine',
      before: BEFORE,
    }),
  ).toEqual({
    reason:
      'Raising @types/node with stripe 23.0.0 changes node_modules/typescript in package-lock.json, outside stripe, the raised peer and the packages only they reach.',
  });
});

it('raises only an @types/* devDependency', async () => {
  registry();
  const manifest = (await fixture('package.json'))
    .replace('"dependencies": {', '"dependencies": {\n    "@types/node": "^18.19.0",')
    .replace('"@types/node": "^18.19.0",\n    "typescript"', '"typescript"');
  const root = await directory({
    'package.json': manifest,
    'package-lock.json': await fixture('committed-package-lock.json'),
  });
  const result = await stripePackageUpgrade(root, '2026-09-30.endive', {
    image: 'node:22-alpine',
    before: BEFORE,
  });
  expect(result).toEqual({ reason: expect.stringMatching(/; upgrade it first\.$/) });
  expect(resolveNpmLockfile).not.toHaveBeenCalled();
});

it('raises the peer in package.json alone when no lockfile is committed', async () => {
  registry();
  const root = await directory({ 'package.json': await fixture('package.json') });
  expect(await stripePackageUpgrade(root, '2026-09-30.endive')).toEqual({
    reason:
      'stripe 23.0.0 needs @types/node >=20, which package.json does not provide; upgrade it first.',
  });
  const result = await stripePackageUpgrade(root, '2026-09-30.endive', {
    image: 'node:22-alpine',
    before: BEFORE,
  });
  if (!('upgrade' in result)) throw new Error(result.reason);
  const [file] = result.upgrade.files;
  expect(JSON.parse(file.after)).toMatchObject({
    dependencies: { stripe: '23.0.0' },
    devDependencies: { '@types/node': '^20.0.0' },
  });
  expect(result.upgrade.warning).toContain('and raises @types/node from ^18.19.0 to ^20.0.0');
  expect(result.upgrade.warning).toContain('a package-lock.json it resolved for validation only');
  expect(resolveNpmLockfile).not.toHaveBeenCalled();
});

it('resolves only root npm projects with registry dependencies, as configured', async () => {
  const manifest = await fixture('package.json');
  const options = { image: 'node:22-alpine' };
  const snapshot = async (files: Record<string, string>) =>
    readCommittedRepository(await directory(files, true));
  process.env.REFIT_LOCKFILE_RESOLUTION = 'off';
  expect(
    await resolvedLockfileSnapshot(
      await snapshot({ 'package.json': manifest }),
      'no-lockfile',
      options,
    ),
  ).toBeUndefined();
  process.env.REFIT_LOCKFILE_RESOLUTION = 'on';
  expect(
    await resolvedLockfileSnapshot(
      await snapshot({ 'package.json': manifest, 'yarn.lock': '' }),
      'lockfile-out-of-sync',
      options,
    ),
  ).toBeUndefined();
  // pnpm reads settings, workspaces and patches from files resolution does not receive.
  expect(
    await resolvedLockfileSnapshot(
      await snapshot({
        'package.json': manifest,
        'pnpm-lock.yaml': '',
        'pnpm-workspace.yaml': 'packages: []\n',
      }),
      'lockfile-out-of-sync',
      options,
    ),
  ).toBeUndefined();
  expect(
    await resolvedLockfileSnapshot(
      await snapshot({ 'package.json': manifest }),
      'dependency-archive-limit',
      options,
    ),
  ).toBeUndefined();
  await expect(
    resolvedLockfileSnapshot(
      await snapshot({
        'package.json': manifest.replace('"^22.6.2"', '"github:stripe/stripe-node"'),
      }),
      'no-lockfile',
      options,
    ),
  ).rejects.toThrow(
    /^Automatic preparation supports public npm registry dependencies only; package.json declares stripe from Git \(github.com\/stripe\/stripe-node\)/,
  );
  await expect(
    resolvedLockfileSnapshot(
      await snapshot({
        'package.json': manifest.replace('"stripe"', '"@acme/ui": "^1.0.0",\n    "stripe"'),
        '.npmrc': '@acme:registry=https://npm.acme.test/\n',
      }),
      'no-lockfile',
      options,
    ),
  ).rejects.toThrow(/\.npmrc configures another registry or registry credentials/);
  // Refused for an unpinned Git dependency, resolution does not apply and the refusal stands.
  expect(
    await resolvedLockfileSnapshot(
      await snapshot({
        'package.json': manifest.replace('"^22.6.2"', '"github:stripe/stripe-node#master"'),
      }),
      'non-registry-dependency',
      options,
    ),
  ).toBeUndefined();
  // A binary bun.lockb does not stop resolution; the .npmrc check shows it was reached.
  await expect(
    resolvedLockfileSnapshot(
      await snapshot({
        'package.json': manifest,
        'bun.lockb': 'binary',
        '.npmrc': 'registry=https://npm.acme.test/\n',
      }),
      'no-lockfile',
      options,
    ),
  ).rejects.toThrow(/\.npmrc configures another registry or registry credentials/);
  expect(
    await resolvedLockfileSnapshot(
      await snapshot({ 'package.json': manifest, 'bun.lock': '{}' }),
      'no-lockfile',
      options,
    ),
  ).toBeUndefined();
  expect(resolveNpmLockfile).not.toHaveBeenCalled();
});

const COMMIT = '7eb2d9abeb36e47c9f7183210f43d44bfd27503a';
const ARCHIVE = `https://codeload.github.com/ai/react/tar.gz/${COMMIT}`;

it('pins public GitHub dependencies to their archive at a locked commit or a declared commit or tag', () => {
  const seed = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      'node_modules/@nanostores/react': {
        version: '0.8.0',
        resolved: `git+ssh://git@github.com/ai/react.git#${COMMIT}`,
      },
    },
  });
  expect(
    githubSources(
      { dependencies: { '@nanostores/react': 'github:ai/react', stripe: '^16.9.0' } },
      seed,
    ),
  ).toEqual({
    manifest: { dependencies: { '@nanostores/react': ARCHIVE, stripe: '^16.9.0' } },
    sources: { '@nanostores/react': { source: 'github:ai/react', tarball: ARCHIVE } },
  });
  expect(
    githubSources({
      dependencies: { a: `git+https://github.com/o/a.git#${COMMIT}` },
      devDependencies: { b: 'o/b#v1.2.3' },
    }).manifest,
  ).toEqual({
    dependencies: { a: `https://codeload.github.com/o/a/tar.gz/${COMMIT}` },
    devDependencies: { b: 'https://codeload.github.com/o/b/tar.gz/v1.2.3' },
  });
  // A branch, an unpinned repository, a lock record of another repository, another host and a
  // local path keep their named stop.
  for (const [source, lock] of [
    ['github:ai/react#main', undefined],
    ['github:ai/react', undefined],
    ['github:someone/react', seed],
    ['gitlab:ai/react', undefined],
    ['file:../react', undefined],
    ['github:ai/react#semver:^0.8.0', undefined],
  ] as const)
    expect(() => githubSources({ dependencies: { '@nanostores/react': source } }, lock)).toThrow(
      /^Automatic preparation supports public npm registry dependencies only; package\.json declares @nanostores\/react as/,
    );
});

it('accepts a GitHub archive in package-lock.json only where Refit pinned it', () => {
  const manifest = JSON.stringify({ dependencies: { '@nanostores/react': ARCHIVE } });
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@nanostores/react': ARCHIVE } },
      'node_modules/@nanostores/react': {
        version: '0.8.0',
        resolved: ARCHIVE,
        integrity: INTEGRITY,
      },
    },
  });
  expect(() => validateNpmLock(manifest, lock)).toThrow(
    /^Automatic preparation supports public npm registry dependencies only/,
  );
  expect(validateNpmLock(manifest, lock, new Map(), new Set([ARCHIVE])).packages).toBe(1);
  // An archive recorded below the root is still refused.
  const nested = JSON.parse(lock);
  nested.packages['node_modules/x'] = { version: '1.0.0', resolved: ARCHIVE, integrity: INTEGRITY };
  expect(() =>
    validateNpmLock(manifest, JSON.stringify(nested), new Map(), new Set(['https://other.test'])),
  ).toThrow();
});

it('refuses an .npmrc registry only for the scopes package.json declares, and any credentials', () => {
  const manifest = { dependencies: { next: '^15.0.0' } };
  expect(npmrcRefusal('\n@jsr:registry=https://npm.jsr.io\n', manifest)).toBeUndefined();
  expect(npmrcRefusal('legacy-peer-deps=true\n', manifest)).toBeUndefined();
  for (const [npmrc, declared] of [
    ['@jsr:registry=https://npm.jsr.io', { dependencies: { '@jsr/std__path': '^1.0.0' } }],
    ['@jsr:registry=https://npm.jsr.io', { dependencies: { path: 'npm:@jsr/std__path@^1' } }],
    ['registry=https://npm.acme.test/', manifest],
    ['//registry.npmjs.org/:_authToken=${NPM_TOKEN}', manifest],
  ] as const)
    expect(npmrcRefusal(npmrc, declared)).toMatch(
      /configures another registry or registry credentials/,
    );
});

it('retries an npm peer conflict once with --legacy-peer-deps and records it', async () => {
  const root = await directory({ 'package.json': '{"dependencies":{"a":"^1.0.0"}}\n' });
  const binary = await directory({});
  // Stands in for npm: ERESOLVE unless --legacy-peer-deps is passed.
  await writeFile(
    join(binary, 'npm'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(join(binary, 'calls'))}, args.join(' ') + '\\n');
if (!args.includes('--legacy-peer-deps')) { console.error('npm error code ERESOLVE'); process.exit(1); }
require('node:fs').writeFileSync('package-lock.json', '{"lockfileVersion":3}');
`,
  );
  await chmod(join(binary, 'npm'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  const { stdout } = await execute(
    process.execPath,
    ['--input-type=module', '-e', RESOLVE_SCRIPT, BEFORE, '0', 'npm', '0', '[]'],
    { cwd: root, env: process.env },
  );
  expect(JSON.parse(stdout)).toEqual({
    lockfile: '{"lockfileVersion":3}',
    late: {},
    legacyPeerDeps: true,
  });
  const calls = (await readFile(join(binary, 'calls'), 'utf8')).trim().split('\n');
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatch(/--before=2026-09-15T00:00:00Z --legacy-peer-deps$/);
});

it('moves mirror URLs to registry.npmjs.org in a lockfile that installs GitHub archives', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/a': { resolved: 'https://registry.npmmirror.com/a/-/a-1.0.0.tgz' },
      'node_modules/b': { resolved: 'https://registry.yarnpkg.com/b/-/b-1.0.0.tgz' },
      'node_modules/c': { resolved: ARCHIVE },
    },
  };
  expect(JSON.parse(onRegistryHost(JSON.stringify(lock))).packages).toEqual({
    '': { name: 'app' },
    'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
    'node_modules/b': { resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz' },
    'node_modules/c': { resolved: ARCHIVE },
  });
});

// Networked: resolves with pnpm in Docker against registry.npmjs.org, then prepares the result.
it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'prepares a pnpm project whose lockfile misses a package.json declaration',
  async () => {
    // Recorded with pnpm 9.15.9 from package.json without ms on 2026-10-28.
    const committed = await fixture('pnpm-committed-lock.yaml');
    const root = await directory(
      {
        'package.json': JSON.stringify({
          name: 'pnpm-resolution-fixture',
          version: '1.0.0',
          private: true,
          dependencies: { ms: '2.1.3', nanoid: '^3.3.0' },
        }),
        'pnpm-lock.yaml': committed,
      },
      true,
    );
    await expect(readPreparationInputs(await readCommittedRepository(root))).rejects.toThrow(
      /^pnpm importer/,
    );
    const prepared = await prepareDependencies({
      repository: root,
      image: IMAGE!,
      cacheDirectory: await mkdtemp(join(tmpdir(), 'refit-lock-cache-')),
    });
    expect(prepared.environment).toMatchObject({
      manager: 'pnpm',
      resolvedLockfile: {
        reason: 'lockfile-out-of-sync',
        before: '2026-09-15T00:00:00.000Z',
        manager: 'pnpm',
      },
    });
  },
  600_000,
);

// Networked: resolves in Docker against registry.npmjs.org, then prepares the result offline.
it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'prepares a lone out-of-sync npm lockfile from one resolved with it as the seed',
  async () => {
    // package.json moved to stripe ^23.0.0 and @types/node ^20.0.0; the committed lockfile did not.
    const root = await directory(
      {
        'package.json': await fixture('bumped-package.json'),
        'package-lock.json': await fixture('committed-package-lock.json'),
      },
      true,
    );
    await expect(readPreparationInputs(await readCommittedRepository(root))).rejects.toThrow(
      /^package\.json dependencies differ from the committed package-lock\.json/,
    );
    const prepared = await prepareDependencies({
      repository: root,
      image: IMAGE!,
      cacheDirectory: await mkdtemp(join(tmpdir(), 'refit-lock-cache-')),
    });
    // stripe 23.0.0 was published after the commit date, so its pin is resolved late.
    expect(prepared.environment.resolvedLockfile).toEqual({
      reason: 'lockfile-out-of-sync',
      before: '2026-09-15T00:00:00.000Z',
      late: {
        stripe: {
          spec: '^23.0.0',
          section: 'dependencies',
          published: '2026-10-01T00:52:07.438Z',
        },
      },
    });
    expect(prepared.environment.lockHash).toBe(
      validateNpmLock(
        await fixture('bumped-package.json'),
        await fixture('bumped-package-lock.json'),
      ).lockHash,
    );
  },
  600_000,
);

// Networked: resolves in Docker against registry.npmjs.org, as the fixture was recorded.
it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'replaces the missing lockfile with one resolved as of the commit date',
  async () => {
    const snapshot = await readCommittedRepository(
      await directory({ 'package.json': await fixture('package.json') }, true),
    );
    const resolved = await resolvedLockfileSnapshot(snapshot, 'no-lockfile', { image: IMAGE! });
    expect(resolved?.record).toEqual({ reason: 'no-lockfile', before: '2026-09-15T00:00:00.000Z' });
    expect(resolved?.snapshot.replaced.get('package-lock.json')).toBe(
      await fixture('committed-package-lock.json'),
    );
    expect(resolved?.snapshot.entries.at(-1)).toMatch(/\tpackage-lock\.json$/);
  },
  600_000,
);

// Networked: resolves in Docker against registry.npmjs.org, then prepares the result offline.
it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'prepares a project that commits no lockfile from one resolved as of its commit date',
  async () => {
    const root = await directory({ 'package.json': await fixture('package.json') }, true);
    const prepared = await prepareDependencies({
      repository: root,
      image: IMAGE!,
      cacheDirectory: await mkdtemp(join(tmpdir(), 'refit-lock-cache-')),
    });
    expect(prepared.environment.resolvedLockfile).toEqual({
      reason: 'no-lockfile',
      before: '2026-09-15T00:00:00.000Z',
    });
    expect(prepared.environment.lockHash).toBe(
      validateNpmLock(await fixture('package.json'), await fixture('committed-package-lock.json'))
        .lockHash,
    );
  },
  600_000,
);
