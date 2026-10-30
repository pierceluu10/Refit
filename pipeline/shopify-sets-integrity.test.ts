import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SETS, slugTokens, TARGET } from '../scripts/shopify-select.mjs';

// shopify-blind-100 is measurement only (docs/BENCHMARKS.md, "Shopify dev and blind sets"): nobody
// opens, traces or debugs its repositories, so one may be named only by its own list and the
// selection inputs that produced it. Anywhere else, shipped source included, it means someone looked.

const root = join(import.meta.dirname, '..');
const SUBSETS = 'docs/benchmarks/subsets';
const BLIND = 'shopify-blind-100.json';
const ALLOWED = [
  /^docs\/benchmarks\/subsets\/shopify-blind-100\.json$/,
  /^docs\/benchmarks\/shopify-selection\//,
];

interface List {
  repos: Array<{ repo: string; commit: string; categories: string[]; source?: string }>;
  target: string;
  schemas: { versions: Array<{ version: string; sha256: string }> };
}

const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as List;
const sets = SETS.map(({ name, size }) => ({ name, size, list: read(`${SUBSETS}/${name}.json`) }));
const slugs = (list: List) => new Set(list.repos.map((entry) => entry.repo.toLowerCase()));
const blindSlugs = slugs(read(`${SUBSETS}/${BLIND}`));
// Fewer affected repositories than the sets ask for are recorded, never hidden: each set holds as
// many as the selection found, up to its size.
const selection = JSON.parse(
  readFileSync(join(root, 'docs/benchmarks/shopify-selection/selection.json'), 'utf8'),
) as { affected: number; devAffected?: number };
const available: Record<string, number> = {
  'shopify-blind-100': selection.affected,
  'shopify-dev-60': selection.devAffected ?? selection.affected - SETS[0].size,
};

it('freezes affected repositories at full commits with every supported schema pinned', () => {
  for (const { name, size, list } of sets) {
    expect(list.repos, name).toHaveLength(Math.min(size, Math.max(0, available[name])));
    expect(list.target).toBe(TARGET);
    expect(list.schemas.versions.map((entry) => entry.version)).toContain(TARGET);
    for (const schema of list.schemas.versions) expect(schema.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const entry of list.repos) {
      expect(entry.repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
      expect(entry.commit, entry.repo).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.categories.length, entry.repo).toBeGreaterThan(0);
    }
  }
});

it('shares no repository between the sets or with any other benchmark list', () => {
  const ours = sets.map(({ name }) => `${name}.json`);
  const all = new Set(sets.flatMap(({ list }) => [...slugs(list)]));
  expect(all.size).toBe(sets.reduce((total, { list }) => total + list.repos.length, 0));
  // Dev repositories drawn from already-open lists are named by other files; blind ones never are.
  const fresh = new Set(
    sets.flatMap(({ list }) =>
      list.repos.filter((entry) => !entry.source).map((entry) => entry.repo.toLowerCase()),
    ),
  );
  const others = [
    ...readdirSync(join(root, SUBSETS))
      .filter((file) => file.endsWith('.json') && !ours.includes(file))
      .map((file) => `${SUBSETS}/${file}`),
    ...readdirSync(join(root, 'docs/benchmarks'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => `docs/benchmarks/${file}`),
  ];
  const shared = others.flatMap((path) =>
    [...slugTokens(readFileSync(join(root, path), 'utf8'))]
      .filter((slug) => fresh.has(slug))
      .map((slug) => `${path}: ${slug}`),
  );
  expect(shared).toEqual([]);
});

it('names no blind repository outside its list and the selection inputs', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path && !ALLOWED.some((pattern) => pattern.test(path)));
  expect(files.some((path) => path.startsWith('pipeline/'))).toBe(true);
  const named = files.flatMap((path) => {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      return [];
    }
    return [...slugTokens(text)]
      .filter((slug) => blindSlugs.has(slug))
      .map((slug) => `${path}: ${slug}`);
  });
  expect(named).toEqual([]);
});
