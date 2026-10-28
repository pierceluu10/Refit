import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readCommittedRepository } from './committed-repository.ts';
import { prepareDependencies } from './dependency-preparation.ts';
import {
  changesOutside,
  keepSeedNames,
  lockfileResolutionEnabled,
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
      await snapshot({ 'package.json': manifest, 'pnpm-lock.yaml': '' }),
      'lockfile-out-of-sync',
      options,
    ),
  ).toBeUndefined();
  expect(
    await resolvedLockfileSnapshot(
      await snapshot({ 'package.json': manifest }),
      'peer-dependency-conflict',
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
    /^Automatic preparation supports public npm registry dependencies only; package.json declares stripe as/,
  );
  await expect(
    resolvedLockfileSnapshot(
      await snapshot({
        'package.json': manifest,
        '.npmrc': '@acme:registry=https://npm.acme.test/\n',
      }),
      'no-lockfile',
      options,
    ),
  ).rejects.toThrow(/\.npmrc configures another registry or registry credentials/);
  expect(resolveNpmLockfile).not.toHaveBeenCalled();
});

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
