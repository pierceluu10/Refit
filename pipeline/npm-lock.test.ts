import { expect, it } from 'vitest';
import { validateNpmLock } from './npm-lock.ts';
import { digest } from './specifications.ts';

const manifest = {
  name: 'ordinary-app',
  dependencies: { stripe: '10.17.0' },
  devDependencies: { typescript: '^5.7.2' },
};
const STRONG_INTEGRITY = `sha512-${Buffer.alloc(64).toString('base64')}`;
const record = {
  version: '10.17.0',
  resolved: 'https://registry.npmjs.org/stripe/-/stripe-10.17.0.tgz',
  integrity: STRONG_INTEGRITY,
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
  { ...record, integrity: 'sha512-YWJjZA==' },
  { ...record, integrity: 'sha512-AAAA' },
  { ...record, link: true },
])('rejects unpinned or non-public package resolution before network use: %j', (value) => {
  expect(() =>
    validateNpmLock(
      JSON.stringify(manifest),
      JSON.stringify({ ...lock, packages: { '': manifest, 'node_modules/stripe': value } }),
    ),
  ).toThrow();
});

it('names the unverified lockfile entries and how the owner can record them', () => {
  const bare = { version: '1.0.0' };
  expect(() =>
    validateNpmLock(
      JSON.stringify(manifest),
      JSON.stringify({
        ...lock,
        packages: { ...lock.packages, 'node_modules/a': bare, 'node_modules/b': bare },
      }),
    ),
  ).toThrow(
    /records node_modules\/a and 1 more packages without .*delete node_modules and run npm install/,
  );
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
  ).toThrow('stripe is "11.0.0" in package.json but "10.17.0" in the lockfile. Run npm install');
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

// npm's own lockfile entry bundles its dependencies: they ship inside npm's verified tarball.
const npmRecord = {
  version: '10.9.2',
  resolved: 'https://registry.npmjs.org/npm/-/npm-10.9.2.tgz',
  integrity: STRONG_INTEGRITY,
};
const bundledLock = (packages: Record<string, unknown>) =>
  JSON.stringify({
    ...lock,
    packages: {
      '': { ...manifest, dependencies: { ...manifest.dependencies, npm: '10.9.2' } },
      'node_modules/stripe': record,
      'node_modules/npm': npmRecord,
      ...packages,
    },
  });
const bundledManifest = JSON.stringify({
  ...manifest,
  dependencies: { ...manifest.dependencies, npm: '10.9.2' },
});

it('accepts bundled records under a verified registry ancestor, including nested bundles', () => {
  expect(() =>
    validateNpmLock(
      bundledManifest,
      bundledLock({
        'node_modules/npm/node_modules/@isaacs/cliui': { version: '8.0.2', inBundle: true },
        'node_modules/npm/node_modules/@isaacs/cliui/node_modules/ansi-regex': {
          version: '6.1.0',
          inBundle: true,
        },
      }),
    ),
  ).not.toThrow();
});

it.each([
  ['a top-level bundled record', { 'node_modules/cliui': { version: '8.0.2', inBundle: true } }],
  [
    'a bundled record without a version',
    { 'node_modules/npm/node_modules/cliui': { inBundle: true } },
  ],
  [
    'a bundled record with its own source',
    {
      'node_modules/npm/node_modules/cliui': {
        version: '8.0.2',
        inBundle: true,
        resolved: 'https://private.example.com/cliui.tgz',
      },
    },
  ],
  [
    'a bundled record under an unverified ancestor',
    {
      'node_modules/npm': { version: '10.9.2' },
      'node_modules/npm/node_modules/cliui': { version: '8.0.2', inBundle: true },
    },
  ],
  [
    'a bundled record under a non-registry ancestor',
    {
      'node_modules/npm': { ...npmRecord, resolved: 'https://private.example.com/npm.tgz' },
      'node_modules/npm/node_modules/cliui': { version: '8.0.2', inBundle: true },
    },
  ],
])('rejects %s', (_name, packages) => {
  expect(() => validateNpmLock(bundledManifest, bundledLock(packages))).toThrow();
});

it("accepts an empty range in a published package's declarations, which npm reads as any version", () => {
  // habibjutt/nextjs_boilerplate locks @tabler/icons-react 3.36.1 (docs/PREPARATION-FAILURES.md).
  const packages = {
    ...lock.packages,
    'node_modules/stripe': { ...record, dependencies: { 'stripe-types': '' } },
  };
  expect(
    validateNpmLock(JSON.stringify(manifest), JSON.stringify({ ...lock, packages })),
  ).toMatchObject({ packages: 1 });
  // The repository's own package.json still names an exact registry range.
  const declared = { ...manifest, dependencies: { stripe: '' } };
  expect(() =>
    validateNpmLock(
      JSON.stringify(declared),
      JSON.stringify({ ...lock, packages: { ...lock.packages, '': declared } }),
    ),
  ).toThrow('package.json declares stripe as "".');
});

it('accepts tarballs a lockfile resolved through a public npm mirror, which npm fetches from registry.npmjs.org', () => {
  // Mangu-Commerce/madcaptees resolves 118 packages through registry.npmmirror.com.
  for (const host of ['registry.npmmirror.com', 'registry.yarnpkg.com'])
    expect(
      validateNpmLock(
        JSON.stringify(manifest),
        JSON.stringify({
          ...lock,
          packages: {
            ...lock.packages,
            'node_modules/stripe': {
              ...record,
              resolved: `https://${host}/stripe/-/stripe-10.17.0.tgz`,
            },
          },
        }),
      ),
    ).toMatchObject({ packages: 1 });
  for (const resolved of [
    'https://npm.pkg.github.com/stripe/-/stripe-10.17.0.tgz',
    'http://registry.npmmirror.com/stripe/-/stripe-10.17.0.tgz',
    'https://user:token@registry.npmmirror.com/stripe/-/stripe-10.17.0.tgz',
  ])
    expect(() =>
      validateNpmLock(
        JSON.stringify(manifest),
        JSON.stringify({
          ...lock,
          packages: { ...lock.packages, 'node_modules/stripe': { ...record, resolved } },
        }),
      ),
    ).toThrow('Package tarballs must use public registry.npmjs.org HTTPS URLs');
});

it('never repeats a source URL credential in a refusal', () => {
  const refusal = () =>
    validateNpmLock(
      JSON.stringify({
        ...manifest,
        dependencies: { stripe: 'git+https://user:secret-token@github.com/acme/stripe.git' },
      }),
      JSON.stringify(lock),
    );
  expect(refusal).toThrow(
    'package.json declares stripe as "git+https://***@github.com/acme/stripe.git"',
  );
  expect(refusal).not.toThrow(/secret-token/);
});
