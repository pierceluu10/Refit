import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readRepository } from './repository.ts';
import { resolveLockedDependency } from './lockfiles.ts';
import { runPipeline } from './run.ts';

const roots: string[] = [];
const declaration = { file: 'package.json', section: 'dependencies', version: '^10.0.0' };
const packages = {
  '': { dependencies: { stripe: '^10.0.0' } },
  'node_modules/stripe': {
    version: '10.17.0',
    resolved: 'https://private-token@example.invalid/stripe.tgz',
  },
};
const resolveLock = (
  content: Record<string, unknown>,
  dependency = declaration,
  packageName = 'stripe',
) => resolveLockedDependency(dependency, packageName, [{ file: 'package-lock.json', content }]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([2, 3])(
  'reads the recorded SDK version from npm lockfile v%s without exposing registry URLs',
  (lockfileVersion) => {
    const result = resolveLock({ lockfileVersion, packages });
    expect(result).toMatchObject({
      status: 'locked',
      version: '10.17.0',
      file: 'package-lock.json',
      packagePath: 'node_modules/stripe',
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
  },
);

it('resolves workspace-local installations before hoisted installations', () => {
  const dependency = { ...declaration, file: 'packages/billing/package.json' };
  const entries = {
    ...packages,
    'packages/billing': packages[''],
    'packages/billing/node_modules/stripe': { version: '10.18.0' },
  };
  expect(resolveLock({ lockfileVersion: 3, packages: entries }, dependency).version).toBe(
    '10.18.0',
  );
  expect(
    resolveLock(
      { lockfileVersion: 3, packages: { ...packages, 'packages/billing': packages[''] } },
      dependency,
    ).packagePath,
  ).toBe('node_modules/stripe');
});

it('does not skip a linked nearest entry to claim a hoisted version', () => {
  const dependency = { ...declaration, file: 'packages/billing/package.json' };
  expect(
    resolveLock(
      {
        lockfileVersion: 3,
        packages: {
          ...packages,
          'packages/billing': packages[''],
          'packages/billing/node_modules/stripe': { link: true, resolved: '../local-stripe' },
        },
      },
      dependency,
    ),
  ).toMatchObject({ status: 'unknown', version: null });
});

it.each([
  { lockfileVersion: 1, packages },
  { lockfileVersion: 4, packages },
  { lockfileVersion: 3 },
  { lockfileVersion: 3, packages: { ...packages, '': { dependencies: { stripe: '^11' } } } },
  { lockfileVersion: 3, packages: { '': packages[''] } },
  { lockfileVersion: 3, packages: { ...packages, 'node_modules/stripe': { version: 'latest' } } },
  {
    lockfileVersion: 3,
    packages: {
      ...packages,
      'node_modules/stripe': { name: 'another-package', version: '10.0.0' },
    },
  },
])('keeps unsupported, stale or incomplete lock evidence unknown: %j', (content) => {
  expect(resolveLock(content)).toMatchObject({
    status: 'unknown',
    version: null,
    packagePath: null,
  });
});

it('does not assume npm-version-dependent shrinkwrap selection', () => {
  expect(
    resolveLockedDependency(declaration, 'stripe', [
      { file: 'package-lock.json', content: { lockfileVersion: 3, packages } },
      { file: 'npm-shrinkwrap.json', content: { lockfileVersion: 3, packages } },
    ]),
  ).toMatchObject({ status: 'unknown', file: 'npm-shrinkwrap.json', version: null });
});

it('supports scoped provider packages but keeps npm aliases unknown', () => {
  const dependency = { ...declaration, version: '1.2.3' };
  expect(
    resolveLock(
      {
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { '@example/catalog': '1.2.3' } },
          'node_modules/@example/catalog': { version: '1.2.3' },
        },
      },
      dependency,
      '@example/catalog',
    ).version,
  ).toBe('1.2.3');
  expect(
    resolveLock(
      {
        lockfileVersion: 3,
        packages: { ...packages, '': { dependencies: { stripe: 'npm:other@1' } } },
      },
      { ...declaration, version: 'npm:other@1' },
    ).status,
  ).toBe('unknown');
});

it('records lock hashes and changes run identity when only locked SDK evidence changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-lockfile-'));
  roots.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { stripe: declaration.version } }),
  );
  await writeFile(
    join(root, 'billing.ts'),
    await readFile('pipeline/fixtures/repository/billing.ts', 'utf8'),
  );
  const lockPath = join(root, 'package-lock.json');
  await writeFile(lockPath, JSON.stringify({ lockfileVersion: 3, packages }));
  const options = {
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
  };
  const first = await runPipeline(options);
  expect(first.repository.dependencies[0].lock.version).toBe('10.17.0');
  expect(JSON.stringify(first)).not.toContain('private-token');
  await writeFile(
    lockPath,
    JSON.stringify({
      lockfileVersion: 3,
      packages: { ...packages, 'node_modules/stripe': { version: '10.18.0' } },
    }),
  );
  const second = await runPipeline(options);
  expect(second.runId).not.toBe(first.runId);
  expect(second.repository.lockfiles[0].hash).not.toBe(first.repository.lockfiles[0].hash);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/package-lock.json'), 'not parsed as a root lockfile');
  expect((await readRepository(root)).lockfiles).toHaveLength(1);
  await writeFile(lockPath, '{');
  await expect(readRepository(root)).rejects.toThrow(/not valid JSON/);
});
