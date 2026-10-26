import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { readCommittedRepository } from './committed-repository.ts';
import { readPreparationInputs } from './dependency-inputs.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function commit(files: Record<string, string>) {
  const repository = await mkdtemp(join(tmpdir(), 'refit-dependency-inputs-'));
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
    'test: fixture',
  ]);
  return readCommittedRepository(repository);
}

const INTEGRITY = `sha512-${Buffer.alloc(64).toString('base64')}`;
const pnpmLock = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    lockfileVersion: '9.0',
    ...extra,
    importers: { '.': { dependencies: { stripe: { specifier: '10.17.0', version: '10.17.0' } } } },
    packages: { 'stripe@10.17.0': { resolution: { integrity: INTEGRITY } } },
    snapshots: { 'stripe@10.17.0': {} },
  });
const npmLock = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'app', dependencies: { stripe: '9.0.0' } } },
});
const workflow = (...commands: string[]) =>
  `name: CI\non:\n  pull_request:\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${commands.map((command) => `      - run: ${command}\n`).join('')}`;

it('installs with the lockfile of the pinned manager when the repository CI installs only with it', async () => {
  // Alex-Unnippillil/share-house-portal at e593855 pins pnpm@10.18.3, and both workflows that install
  // run `pnpm install --frozen-lockfile`; its package-lock.json is a stale leftover.
  const portal = {
    'package.json': JSON.stringify({
      name: 'share-house-portal',
      packageManager: 'pnpm@10.18.3',
      dependencies: { stripe: '10.17.0' },
    }),
    'pnpm-lock.yaml': pnpmLock(),
    'pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - esbuild\n  - sharp\n',
    'package-lock.json': npmLock,
    '.github/workflows/ci.yml': workflow('pnpm install --frozen-lockfile', 'pnpm typecheck'),
    '.github/workflows/css-size.yml': workflow('pnpm install --frozen-lockfile'),
    // Its Lighthouse workflow is not valid YAML (a heredoc's lines start at column 1); it installs nothing.
    '.github/workflows/lighthouse-ci.yml': `${workflow('pnpm dlx @lhci/cli@0.13.x autorun')}      - run: |\n          node <<'SUMMARY'\nconst fs = require('fs');\nSUMMARY\n`,
  };
  const prepared = await readPreparationInputs(await commit(portal));
  expect(prepared.inputs).toMatchObject({ manager: 'pnpm', managerVersion: '10.18.3' });
  expect([...prepared.files.keys()]).not.toContain('package-lock.json');
  // Installing pnpm itself globally with npm is not a project install.
  expect(
    (
      await readPreparationInputs(
        await commit({
          ...portal,
          '.github/workflows/ci.yml': workflow('npm install -g pnpm@10.18.3 && pnpm install'),
        }),
      )
    ).inputs.manager,
  ).toBe('pnpm');
  const conflict =
    'The repository commits package-lock.json and pnpm-lock.yaml; keep only the lockfile of the package manager you use.';
  // A workflow that installs with npm disagrees with the pin, so neither lockfile is chosen.
  await expect(
    readPreparationInputs(
      await commit({ ...portal, '.github/workflows/css-size.yml': workflow('npm ci') }),
    ),
  ).rejects.toThrow(conflict);
  // So does a repository without a workflow that installs.
  await expect(
    readPreparationInputs(
      await commit({
        ...portal,
        '.github/workflows/ci.yml': workflow('pnpm typecheck'),
        '.github/workflows/css-size.yml': workflow('pnpm run css:purge'),
      }),
    ),
  ).rejects.toThrow(conflict);
});

// A package-lock.json whose root records stripe as `recorded` and locks stripe `version`.
const npmLockAt = (recorded: string, version: string) =>
  JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', dependencies: { stripe: recorded } },
      'node_modules/stripe': {
        version,
        resolved: `https://registry.npmjs.org/stripe/-/stripe-${version}.tgz`,
        integrity: INTEGRITY,
      },
    },
  });
const yarnLock = (range: string, integrity = `  integrity ${INTEGRITY}\n`) =>
  `# yarn lockfile v1\n\n\n"stripe@${range}":\n  version "10.17.0"\n  resolved "https://registry.yarnpkg.com/stripe/-/stripe-10.17.0.tgz"\n${integrity}`;
const manifest = (range: string) =>
  JSON.stringify({ name: 'app', dependencies: { stripe: range } });

