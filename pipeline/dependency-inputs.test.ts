import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  // Without a workflow that installs, the pin alone decides.
  const pinned = await readPreparationInputs(
    await commit({
      ...portal,
      '.github/workflows/ci.yml': workflow('pnpm typecheck'),
      '.github/workflows/css-size.yml': workflow('pnpm run css:purge'),
    }),
  );
  expect(pinned.inputs.lockfileChoice).toEqual({
    lockfile: 'pnpm-lock.yaml',
    rule: 'package-manager',
    because: 'the lockfile of the manager package.json pins (`"packageManager": "pnpm@10.18.3"`)',
    others: { 'package-lock.json': 'not read' },
  });
  // A pin whose lockfile is not committed picks none.
  await expect(
    readPreparationInputs(
      await commit({
        ...portal,
        'package.json': portal['package.json'].replace('pnpm@10.18.3', 'yarn@1.22.22'),
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
      rule: 'in-sync',
      others: {
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
      rule: 'in-sync',
      others: {
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
  // The one in sync is installed even where check selection used to prefer the other's manager:
  // the checks now run with the chosen lockfile's manager (check-selection.ts).
  const stalePnpmLock = pnpmLock().replace('"specifier":"10.17.0"', '"specifier":"10.16.0"');
  for (const [other, content, chosen] of [
    ['pnpm-lock.yaml', stalePnpmLock, 'package-lock.json'],
    ['yarn.lock', yarnLock('10.17.0'), 'yarn.lock'],
  ])
    expect(
      (
        await readPreparationInputs(
          await commit({
            'package.json': manifest('10.17.0'),
            ...(other === 'pnpm-lock.yaml'
              ? { 'package-lock.json': npmLockAt('10.17.0', '10.17.0') }
              : { 'pnpm-lock.yaml': stalePnpmLock }),
            [other]: content,
          }),
        )
      ).inputs.lockfileChoice,
    ).toMatchObject({ lockfile: chosen, rule: 'in-sync' });
});

const recorded = (name: string) =>
  readFile(join(import.meta.dirname, 'fixtures', 'conflicting-lockfiles', name), 'utf8');

// Commits `first`, then `later` on top, and reads the repository at the second commit.
async function commitTwice(first: Record<string, string>, later: Record<string, string>) {
  const repository = (await commit(first)).directory;
  for (const [path, content] of Object.entries(later))
    await writeFile(join(repository, path), content);
  await execute('git', ['-C', repository, 'add', '.']);
  await execute(
    'git',
    [
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
      'test: later',
    ],
    { env: { ...process.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' } },
  );
  return repository;
}

it('installs the most recently committed of several lockfiles in sync with package.json', async () => {
  // Shaped like ensarokumus/tldr-app at 566f26e: no pin, no workflow, package-lock.json and
  // yarn.lock both in sync, and yarn.lock committed last.
  const [manifestText, npm, yarn, pnpm] = await Promise.all(
    ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].map(recorded),
  );
  const repository = await commitTwice(
    { 'package.json': manifestText, 'package-lock.json': npm, 'yarn.lock': `${yarn}\n` },
    { 'yarn.lock': yarn },
  );
  const newest = await readPreparationInputs(await readCommittedRepository(repository));
  expect(newest.inputs.manager).toBe('yarn');
  expect([...newest.files.keys()]).toEqual(['package.json', 'yarn.lock']);
  const { stdout: npmDate } = await execute('git', [
    '-C',
    repository,
    'log',
    '-1',
    '--format=%cI',
    '--',
    'package-lock.json',
  ]);
  expect(newest.inputs.lockfileChoice).toEqual({
    lockfile: 'yarn.lock',
    rule: 'newest',
    because: `the most recently committed lockfile in sync with \`package.json\` (last changed ${(
      await execute('git', ['-C', repository, 'log', '-1', '--format=%cI'])
    ).stdout.trim()})`,
    others: { 'package-lock.json': `package-lock.json was last changed ${npmDate.trim()}.` },
  });
  // An out-of-sync lockfile is never a candidate, however recently committed: the stale
  // package-lock.json is committed last here, and pnpm-lock.yaml is the only one in sync.
  const stale = await recorded('stale-package-lock.json');
  const outOfSync = await readPreparationInputs(
    await readCommittedRepository(
      await commitTwice(
        { 'package.json': manifestText, 'pnpm-lock.yaml': pnpm, 'package-lock.json': npm },
        { 'package-lock.json': stale },
      ),
    ),
  );
  expect(outOfSync.inputs.lockfileChoice).toMatchObject({
    lockfile: 'pnpm-lock.yaml',
    rule: 'in-sync',
  });
  // Committed together, they tie, and none is picked.
  const conflict = 'keep only the lockfile of the package manager you use.';
  await expect(
    readPreparationInputs(
      await commit({ 'package.json': manifestText, 'package-lock.json': npm, 'yarn.lock': yarn }),
    ),
  ).rejects.toThrow(conflict);
  // A shallow clone has no history to date them by.
  const shallow = await mkdtemp(join(tmpdir(), 'refit-dependency-inputs-shallow-'));
  roots.push(shallow);
  await execute('git', ['clone', '-q', '--depth=1', `file://${repository}`, shallow]);
  await expect(readPreparationInputs(await readCommittedRepository(shallow))).rejects.toThrow(
    conflict,
  );
  // A candidate Refit committed itself has one commit; the original commit's choice stands.
  const candidate = await commit({
    'package.json': manifestText,
    'package-lock.json': npm,
    'yarn.lock': yarn,
  });
  expect(
    (await readPreparationInputs(candidate, candidate.entries, newest.inputs.lockfileChoice)).inputs
      .lockfileChoice?.lockfile,
  ).toBe('yarn.lock');
});

it('installs the lockfile of the one manager the GitHub workflows install with', async () => {
  // Shaped like Ankit-Sharma1011/Quill without its pin: pnpm-lock.yaml beside package-lock.json.
  const [manifestText, npm, pnpm] = await Promise.all(
    ['package.json', 'package-lock.json', 'pnpm-lock.yaml'].map(recorded),
  );
  const files = { 'package.json': manifestText, 'package-lock.json': npm, 'pnpm-lock.yaml': pnpm };
  const ci = await readPreparationInputs(
    await commit({ ...files, '.github/workflows/ci.yml': workflow('npm ci', 'npm test') }),
  );
  expect(ci.inputs).toMatchObject({
    manager: 'npm',
    lockfileChoice: {
      lockfile: 'package-lock.json',
      rule: 'ci',
      others: { 'pnpm-lock.yaml': 'not read' },
    },
  });
  // Workflows that install with two managers, or with one whose lockfile is not committed, pick none.
  for (const commands of [['npm ci', 'pnpm install'], ['yarn install --frozen-lockfile']])
    await expect(
      readPreparationInputs(
        await commit({ ...files, '.github/workflows/ci.yml': workflow(...commands) }),
      ),
    ).rejects.toThrow('keep only the lockfile of the package manager you use.');
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
