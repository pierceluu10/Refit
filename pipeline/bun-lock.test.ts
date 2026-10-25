import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { npmLockFromBun } from './bun-lock.ts';
import { readCommittedRepository } from './committed-repository.ts';
import { readPreparationInputs } from './dependency-inputs.ts';
import { validateNpmLock } from './npm-lock.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const integrity = (seed: string) => `sha512-${Buffer.alloc(64, seed).toString('base64')}`;
// Bun writes JSON with trailing commas, which the translation must read.
const bunLock = (workspace: object, packages: Record<string, unknown[]>) =>
  `${JSON.stringify({ lockfileVersion: 1, workspaces: { '': workspace }, packages }, null, 2).replace(/\n(\s*[}\]])/g, ',\n$1')}\n`;

// guillermolg00/nextjs-stripe-store at 9426a03: a scoped package nested under a scoped parent,
// platform packages reached only through optionalDependencies, a wasm package (cpu "none") that
// bundles its own dependencies, and an optional peer.
const storeManifest = {
  name: 'next-stripe-store',
  dependencies: {
    '@radix-ui/react-alert-dialog': '^1.1.15',
    '@radix-ui/react-slot': '^1.2.4',
    '@tailwindcss/oxide': '4.1.18',
  },
  devDependencies: { '@biomejs/biome': '2.3.8' },
};
const storeLock = bunLock(storeManifest, {
  '@radix-ui/react-alert-dialog': [
    '@radix-ui/react-alert-dialog@1.1.15',
    '',
    {
      dependencies: { '@radix-ui/react-slot': '1.2.3' },
      peerDependencies: { '@types/react': '*' },
      optionalPeers: ['@types/react'],
    },
    integrity('a'),
  ],
  '@radix-ui/react-slot': ['@radix-ui/react-slot@1.2.4', '', {}, integrity('b')],
  '@radix-ui/react-alert-dialog/@radix-ui/react-slot': [
    '@radix-ui/react-slot@1.2.3',
    '',
    {},
    integrity('c'),
  ],
  '@tailwindcss/oxide': [
    '@tailwindcss/oxide@4.1.18',
    '',
    {
      optionalDependencies: {
        '@tailwindcss/oxide-linux-x64-musl': '4.1.18',
        '@tailwindcss/oxide-wasm32-wasi': '4.1.18',
      },
    },
    integrity('d'),
  ],
  '@tailwindcss/oxide-linux-x64-musl': [
    '@tailwindcss/oxide-linux-x64-musl@4.1.18',
    '',
    { os: 'linux', cpu: 'x64' },
    integrity('e'),
  ],
  '@tailwindcss/oxide-wasm32-wasi': [
    '@tailwindcss/oxide-wasm32-wasi@4.1.18',
    '',
    { dependencies: { tslib: '^2.4.0' }, cpu: 'none' },
    integrity('f'),
  ],
  '@tailwindcss/oxide-wasm32-wasi/tslib': ['tslib@2.8.1', '', { bundled: true }, integrity('g')],
  '@biomejs/biome': [
    '@biomejs/biome@2.3.8',
    '',
    {
      optionalDependencies: { '@biomejs/cli-darwin-arm64': '2.3.8' },
      bin: { biome: 'bin/biome' },
    },
    integrity('h'),
  ],
  '@biomejs/cli-darwin-arm64': [
    '@biomejs/cli-darwin-arm64@2.3.8',
    '',
    { os: 'darwin', cpu: 'arm64' },
    integrity('i'),
  ],
});

