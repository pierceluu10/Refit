import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CHANGE_TYPES, SETS } from '../scripts/ai-provider-sets-select.mjs';
import { slugTokens } from '../scripts/stripe-holdout-select.mjs';

// The AI-provider measurement sets follow the Stripe holdout rules
// (docs/benchmarks/AI-PROVIDER-SETS.md): nobody opens, traces or debugs their repositories to design
// a fix, so a measurement repository may be named only by its own list, the selection inputs and the
// milestone results recorded from it. Dev sets are for debugging and may be named anywhere.

const root = join(import.meta.dirname, '..');
const SUBSETS = 'docs/benchmarks/subsets';
const ALLOWED = [
  /^docs\/benchmarks\/subsets\/(?:openai-100|anthropic-100|gemini-30)\.json$/,
  /^docs\/benchmarks\/ai-provider-selection\//,
  /^docs\/benchmarks\/ai-provider-results\//,
];

interface Entry {
  repo: string;
  commit: string;
  language: 'js' | 'py';
  changeTypes: string[];
}
interface List {
  provider: string;
  repos: Entry[];
}
type SetSpec = { name: string; purpose: string; js: number; py: number };

const specs = (Object.values(SETS) as SetSpec[][]).flat();
const read = (name: string) =>
  JSON.parse(readFileSync(join(root, SUBSETS, `${name}.json`), 'utf8')) as List;
const lists = specs.map((spec) => ({ spec, list: read(spec.name) }));
const measurementSlugs = new Set(
  lists
    .filter(({ spec }) => spec.purpose === 'measurement')
    .flatMap(({ list }) => list.repos.map((entry) => entry.repo.toLowerCase())),
);

it('freezes every set at its size and language split, at full commits, with known change types', () => {
  for (const { spec, list } of lists) {
    expect(list.repos, spec.name).toHaveLength(spec.js + spec.py);
    expect(
      list.repos.filter((entry) => entry.language === 'js'),
      spec.name,
    ).toHaveLength(spec.js);
    expect(
      list.repos.filter((entry) => entry.language === 'py'),
      spec.name,
    ).toHaveLength(spec.py);
    for (const entry of list.repos) {
      expect(entry.repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
      expect(entry.commit, entry.repo).toMatch(/^[0-9a-f]{40}$/);
      for (const type of entry.changeTypes) expect(CHANGE_TYPES).toContain(type);
    }
  }
});

it('shares no repository between sets or with any other benchmark list', () => {
  const all = lists.flatMap(({ list }) => list.repos.map((entry) => entry.repo.toLowerCase()));
  expect(new Set(all).size).toBe(all.length);
  const ours = new Set(specs.map((spec) => `${spec.name}.json`));
  const others = [
    ...readdirSync(join(root, SUBSETS))
      .filter((file) => file.endsWith('.json') && !ours.has(file))
      .map((file) => `${SUBSETS}/${file}`),
    ...readdirSync(join(root, 'docs/benchmarks'))
      .filter((file) => file.endsWith('-repos.json'))
      .map((file) => `docs/benchmarks/${file}`),
  ];
  const slugs = new Set(all);
  const shared = others.flatMap((path) => {
    const list = JSON.parse(readFileSync(join(root, path), 'utf8')) as { repos?: unknown[] };
    return (list.repos ?? [])
      .map((entry) => (typeof entry === 'string' ? entry : (entry as Entry).repo))
      .filter((repo) => typeof repo === 'string' && slugs.has(repo.toLowerCase()))
      .map((repo) => `${path}: ${repo}`);
  });
  expect(shared).toEqual([]);
});

it('names no measurement repository outside its list, the selection inputs and milestone results', () => {
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
      .filter((slug) => measurementSlugs.has(slug))
      .map((slug) => `${path}: ${slug}`);
  });
  expect(named).toEqual([]);
});
