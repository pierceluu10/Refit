import { expect, it } from 'vitest';
import { DEFAULT_PNPM_VERSION, validatePnpmInputs } from './pnpm-inputs.ts';
import { parsePnpmLock } from './pnpm-lock.ts';
import { resolveLockedDependency } from './lockfiles.ts';

const INTEGRITY = `sha512-${Buffer.alloc(64).toString('base64')}`;
type ObjectData = Record<string, any>;
function scenario() {
  const manifest: ObjectData = {
    name: 'billing-app',
    packageManager: 'pnpm@12.4.2',
    dependencies: { stripe: '10.17.0' },
    scripts: { postinstall: 'must-never-run' },
  };
  const lock: ObjectData = {
    lockfileVersion: '9.0',
    importers: { '.': { dependencies: { stripe: { specifier: '10.17.0', version: '10.17.0' } } } },
    packages: { 'stripe@10.17.0': { resolution: { integrity: INTEGRITY } } },
    snapshots: { 'stripe@10.17.0': {} },
  };
  const workspace: ObjectData = { packages: ['packages/*'], catalog: { stripe: '10.17.0' } };
  const workspaces = new Map<string, string>();
  return { manifest, lock, workspace, workspaces };
}
function validate(sample = scenario(), environment?: ObjectData) {
  return validatePnpmInputs(
    JSON.stringify(sample.manifest),
    environment
      ? `---\n${JSON.stringify(environment)}\n---\n${JSON.stringify(sample.lock)}`
      : JSON.stringify(sample.lock),
    JSON.stringify(sample.workspace),
    sample.workspaces,
  );
}
function manager(): ObjectData {
  return {
    lockfileVersion: '9.0',
    importers: {
      '.': {
        configDependencies: {},
        packageManagerDependencies: { pnpm: { specifier: '12.4.2', version: '12.4.2' } },
      },
    },
    packages: { 'pnpm@12.4.2': { resolution: { integrity: INTEGRITY } } },
    snapshots: { 'pnpm@12.4.2': {} },
  };
}

