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

const locked = (versions: Record<string, string | Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(versions).map(([name, version]) => [
      `node_modules/${name}`,
      typeof version === 'string'
        ? {
            version,
            resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
            integrity: STRONG_INTEGRITY,
          }
        : version,
    ]),
  );

interface Drift {
  declared: Record<string, string>;
  recorded: Record<string, string>;
  versions: Record<string, string | Record<string, unknown>>;
}

// npm ci keeps a locked version that satisfies the declared range and prunes what package.json no
// longer declares, so it installs these committed lockfiles unchanged.
it.each<Drift & { repository: string }>([
  {
    // brandbite/brandbite at 22f3265 pins pdfjs-dist 4.10.38, the version its lockfile locks.
    repository: 'brandbite/brandbite',
    declared: { 'pdfjs-dist': '4.10.38' },
    recorded: { 'pdfjs-dist': '^4.10.38' },
    versions: { 'pdfjs-dist': '4.10.38' },
  },
  {
    // eka0789/evofuture at af720ff dropped socket.io and socket.io-client from package.json only.
    repository: 'eka0789/evofuture',
    declared: { stripe: '^20.4.0' },
    recorded: { stripe: '^20.4.0', 'socket.io': '^4.8.3', 'socket.io-client': '^4.8.3' },
    versions: { stripe: '20.4.0', 'socket.io': '4.8.3', 'socket.io-client': '4.8.3' },
  },
])('accepts drift npm ci accepts ($repository)', ({ declared, recorded, versions }) => {
  const lockContent = JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'app', dependencies: recorded }, ...locked(versions) },
  });
  expect(
    validateNpmLock(JSON.stringify({ name: 'app', dependencies: declared }), lockContent),
  ).toMatchObject({ lockHash: digest(lockContent) });
});

it.each<Drift & { section: string; message: string }>([
  {
    // SergeySharipov/ai-companion-saas at b680ee2 pins next 15.3.6; the lockfile locks 15.3.0.
    section: 'dependencies',
    declared: { next: '15.3.6' },
    recorded: { next: '15.3.0' },
    versions: { next: '15.3.0' },
    message: 'next is "15.3.6" in package.json but "15.3.0" in the lockfile.',
  },
  {
    // baifan1366/project-management-system at 700d317: ^2.0.5 excludes the locked sonner 2.0.1.
    section: 'dependencies',
    declared: { sonner: '^2.0.5' },
    recorded: { sonner: '^2.0.1' },
    versions: { sonner: '2.0.1' },
    message: 'sonner is "^2.0.5" in package.json but "^2.0.1" in the lockfile.',
  },
  {
    // piyush805/miro-clone at eddde6a added stripe to package.json and never locked it.
    section: 'dependencies',
    declared: { stripe: '^16.7.0' },
    recorded: {},
    versions: {},
    message: 'stripe is "^16.7.0" in package.json but missing in the lockfile.',
  },
  {
    // Eziox-Development/eziox-web at 1b42f1e locks rolldown-vite 7.3.1 under the vite alias.
    // Aliased entries are never compared, so drift on one refuses.
    section: 'devDependencies',
    declared: { vite: 'npm:rolldown-vite@7.1.16' },
    recorded: { vite: 'npm:rolldown-vite@latest' },
    versions: {
      vite: {
        name: 'rolldown-vite',
        version: '7.3.1',
        resolved: 'https://registry.npmjs.org/rolldown-vite/-/rolldown-vite-7.3.1.tgz',
        integrity: STRONG_INTEGRITY,
      },
    },
    message: 'vite is "npm:rolldown-vite@7.1.16" in package.json but "npm:rolldown-vite@latest"',
  },
])(
  'refuses drift npm ci rejects, naming the declaration it rejects: $message',
  ({ section, declared, recorded, versions, message }) => {
    // ArhanAnsari/InspireGem at a6bf456 also moved react to ^18.3.1, which the locked 18.3.1
    // satisfies: npm ci accepts that first difference, so the refusal names the next one.
    const shape = (react: string, value: Record<string, string>) =>
      section === 'dependencies'
        ? { dependencies: { react, ...value } }
        : { dependencies: { react }, [section]: value };
    expect(() =>
      validateNpmLock(
        JSON.stringify({ name: 'app', ...shape('^18.3.1', declared) }),
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'app', ...shape('^18.2.0', recorded) },
            ...locked({ react: '18.3.1', ...versions }),
          },
        }),
      ),
    ).toThrow(`package.json ${section} differ from the committed package-lock.json: ${message}`);
  },
);

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
  expect(refusal).toThrow('package.json declares stripe from Git (github.com/acme/stripe)');
  expect(refusal).not.toThrow(/secret-token|user/);
  const tarball = () =>
    validateNpmLock(
      JSON.stringify({
        ...manifest,
        dependencies: { stripe: 'https://user:secret-token@example.com/stripe.tgz' },
      }),
      JSON.stringify(lock),
    );
  expect(tarball).toThrow('package.json declares stripe as "https://***@example.com/stripe.tgz"');
  expect(tarball).not.toThrow(/secret-token/);
});

