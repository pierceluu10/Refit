import { expect, it } from 'vitest';
import { validateNpmLock } from './npm-lock.ts';
import { baselineStop, preparationStop } from './preparation-stops.ts';

const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
const manifest = { name: 'app', dependencies: { stripe: '10.17.0' } };
const stripe = {
  version: '10.17.0',
  resolved: 'https://registry.npmjs.org/stripe/-/stripe-10.17.0.tgz',
  integrity,
};

function refusal(packageJson: object, packages: Record<string, unknown>) {
  try {
    validateNpmLock(JSON.stringify(packageJson), JSON.stringify({ lockfileVersion: 3, packages }));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected the lockfile to be refused');
}

it('names the dependency that comes from outside the public registry', () => {
  // PedroPini/ScaleNext and TN0123/Schematic (docs/PREPARATION-FAILURES.md).
  const declared = refusal(
    { ...manifest, dependencies: { '@nanostores/react': 'github:ai/react' } },
    { '': { ...manifest, dependencies: { '@nanostores/react': 'github:ai/react' } } },
  );
  expect(declared).toContain(
    'package.json declares @nanostores/react from Git (github.com/ai/react), which Refit does not fetch',
  );
  const nested = refusal(manifest, {
    '': manifest,
    'node_modules/stripe': stripe,
    'node_modules/@electron/rebuild': {
      ...stripe,
      resolved: 'https://registry.npmjs.org/@electron/rebuild/-/rebuild-3.7.2.tgz',
      dependencies: {
        '@electron/node-gyp': 'git+https://github.com/electron/node-gyp.git#06b29aa',
      },
    },
  });
  expect(nested).toContain(
    'package-lock.json record node_modules/@electron/rebuild declares @electron/node-gyp from Git (github.com/electron/node-gyp at 06b29aa)',
  );
  // The lockfile record itself, as npm writes a Git dependency it resolved to a commit.
  const locked = refusal(manifest, {
    '': manifest,
    'node_modules/stripe': stripe,
    'node_modules/sdk': {
      ...stripe,
      resolved: `git+ssh://git@github.com/acme/sdk.git#${'a'.repeat(40)}`,
    },
  });
  expect(locked).toContain(
    'package-lock.json installs node_modules/sdk from Git (github.com/acme/sdk at commit aaaaaaa)',
  );
  // A local path is not described as Git.
  expect(
    refusal(
      { ...manifest, dependencies: { sdk: './vendor/sdk' } },
      { '': { ...manifest, dependencies: { sdk: './vendor/sdk' } } },
    ),
  ).toContain('package.json declares sdk as "./vendor/sdk".');
  for (const message of [declared, nested, locked])
    expect(preparationStop(message)).toMatchObject({
      reason: 'git-dependency',
      summary: 'a dependency is installed from Git, which Refit does not fetch',
      action: expect.stringContaining('In .refit.json, remove "prepareDependencies"'),
    });
  const privateRegistry = refusal(manifest, {
    '': manifest,
    'node_modules/stripe': {
      ...stripe,
      resolved: 'https://npm.pkg.github.com/stripe/-/stripe-10.17.0.tgz',
    },
  });
  expect(privateRegistry).toContain(
    'package-lock.json resolves node_modules/stripe from npm.pkg.github.com',
  );
  for (const message of [privateRegistry])
    expect(preparationStop(message)).toMatchObject({
      reason: 'non-registry-dependency',
      action: expect.stringContaining('In .refit.json, remove "prepareDependencies"'),
    });
});

it('says which lockfile limit a refused lockfile misses', () => {
  // App-4-Dat-LLC/LandLORDER-rp commits a version 3 lockfile with no package records.
  const lock = (value: object) => () =>
    validateNpmLock(JSON.stringify(manifest), JSON.stringify(value));
  expect(lock({ lockfileVersion: 3 })).toThrow(
    'It has no package record for the root project; regenerate it with npm install.',
  );
  expect(lock({ lockfileVersion: 1, dependencies: {} })).toThrow(
    'It is lockfile version 1; npm 7 or later writes version 2 or 3.',
  );
});

it('gives every refusal Refit cannot fix a named stop with its .refit.json change', () => {
  // Messages from the 2026-10-22 rerun of the benchmark failures at fb0143a.
  for (const [message, reason] of [
    [
      'Dependency archive exceeds 1024 MiB. An operator can set REFIT_VALIDATION_WORKSPACE=4g (up to a 2 GiB archive and 5 GiB container memory) for a larger tree.',
      'dependency-tree-too-large',
    ],
    [
      "yarn dependency preparation ran out of space in its 2g workspace (ENOSPC). Yarn 1 also downloads other platforms' optional binaries.",
      'dependency-tree-too-large',
    ],
    [
      'Every pnpm package needs a registry name/version and SHA-256-or-stronger integrity; local, Git, patched and URL sources require a custom image. pnpm-lock.yaml records left-pad@1.3.0 without them.',
      'non-registry-dependency',
    ],
    [
      'pnpm declarations must use public registry, configured catalogs or explicit local workspaces; package.json declares react@latest as "link:ai/react@latest".',
      'non-registry-dependency',
    ],
    [
      'Tracked node_modules, conflicting lockfiles, shrinkwrap or pnpm hooks require a custom validation image. The repository commits package-lock.json and pnpm-lock.yaml; keep only the lockfile of the package manager you use.',
      'conflicting-dependency-files',
    ],
    [
      'Automatic preparation requires a root npm lockfile version 2 or 3 with at most 20,000 package records.',
      'unsupported-lockfile',
    ],
    [
      'npm workspaces require at most 64 positive relative path/glob patterns. Negations, escaping paths and object declarations other than { packages } require a custom image.',
      'unsupported-workspace',
    ],
    [
      'Unsupported pnpm settings require a custom validation image; hooks, patches, alternate stores, runtimes and registries are not loaded automatically, and the "pnpm" field of package.json sets "patchedDependencies".',
      'unsupported-workspace',
    ],
  ] as const)
    expect(preparationStop(message)).toMatchObject({
      reason,
      action: expect.stringMatching(/\.refit\.json/),
    });
  // Refusals the repository fixes itself keep their own instructions.
  expect(
    preparationStop(
      'package.json dependencies differ from the committed package-lock.json: next is "15.3.6" in package.json but "15.3.0" in the lockfile. Run npm install and commit the updated package-lock.json.',
    ),
  ).toBeUndefined();
});

it('names the setup reason a baseline check fails for', () => {
  // JensenMPillay/pdfai and RISHIE2006/Signl baselines (docs/PREPARATION-FAILURES.md).
  expect(
    baselineStop(
      '\n> pdfai@0.1.0 test /workspace\n> jest\n\nNo tests found, exiting with code 1\nRun with `--passWithNoTests` to exit with code 0\n',
    ),
  ).toMatchObject({ reason: 'no-tests-found', action: expect.stringContaining('"command"') });
  expect(
    baselineStop(
      'Error: Could not locate the bindings file. Tried:\n → /workspace/node_modules/better-sqlite3/build/better_sqlite3.node\n',
    ),
  ).toMatchObject({ reason: 'native-build-required' });
  expect(baselineStop('FAIL src/payments.test.ts\nexpected 2 to be 3')).toBeUndefined();
});
