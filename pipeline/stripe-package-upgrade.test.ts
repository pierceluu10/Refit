import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  codeDiff,
  packageDiff,
  STRIPE_SDK_RELEASES,
  stripePackageUpgrade,
} from './stripe-package-upgrade.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const TARGET = STRIPE_SDK_RELEASES['2026-09-30.endive'];
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

function lockfile(spec = '^12.18.0', options: { dev?: boolean; qs?: boolean } = {}) {
  const section = options.dev ? 'devDependencies' : 'dependencies';
  return {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', version: '1.0.0', [section]: { stripe: spec } },
      'node_modules/qs': {
        version: '6.13.0',
        resolved: 'https://registry.npmjs.org/qs/-/qs-6.13.0.tgz',
        integrity: INTEGRITY,
      },
      'node_modules/stripe': {
        version: '12.18.0',
        resolved: 'https://registry.npmjs.org/stripe/-/stripe-12.18.0.tgz',
        integrity: INTEGRITY,
        ...(options.dev ? { dev: true } : {}),
        dependencies: { '@types/node': '>=8.1.0', qs: '^6.11.0' },
      },
    },
  };
}

function withTypesNode(version: string) {
  const lock = lockfile();
  (lock.packages as Record<string, unknown>)['node_modules/@types/node'] = {
    version,
    resolved: `https://registry.npmjs.org/@types/node/-/node-${version}.tgz`,
    integrity: INTEGRITY,
    dev: true,
  };
  return lock;
}

async function project(
  options: { spec?: string; dev?: boolean; lock?: unknown; raw?: string; manifest?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-sdk-upgrade-'));
  roots.push(root);
  const spec = options.spec ?? '^12.18.0';
  const section = options.dev ? 'devDependencies' : 'dependencies';
  await writeFile(
    join(root, 'package.json'),
    options.manifest ??
      `{\n  "name": "app",\n  "${section}": {\n    "stripe": "${spec}",\n    "next": "14.0.0"\n  }\n}\n`,
  );
  await writeFile(
    join(root, 'package-lock.json'),
    options.raw ?? `${JSON.stringify(options.lock ?? lockfile(spec, options), null, 2)}\n`,
  );
  return root;
}

function registry(metadata: Record<string, unknown> = {}, status = 200) {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          name: 'stripe',
          version: TARGET,
          license: 'MIT',
          dependencies: {},
          engines: { node: '>=20' },
          peerDependencies: { '@types/node': '>=20' },
          peerDependenciesMeta: { '@types/node': { optional: true } },
          dist: {
            tarball: `https://registry.npmjs.org/stripe/-/stripe-${TARGET}.tgz`,
            integrity: INTEGRITY,
          },
          ...metadata,
        }),
        { status },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('maps the benchmark target API version to its stripe-node release', () => {
  expect(TARGET).toBe('23.0.0');
});

it('replaces only the stripe declaration and lock entry with verified registry metadata', async () => {
  const fetch = registry();
  const result = await stripePackageUpgrade(await project(), '2026-09-30.endive');
  if (!('upgrade' in result)) throw new Error(result.reason);
  expect(fetch).toHaveBeenCalledWith(
    `https://registry.npmjs.org/stripe/${TARGET}`,
    expect.objectContaining({ redirect: 'error' }),
  );
  expect(result.upgrade).toMatchObject({ from: '12.18.0', to: TARGET });
  const [manifest, lock] = result.upgrade.files;
  expect(manifest.after).toBe(manifest.before.replace('"^12.18.0"', `"^${TARGET}"`));
  const after = JSON.parse(lock.after);
  expect(after.packages['node_modules/stripe']).toEqual({
    version: TARGET,
    resolved: `https://registry.npmjs.org/stripe/-/stripe-${TARGET}.tgz`,
    integrity: INTEGRITY,
    license: 'MIT',
    engines: { node: '>=20' },
    peerDependencies: { '@types/node': '>=20' },
    peerDependenciesMeta: { '@types/node': { optional: true } },
  });
  expect(after.packages[''].dependencies.stripe).toBe(`^${TARGET}`);
  expect(after.packages['node_modules/qs']).toEqual(lockfile().packages['node_modules/qs']);
});

