import { expect, it } from 'vitest';
import {
  apiVersionOf,
  assignSets,
  checkIneligibility,
  DEFAULT_SEED,
  lockedStripe,
  metadataIneligibility,
  packageManagerOf,
  seededOrder,
  seedRank,
  slugTokens,
  TARGET,
  usesStripeSdk,
} from '../scripts/stripe-holdout-select.mjs';

it('orders candidates by SHA-256 of the seed and the lower-cased name, whatever the input order', () => {
  expect(seedRank('s', 'Owner/Repo')).toBe(seedRank('s', 'owner/repo'));
  expect(seedRank('s', 'owner/repo')).toMatch(/^[0-9a-f]{64}$/);
  expect(seedRank('s', 'owner/repo')).not.toBe(seedRank('t', 'owner/repo'));
  const repos = ['a/one', 'b/two', 'c/three', 'd/four'];
  const order = seededOrder(DEFAULT_SEED, repos);
  expect(seededOrder(DEFAULT_SEED, [...repos].reverse())).toEqual(order);
  expect([...order].sort()).toEqual(repos);
  const ranks = order.map((repo) => seedRank(DEFAULT_SEED, repo));
  expect([...ranks].sort()).toEqual(ranks);
});

it('collects every owner/name Refit mentions, lower-cased', () => {
  const tokens = slugTokens(
    '{"repo": "AadityaShukla01/Simplex"} see https://github.com/refit-dev/refit-bench and docs/BENCHMARKS.md',
  );
  expect(tokens.has('aadityashukla01/simplex')).toBe(true);
  expect(tokens.has('refit-dev/refit-bench')).toBe(true);
  expect(tokens.has('com/refit-dev')).toBe(false);
  expect(slugTokens('git clone https://github.com/Owner/Name.git').has('owner/name')).toBe(true);
});

it("applies the fresh set's metadata filters", () => {
  const record = {
    isArchived: false,
    isFork: false,
    diskUsage: 1000,
    pushedAt: '2026-01-02T00:00:00Z',
    defaultBranchRef: { target: { oid: 'a'.repeat(40) } },
    declaresStripe: true,
  };
  expect(metadataIneligibility(record)).toBeNull();
  expect(metadataIneligibility(null)).toBe('unavailable');
  expect(metadataIneligibility({ ...record, isArchived: true })).toBe('archived');
  expect(metadataIneligibility({ ...record, isFork: true })).toBe('fork');
  expect(metadataIneligibility({ ...record, diskUsage: 50 * 1024 })).toBe('over 50 MB');
  expect(metadataIneligibility({ ...record, pushedAt: '2023-12-31T23:59:59Z' })).toBe(
    'no push since 2024-01-01',
  );
  expect(metadataIneligibility({ ...record, declaresStripe: false })).toBe(
    'stripe not in root package.json',
  );
  expect(packageManagerOf({ lock0: true })).toBe('npm');
  expect(packageManagerOf({ lock1: true })).toBe('pnpm');
  expect(packageManagerOf({ lock0: true, lock2: true })).toBe('several');
  expect(packageManagerOf({})).toBe('none');
});

it('needs application code that imports stripe and constructs a client', () => {
  const client = {
    path: 'src/lib/stripe.ts',
    text: "import Stripe from 'stripe';\nnew Stripe(key);",
  };
  expect(usesStripeSdk([client])).toBe(true);
  expect(
    usesStripeSdk([
      { path: 'server.js', text: "const stripe = require('stripe')(process.env.KEY);" },
    ]),
  ).toBe(true);
  // Only a test constructs the client.
  expect(usesStripeSdk([{ ...client, path: 'src/__tests__/stripe.ts' }])).toBe(false);
  expect(usesStripeSdk([{ ...client, path: 'src/stripe.test.ts' }])).toBe(false);
  // Types only, no client.
  expect(usesStripeSdk([{ path: 'src/types.ts', text: "import type Stripe from 'stripe';" }])).toBe(
    false,
  );
});

it('reads the API version as the fresh set did: oldest pin, else the locked release', () => {
  const releases = { '2023-10-16': '14.0.0', '2024-04-10': '15.0.0', '2024-06-20': '16.0.0' };
  expect(apiVersionOf({ pins: ['2024-06-20', '2023-10-16'], locked: '16.1.0' }, releases)).toEqual({
    before: '2023-10-16',
    beforeSource: 'apiVersion pin (oldest of 2)',
  });
  expect(apiVersionOf({ pins: [], locked: '14.2.0' }, releases)).toEqual({
    before: '2024-04-10',
    beforeSource: 'SDK version',
  });
  expect(apiVersionOf({ pins: [], locked: '15.0.0' }, releases)?.before).toBe('2024-04-10');
  expect(apiVersionOf({ pins: [], locked: null }, releases)).toBeNull();
  expect(apiVersionOf({ pins: [], locked: '99.0.0' }, releases)).toBeNull();
});

it('reads the locked stripe-node release from each lockfile format', () => {
  expect(
    lockedStripe(
      JSON.stringify({ packages: { 'node_modules/stripe': { version: '14.2.0' } } }),
      'npm',
    ),
  ).toBe('14.2.0');
  expect(
    lockedStripe(
      'importers:\n  .:\n    dependencies:\n      stripe:\n        specifier: ^16.0.0\n        version: 16.1.0\n',
      'pnpm',
    ),
  ).toBe('16.1.0');
  expect(lockedStripe('stripe@^12.0.0:\n  version "12.18.0"\n', 'yarn')).toBe('12.18.0');
});

it('keeps only SDK users on an older API version with a pinned spec', () => {
  const specs = new Set(['2023-10-16', TARGET]);
  const check = { usesSdk: true, before: '2023-10-16' };
  expect(checkIneligibility(check, specs)).toBeNull();
  expect(checkIneligibility(undefined, specs)).toBe('clone failed');
  expect(checkIneligibility({ error: 'ETIMEDOUT' }, specs)).toBe('clone failed');
  expect(checkIneligibility({ ...check, usesSdk: false }, specs)).toBe(
    'no Stripe SDK client in application code',
  );
  expect(checkIneligibility({ ...check, before: undefined }, specs)).toBe('no API version');
  expect(checkIneligibility({ ...check, before: TARGET }, specs)).toBe('already on the target');
  expect(checkIneligibility({ ...check, before: '2020-08-27' }, specs)).toBe(
    'API version without a pinned spec',
  );
});

it('fills the sets in order and refuses a short one', () => {
  const kept = Array.from({ length: 5 }, (_, index) => `o/r${index}`);
  const sets = [
    { name: 'a', size: 3 },
    { name: 'b', size: 2 },
  ];
  expect(assignSets(kept, sets)).toEqual([
    { name: 'a', repos: ['o/r0', 'o/r1', 'o/r2'] },
    { name: 'b', repos: ['o/r3', 'o/r4'] },
  ]);
  expect(() => assignSets(kept.slice(0, 4), sets)).toThrow('b needs 2 repositories, got 1');
});
