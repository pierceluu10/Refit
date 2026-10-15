import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveLockedDependency } from './lockfiles.ts';
import { readRepository } from './repository.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const dependency = {
  file: 'packages/billing/package.json',
  section: 'dependencies',
  version: '^10.0.0',
};
function lock() {
  return {
    lockfileVersion: '9.0',
    importers: {
      'packages/billing': {
        dependencies: {
          stripe: { specifier: '^10.0.0', version: '10.17.0(@types/node@22.15.30)' },
        },
      },
    },
    packages: {
      'stripe@10.17.0': { resolution: { tarball: 'https://secret@example.invalid/private.tgz' } },
    },
    snapshots: { 'stripe@10.17.0(@types/node@22.15.30)': {} },
  };
}
function resolve(content: Record<string, unknown>, declaration = dependency) {
  return resolveLockedDependency(declaration, 'stripe', [{ file: 'pnpm-lock.yaml', content }]);
}

it('records the exact pnpm workspace package and peer-qualified graph without registry data', () => {
  expect(resolve(lock())).toMatchObject({
    status: 'locked',
    version: '10.17.0',
    file: 'pnpm-lock.yaml',
    packagePath: 'packages/stripe@10.17.0',
  });
  expect(JSON.stringify(resolve(lock()))).not.toContain('secret');
});
it.each(['npm:other@10.17.0', 'workspace:*', 'file:../sdk', 'link:../sdk'])(
  'keeps %s SDK sources unverified',
  (version) => {
    const sample = lock();
    sample.importers['packages/billing'].dependencies.stripe.specifier = version;
    expect(resolve(sample, { ...dependency, version }).status).toBe('unknown');
  },
);
it('does not infer a missing/stale importer, package or peer snapshot', () => {
  const samples: Record<string, unknown>[] = [
    { ...lock(), lockfileVersion: '6.0' },
    { ...lock(), packages: {} },
    { ...lock(), snapshots: {} },
    { ...lock(), importers: {} },
    {
      ...lock(),
      importers: {
        'packages/billing': { dependencies: { stripe: { specifier: '^11', version: '10.17.0' } } },
      },
    },
  ];
  for (const sample of samples)
    expect(resolve(sample)).toMatchObject({ status: 'unknown', version: null });
});
it('refuses to choose between npm and pnpm graphs', () => {
  expect(
    resolveLockedDependency(dependency, 'stripe', [
      { file: 'pnpm-lock.yaml', content: lock() },
      { file: 'package-lock.json', content: {} },
    ]),
  ).toMatchObject({ status: 'unknown', file: null });
});
it('reads actual root YAML, records its hash and resolves a workspace SDK without installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-pnpm-lock-'));
  roots.push(root);
  await mkdir(join(root, 'packages/billing'), { recursive: true });
  await writeFile(
    join(root, dependency.file),
    JSON.stringify({ dependencies: { stripe: dependency.version } }),
  );
  await writeFile(
    join(root, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'
importers:
  packages/billing:
    dependencies:
      stripe: {specifier: ^10.0.0, version: 10.17.0}
packages:
  stripe@10.17.0: {}
snapshots:
  stripe@10.17.0: {}
`,
  );
  const first = await readRepository(root);
  expect(first.dependencies[0].lock).toMatchObject({ status: 'locked', version: '10.17.0' });
  expect(first.lockfiles).toMatchObject([
    { file: 'pnpm-lock.yaml', version: 9, hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
  ]);
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nlockfileVersion: 9\n');
  await expect(readRepository(root)).rejects.toThrow('invalid or unsupported YAML');
});