it('accepts an installed optional peer inside its range', async () => {
  registry();
  const result = await stripePackageUpgrade(
    await project({ lock: withTypesNode('20.11.5') }),
    '2026-09-30.endive',
  );
  expect('upgrade' in result).toBe(true);
});

it('keeps exact and dev declarations as they were written', async () => {
  registry();
  const result = await stripePackageUpgrade(
    await project({ spec: '12.18.0', dev: true }),
    '2026-09-30.endive',
  );
  if (!('upgrade' in result)) throw new Error(result.reason);
  expect(result.upgrade.files[0].after).toContain(`"stripe": "${TARGET}"`);
  const after = JSON.parse(result.upgrade.files[1].after);
  expect(after.packages['node_modules/stripe'].dev).toBe(true);
  expect(after.packages[''].devDependencies.stripe).toBe(TARGET);
});

it.each([
  ['an unknown API version', {}, {}, '2099-01-01.unknown', /No stripe-node release/],
  ['a dist-tag range', { spec: 'latest' }, {}, undefined, /not an exact, \^ or ~ version/],
  [
    'an old lockfile format',
    { lock: { ...lockfile(), lockfileVersion: 1 } },
    {},
    undefined,
    /versions 2 and 3/,
  ],
  ['non-npm formatting', { raw: JSON.stringify(lockfile()) }, {}, undefined, /npm formatting/],
  [
    'a registry tarball elsewhere',
    {},
    { dist: { tarball: 'https://example.com/stripe.tgz', integrity: INTEGRITY } },
    undefined,
    /not a verifiable release/,
  ],
  [
    'a weak integrity',
    {},
    {
      dist: {
        tarball: `https://registry.npmjs.org/stripe/-/stripe-${TARGET}.tgz`,
        integrity: 'sha1-abc',
      },
    },
    undefined,
    /not a verifiable release/,
  ],
  [
    'a new dependency',
    {},
    { dependencies: { 'left-pad': '^1.0.0' } },
    undefined,
    /needs dependency changes \(left-pad\)/,
  ],
  [
    'a required peer',
    {},
    { peerDependencies: { react: '>=18' }, peerDependenciesMeta: {} },
    undefined,
    /needs dependency changes \(react\)/,
  ],
  [
    'an installed optional peer below its range',
    { lock: withTypesNode('18.11.18') },
    {},
    undefined,
    /needs @types\/node >=20, which the lockfile does not provide/,
  ],
  [
    'an installed optional peer with an unsupported range',
    { lock: withTypesNode('22.0.0') },
    { peerDependencies: { '@types/node': '^20 || ^22' } },
    undefined,
    /needs @types\/node \^20 \|\| \^22/,
  ],
  [
    'a duplicate declaration',
    {
      manifest:
        '{"dependencies": {"stripe": "^12.18.0"}, "devDependencies": {"stripe": "^12.18.0"}}\n',
    },
    {},
    undefined,
    /more than once/,
  ],
])('refuses %s', async (_label, setup, metadata, version, reason) => {
  registry(metadata);
  const result = await stripePackageUpgrade(
    await project(setup as Parameters<typeof project>[0]),
    version ?? '2026-09-30.endive',
  );
  expect(result).toEqual({ reason: expect.stringMatching(reason) });
});

it('refuses projects without an npm lockfile and registry failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-sdk-upgrade-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{"dependencies":{"stripe":"^12.18.0"}}\n');
  expect(await stripePackageUpgrade(root, '2026-09-30.endive')).toEqual({
    reason: expect.stringMatching(/package-lock.json/),
  });
  registry({}, 404);
  expect(await stripePackageUpgrade(await project(), '2026-09-30.endive')).toEqual({
    reason: expect.stringMatching(/HTTP 404/),
  });
});

