import { expect, it } from 'vitest';
import { changesOutside } from './lockfile-resolution.ts';
import { scopedNpmLock } from './scoped-lockfile.ts';

const lock = (packages: Record<string, unknown>) =>
  `${JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;

// openai 4 brings node-fetch and its own @types/node 18; the project declares @types/node 20.
const committed = lock({
  '': {
    name: 'app',
    dependencies: { openai: '^4.20.0', zod: '^3.22.0' },
    devDependencies: { '@types/node': '^20.0.0' },
  },
  'node_modules/@types/node': { version: '20.11.0', dev: true },
  'node_modules/node-fetch': { version: '2.7.0', dependencies: { 'whatwg-url': '^5.0.0' } },
  'node_modules/openai': {
    version: '4.20.0',
    dependencies: { '@types/node': '^18.11.18', 'node-fetch': '^2.6.7' },
  },
  'node_modules/openai/node_modules/@types/node': { version: '18.19.0' },
  'node_modules/whatwg-url': { version: '5.0.0' },
  'node_modules/zod': { version: '3.25.76' },
});
const openai6 = {
  version: '6.49.0',
  peerDependencies: { ws: '^8.18.0', zod: '^3.25 || ^4.0' },
  peerDependenciesMeta: { ws: { optional: true }, zod: { optional: true } },
};

it('keeps every entry outside the SDK as committed and takes only its new tree', () => {
  // npm also re-hoisted @types/node and added another platform's optional binary.
  const resolved = lock({
    '': {
      name: 'app',
      dependencies: { openai: '^6.49.0', zod: '^3.22.0' },
      devDependencies: { '@types/node': '^20.0.0' },
    },
    'node_modules/@types/node': { version: '20.19.1', dev: true },
    'node_modules/@esbuild/linux-x64': { version: '0.25.0', optional: true },
    'node_modules/openai': openai6,
    'node_modules/zod': { version: '3.25.76' },
  });
  expect(changesOutside(committed, resolved, ['openai'])).not.toEqual([]);
  const result = scopedNpmLock({ committed, resolved, names: ['openai'] });
  if (!('lockfile' in result)) throw new Error(result.reason);
  const packages = JSON.parse(result.lockfile).packages;
  expect(Object.keys(packages)).toEqual([
    '',
    'node_modules/@types/node',
    'node_modules/openai',
    'node_modules/zod',
  ]);
  expect(packages['node_modules/@types/node'].version).toBe('20.11.0');
  expect(packages['node_modules/openai']).toEqual(openai6);
  expect(packages[''].dependencies).toEqual({ openai: '^6.49.0', zod: '^3.22.0' });
  expect(changesOutside(committed, result.lockfile, ['openai'])).toEqual([]);
});

it('stops when the new SDK needs a peer the project locks below its range', () => {
  const old = committed.replace('"version": "3.25.76"', '"version": "3.22.4"');
  const resolved = lock({
    '': { name: 'app', dependencies: { openai: '^6.49.0', zod: '^3.22.0' } },
    'node_modules/openai': openai6,
    'node_modules/zod': { version: '3.25.76' },
  });
  expect(scopedNpmLock({ committed: old, resolved, names: ['openai'] })).toEqual({
    reason:
      'openai 6.49.0 declares zod ^3.25 || ^4.0 (an optional peer, but installed); the project locks zod 3.22.4, and moving it would change a package outside the upgrade.',
  });
});

it('nests a release the new tree needs below it when a shared package holds the slot', () => {
  const resolved = lock({
    '': {
      name: 'app',
      dependencies: { openai: '^6.49.0', zod: '^3.22.0', 'node-fetch': '^2.7.0' },
    },
    'node_modules/node-fetch': { version: '2.7.0', dependencies: { 'whatwg-url': '^5.0.0' } },
    'node_modules/node-fetch/node_modules/whatwg-url': { version: '5.0.0' },
    'node_modules/openai': { version: '6.49.0', dependencies: { 'whatwg-url': '^14.0.0' } },
    'node_modules/whatwg-url': { version: '14.0.0', dependencies: { tr46: '^5.0.0' } },
    'node_modules/tr46': { version: '5.1.0' },
    'node_modules/zod': { version: '3.25.76' },
  });
  // node-fetch, kept as committed, still needs whatwg-url 5 at the top.
  const shared = committed.replace(
    '"zod": "^3.22.0"\n',
    '"zod": "^3.22.0",\n        "node-fetch": "^2.7.0"\n',
  );
  const result = scopedNpmLock({ committed: shared, resolved, names: ['openai'] });
  if (!('lockfile' in result)) throw new Error(result.reason);
  const packages = JSON.parse(result.lockfile).packages;
  expect(packages['node_modules/whatwg-url'].version).toBe('5.0.0');
  expect(packages['node_modules/openai/node_modules/whatwg-url'].version).toBe('14.0.0');
  expect(packages['node_modules/tr46'].version).toBe('5.1.0');
  expect(Object.keys(packages['']['dependencies'])).toEqual(['openai', 'zod', 'node-fetch']);
});

it('leaves lockfile version 2 to the existing refusal', () => {
  const v2 = committed.replace('"requires": true,', '"requires": true,\n  "dependencies": {},');
  expect(scopedNpmLock({ committed: v2, resolved: committed, names: ['openai'] })).toMatchObject({
    reason: expect.stringContaining('lockfile version 2'),
  });
});
