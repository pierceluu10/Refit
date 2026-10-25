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

it('keeps refusing conflicting lockfiles without a pinned manager', async () => {
  // Yosef-Ali/compasstio-ai at 5124832 commits package-lock.json and yarn.lock, with no
  // packageManager and no CI: which manager is real is a guess.
  await expect(
    readPreparationInputs(
      await commit({
        'package.json': JSON.stringify({ name: 'compasstio', dependencies: { stripe: '10.17.0' } }),
        'package-lock.json': npmLock,
        'yarn.lock': '# yarn lockfile v1\n',
      }),
    ),
  ).rejects.toThrow(
    'The repository commits package-lock.json and yarn.lock; keep only the lockfile of the package manager you use.',
  );
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
