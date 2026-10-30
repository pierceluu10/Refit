import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  affectedReasons,
  benchmarkRepositories,
  retirements,
  searchQueries,
  splitQuery,
  splitSets,
  textSignals,
  TIERS,
  versionStatus,
} from '../scripts/meta-active-select.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const dates = retirements({
  deadlines: [
    { provider: 'meta-graph', kind: 'api-version', date: '2024-05-28', versions: ['v13.0'] },
    { provider: 'meta-graph', kind: 'api-version', date: '2026-09-24', versions: ['v20.0'] },
    { provider: 'meta-graph', kind: 'api-version', date: '2027-05-20', versions: ['v22.0'] },
    { provider: 'meta-graph', kind: 'api-version', date: '2028-02-18', versions: ['v24.0'] },
    { provider: 'shopify', kind: 'api-version', date: '2020-01-01', versions: ['v99.0'] },
  ],
});

it('searches each signal once and splits only on request', () => {
  const queries = searchQueries();
  expect(new Set(queries.map((entry) => entry.signal))).toEqual(
    new Set(['versioned-url', 'business-sdk', 'fb-init', 'instagram', 'whatsapp-cloud']),
  );
  expect(splitQuery('"FB.init"')[0]).toBe('"FB.init" size:<2000');
});

it('reads every repository named anywhere under the benchmark directory, except skipped files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-select-'));
  roots.push(root);
  await mkdir(join(root, 'subsets'));
  await writeFile(join(root, 'a.json'), JSON.stringify({ repos: [{ repo: 'Org/One' }] }));
  await writeFile(
    join(root, 'subsets', 'b.json'),
    JSON.stringify({ rows: [{ nested: { repository: 'org/two' } }, { repo: 'not a repo' }] }),
  );
  await writeFile(join(root, 'self.json'), JSON.stringify({ repos: [{ repo: 'org/self' }] }));
  const found = await benchmarkRepositories(root, [join(root, 'self.json')]);
  expect([...found.keys()].sort()).toEqual(['org/one', 'org/two']);
});

it('dates versions from the registry, older than its first entry as retired', () => {
  expect(versionStatus('v11.0', dates, '2026-10-29')).toBe('retired');
  expect(versionStatus('v20.0', dates, '2026-10-29')).toBe('retired');
  expect(versionStatus('v22.0', dates, '2026-10-29')).toBe('retiring');
  expect(versionStatus('v24.0', dates, '2026-10-29')).toBe('supported');
  expect(versionStatus('v26.0', dates, '2026-10-29')).toBe('supported');
});

it('finds FB.init versions and Instagram Basic Display scopes', () => {
  expect(
    textSignals(
      'FB.init({ appId: id, cookie: true, version: \'v12.0\' }); FB.init({version:"v24.0"})',
    ).fbInit,
  ).toEqual(['v12.0', 'v24.0']);
  expect(textSignals("const scope = 'user_profile,user_media'; // instagram").basicDisplay).toBe(
    true,
  );
  expect(textSignals("const scope = 'user_profile';").basicDisplay).toBe(false);
});

it('counts only live requests and live listed changes as affected', () => {
  const scan = {
    calls: [
      { use: 'live', file: 'src/a.ts', version: 'v24.0' },
      { use: 'test', file: 'test/a.ts', version: 'v10.0' },
    ],
  };
  const text = { fbInit: [], basicDisplay: false };
  expect(affectedReasons({ scan, moves: null, text }, dates, '2026-10-29')).toEqual([]);
  const moves = {
    stops: [
      {
        reasons: [
          'src/a.ts:3: v25.0 field-removed page-foo: Removed.',
          'test/a.ts:3: v25.0 edge-changed page-bar: Changed.',
        ],
      },
    ],
  };
  expect(affectedReasons({ scan, moves, text }, dates, '2026-10-29')).toEqual(['removed-request']);
  expect(
    affectedReasons(
      { scan, moves: null, text: { fbInit: ['v22.0'], basicDisplay: true } },
      dates,
      '2026-10-29',
    ),
  ).toEqual(['instagram-basic-display', 'retiring-version']);
});

it('splits sets by seeded hash, blind first, with no overlap', () => {
  const repos = Array.from({ length: 10 }, (_, index) => ({ repo: `org/r${index}` }));
  const { blind, dev } = splitSets(repos, 'seed', 3, 5);
  expect(blind).toHaveLength(3);
  expect(dev).toHaveLength(5);
  expect(blind.filter((entry) => dev.includes(entry))).toEqual([]);
  expect(splitSets([...repos].reverse(), 'seed', 3, 5)).toEqual({ blind, dev });
  expect(splitSets(repos, 'seed', 3, 50).blind).toEqual(blind);
});

it('loosens activity only in the agreed order: 180 days, then one author', () => {
  expect(TIERS.map(({ days, authors }) => [days, authors])).toEqual([
    [90, 2],
    [180, 2],
    [180, 1],
  ]);
});
