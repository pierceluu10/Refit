import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { satisfies, sharedMovesOutside, shopifySdkUpgrade } from './shopify-sdk-upgrade.ts';

const REGISTRY = 'https://registry.npmjs.org/';
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const API = '@shopify/shopify-api';
const ADMIN = '@shopify/admin-api-client';
const GRAPHQL = '@shopify/graphql-client';
const EXPRESS = '@shopify/shopify-app-express';
const PRISMA_STORAGE = '@shopify/shopify-app-session-storage-prisma';

type Manifest = Record<string, unknown>;
type Releases = Record<string, Record<string, Manifest>>;

// A small registry: @shopify/shopify-api 12.3.0 is the first release with ApiVersion.April26.
const REMIX = '@shopify/shopify-app-remix';
const RUNTIME = '@remix-run/server-runtime';
const RELEASES: Releases = {
  [REMIX]: {
    '3.4.0': { dependencies: { [API]: '^11.14.1', [RUNTIME]: '^2.10.0' } },
    '4.1.1': { dependencies: { [API]: '^12.3.0', [RUNTIME]: '^2.17.3' } },
  },
  [RUNTIME]: {
    '2.15.2': { dependencies: { cookie: '^0.6.0' } },
    '2.17.3': { dependencies: { cookie: '^0.7.0' } },
  },
  [API]: {
    '11.14.1': { dependencies: { [ADMIN]: '^1.0.0', 'lossless-json': '^2.0.11' } },
    '12.0.0': { dependencies: { [ADMIN]: '^1.1.0' } },
    '12.3.0': {
      dependencies: { [ADMIN]: '^1.1.1', 'compare-versions': '^6.1.1' },
      engines: { node: '>=20.10.0' },
    },
    '12.4.0-rc.0': {},
    '13.1.0': { dependencies: { [ADMIN]: '^1.1.1' } },
    '14.0.0': { dependencies: { [ADMIN]: '^1.1.1' }, engines: { node: '>=22.0.0' } },
  },
  [ADMIN]: {
    '1.0.8': { dependencies: { [GRAPHQL]: '^1.3.0' } },
    '1.1.1': { dependencies: { [GRAPHQL]: '^1.4.1' } },
  },
  [GRAPHQL]: { '1.3.2': {}, '1.4.1': {} },
  'compare-versions': { '6.1.0': {}, '6.1.1': {} },
  [EXPRESS]: {
    '5.0.17': { dependencies: { [API]: '^11.14.1' } },
    '6.0.5': { dependencies: { [API]: '^12.3.0' } },
    '7.0.0': { dependencies: { [API]: '^13.0.0' } },
    '8.0.0': { dependencies: { [API]: '^14.0.0' } },
  },
};

// npm's networked re-resolution (pipeline/lockfile-resolution.ts) runs in Docker; tests answer it.
const resolution = vi.hoisted(() => ({ lockfile: '', calls: [] as { manifest: string }[] }));
vi.mock('./lockfile-resolution.ts', async (actual) => ({
  ...(await actual<typeof import('./lockfile-resolution.ts')>()),
  resolveNpmLockfile: async (options: { manifest: string; before: string }) => {
    resolution.calls.push(options);
    return { lockfile: resolution.lockfile, before: options.before, late: {} };
  },
}));

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tarball = (name: string, version: string) =>
  `${REGISTRY}${name}/-/${name.split('/').at(-1)}-${version}.tgz`;

function locked(name: string, version: string, fields: Record<string, unknown> = {}) {
  return { version, resolved: tarball(name, version), integrity: INTEGRITY, ...fields };
}

const API_ENTRIES = {
  [ADMIN]: locked(ADMIN, '1.0.8', { license: 'MIT', dependencies: { [GRAPHQL]: '^1.3.0' } }),
  [GRAPHQL]: locked(GRAPHQL, '1.3.2', { license: 'MIT' }),
  [API]: locked(API, '11.14.1', {
    license: 'MIT',
    dependencies: { [ADMIN]: '^1.0.0', 'lossless-json': '^2.0.11' },
  }),
  'lossless-json': locked('lossless-json', '2.0.11', { license: 'MIT' }),
};

