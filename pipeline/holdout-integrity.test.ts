import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { slugTokens, TARGET } from '../scripts/stripe-holdout-select.mjs';

// The holdout sets are measurement only (docs/BENCHMARKS.md#holdout-sets): nobody opens, traces or
// debugs their repositories to design a fix, and owner decision D5 forbids repository-specific code.
// So a holdout repository may be named only by its own list, the selection inputs that produced it
// and the milestone results recorded from it; anywhere else, shipped source included, it means
// someone looked.

const root = join(import.meta.dirname, '..');
const SUBSETS = 'docs/benchmarks/subsets';
const HOLDOUTS = { 'holdout-100.json': 100, 'holdout-30b.json': 30 };
const ALLOWED = [
  /^docs\/benchmarks\/subsets\/holdout-[^/]+\.json$/,
  /^docs\/benchmarks\/holdout-selection\//,
  /^docs\/benchmarks\/holdout-results\//,
];

interface Entry {
  repo: string;
  commit: string;
  before: string;
}
interface List {
  repos: Entry[];
  specs: Array<{ version: string; tag: string }>;
  target?: string;
}

const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as List;
const holdouts = Object.keys(HOLDOUTS).map((name) => ({ name, list: read(`${SUBSETS}/${name}`) }));
const holdoutSlugs = new Set(
  holdouts.flatMap(({ list }) => list.repos.map((entry) => entry.repo.toLowerCase())),
);

it('freezes 100 and 30 real repositories at full commits on API versions older than the target', () => {
  const pinned = new Map(
    (
      JSON.parse(readFileSync(join(root, 'data/stripe-openapi-versions.json'), 'utf8')) as {
        versions: Array<{ version: string; tag: string }>;
      }
    ).versions.map((entry) => [entry.version, entry.tag]),
  );
  for (const { name, list } of holdouts) {
    expect(list.repos, name).toHaveLength(HOLDOUTS[name as keyof typeof HOLDOUTS]);
    expect(list.target).toBe(TARGET);
    const specs = new Map(list.specs.map((spec) => [spec.version, spec.tag]));
    expect(specs.get(TARGET)).toBe(pinned.get(TARGET));
    for (const entry of list.repos) {
      expect(entry.repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
      expect(entry.commit, entry.repo).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.before < TARGET, entry.repo).toBe(true);
      expect(specs.get(entry.before), entry.repo).toBe(pinned.get(entry.before));
    }
  }
});

it('shares no repository with each other or any other benchmark list', () => {
  expect(holdoutSlugs.size).toBe(130);
  const others = [
    ...readdirSync(join(root, SUBSETS))
      .filter((file) => file.endsWith('.json') && !(file in HOLDOUTS))
      .map((file) => `${SUBSETS}/${file}`),
    ...readdirSync(join(root, 'docs/benchmarks'))
      .filter((file) => file.endsWith('-repos.json'))
      .map((file) => `docs/benchmarks/${file}`),
  ];
  expect(others.length).toBeGreaterThan(40);
  const shared = others.flatMap((path) => {
    const list = JSON.parse(readFileSync(join(root, path), 'utf8')) as { repos?: unknown[] };
    return (list.repos ?? [])
      .map((entry) => (typeof entry === 'string' ? entry : (entry as Entry).repo))
      .filter((repo) => typeof repo === 'string' && holdoutSlugs.has(repo.toLowerCase()))
      .map((repo) => `${path}: ${repo}`);
  });
  expect(shared).toEqual([]);
});

it('names no holdout repository outside its list, the selection inputs and milestone results', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path && !ALLOWED.some((pattern) => pattern.test(path)));
  expect(files.some((path) => path.startsWith('src/'))).toBe(true);
  const named = files.flatMap((path) => {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      return [];
    }
    return [...slugTokens(text)]
      .filter((slug) => holdoutSlugs.has(slug))
      .map((slug) => `${path}: ${slug}`);
  });
  expect(named).toEqual([]);
});
