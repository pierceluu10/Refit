import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  activeSince,
  apiVersionPins,
  DEFAULT_EXCLUDES,
  readExclusions,
  searchQueries,
  SIZE_RANGES,
} from '../scripts/stripe-active-select.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('counts the 90-day activity window back from --frozen-at', () => {
  expect(activeSince('2026-10-16')).toBe('2026-07-18T00:00:00Z');
  expect(activeSince('2026-10-24')).toBe('2026-07-26T00:00:00Z');
  expect(() => activeSince('2026-10')).toThrow('--frozen-at must be a date');
  expect(() => activeSince('2026-13-40')).toThrow('--frozen-at must be a date');
});

it('splits each of the 13 searches by file size to reach past the 1,000-result cap', () => {
  const queries = searchQueries();
  expect(queries).toHaveLength(13 * SIZE_RANGES.length);
  expect(queries[0]).toBe('"new Stripe(" apiVersion language:TypeScript size:<2000');
  expect(new Set(queries).size).toBe(queries.length);
});

it('reads literal apiVersion pins and skips commented-out ones', () => {
  // QwertyFusion/bookworm (P3, board #248): only a commented-out pin, so the SDK version decides.
  expect(
    apiVersionPins(
      [
        'const stripe = new Stripe(key, {',
        "  // apiVersion: '2023-08-16',",
        '});',
        '/* apiVersion: "2022-11-15" */',
        ' * apiVersion: `2020-08-27`',
      ].join('\n'),
    ),
  ).toEqual([]);
  expect(
    apiVersionPins(
      'export const stripe = new Stripe(k, { apiVersion: \'2025-02-24.acacia\' });\nnew Stripe(k, {apiVersion:"2024-06-20"})',
    ),
  ).toEqual(['2025-02-24.acacia', '2024-06-20']);
});

it('excludes every repository of every list, case-insensitively, and unions their specs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-active-select-'));
  roots.push(root);
  const first = join(root, 'first.json');
  const second = join(root, 'second.json');
  await writeFile(
    first,
    JSON.stringify({
      repos: [{ repo: 'Acme/Shop' }, { repo: 'b/c' }],
      specs: [{ version: '2024-06-20', tag: 'v1000' }],
    }),
  );
  await writeFile(
    second,
    JSON.stringify({
      repos: [{ repo: 'acme/shop' }, { repo: 'd/e' }],
      specs: [
        { version: '2024-06-20', tag: 'v1000' },
        { version: '2026-09-30.endive', tag: 'v2000' },
      ],
    }),
  );
  const exclusions = await readExclusions([first, second]);
  expect([...exclusions.repos].sort()).toEqual(['acme/shop', 'b/c', 'd/e']);
  expect(exclusions.lists).toEqual([
    { list: first, repositories: 2 },
    { list: second, repositories: 2 },
  ]);
  expect(Object.fromEntries(exclusions.specs)).toEqual({
    '2024-06-20': 'v1000',
    '2026-09-30.endive': 'v2000',
  });

  await writeFile(
    second,
    JSON.stringify({ repos: [], specs: [{ version: '2024-06-20', tag: 'v9' }] }),
  );
  await expect(readExclusions([first, second])).rejects.toThrow('pins 2024-06-20 to v9');
  await writeFile(second, JSON.stringify({ specs: [] }));
  await expect(readExclusions([second])).rejects.toThrow('has no repos array');
});

it('excludes the three earlier sets by default, and the committed lists agree on their specs', async () => {
  expect(DEFAULT_EXCLUDES).toHaveLength(3);
  const tuned = [...DEFAULT_EXCLUDES, 'docs/benchmarks/2026-10-16-stripe-active-repos.json'];
  const exclusions = await readExclusions(tuned);
  expect(exclusions.repos.size).toBe(597);
  expect(exclusions.specs.get('2026-09-30.endive')).toBeTruthy();
});
