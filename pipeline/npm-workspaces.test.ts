import { expect, it } from 'vitest';
import { npmWorkspaceDirectories, validateNpmLock } from './npm-lock.ts';
import { digest } from './specifications.ts';

const manifest = {
  name: 'workspace-root',
  private: true,
  workspaces: ['./packages/*'],
  dependencies: {},
};
const workspace = {
  name: '@demo/billing',
  version: '1.0.0',
  dependencies: { stripe: '10.17.0' },
  scripts: { postinstall: 'must-not-run' },
};
const record = {
  version: '10.17.0',
  resolved: 'https://registry.npmjs.org/stripe/-/stripe-10.17.0.tgz',
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
};
function scenario() {
  return {
    content: JSON.stringify(manifest),
    workspaces: new Map([['packages/billing', JSON.stringify(workspace)]]),
    lock: {
      lockfileVersion: 3,
      packages: {
        '': manifest,
        'packages/billing': workspace,
        'node_modules/@demo/billing': { link: true, resolved: 'packages/billing' },
        'node_modules/stripe': record,
      } as Record<string, unknown>,
    },
  };
}
function validate(sample = scenario()) {
  return validateNpmLock(sample.content, JSON.stringify(sample.lock), sample.workspaces);
}

it.each([2, 3])(
  'records committed workspace hashes and exact links for lockfile version %s',
  (version) => {
    const sample = scenario();
    sample.lock.lockfileVersion = version;
    expect(validate(sample)).toMatchObject({
      workspaceHashes: { 'packages/billing': digest(sample.workspaces.get('packages/billing')!) },
      workspaceLinks: { 'node_modules/@demo/billing': 'packages/billing' },
      packages: 3,
    });
  },
);

it('uses standard positive globs over committed manifest paths, excludes dependency trees and keeps deterministic order', () => {
  expect(
    npmWorkspaceDirectories({ ...manifest, workspaces: ['./packages/{a,b}/', 'apps/**'] }, [
      'packages/b/package.json',
      'apps/api/package.json',
      'package.json',
      'packages/a/package.json',
      'apps/api/node_modules/hidden/package.json',
      'examples/ignored/package.json',
    ]),
  ).toEqual(['apps/api', 'packages/a', 'packages/b']);
});

it.each([
  ['../outside/*'],
  ['/private/*'],
  ['!packages/a'],
  { packages: ['packages/*'] },
  ['packages/\n*'],
  [null],
])('rejects unsupported or escaping declarations before reading extra files: %j', (workspaces) => {
  expect(() => npmWorkspaceDirectories({ ...manifest, workspaces }, [])).toThrow(
    /positive relative/,
  );
});

it.each([
  ['wrong target', { link: true, resolved: 'packages/missing' }],
  ['escaping target', { link: true, resolved: '../outside' }],
  ['file URI', { link: true, resolved: 'file:packages/billing' }],
])('rejects %s links before installation', (_name, link) => {
  const sample = scenario();
  sample.lock.packages['node_modules/@demo/billing'] = link;
  expect(() => validate(sample)).toThrow(/declared committed workspace/);
});

it('rejects a linked package whose installed name differs from the workspace name', () => {
  const sample = scenario();
  sample.lock.packages['node_modules/impostor'] =
    sample.lock.packages['node_modules/@demo/billing'];
  delete sample.lock.packages['node_modules/@demo/billing'];
  expect(() => validate(sample)).toThrow(/exact package name/);
});

it.each([
  ['dependencies', { ...workspace, dependencies: { stripe: '11.0.0' } }],
  ['version', { ...workspace, version: '2.0.0' }],
  ['name', { ...workspace, name: '@demo/renamed' }],
])('rejects a stale workspace %s before installation', (_name, value) => {
  const sample = scenario();
  sample.workspaces.set('packages/billing', JSON.stringify(value));
  expect(() => validate(sample)).toThrow(/lockfile/);
});

it('rejects missing importer manifests, mismatched root globs and undeclared package records', () => {
  const missing = scenario();
  missing.workspaces.clear();
  expect(() => validate(missing)).toThrow();
  const globs = scenario();
  globs.content = JSON.stringify({ ...manifest, workspaces: ['apps/*'] });
  expect(() => validate(globs)).toThrow(/Workspaces/);
  const extra = scenario();
  extra.lock.packages['examples/hidden'] = workspace;
  expect(() => validate(extra)).toThrow(/Every npm package/);
});

it('allows root and workspace-specific public dependency versions while rejecting unrelated nested install paths', () => {
  const sample = scenario();
  sample.lock.packages['packages/billing/node_modules/stripe'] = { ...record, version: '19.1.0' };
  expect(validate(sample).packages).toBe(4);
  sample.lock.packages['examples/unselected/node_modules/stripe'] = record;
  expect(() => validate(sample)).toThrow(/Every npm package/);
});

it.each([
  { ...workspace, bin: { tool: 'tool.js' } },
  { ...workspace, workspaces: ['nested/*'] },
  { ...workspace, bundledDependencies: [] },
  { ...workspace, dependencies: { stripe: 'file:../stripe' } },
  { ...workspace, name: '../escape' },
])('keeps unsupported workspace installation behavior explicit: %j', (value) => {
  const sample = scenario();
  sample.workspaces.set('packages/billing', JSON.stringify(value));
  expect(() => validate(sample)).toThrow();
});

it('requires unique names and incorporates a script-only workspace manifest change into its input hashes', () => {
  const original = scenario();
  const first = validate(original);
  original.workspaces.set(
    'packages/billing',
    JSON.stringify({ ...workspace, scripts: { test: 'node test.js' } }),
  );
  expect(validate(original).workspaceHashes).not.toEqual(first.workspaceHashes);
  original.workspaces.set('packages/duplicate', JSON.stringify(workspace));
  expect(() => validate(original)).toThrow(/unique/);
});