// pnpm 9 formatting: blank lines between entries, unpadded flow maps, single quotes.
function pnpmLock(options: { typesNode?: string; version?: string; extraImporter?: boolean } = {}) {
  const typesNode = options.typesNode;
  return `lockfileVersion: '${options.version ?? '9.0'}'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      qs:
        specifier: ^6.13.0
        version: 6.13.0
      stripe:
        specifier: ^16.12.0
        version: 16.12.0
${
  typesNode
    ? `    devDependencies:
      '@types/node':
        specifier: ${typesNode}
        version: ${typesNode}
`
    : ''
}${
    options.extraImporter
      ? `
  packages/api:
    dependencies:
      stripe:
        specifier: ^16.12.0
        version: 16.12.0
`
      : ''
  }
packages:

  '@types/node@${typesNode ?? '20.11.5'}':
    resolution: {integrity: ${INTEGRITY}}

  es-errors@1.3.0:
    resolution: {integrity: ${INTEGRITY}}
    engines: {node: '>= 0.4'}

  qs@6.13.0:
    resolution: {integrity: ${INTEGRITY}}
    engines: {node: '>=0.6'}

  stripe@16.12.0:
    resolution: {integrity: ${INTEGRITY}}
    engines: {node: '>=12.*'}

snapshots:

  '@types/node@${typesNode ?? '20.11.5'}': {}

  es-errors@1.3.0: {}

  qs@6.13.0: {}

  stripe@16.12.0:
    dependencies:
      '@types/node': ${typesNode ?? '20.11.5'}
      es-errors: 1.3.0
      qs: 6.13.0
`;
}

async function pnpmProject(lock: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-sdk-upgrade-pnpm-'));
  roots.push(root);
  await writeFile(
    join(root, 'package.json'),
    '{\n  "name": "app",\n  "dependencies": {\n    "qs": "^6.13.0",\n    "stripe": "^16.12.0"\n  }\n}\n',
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), lock);
  return root;
}

it('upgrades a pnpm lockfile the way pnpm writes it, qualifying the installed optional peer', async () => {
  registry();
  const result = await stripePackageUpgrade(
    await pnpmProject(pnpmLock({ typesNode: '22.10.1' })),
    '2026-09-30.endive',
  );
  if (!('upgrade' in result)) throw new Error(result.reason);
  expect(result.upgrade).toMatchObject({ from: '16.12.0', to: TARGET });
  const [manifest, lock] = result.upgrade.files;
  expect(manifest.after).toContain(`"stripe": "^${TARGET}"`);
  expect(lock.path).toBe('pnpm-lock.yaml');
  // es-errors only served the old stripe; qs and @types/node are still root dependencies.
  expect(lock.after).toBe(
    pnpmLock({ typesNode: '22.10.1' })
      .replace(
        'specifier: ^16.12.0\n        version: 16.12.0',
        `specifier: ^${TARGET}\n        version: ${TARGET}(@types/node@22.10.1)`,
      )
      .replace(
        `  es-errors@1.3.0:\n    resolution: {integrity: ${INTEGRITY}}\n    engines: {node: '>= 0.4'}\n\n`,
        '',
      )
      .replace(
        `  stripe@16.12.0:\n    resolution: {integrity: ${INTEGRITY}}\n    engines: {node: '>=12.*'}\n`,
        `  stripe@${TARGET}:\n    resolution: {integrity: ${INTEGRITY}}\n    engines: {node: '>=20'}\n    peerDependencies:\n      '@types/node': '>=20'\n    peerDependenciesMeta:\n      '@types/node':\n        optional: true\n`,
      )
      .replace('  es-errors@1.3.0: {}\n\n', '')
      .replace(
        "  stripe@16.12.0:\n    dependencies:\n      '@types/node': 22.10.1\n      es-errors: 1.3.0\n      qs: 6.13.0\n",
        `  stripe@${TARGET}(@types/node@22.10.1):\n    optionalDependencies:\n      '@types/node': 22.10.1\n`,
      ),
  );
});

