import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveLockedDependency } from './lockfiles.ts';
import { readRepository } from './repository.ts';
import { parseYarnLock } from './yarn-lock.ts';

const FIXTURES = 'pipeline/fixtures/yarn-locks';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(lock: string, stripe = '^17.7.0', extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-yarn-lock-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { stripe } }));
  await copyFile(join(FIXTURES, lock), join(root, 'yarn.lock'));
  for (const [name, content] of Object.entries(extra)) await writeFile(join(root, name), content);
  return readRepository(root, 'stripe');
}

it.each([
  ['classic.lock', 1],
  ['berry.lock', 8],
])('records the Stripe version from a generated %s', async (lock, lockfileVersion) => {
  const result = await repository(lock);
  expect(result.lockfiles).toMatchObject([{ file: 'yarn.lock', version: lockfileVersion }]);
  expect(result.dependencies[0].lock).toMatchObject({
    status: 'locked',
    file: 'yarn.lock',
    version: '17.7.0',
    packagePath: 'stripe@17.7.0',
  });
});

it.each(['classic.lock', 'berry.lock'])(
  'keeps %s versions unknown when the manifest range has no lock entry',
  async (lock) => {
    expect((await repository(lock, '^18.0.0')).dependencies[0].lock).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('No yarn.lock entry matches'),
    });
  },
);

it.each([
  'npm:stripe@17.7.0',
  'workspace:*',
  'file:../sdk',
  'patch:stripe@17.7.0',
  'github:stripe/stripe-node',
  'stripe/stripe-node',
])('keeps %s SDK sources unverified', async (version) => {
  expect((await repository('classic.lock', version)).dependencies[0].lock).toMatchObject({
    status: 'unknown',
    reason: expect.stringContaining('manual review'),
  });
});

it('reads comma-joined classic descriptors and requires public registry tarballs', () => {
  const lock = (resolved: string) =>
    parseYarnLock(
      `# yarn lockfile v1\n\n"stripe@^17.0.0", stripe@^17.7.0:\n  version "17.7.0"\n  resolved "${resolved}"\n  dependencies:\n    qs "^6.11.0"\n`,
    );
  const resolve = (content: Record<string, unknown>) =>
    resolveLockedDependency(
      { file: 'package.json', section: 'dependencies', version: '^17.0.0' },
      'stripe',
      [{ file: 'yarn.lock', content }],
    );
  expect(
    resolve(lock('https://registry.yarnpkg.com/stripe/-/stripe-17.7.0.tgz#abc')),
  ).toMatchObject({
    status: 'locked',
    version: '17.7.0',
  });
  for (const resolved of [
    'https://npm.private.example/stripe/-/stripe-17.7.0.tgz',
    'git+https://github.com/stripe/stripe-node.git#abc',
  ])
    expect(resolve(lock(resolved)), resolved).toMatchObject({ status: 'unknown' });
});

it('leaves versions unknown instead of failing on an unreadable yarn.lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-yarn-lock-'));
  roots.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { stripe: '^17.7.0' } }),
  );
  await writeFile(join(root, 'yarn.lock'), 'stripe@^17.7.0 version 17.7.0\n');
  const result = await readRepository(root, 'stripe');
  expect(result.lockfiles).toMatchObject([{ file: 'yarn.lock', version: null }]);
  expect(result.dependencies[0].lock).toMatchObject({
    status: 'unknown',
    reason: expect.stringContaining('No SDK version is inferred'),
  });
});

it('does not choose between yarn.lock and another package-manager lockfile', async () => {
  const result = await repository('classic.lock', '^17.7.0', {
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
  });
  expect(result.dependencies[0].lock).toMatchObject({
    status: 'unknown',
    reason: expect.stringContaining('Multiple package-manager lockfiles'),
  });
});