// Ardione321/prep-ai at bf7fca8: an npm alias (string-width-cjs), a plain package nested under a
// scoped one, and fdir's optional peer on picomatch.
const prepManifest = {
  name: 'prep-ai',
  dependencies: { '@heroui/theme': '2.4.17', '@isaacs/cliui': '8.0.2', fdir: '6.4.6' },
};
const prepLock = bunLock(prepManifest, {
  '@heroui/theme': [
    '@heroui/theme@2.4.17',
    '',
    { dependencies: { clsx: '^1.2.1' } },
    integrity('j'),
  ],
  '@heroui/theme/clsx': ['clsx@1.2.1', '', {}, integrity('k')],
  '@isaacs/cliui': [
    '@isaacs/cliui@8.0.2',
    '',
    { dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' } },
    integrity('l'),
  ],
  'string-width-cjs': ['string-width@4.2.3', '', {}, integrity('m')],
  fdir: [
    'fdir@6.4.6',
    '',
    { peerDependencies: { picomatch: '^3 || ^4' }, optionalPeers: ['picomatch'] },
    integrity('n'),
  ],
});

it('translates a bun.lock into the npm lockfile of the same tree, with platform packages optional', () => {
  const store = JSON.parse(npmLockFromBun(JSON.stringify(storeManifest), storeLock));
  expect(store.packages['']).toEqual(storeManifest);
  expect(
    store.packages['node_modules/@radix-ui/react-alert-dialog/node_modules/@radix-ui/react-slot'],
  ).toEqual({
    version: '1.2.3',
    resolved: 'https://registry.npmjs.org/@radix-ui/react-slot/-/react-slot-1.2.3.tgz',
    integrity: integrity('c'),
  });
  expect(store.packages['node_modules/@radix-ui/react-alert-dialog'].peerDependenciesMeta).toEqual({
    '@types/react': { optional: true },
  });
  expect(store.packages['node_modules/@tailwindcss/oxide-linux-x64-musl']).toMatchObject({
    os: ['linux'],
    cpu: ['x64'],
    optional: true,
  });
  // A bundled package ships inside its parent's tarball, as npm records it.
  expect(store.packages['node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/tslib']).toEqual({
    version: '2.8.1',
    inBundle: true,
    optional: true,
  });
  expect(store.packages['node_modules/@tailwindcss/oxide-wasm32-wasi']).toMatchObject({
    cpu: ['none'],
    optional: true,
  });
  expect(store.packages['node_modules/@biomejs/biome']).not.toHaveProperty('optional');
  expect(store.packages['node_modules/@biomejs/cli-darwin-arm64']).toMatchObject({
    optional: true,
  });
  expect(store.packages['node_modules/@tailwindcss/oxide']).not.toHaveProperty('optional');
  const prep = JSON.parse(npmLockFromBun(JSON.stringify(prepManifest), prepLock));
  expect(prep.packages['node_modules/string-width-cjs']).toEqual({
    name: 'string-width',
    version: '4.2.3',
    resolved: 'https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz',
    integrity: integrity('m'),
  });
  expect(prep.packages['node_modules/@heroui/theme/node_modules/clsx']).toMatchObject({
    version: '1.2.1',
  });
  // An optional peer Bun did not install leaves nothing unresolved.
  expect(prep.packages['node_modules/fdir']).not.toHaveProperty('optional');
  // Refit's npm checks accept both translations as committed lockfiles.
  for (const [manifest, lock] of [
    [storeManifest, storeLock],
    [prepManifest, prepLock],
  ] as const)
    expect(
      validateNpmLock(JSON.stringify(manifest), npmLockFromBun(JSON.stringify(manifest), lock)),
    ).toMatchObject({
      packages: Object.keys(JSON.parse(lock.replace(/,(\s*[}\]])/g, '$1')).packages).length,
    });
});

