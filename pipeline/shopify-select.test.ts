import { expect, it } from 'vitest';
import {
  categories,
  metadataIneligibility,
  searchQueries,
  seededOrder,
  SETS,
  splitSets,
  STAGES,
  supportedVersions,
} from '../scripts/shopify-select.mjs';
import { SIZE_RANGES } from '../scripts/stripe-active-select.mjs';

const SINCE = '2026-07-31T00:00:00Z';
const SUPPORTED = ['2026-01', '2026-04', '2026-07', '2026-10'];

it('splits each Shopify search by file size to reach past the 1,000-result cap', () => {
  const queries = searchQueries();
  expect(queries).toHaveLength(6 * SIZE_RANGES.length);
  expect(new Set(queries).size).toBe(queries.length);
  expect(queries.some((query) => query.startsWith('api_version filename:shopify.app.toml'))).toBe(
    true,
  );
});

it('reads the supported Admin API versions from the deadline registry', () => {
  const deadlines = {
    deadlines: [
      { id: 'shopify-admin-2025-10', date: '2026-10-16' },
      { id: 'shopify-admin-2026-04', date: '2027-04-16' },
      { id: 'shopify-admin-2026-01', date: '2027-01-16' },
      { id: 'meta-graph-v13-0', date: '2027-01-01' },
    ],
  };
  expect(supportedVersions(deadlines, '2026-10-29')).toEqual(['2026-01', '2026-04']);
  expect(supportedVersions(deadlines, '2026-10-01')).toEqual(['2025-10', '2026-01', '2026-04']);
});

it('keeps only active team repositories with CI and a root lockfile', () => {
  const author = (login: string) => ({ author: { user: { login } } });
  const record = {
    nameWithOwner: 'a/b',
    isArchived: false,
    isFork: false,
    diskUsage: 100,
    defaultBranchRef: {
      target: {
        committedDate: '2026-10-01T00:00:00Z',
        history: { nodes: [author('x'), author('y'), author('dependabot[bot]')] },
      },
    },
    workflows: { entries: [{ name: 'ci.yml' }] },
    manifest: { oid: '1' },
    lock1: { oid: '2' },
  };
  expect(metadataIneligibility(record, SINCE)).toBeNull();
  expect(metadataIneligibility({ ...record, lock1: null }, SINCE)).toBe('no root lockfile');
  expect(metadataIneligibility({ ...record, workflows: null }, SINCE)).toBe(
    'no GitHub Actions workflow',
  );
  const solo = structuredClone(record);
  solo.defaultBranchRef.target.history.nodes = [author('x'), author('renovate[bot]')];
  expect(metadataIneligibility(solo, SINCE)).toBe('fewer than 2 human authors in 90 days');
  const stale = structuredClone(record);
  stale.defaultBranchRef.target.committedDate = '2026-05-01T00:00:00Z';
  expect(metadataIneligibility(stale, SINCE)).toBe('no commit in 90 days');
});

it('loosens the activity window, then the author count, never CI or the lockfile', () => {
  const author = (login: string, committedDate: string) => ({
    committedDate,
    author: { user: { login } },
  });
  const record = {
    nameWithOwner: 'a/b',
    isArchived: false,
    isFork: false,
    diskUsage: 100,
    defaultBranchRef: {
      target: {
        committedDate: '2026-07-01T00:00:00Z',
        history: {
          nodes: [author('x', '2026-07-01T00:00:00Z'), author('y', '2026-06-01T00:00:00Z')],
        },
      },
    },
    workflows: { entries: [{ name: 'ci.yml' }] },
    manifest: { oid: '1' },
    lock1: { oid: '2' },
  };
  const since180 = '2026-05-02T00:00:00Z';
  const [, wider, single] = STAGES;
  expect(metadataIneligibility(record, SINCE)).toBe('no commit in 90 days');
  expect(metadataIneligibility(record, since180, wider)).toBeNull();
  // An author outside the window does not count toward it.
  expect(metadataIneligibility(record, '2026-06-15T00:00:00Z', { days: 180, authors: 2 })).toBe(
    'fewer than 2 human authors in 180 days',
  );
  expect(metadataIneligibility(record, '2026-06-15T00:00:00Z', single)).toBeNull();
  expect(metadataIneligibility({ ...record, workflows: null }, since180, single)).toBe(
    'no GitHub Actions workflow',
  );
  expect(metadataIneligibility({ ...record, lock1: null }, since180, single)).toBe(
    'no root lockfile',
  );
});

it('names each breaking-change category the pre-scan reaches', () => {
  const check = {
    shopifyUsage: true,
    pins: ['2026-04'],
    rest: 0,
    breakingDocuments: 0,
    alreadyFailing: 0,
    productModel: 0,
  };
  expect(categories(check, SUPPORTED)).toEqual([]);
  expect(categories({ ...check, pins: ['2024-07', '2026-04'] }, SUPPORTED)).toEqual([
    'unsupported-version',
  ]);
  expect(categories({ ...check, pins: ['2026-01'] }, SUPPORTED)).toEqual(['retiring-soonest']);
  expect(categories({ ...check, rest: 2, alreadyFailing: 1, productModel: 1 }, SUPPORTED)).toEqual([
    'deprecated-rest',
    'removed-fields',
    'product-model',
  ]);
  expect(categories({ ...check, shopifyUsage: false, rest: 2 }, SUPPORTED)).toEqual([]);
  expect(categories({ error: 'clone failed' }, SUPPORTED)).toEqual([]);
});

it('fills the blind set, then the dev set, from one seeded order with no overlap', () => {
  const affected = Array.from({ length: 200 }, (_, index) => `owner/repo-${index}`);
  const sets = splitSets('seed', affected);
  expect(sets.map(({ name, repos }) => [name, repos.length])).toEqual(
    SETS.map(({ name, size }) => [name, size]),
  );
  expect(new Set(sets.flatMap(({ repos }) => repos)).size).toBe(160);
  expect(sets[0].repos).toEqual(seededOrder('seed', affected).slice(0, 100));
  // Too few: the blind set keeps every repository it can.
  expect(splitSets('seed', affected.slice(0, 120)).map(({ repos }) => repos.length)).toEqual([
    100, 20,
  ]);
  expect(seededOrder('seed', [...affected].reverse())).toEqual(seededOrder('seed', affected));
});

it('draws the dev set from already-open lists when the search has too few', () => {
  const affected = Array.from({ length: 84 }, (_, index) => `owner/repo-${index}`);
  const open = Array.from({ length: 90 }, (_, index) => `open/repo-${index}`);
  const [blind, dev] = splitSets('seed', affected, open);
  expect(blind.repos).toEqual(seededOrder('seed', affected));
  expect(dev.repos).toEqual(seededOrder('seed', open).slice(0, 60));
});