// package-lock.json version 3 as npm writes it: keys under node_modules in npm order.
function lockfile(
  declared: Record<string, string>,
  entries: Record<string, unknown>,
  section = 'dependencies',
) {
  const packages: Record<string, unknown> = {
    '': { name: 'app', version: '1.0.0', [section]: declared },
  };
  for (const [name, entry] of Object.entries(entries)) packages[`node_modules/${name}`] = entry;
  return {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries(
      Object.entries(packages).sort(([left], [right]) => left.localeCompare(right, 'en')),
    ),
  };
}

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-shopify-sdk-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function project(
  options: {
    declared?: Record<string, string>;
    entries?: Record<string, unknown>;
    section?: string;
    lock?: (lock: ReturnType<typeof lockfile>) => unknown;
    files?: Record<string, string>;
  } = {},
) {
  const declared = options.declared ?? { [API]: '^11.14.1' };
  const section = options.section ?? 'dependencies';
  const lock = lockfile(declared, options.entries ?? API_ENTRIES, section);
  return directory({
    'package.json': `${JSON.stringify({ name: 'app', [section]: declared }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(options.lock?.(lock) ?? lock, null, 2)}\n`,
    ...options.files,
  });
}

function registry(releases: Releases = RELEASES, status = 200) {
  const fetch = vi.fn(async (url: string) => {
    if (status !== 200) return new Response('', { status });
    const parts = url.slice(REGISTRY.length).split('/');
    const scoped = parts[0].startsWith('@');
    const name = parts.slice(0, scoped ? 2 : 1).join('/');
    const version = parts[scoped ? 2 : 1];
    const manifest = (release: string) => ({
      name,
      version: release,
      license: 'MIT',
      ...releases[name][release],
    });
    if (!releases[name] || (version && !releases[name][version]))
      return new Response('{}', { status: 404 });
    return Response.json(
      version
        ? {
            ...manifest(version),
            dist: { tarball: tarball(name, version), integrity: INTEGRITY },
            ...(releases[name][version].dist ? { dist: releases[name][version].dist } : {}),
          }
        : {
            name,
            versions: Object.fromEntries(
              Object.keys(releases[name]).map((release) => [release, manifest(release)]),
            ),
          },
    );
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const render = (lock: unknown) => `${JSON.stringify(lock, null, 2)}\n`;

it('reads the npm range forms Shopify packages use and refuses the rest', () => {
  const cases: [string, string, boolean | undefined][] = [
    ['12.3.0', '^12.0.0', true],
    ['13.0.0', '^12.0.0', false],
    ['0.2.5', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['1.4.1', '~1.4', true],
    ['1.5.0', '~1.4', false],
    ['2.17.3', '>=2.17.3 <3.0.0', true],
    ['2.16.8', '>=2.17.3 <3.0.0', false],
    ['12.0.0', '^11.0.0 || ^12.0.0', true],
    ['1.2.3', '*', true],
    ['1.2.3', '', true],
    ['1.2.3', '1.x', true],
    ['1.3.0', '>1.2', true],
    ['1.2.9', '>1.2', false],
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['12.4.0-rc.0', '^12.0.0', false],
    ['1.0.0', 'npm:other@^1.0.0', undefined],
    ['1.0.0', 'latest', undefined],
  ];
  for (const [version, range, expected] of cases)
    expect([version, range, satisfies(version, range)]).toEqual([version, range, expected]);
});

it('moves @shopify/shopify-api and its SDK family to the first release naming the target member', async () => {
  const fetch = registry();
  const root = await project();
  const result = await shopifySdkUpgrade(root, 'April26');
  if (!('upgrade' in result)) throw new Error(result.reason);
  expect(fetch).toHaveBeenCalledWith(
    `${REGISTRY}${API}`,
    expect.objectContaining({
      redirect: 'error',
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    }),
  );
  const { files, ...upgrade } = result.upgrade;
  expect(upgrade).toEqual({
    primary: API,
    from: '11.14.1',
    to: '12.3.0',
    apiRelease: '12.3.0',
    packages: [
      { name: API, from: '11.14.1', to: '12.3.0' },
      { name: ADMIN, from: '1.0.8', to: '1.1.1' },
      { name: 'compare-versions', from: null, to: '6.1.1' },
      { name: GRAPHQL, from: '1.3.2', to: '1.4.1' },
    ],
    removed: ['lossless-json'],
  });
  const [manifest, lock] = files;
  expect(manifest.after).toBe(manifest.before.replace('"^11.14.1"', '"^12.3.0"'));
  // Byte for byte what npm writes: the new entries in npm's key order, lossless-json dropped.
  expect(lock.after).toBe(
    render(
      lockfile(
        { [API]: '^12.3.0' },
        {
          [ADMIN]: locked(ADMIN, '1.1.1', {
            license: 'MIT',
            dependencies: { [GRAPHQL]: '^1.4.1' },
          }),
          [GRAPHQL]: locked(GRAPHQL, '1.4.1', { license: 'MIT' }),
          [API]: locked(API, '12.3.0', {
            license: 'MIT',
            dependencies: { [ADMIN]: '^1.1.1', 'compare-versions': '^6.1.1' },
            engines: { node: '>=20.10.0' },
          }),
          'compare-versions': locked('compare-versions', '6.1.1', { license: 'MIT' }),
        },
      ),
    ),
  );
});

it('keeps a declaration that already admits the release and flags dev-only packages', async () => {
  registry();
  const dev = Object.fromEntries(
    Object.entries(API_ENTRIES).map(([name, entry]) => [name, { ...entry, dev: true }]),
  );
  const result = await shopifySdkUpgrade(
    await project({ declared: { [API]: '>=11.0.0' }, entries: dev, section: 'devDependencies' }),
    'April26',
  );
  if (!('upgrade' in result)) throw new Error(result.reason);
  const [lock, ...others] = result.upgrade.files;
  expect([lock.path, others]).toEqual(['package-lock.json', []]);
  const packages = JSON.parse(lock.after).packages;
  expect(packages[''].devDependencies).toEqual({ [API]: '>=11.0.0' });
  expect(Object.keys(packages['node_modules/compare-versions'])).toEqual([
    'version',
    'resolved',
    'integrity',
    'dev',
    'license',
  ]);
  for (const name of [API, ADMIN, GRAPHQL, 'compare-versions'])
    expect([name, packages[`node_modules/${name}`].dev]).toEqual([name, true]);
});

it('moves an app package to its target major, bringing @shopify/shopify-api with it', async () => {
  registry();
  const result = await shopifySdkUpgrade(
    await project({
      declared: { [EXPRESS]: '^5.0.17' },
      entries: {
        ...API_ENTRIES,
        [EXPRESS]: locked(EXPRESS, '5.0.17', {
          license: 'MIT',
          dependencies: { [API]: '^11.14.1' },
        }),
      },
    }),
    'April26',
  );
  if (!('upgrade' in result)) throw new Error(result.reason);
  expect(result.upgrade).toMatchObject({
    primary: EXPRESS,
    from: '5.0.17',
    to: '6.0.5',
    apiRelease: '12.3.0',
  });
  const [manifest] = result.upgrade.files;
  expect(manifest.after).toBe(manifest.before.replace('"^5.0.17"', '"^6.0.5"'));
});

it('moves a session storage adapter only to a release whose peers the lockfile satisfies', async () => {
  const adapter = (prisma: string) => ({ peerDependencies: { [API]: '^12.0.0', prisma } });
  const entries = {
    ...API_ENTRIES,
    [PRISMA_STORAGE]: locked(PRISMA_STORAGE, '5.0.2', {
      license: 'MIT',
      peerDependencies: { [API]: '^11.0.0', prisma: '^5.0.0' },
    }),
    prisma: locked('prisma', '5.22.0', { license: 'Apache-2.0' }),
  };
  const declared = { [API]: '^11.14.1', [PRISMA_STORAGE]: '^5.0.2', prisma: '^5.22.0' };
  registry({
    ...RELEASES,
    [PRISMA_STORAGE]: {
      '5.0.2': { peerDependencies: { [API]: '^11.0.0', prisma: '^5.0.0' } },
      '6.0.9': adapter('^5.0.0'),
      '7.0.0': adapter('^6.15.0'),
    },
  });
  const moved = await shopifySdkUpgrade(await project({ declared, entries }), 'April26');
  if (!('upgrade' in moved)) throw new Error(moved.reason);
  expect(moved.upgrade.packages).toContainEqual({
    name: PRISMA_STORAGE,
    from: '5.0.2',
    to: '6.0.9',
  });
  expect(moved.upgrade.files[0].after).toContain(`"${PRISMA_STORAGE}": "^6.0.9"`);

  registry({
    ...RELEASES,
    [PRISMA_STORAGE]: {
      '5.0.2': { peerDependencies: { [API]: '^11.0.0', prisma: '^5.0.0' } },
      '7.0.0': adapter('^6.15.0'),
    },
  });
  expect(await shopifySdkUpgrade(await project({ declared, entries }), 'April26')).toEqual({
    reason: `The lockfile cannot take the ${API} 12 upgrade without npm resolving it again; the closest release, 12.3.0: ${PRISMA_STORAGE} 7.0.0, the first release for ${API} 12.3.0, needs prisma ^6.15.0 (the lockfile has 5.22.0).`,
  });
});

it('names every range the lockfile cannot keep instead of resolving the tree again', async () => {
  registry({
    ...RELEASES,
    'compare-versions': { '6.1.1': { dependencies: { semver: '^7.0.0' } } },
  });
  const result = await shopifySdkUpgrade(
    await project({
      entries: {
        ...API_ENTRIES,
        other: locked('other', '1.0.0', { dependencies: { [GRAPHQL]: '~1.3.0' } }),
      },
    }),
    'April26',
  );
  expect(result).toEqual({
    reason: `The lockfile cannot take the ${API} 12 upgrade without npm resolving it again; the closest release, 12.3.0: ${API} 12.3.0 needs compare-versions ^6.1.1; the lockfile has none, and no dependency-free release fits every range. other 1.0.0 needs ${GRAPHQL} ~1.3.0; the upgrade chooses 1.4.1.`,
  });
});

it('upgrades package-lock.json when the documented lockfile choice picks it, naming the others', async () => {
  registry();
  const root = await project({ files: { 'yarn.lock': '# yarn lockfile v1\n' } });
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ ...manifest, packageManager: 'npm@10.9.2' }, null, 2)}\n`,
  );
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'init');
  const result = await shopifySdkUpgrade(root, 'April26');
  expect(result).toMatchObject({
    upgrade: { to: '12.3.0', otherLockfiles: { 'yarn.lock': expect.any(String) } },
  });
  const files = 'upgrade' in result ? result.upgrade.files.map((file) => file.path) : [];
  expect(files).toEqual(['package.json', 'package-lock.json']);
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ ...manifest, packageManager: 'yarn@1.22.22' }, null, 2)}\n`,
  );
  git('commit', '-qam', 'yarn');
  // yarn.lock is chosen, and preparation refuses it, so the upgrade does too.
  expect(await shopifySdkUpgrade(root, 'April26')).toEqual({
    reason: expect.stringMatching(
      /^Preparation cannot read the committed lockfile, so the Shopify SDK upgrade cannot either: /,
    ),
  });
});