it('refuses a bun.lock whose tree npm cannot install exactly as Bun lays it out', () => {
  const refusal = (manifest: object, lock: string) => () =>
    npmLockFromBun(JSON.stringify(manifest), lock);
  // joschan21/contentport at 3d86f3a nests jose 6.1.0 inside @better-auth/core to satisfy its peer,
  // while jose 5.10.0 is hoisted; npm resolves a peer from the dependent's parent.
  const contentport = {
    name: 'contentport',
    dependencies: { '@better-auth/core': '1.3.30', jose: '^5.2.3' },
  };
  expect(
    refusal(
      contentport,
      bunLock(contentport, {
        '@better-auth/core': [
          '@better-auth/core@1.3.30',
          '',
          { peerDependencies: { jose: '^6.1.0' } },
          integrity('o'),
        ],
        jose: ['jose@5.10.0', '', {}, integrity('p')],
        '@better-auth/core/jose': ['jose@6.1.0', '', {}, integrity('q')],
      }),
    ),
  ).toThrow(
    "bun.lock nests jose, a peer dependency of @better-auth/core, inside @better-auth/core. npm resolves a peer from the dependent's parent, so it cannot install the tree Bun installs.",
  );
  const tree = (packages: Record<string, unknown[]>) => bunLock(prepManifest, packages);
  const prep = JSON.parse(prepLock.replace(/,(\s*[}\]])/g, '$1')).packages;
  for (const [packages, message] of [
    [
      { ...prep, fdir: ['fdir@github:thecodrr/fdir', '', {}, integrity('n')] },
      'bun.lock records fdir',
    ],
    [
      { ...prep, fdir: ['fdir@6.4.6', 'https://npm.example.invalid/', {}, integrity('n')] },
      'bun.lock records fdir',
    ],
    [{ ...prep, fdir: ['fdir@6.4.6', '', {}, 'sha1-weak'] }, 'bun.lock records fdir'],
    [
      { ...prep, 'missing/clsx': ['clsx@1.2.1', '', {}, integrity('k')] },
      'nests missing/clsx under a package',
    ],
    [
      { ...prep, '@heroui/theme/clsx': undefined },
      'bun.lock leaves clsx unresolved for @heroui/theme',
    ],
  ] as const)
    expect(
      refusal(
        prepManifest,
        tree(JSON.parse(JSON.stringify(packages)) as Record<string, unknown[]>),
      ),
      message,
    ).toThrow(message);
  // Workspaces, and a root that disagrees with package.json, are not translated.
  expect(
    refusal(
      prepManifest,
      prepLock.replace(
        '"workspaces": {',
        '"workspaces": {\n    "packages/web": { "name": "web" },',
      ),
    ),
  ).toThrow('only the root workspace');
  expect(
    refusal(
      { ...prepManifest, dependencies: { ...prepManifest.dependencies, fdir: '6.4.7' } },
      prepLock,
    ),
  ).toThrow(
    'package.json dependencies differ from the committed bun.lock: fdir is "6.4.7" in package.json but "6.4.6" in bun.lock.',
  );
});

async function commit(files: Record<string, string>) {
  const repository = await mkdtemp(join(tmpdir(), 'refit-bun-lock-'));
  roots.push(repository);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repository, path, '..'), { recursive: true });
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
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'test: bun fixture',
  ]);
  return readCommittedRepository(repository);
}

it('prepares from the translation of bun.lock, which Bun reads before a committed bun.lockb', async () => {
  const prepared = await readPreparationInputs(
    await commit({
      'package.json': JSON.stringify(prepManifest),
      'bun.lock': prepLock,
      'bun.lockb': 'binary lockfile Bun reads only without bun.lock',
    }),
  );
  expect(prepared.inputs).toMatchObject({
    manager: 'npm',
    bunLockHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    packages: 5,
  });
  expect([...prepared.files.keys()]).toEqual(['package.json', 'package-lock.json']);
  expect(prepared.files.get('package-lock.json')).toBe(
    npmLockFromBun(JSON.stringify(prepManifest), prepLock),
  );
  await expect(
    readPreparationInputs(
      await commit({
        'package.json': JSON.stringify(prepManifest),
        'bun.lock': prepLock,
        'bunfig.toml': '[install]\nlinker = "isolated"\n',
      }),
    ),
  ).rejects.toThrow('does not read bunfig.toml');
  await expect(
    readPreparationInputs(
      await commit({
        'package.json': JSON.stringify({ ...prepManifest, packageManager: 'pnpm@10.18.3' }),
        'bun.lock': prepLock,
      }),
    ),
  ).rejects.toThrow('The declared package manager differs from the committed bun lockfile.');
});