it('accepts a public code host release archive npm locked with its integrity, and nothing looser', () => {
  const archive = 'https://github.com/acme/kit/archive/refs/tags/v0.1.2.tar.gz';
  const declared = { ...manifest, dependencies: { ...manifest.dependencies, kit: archive } };
  const kit = { version: '0.1.2', resolved: archive, integrity: STRONG_INTEGRITY };
  const validate = (resolved: string, extra: Record<string, unknown> = {}) =>
    validateNpmLock(
      JSON.stringify({ ...declared, dependencies: { ...declared.dependencies, kit: resolved } }),
      JSON.stringify({
        ...lock,
        packages: {
          ...lock.packages,
          '': { ...declared, dependencies: { ...declared.dependencies, kit: resolved } },
          'node_modules/kit': { ...kit, resolved },
          ...extra,
        },
      }),
    );
  expect(validate(archive)).toMatchObject({ packages: 2, remoteTarballs: 1 });
  expect(validate(`https://codeload.github.com/acme/kit/tar.gz/${'a'.repeat(40)}`)).toMatchObject({
    remoteTarballs: 1,
  });
  expect(validate('https://gitlab.com/acme/kit/-/archive/v1/kit-v1.tar.gz')).toMatchObject({
    remoteTarballs: 1,
  });
  // Other hosts, credentials, ports, queries and non-archive paths stay refused.
  for (const url of [
    'https://example.com/kit.tgz',
    'http://github.com/acme/kit/archive/v1.tar.gz',
    'https://token@github.com/acme/kit/archive/v1.tar.gz',
    'https://github.com:444/acme/kit/archive/v1.tar.gz',
    'https://github.com/acme/kit/archive/v1.tar.gz?x=1',
    'https://github.com/acme/kit/releases/download/v1/kit.tgz',
    'https://github.com/acme/kit/archive/../../evil/archive/v1.tar.gz',
  ])
    expect(() => validate(url), url).toThrow();
  // Without a SHA-256-or-stronger integrity it is unverifiable, as any other record.
  expect(() =>
    validateNpmLock(
      JSON.stringify(declared),
      JSON.stringify({
        ...lock,
        packages: {
          ...lock.packages,
          '': declared,
          'node_modules/kit': { ...kit, integrity: 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
        },
      }),
    ),
  ).toThrow('without a version, registry "resolved" URL and SHA-256-or-stronger "integrity"');
  // npm can fetch it from its host only when no record needs a mirror replaced.
  expect(() =>
    validate(archive, {
      'node_modules/ms': {
        version: '2.1.3',
        resolved: 'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz',
        integrity: STRONG_INTEGRITY,
      },
    }),
  ).toThrow('from a code host and other packages from a registry mirror');
});