it('leaves an unused optional peer out of the pnpm snapshot and prunes what only stripe used', async () => {
  registry();
  const result = await stripePackageUpgrade(await pnpmProject(pnpmLock()), '2026-09-30.endive');
  if (!('upgrade' in result)) throw new Error(result.reason);
  const after = result.upgrade.files[1].after;
  expect(after).toContain(`        version: ${TARGET}\n`);
  expect(after).toContain(`  stripe@${TARGET}: {}\n`);
  expect(after).not.toContain('es-errors');
  expect(after).not.toContain('@types/node@20.11.5');
  expect(after).toContain('  qs@6.13.0: {}');
});

it.each([
  ['lockfile v6', pnpmLock({ version: '6.0' }), /Only pnpm lockfile version 9/],
  ['non-pnpm formatting', pnpmLock().replace(/\{integrity: /g, '{ integrity: '), /pnpm formatting/],
  ['a second importer', pnpmLock({ extraImporter: true }), /more than the root importer/],
  [
    'an optional peer below its range',
    pnpmLock({ typesNode: '18.19.0' }),
    /needs @types\/node >=20, which the lockfile does not provide/,
  ],
])('refuses a pnpm project with %s', async (_label, lock, reason) => {
  registry();
  expect(await stripePackageUpgrade(await pnpmProject(lock), '2026-09-30.endive')).toEqual({
    reason: expect.stringMatching(reason),
  });
});

it('splits a rendered patch into its code and dependency parts', () => {
  const code =
    'diff --git "a/src/a.ts" "b/src/a.ts"\n--- "a/src/a.ts"\n+++ "b/src/a.ts"\n@@ -1 +1 @@\n-a\n+b\n';
  const manifest =
    'diff --git "a/package.json" "b/package.json"\n--- "a/package.json"\n+++ "b/package.json"\n@@ -1 +1 @@\n-x\n+y\n';
  expect(packageDiff(code + manifest)).toBe(manifest);
  expect(codeDiff(code + manifest)).toBe(code);
  expect(packageDiff(code)).toBe('');
});

const SUBSCRIPTION = (after: boolean) => ({
  openapi: '3.0.3',
  info: { title: 'Simulated Stripe contract', version: after ? '2026-09-30.endive' : '2024-06-20' },
  paths: {},
  components: {
    schemas: {
      subscription: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          items: {
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/subscription_item' } },
            },
          },
          ...(after ? {} : { current_period_end: { type: 'integer' } }),
        },
      },
      subscription_item: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ...(after
            ? { current_period_start: { type: 'integer' }, current_period_end: { type: 'integer' } }
            : {}),
        },
      },
    },
  },
});
const SOURCE = `import Stripe from 'stripe';
const stripe = new Stripe('sk_test_placeholder', { apiVersion: '2024-06-20' });
export async function accessEndsAt(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return new Date(subscription.current_period_end * 1000).toISOString();
}
`;
const PROVIDER = {
  id: 'stripe-upgrade',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: 'Stripe',
  constructorCalls: true,
  apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
  operations: [{ resource: 'subscriptions', method: 'retrieve', schema: 'subscription' }],
};

async function scan(root: string, file: string) {
  await writeFile(
    join(root, file),
    file.endsWith('.js') ? SOURCE.replace('(id: string)', '(id)') : SOURCE,
  );
  await writeFile(join(root, 'before.json'), JSON.stringify(SUBSCRIPTION(false)));
  await writeFile(join(root, 'after.json'), JSON.stringify(SUBSCRIPTION(true)));
  await writeFile(join(root, 'provider.json'), JSON.stringify(PROVIDER));
  const { runPipeline } = await import('./run.ts');
  return runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: '2024-06-20',
    proposePatch: true,
  });
}