// pnpm-lock.yaml version 9 for a root project declaring the remix app package at `remix`.
function pnpmLock(remix: string, api: string, runtime: string, other = '1.0.0') {
  const pkg = (name: string, version: string) =>
    `  '${name}@${version}':\n    resolution: {integrity: ${INTEGRITY}}\n`;
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '${REMIX}':
        specifier: ^${remix}
        version: ${remix}
      other:
        specifier: ^1.0.0
        version: ${other}

packages:

${[pkg(API, api), pkg(REMIX, remix), pkg(RUNTIME, runtime), pkg('other', other)].join('\n')}
snapshots:

  '${API}@${api}': {}

  '${REMIX}@${remix}':
    dependencies:
      '${API}': ${api}
      '${RUNTIME}': ${runtime}

  '${RUNTIME}@${runtime}': {}

  other@${other}: {}
`;
}

it('re-resolves a pnpm lockfile with the pnpm release preparation uses, keeping nothing else it changes', async () => {
  registry();
  const root = await directory({
    'package.json': `${JSON.stringify({ name: 'app', packageManager: 'pnpm@9.1.0', dependencies: { [REMIX]: '^3.4.0', other: '^1.0.0' } }, null, 2)}\n`,
    'pnpm-lock.yaml': pnpmLock('3.4.0', '11.14.1', '2.15.2'),
  });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'init');
  const options = { image: 'node:22-alpine', before: '2026-01-01T00:00:00Z' };
  expect(await shopifySdkUpgrade(root, 'April26')).toEqual({
    reason:
      'The repository installs from pnpm-lock.yaml. Its upgrade needs lockfile resolution, which is off.',
  });
  resolution.lockfile = pnpmLock('4.1.1', '12.3.0', '2.17.3');
  const result = await shopifySdkUpgrade(root, 'April26', options);
  expect(result).toMatchObject({
    upgrade: {
      primary: REMIX,
      from: '3.4.0',
      to: '4.1.1',
      apiRelease: '12.3.0',
      resolved: {
        manager: 'pnpm 9.1.0',
        lockfile: 'pnpm-lock.yaml',
        frameworks: [`${RUNTIME} 2.15.2 → 2.17.3`],
      },
    },
  });
  expect(resolution.calls.at(-1)).toMatchObject({
    manager: 'pnpm',
    managerVersion: '9.1.0',
    managerArguments: [
      '--config.auto-install-peers=true',
      '--config.exclude-links-from-lockfile=false',
    ],
  });
  const files = 'upgrade' in result ? result.upgrade.files.map((file) => file.path) : [];
  expect(files).toEqual(['package.json', 'pnpm-lock.yaml']);
  // A package the app declares on its own moves too: refused.
  resolution.lockfile = pnpmLock('4.1.1', '12.3.0', '2.17.3', '1.1.0');
  expect(await shopifySdkUpgrade(root, 'April26', options)).toMatchObject({
    reason: expect.stringContaining(
      "pnpm 9.1.0's re-resolved pnpm-lock.yaml changes importer ., other@1.0.0, other@1.1.0",
    ),
  });
});

it('moves several majors to the release that ships the member, unless a documented break stops it', async () => {
  registry();
  const result = await shopifySdkUpgrade(await project(), 'October26');
  expect(result).toMatchObject({ upgrade: { primary: API, from: '11.14.1', to: '14.0.0' } });
  const root = await project();
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ ...manifest, engines: { node: '>=20 <22' } }, null, 2)}\n`,
  );
  expect(await shopifySdkUpgrade(root, 'October26')).toEqual({
    reason: `${API} 14 needs Node.js 22.0.0 or later, and package.json declares engines.node >=20 <22.`,
  });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ ...manifest, engines: { node: '22.14.0' } }, null, 2)}\n`,
  );
  expect(await shopifySdkUpgrade(root, 'October26')).toMatchObject({ upgrade: { to: '14.0.0' } });
  // @shopify/shopify-app-express 8 is the first on 14; crossing 7 moves the app to Express 5.
  const express = await project({
    declared: { [EXPRESS]: '^5.0.17' },
    entries: {
      ...API_ENTRIES,
      [EXPRESS]: locked(EXPRESS, '5.0.17', { license: 'MIT', dependencies: { [API]: '^11.14.1' } }),
    },
  });
  expect(await shopifySdkUpgrade(express, 'October26')).toEqual({
    reason: `${EXPRESS} 7.0.0 moves the app from Express 4 to Express 5 (0d4a3f7), a framework migration; the upgrade to 8.0.0 stops for review.`,
  });
});

it('refuses registry metadata it cannot verify and reports registry failures', async () => {
  const withRelease = (fields: Manifest) => ({
    ...RELEASES,
    [API]: { ...RELEASES[API], '12.3.0': { ...RELEASES[API]['12.3.0'], ...fields } },
  });
  const unverifiable = `Shopify SDK metadata could not be read: The npm registry metadata for ${API} 12.3.0 is not a verifiable release this upgrade can lock.`;
  registry(withRelease({ scripts: { postinstall: 'node install.js' } }));
  expect(await shopifySdkUpgrade(await project(), 'April26')).toEqual({ reason: unverifiable });
  registry(
    withRelease({
      dist: { tarball: 'https://example.com/shopify-api-12.3.0.tgz', integrity: INTEGRITY },
    }),
  );
  expect(await shopifySdkUpgrade(await project(), 'April26')).toEqual({ reason: unverifiable });
  registry(RELEASES, 404);
  expect(await shopifySdkUpgrade(await project(), 'April26')).toEqual({
    reason: `Shopify SDK metadata could not be read: The npm registry returned HTTP 404 for ${REGISTRY}${API}.`,
  });
});

it('refuses projects and targets outside the upgrade before reading the registry', async () => {
  const fetch = registry();
  const cases: [string, Promise<string>, string][] = [
    [
      'another lockfile',
      project({ files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" } }),
      'The repository commits several lockfiles and no documented rule picks one.',
    ],
    [
      'lockfile version 2',
      project({ lock: (lock) => ({ ...lock, lockfileVersion: 2 }) }),
      'The Shopify SDK upgrade covers npm lockfile version 3 only.',
    ],
    [
      'keys out of order',
      project({
        lock: (lock) => ({
          ...lock,
          packages: Object.fromEntries(Object.entries(lock.packages).reverse()),
        }),
      }),
      'package-lock.json packages are not in npm order.',
    ],
    [
      'two majors behind',
      project({ entries: { ...API_ENTRIES, [API]: locked(API, '10.0.0') } }),
      `${API} 10.0.0 is older than 11, the oldest major whose migration Refit applies.`,
    ],
    [
      'newer major',
      project({ entries: { ...API_ENTRIES, [API]: locked(API, '13.1.0') } }),
      `${API} 13.1.0 is newer than major 12, which this upgrade targets.`,
    ],
    [
      'nested copy',
      project({
        entries: {
          ...API_ENTRIES,
          other: locked('other', '1.0.0'),
          [`other/node_modules/${API}`]: locked(API, '11.0.0'),
        },
      }),
      `package-lock.json nests ${API} under other 1.0.0.`,
    ],
    [
      'two app packages',
      project({ declared: { [EXPRESS]: '^5.0.0', '@shopify/shopify-app-remix': '^3.0.0' } }),
      `package.json declares several Shopify app packages (@shopify/shopify-app-remix, ${EXPRESS}).`,
    ],
    [
      'no Shopify package',
      project({ declared: { express: '^4.0.0' } }),
      `package.json declares neither ${API} nor a Shopify app package.`,
    ],
  ];
  for (const [label, root, reason] of cases)
    expect([label, await shopifySdkUpgrade(await root, 'April26')]).toEqual([label, { reason }]);
  expect(await shopifySdkUpgrade(await project(), 'Someday99')).toEqual({
    reason: `No ${API} release is recorded for ApiVersion.Someday99.`,
  });
  expect(fetch).not.toHaveBeenCalled();
});

// The same schema on both versions, so every document validates and only the SDK limits the pin.
it('lets npm re-resolve framework packages an SDK major needs, and keeps nothing else it changes', async () => {
  registry();
  const entries = {
    ...API_ENTRIES,
    [REMIX]: locked(REMIX, '3.4.0', {
      license: 'MIT',
      dependencies: { [API]: '^11.14.1', [RUNTIME]: '^2.10.0' },
    }),
    [RUNTIME]: locked(RUNTIME, '2.15.2', { license: 'MIT', dependencies: { cookie: '^0.6.0' } }),
    cookie: locked('cookie', '0.6.0', { license: 'MIT' }),
    other: locked('other', '1.0.0', { license: 'MIT' }),
  };
  const declared = { [REMIX]: '^3.4.0', other: '^1.0.0' };
  const root = await project({ declared, entries });
  // Without resolution, the lockfile cannot take remix 4's newer server runtime.
  expect(await shopifySdkUpgrade(root, 'April26')).toMatchObject({
    reason: expect.stringContaining(`${RUNTIME} ^2.17.3`),
  });
  const resolved = (changes: Record<string, unknown>) =>
    JSON.stringify(
      lockfile(
        { ...declared, [REMIX]: '^4.1.1' },
        {
          ...entries,
          [REMIX]: locked(REMIX, '4.1.1', { license: 'MIT', dependencies: { [API]: '^12.3.0' } }),
          [API]: locked(API, '12.3.0', { license: 'MIT', dependencies: { [ADMIN]: '^1.1.1' } }),
          [RUNTIME]: locked(RUNTIME, '2.17.3', {
            license: 'MIT',
            dependencies: { cookie: '^0.7.0' },
          }),
          cookie: locked('cookie', '0.7.0', { license: 'MIT' }),
          ...changes,
        },
      ),
      null,
      2,
    ) + '\n';
  resolution.lockfile = resolved({});
  const result = await shopifySdkUpgrade(root, 'April26', {
    image: 'node:22-alpine',
    before: '2026-01-01T00:00:00Z',
  });
  expect(result).toMatchObject({
    upgrade: {
      primary: REMIX,
      to: '4.1.1',
      apiRelease: '12.3.0',
      resolved: {
        before: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        frameworks: [`${RUNTIME} 2.15.2 → 2.17.3`],
      },
    },
  });
  expect(resolution.calls.at(-1)?.manifest).toContain(`"${REMIX}": "^4.1.1"`);
  // A change to a package the app also uses on its own is refused.
  resolution.lockfile = resolved({ other: locked('other', '1.1.0', { license: 'MIT' }) });
  expect(
    await shopifySdkUpgrade(root, 'April26', {
      image: 'node:22-alpine',
      before: '2026-01-01T00:00:00Z',
    }),
  ).toMatchObject({ reason: expect.stringContaining('node_modules/other') });
});

it('rewrites package.json alone when no lockfile is committed', async () => {
  registry();
  const root = await directory({
    'package.json': `${JSON.stringify({ name: 'app', dependencies: { [API]: '^11.14.1' } }, null, 2)}\n`,
  });
  const result = await shopifySdkUpgrade(root, 'October26');
  expect(result).toMatchObject({
    upgrade: { primary: API, from: '11.14.1', to: '14.0.0', lockless: true, apiRelease: '14.0.0' },
  });
  const files = 'upgrade' in result ? result.upgrade.files : [];
  expect(files.map((file) => file.path)).toEqual(['package.json']);
  expect(files[0].after).toContain(`"${API}": "^14.0.0"`);
});

it('never moves a lockless declaration backwards and leaves one that already allows the target', async () => {
  registry();
  const root = await directory({
    'package.json': `${JSON.stringify({ name: 'app', dependencies: { [REMIX]: '^4.1.0' } }, null, 2)}\n`,
  });
  expect(await shopifySdkUpgrade(root, 'January26')).toMatchObject({
    upgrade: { primary: REMIX, to: '4.1.1', lockless: true, files: [] },
  });
});

it('moves prisma with the session storage that needs it, and stops on Prisma 6 schema changes', async () => {
  registry({
    ...RELEASES,
    [PRISMA_STORAGE]: {
      '5.0.2': { peerDependencies: { [API]: '^11.0.0', prisma: '^5.0.0' } },
      '7.0.0': {
        peerDependencies: { [API]: '^12.0.0', prisma: '^6.15.0', '@prisma/client': '^6.15.0' },
      },
    },
    prisma: { '5.22.0': {}, '6.15.0': {}, '6.19.0': {}, '7.0.0': {} },
    '@prisma/client': { '5.22.0': {}, '6.19.0': {}, '7.0.0': {} },
  });
  const manifest = {
    name: 'app',
    dependencies: {
      [REMIX]: '^3.4.0',
      [PRISMA_STORAGE]: '^5.0.2',
      '@prisma/client': '^5.22.0',
      prisma: '^5.22.0',
    },
  };
  const schema = (fields: string) =>
    `datasource db {\n  provider = "sqlite"\n  url = "file:dev.sqlite"\n}\nmodel Session {\n  id String @id\n${fields}}\n`;
  const root = await directory({
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'prisma/schema.prisma': schema('  shop String\n'),
  });
  const result = await shopifySdkUpgrade(root, 'April26');
  expect(result).toMatchObject({ upgrade: { primary: REMIX, to: '4.1.1', lockless: true } });
  const after = 'upgrade' in result ? result.upgrade.files[0].after : '';
  expect(after).toContain('"prisma": "^6.19.0"');
  expect(after).toContain('"@prisma/client": "^6.19.0"');
  expect(after).toContain(`"${PRISMA_STORAGE}": "^7.0.0"`);
  await writeFile(join(root, 'prisma/schema.prisma'), schema('  data Bytes\n'));
  expect(await shopifySdkUpgrade(root, 'April26')).toEqual({
    reason:
      'Prisma 6 returns Bytes fields as Uint8Array instead of Buffer, and the schema has a Bytes field.',
  });
});

it('lets npm move a shared package only within its major, as every dependent range allows', () => {
  const lock = (root: Record<string, string>, packages: Record<string, unknown>) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: root }, ...packages },
    });
  const before = lock(
    { [API]: '^11.0.0', isbot: '^5.1.0', other: '^1.0.0' },
    {
      [`node_modules/${API}`]: {
        version: '11.12.0',
        dependencies: { isbot: '^5.1.21', 'node-fetch': '^2.6.1' },
      },
      'node_modules/isbot': { version: '5.1.26' },
      'node_modules/node-fetch': { version: '2.7.0' },
      'node_modules/other': { version: '1.0.0', dependencies: { 'node-fetch': '^2.6.1' } },
    },
  );
  const after = (root: Record<string, string>, isbot: string, other = '1.0.0') =>
    lock(root, {
      [`node_modules/${API}`]: { version: '14.0.1', dependencies: { isbot: '^5.2.0' } },
      'node_modules/isbot': { version: isbot },
      // Only a dev dependency reaches it now, so npm flags it; the flag alone is no change.
      'node_modules/node-fetch': { version: '2.7.0', dev: true },
      'node_modules/other': { version: other, dependencies: { 'node-fetch': '^2.6.1' } },
    });
  const root = { [API]: '^14.0.1', isbot: '^5.1.0', other: '^1.0.0' };
  expect(sharedMovesOutside(before, after(root, '5.2.2'), [API])).toEqual([]);
  // Another major, a declaration the move breaks, or a package the app alone moves all stop.
  expect(sharedMovesOutside(before, after(root, '6.0.0'), [API])).toEqual(['node_modules/isbot']);
  expect(sharedMovesOutside(before, after({ ...root, isbot: '~5.1.0' }, '5.2.2'), [API])).toEqual([
    'node_modules/isbot',
  ]);
  expect(sharedMovesOutside(before, after(root, '5.2.2', '1.1.0'), [API])).toEqual([
    'node_modules/other',
  ]);
});
