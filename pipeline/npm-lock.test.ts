import { expect, it } from 'vitest';
import { validateNpmLock } from './npm-lock.ts';
import { digest } from './specifications.ts';

const manifest = {
  name: 'ordinary-app',
  dependencies: { stripe: '10.17.0' },
  devDependencies: { typescript: '^5.7.2' },
};
const record = {
  version: '10.17.0',
  resolved: 'https://registry.npmjs.org/stripe/-/stripe-10.17.0.tgz',
  integrity: 'sha512-YWJjZA==',
};
const lock = { lockfileVersion: 3, packages: { '': manifest, 'node_modules/stripe': record } };

it('retains exact committed input hashes and accepts public scoped packages and npm aliases', () => {
  const packageContent = JSON.stringify({
    ...manifest,
    dependencies: { stripe: 'npm:stripe@10.17.0', '@example/sdk': '^1.2.3' },
    scripts: { postinstall: 'must-never-run' },
  });
  const lockContent = JSON.stringify({
    ...lock,
    packages: {
      ...lock.packages,
      '': JSON.parse(packageContent),
      'node_modules/@example/sdk': {
        ...record,
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/@example/sdk/-/sdk-1.2.3.tgz',
      },
    },
  });
  expect(validateNpmLock(packageContent, lockContent)).toEqual({
    packageHash: digest(packageContent),
    lockHash: digest(lockContent),
    packages: 2,
  });
});

it.each([
  { ...record, resolved: 'https://secret@registry.npmjs.org/stripe/-/stripe.tgz' },
  { ...record, resolved: 'https://registry.npmjs.org/stripe/-/stripe.tgz?token=secret' },
  { ...record, resolved: 'https://private.example.com/stripe.tgz' },
  { ...record, resolved: 'http://registry.npmjs.org/stripe/-/stripe.tgz' },
  { ...record, resolved: 'git+https://github.com/example/stripe.git' },
  { ...record, resolved: undefined },
  { ...record, integrity: undefined },
  { ...record, integrity: 'sha1-YWJjZA==' },
  { ...record, link: true },
])('rejects unpinned or non-public package resolution before network use: %j', (value) => {
  expect(() =>
    validateNpmLock(
      JSON.stringify(manifest),
      JSON.stringify({ ...lock, packages: { '': manifest, 'node_modules/stripe': value } }),
    ),
  ).toThrow();
});

it('refuses local dependencies, workspaces, unsupported locks and traversal without rejecting ordinary application scripts', () => {
  for (const source of [
    'file:../private',
    'git+ssh://git@example.com/repo',
    'example/repo',
    'https://example.com/package.tgz',
    'workspace:*',
  ])
    expect(() =>
      validateNpmLock(
        JSON.stringify({ ...manifest, dependencies: { stripe: source } }),
        JSON.stringify(lock),
      ),
    ).toThrow(/registry/);
  expect(() =>
    validateNpmLock(
      JSON.stringify({ ...manifest, workspaces: ['packages/*'] }),
      JSON.stringify(lock),
    ),
  ).toThrow(/Workspaces/);
  expect(() =>
    validateNpmLock(JSON.stringify(manifest), JSON.stringify({ ...lock, lockfileVersion: 1 })),
  ).toThrow(/version 2 or 3/);
  expect(() =>
    validateNpmLock(
      JSON.stringify(manifest),
      JSON.stringify({ ...lock, packages: { '': manifest, 'node_modules/../outside': record } }),
    ),
  ).toThrow(/Every npm package/);
});

it('requires matching root dependency declarations and rejects non-registry overrides', () => {
  expect(() =>
    validateNpmLock(
      JSON.stringify({ ...manifest, dependencies: { stripe: '11.0.0' } }),
      JSON.stringify(lock),
    ),
  ).toThrow(/requirements differ/);
  expect(() =>
    validateNpmLock(
      JSON.stringify({
        ...manifest,
        overrides: { stripe: { '.': 'https://private.example.com/package.tgz' } },
      }),
      JSON.stringify(lock),
    ),
  ).toThrow(/overrides/);
});