it('installs the one committed lockfile in sync with package.json and records why the other was not read', async () => {
  // saidMounaim/tick-event at 18df566 (no packageManager, no CI): package.json pins next 15.3.8,
  // package-lock.json still locks 15.3.4, and pnpm-lock.yaml matches package.json.
  const tickEvent = await readPreparationInputs(
    await commit({
      'package.json': manifest('10.17.0'),
      'package-lock.json': npmLockAt('10.16.0', '10.16.0'),
      'pnpm-lock.yaml': pnpmLock(),
    }),
  );
  expect(tickEvent.inputs).toMatchObject({
    manager: 'pnpm',
    lockfileChoice: {
      lockfile: 'pnpm-lock.yaml',
      outOfSync: {
        'package-lock.json':
          'package.json dependencies differ from the committed package-lock.json: stripe is "10.17.0" in package.json but "10.16.0" in the lockfile.',
      },
    },
  });
  expect([...tickEvent.files.keys()]).not.toContain('package-lock.json');
  // Yosef-Ali/compasstio-ai at 5124832 (no packageManager, no CI): package.json asks for
  // @blocknote/core ^0.26.0, package-lock.json still locks 0.8.0, and yarn.lock records ^0.26.0.
  const compasstio = await readPreparationInputs(
    await commit({
      'package.json': manifest('^10.17.0'),
      'package-lock.json': npmLockAt('^9.0.0', '9.0.0'),
      'yarn.lock': yarnLock('^10.17.0'),
    }),
  );
  expect(compasstio.inputs).toMatchObject({
    manager: 'yarn',
    lockfileChoice: {
      lockfile: 'yarn.lock',
      outOfSync: {
        'package-lock.json':
          'package.json dependencies differ from the committed package-lock.json: stripe is "^10.17.0" in package.json but "^9.0.0" in the lockfile.',
      },
    },
  });
  expect([...compasstio.files.keys()]).toEqual(['package.json', 'yarn.lock']);
});

it('keeps refusing several lockfiles unless exactly one is in sync and the others are out of sync', async () => {
  const conflict = (other: string) =>
    `The repository commits package-lock.json and ${other}; keep only the lockfile of the package manager you use.`;
  // cesarolvr/journeylog-app at 74f52ec: both lockfiles match package.json, so either could be the
  // one its installs use.
  await expect(
    readPreparationInputs(
      await commit({
        'package.json': manifest('10.17.0'),
        'package-lock.json': npmLockAt('10.17.0', '10.17.0'),
        'yarn.lock': yarnLock('10.17.0'),
      }),
    ),
  ).rejects.toThrow(conflict('yarn.lock'));
  // Librum-Reader/Librum-Website at 60d5159: yarn.lock is refused for missing integrity, which says
  // nothing about which lockfile its installs use.
  await expect(
    readPreparationInputs(
      await commit({
        'package.json': manifest('10.17.0'),
        'package-lock.json': npmLockAt('10.17.0', '10.17.0'),
        'yarn.lock': yarnLock('10.17.0', ''),
      }),
    ),
  ).rejects.toThrow(conflict('yarn.lock'));
  // Neither is in sync.
  await expect(
    readPreparationInputs(
      await commit({
        'package.json': manifest('10.17.0'),
        'package-lock.json': npmLockAt('10.16.0', '10.16.0'),
        'pnpm-lock.yaml': pnpmLock().replace('"specifier":"10.17.0"', '"specifier":"10.16.0"'),
      }),
    ),
  ).rejects.toThrow(conflict('pnpm-lock.yaml'));
});

it('gives pnpm each committed patch file whose SHA-256 pnpm-lock.yaml records', async () => {
  // inventashif/hackerai at c48bdee patches ai@6.0.200 from its package.json "pnpm" field;
  // pnpm-lock.yaml records the patch file's SHA-256 (1079dc93… for the 2,975-byte file).
  const patch =
    'diff --git a/dist/index.js b/dist/index.js\n--- a/dist/index.js\n+++ b/dist/index.js\n@@ -1 +1 @@\n-a\n+b\n';
  const hash = createHash('sha256').update(patch).digest('hex');
  const files = (path: string, recorded: string) => ({
    'package.json': JSON.stringify({
      name: 'hackerai',
      packageManager: 'pnpm@10.33.2',
      dependencies: { stripe: '10.17.0' },
      pnpm: { patchedDependencies: { 'stripe@10.17.0': path } },
    }),
    'pnpm-lock.yaml': pnpmLock({
      patchedDependencies: { 'stripe@10.17.0': { hash: recorded, path } },
    }),
    'patches/stripe@10.17.0.patch': patch,
  });
  const prepared = await readPreparationInputs(
    await commit(files('patches/stripe@10.17.0.patch', hash)),
  );
  expect(prepared.inputs.patchHashes).toEqual({ 'patches/stripe@10.17.0.patch': hash });
  expect(prepared.files.get('patches/stripe@10.17.0.patch')).toBe(patch);
  await expect(
    readPreparationInputs(await commit(files('patches/stripe@10.17.0.patch', 'a'.repeat(64)))),
  ).rejects.toThrow(
    'The committed patches/stripe@10.17.0.patch differs from the patch hash pnpm-lock.yaml records.',
  );
  await expect(
    readPreparationInputs(await commit(files('patches/missing.patch', hash))),
  ).rejects.toThrow('not a committed regular file: patches/missing.patch');
});