it('retains immutable input identity and does not treat root lifecycle scripts as executable preparation', () => {
  expect(validate()).toMatchObject({
    manager: 'pnpm',
    managerVersion: '12.4.2',
    packages: 1,
    packageHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    workspaceConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});
it('validates explicit workspace links and default/named catalog constraints', () => {
  const sample = scenario();
  delete sample.manifest.dependencies;
  sample.workspaces.set(
    'packages/billing',
    JSON.stringify({
      name: 'billing',
      dependencies: { stripe: 'catalog:stable', ids: 'workspace:*' },
    }),
  );
  sample.workspaces.set('packages/ids', JSON.stringify({ name: 'ids', version: '1.0.0' }));
  delete sample.workspace.catalog;
  sample.workspace.catalogs = { stable: { stripe: '10.17.0' } };
  sample.lock.catalogs = { stable: { stripe: { specifier: '10.17.0', version: '10.17.0' } } };
  sample.lock.importers = {
    '.': {},
    'packages/billing': {
      dependencies: {
        stripe: { specifier: 'catalog:stable', version: '10.17.0' },
        ids: { specifier: 'workspace:*', version: 'link:../ids' },
      },
    },
    'packages/ids': {},
  };
  expect(validate(sample)).toMatchObject({
    workspaceLinks: { 'packages/billing/node_modules/ids': 'packages/ids' },
    workspaceOptionalLinks: { 'node_modules/.pnpm/node_modules/ids': 'packages/ids' },
  });
  sample.workspace.catalogs.stable.stripe = '11.0.0';
  expect(() => validate(sample)).toThrow('catalog requirements differ');
  sample.workspace.catalogs.stable.stripe = '10.17.0';
  sample.lock.importers['packages/billing'].dependencies.ids.version = 'link:../../../outside';
  expect(() => validate(sample)).toThrow('link explicitly');
});
it('reads the application graph from the last document and binds the manager graph separately', () => {
  const sample = scenario(),
    environment = manager();
  expect(validate(sample, environment)).toMatchObject({ packages: 1, managerIntegrity: INTEGRITY });
  const content = `---\n${JSON.stringify(environment)}\n---\n${JSON.stringify(sample.lock)}`;
  const parsed = parsePnpmLock(content);
  expect(
    resolveLockedDependency(
      { file: 'package.json', section: 'dependencies', version: '10.17.0' },
      'stripe',
      [{ file: 'pnpm-lock.yaml', content: parsed.document }],
    ).version,
  ).toBe('10.17.0');
  environment.importers['.'].configDependencies.plugin = { version: '1.0.0' };
  expect(() => validate(sample, environment)).toThrow('configuration dependencies');
});
it('installs an unpinned lockfile v9 root with the final pnpm 9 release, never a range', () => {
  const sample = scenario();
  delete sample.manifest.packageManager;
  expect(validate(sample)).toMatchObject({ managerVersion: DEFAULT_PNPM_VERSION });
  expect(validate(sample)).not.toHaveProperty('managerIntegrity');
  // An environment document that records another manager still has to match the pin.
  expect(() => validate(sample, manager())).toThrow('exact declared package manager');
});
it('checks manager environment versions, all package integrities and explicit Corepack checksums', () => {
  const sample = scenario(),
    environment = manager();
  sample.manifest.packageManager += '+' + 'sha512.' + Buffer.alloc(64).toString('hex');
  expect(validate(sample, environment).managerIntegrity).toBe(INTEGRITY);
  environment.packages['pnpm@12.4.2'].resolution.integrity =
    `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  expect(() => validate(sample, environment)).toThrow('checksum differs');
  environment.packages['pnpm@12.4.2'].resolution.integrity = 'sha1-unsafe';
  expect(() => validate(sample, environment)).toThrow('SHA-256-or-stronger');
});
it.each([
  [
    'manager range',
    (s: ReturnType<typeof scenario>) => {
      s.manifest.packageManager = 'pnpm@^12';
    },
  ],
  [
    'stale importer',
    (s: ReturnType<typeof scenario>) => {
      s.manifest.dependencies.stripe = '11.0.0';
    },
  ],
  [
    'missing snapshot',
    (s: ReturnType<typeof scenario>) => {
      s.lock.snapshots = {};
    },
  ],
  [
    'private tarball',
    (s: ReturnType<typeof scenario>) => {
      s.lock.packages['stripe@10.17.0'].resolution.tarball = 'https://private.invalid/stripe.tgz';
    },
  ],
  [
    'weak integrity',
    (s: ReturnType<typeof scenario>) => {
      s.lock.packages['stripe@10.17.0'].resolution.integrity = 'sha1-unsafe';
    },
  ],
  [
    'Git source',
    (s: ReturnType<typeof scenario>) => {
      s.lock.packages['stripe@10.17.0'].resolution.repo = 'git://outside';
    },
  ],
  [
    'hidden configuration dependency',
    (s: ReturnType<typeof scenario>) => {
      s.lock.importers['.'].configDependencies = { plugin: '1' };
    },
  ],
  [
    'patch metadata',
    (s: ReturnType<typeof scenario>) => {
      s.lock.patchedDependencies = { stripe: 'patch.js' };
    },
  ],
  [
    'runtime download',
    (s: ReturnType<typeof scenario>) => {
      s.manifest.devEngines = { runtime: { version: '25' } };
    },
  ],
  [
    'injected source',
    (s: ReturnType<typeof scenario>) => {
      s.manifest.dependenciesMeta = { stripe: { injected: true } };
    },
  ],
  [
    'pnpm hook',
    (s: ReturnType<typeof scenario>) => {
      s.workspace.pnpmfile = 'hook.js';
    },
  ],
  [
    'custom resolver',
    (s: ReturnType<typeof scenario>) => {
      s.manifest.dependencies.stripe = 'exec:external-command';
    },
  ],
  [
    'remote override',
    (s: ReturnType<typeof scenario>) => {
      s.workspace.overrides = { stripe: 'https://outside.invalid/sdk.tgz' };
    },
  ],
  [
    'escaped workspace',
    (s: ReturnType<typeof scenario>) => {
      s.workspace.packages = ['../outside'];
    },
  ],
  [
    'workspace binary',
    (s: ReturnType<typeof scenario>) => {
      s.workspaces.set('packages/cli', JSON.stringify({ name: 'cli', bin: 'index.js' }));
      s.lock.importers['packages/cli'] = {};
    },
  ],
])('refuses %s before preparing an environment', (_name, mutate) => {
  const sample = scenario();
  mutate(sample);
  expect(() => validate(sample)).toThrow();
});
it('rejects aliases, duplicate keys, extra documents and a forged leading application graph', () => {
  for (const content of [
    'lockfileVersion: 9\nlockfileVersion: 9',
    'importers: &v {}\npackages: *v',
    '---\n{}\n---\n{}\n---\n{}',
    '---\n{"importers":{".":{"dependencies":{}}}}\n---\n{}',
  ])
    expect(() => parsePnpmLock(content)).toThrow();
});