it('adds the SDK upgrade to a TypeScript patch that bumps the API version', async () => {
  registry();
  const report = await scan(await project(), 'billing.ts');
  expect(report.patch).toMatchObject({
    status: 'proposed',
    unresolvedFindings: 0,
    sdkUpgrade: { from: '12.18.0', to: TARGET },
  });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain(
    "+const stripe = new Stripe('sk_test_placeholder', { apiVersion: '2026-09-30.endive' });",
  );
  expect(packageDiff(diff)).toContain(`+    "stripe": "^${TARGET}",`);
  expect(packageDiff(diff)).toContain(`stripe-${TARGET}.tgz`);
  expect('warnings' in report.patch && report.patch.warnings[0]).toContain(
    `Upgrades stripe from 12.18.0 to ${TARGET}`,
  );
});

it('leaves JavaScript projects on their installed SDK', async () => {
  const fetch = registry();
  const report = await scan(await project(), 'billing.js');
  expect(report.patch).toMatchObject({ status: 'proposed' });
  expect('sdkUpgrade' in report.patch).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

const execute = promisify(execFile);
it.skipIf(
  !process.env.REFIT_STRIPE_SDK ||
    !process.env.REFIT_DOCKER_IMAGE ||
    !process.env.REFIT_NPM_PREPARE,
)(
  'validates a TypeScript migration with the upgraded SDK in offline Docker',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-sdk-upgrade-e2e-'));
    roots.push(root);
    const repository = join(root, 'app');
    await mkdir(join(repository, 'src'), { recursive: true });
    await writeFile(
      join(repository, 'package.json'),
      `${JSON.stringify({ name: 'refit-upgrade-app', private: true, type: 'module', dependencies: { stripe: '^16.12.0' }, devDependencies: { typescript: '5.6.3' } }, null, 2)}\n`,
    );
    await writeFile(
      join(repository, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['src'],
      }),
    );
    await writeFile(join(repository, 'src/billing.ts'), SOURCE);
    await writeFile(join(repository, '.gitignore'), 'node_modules/\n');
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: repository,
      timeout: 300_000,
    });
    const git = (args: string[]) =>
      execute('git', ['-C', repository, '-c', 'commit.gpgsign=false', ...args]);
    await git(['init', '-q', '-b', 'main']);
    await git(['add', '.']);
    await git([
      '-c',
      'user.name=Refit Tests',
      '-c',
      'user.email=tests@refit.local',
      'commit',
      '-qm',
      'seed',
    ]);
    await writeFile(join(root, 'before.json'), JSON.stringify(SUBSCRIPTION(false)));
    await writeFile(join(root, 'after.json'), JSON.stringify(SUBSCRIPTION(true)));
    await writeFile(join(root, 'provider.json'), JSON.stringify(PROVIDER));
    const { validateMigration } = await import('./validation.ts');
    const report = await validateMigration({
      repository,
      before: join(root, 'before.json'),
      after: join(root, 'after.json'),
      providerConfig: join(root, 'provider.json'),
      apiVersion: '2024-06-20',
      apiVersionPolicy: 'source-verified',
      image: process.env.REFIT_DOCKER_IMAGE!,
      prepareDependencies: true,
      command: ['npx', '--no-install', 'tsc', '--noEmit'],
    });
    expect(report.patch).toMatchObject({ sdkUpgrade: { from: '16.12.0', to: TARGET } });
    // Under stripe 16 types both the new apiVersion literal and item periods fail to typecheck.
    expect(report.validation).toMatchObject({
      status: 'passed',
      baseline: { status: 'passed' },
      patched: { status: 'passed' },
    });
    expect('patchedEnvironment' in report.validation).toBe(true);
    expect(report.publicationFiles.map((file) => file.path).sort()).toEqual([
      'package-lock.json',
      'package.json',
      'src/billing.ts',
      'src/stripe-subscription-period.ts',
    ]);
  },
  900_000,
);
