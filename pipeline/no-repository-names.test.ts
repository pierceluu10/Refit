import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Owner decision 10 (Push 279, 2026-10-24): no benchmark repository's name or commit appears in
// non-test source, so a rule cannot be fitted to one repository.
const ROOT = join(import.meta.dirname, '..');
const LISTS = join(ROOT, 'docs', 'benchmarks');
const SOURCES = ['pipeline', 'src'];

// Exact `file: owner/repo` pairs that name a project, not a benchmark repository, each with why.
const ALLOWED: Record<string, string> = {
  'pipeline/shopify-sdk-upgrade.ts: shopify/shopify-app-js':
    "Shopify's own SDK monorepo, whose packages the upgrade moves together; it is also in a frozen list.",
  'pipeline/shopify-pipeline.ts: shopify/shopify-app-js':
    "The URL of Shopify's v12 migration guide in its SDK monorepo, which is also in a frozen list.",
};

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return jsonFiles(path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Test fixtures and helpers are test code.
      return entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === 'test'
        ? []
        : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Every `owner/repo` a path, URL or `owner__repo` directory name in the text could spell.
function candidates(text: string): string[] {
  return (text.match(/[\w./-]+/g) ?? []).flatMap((run) => {
    const parts = run.split('/');
    return [
      ...parts.slice(1).map((repo, index) => `${parts[index]}/${repo.replace(/\.+$/, '')}`),
      ...parts.filter((part) => part.includes('__')).map((part) => part.replace('__', '/')),
    ];
  });
}

function frozenEntries(): { repositories: Set<string>; commits: Set<string> } {
  const repositories = new Set<string>();
  const commits = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) value.forEach((item) => visit(item, key));
    else if (value && typeof value === 'object')
      for (const [name, item] of Object.entries(value)) visit(item, name);
    else if (typeof value !== 'string') return;
    else if ((key === 'repo' || key === 'repository') && /^[\w.-]+\/[\w.-]+$/.test(value))
      repositories.add(value.toLowerCase());
    else if (key === 'commit' && /^[0-9a-f]{40}$/i.test(value)) commits.add(value.toLowerCase());
  };
  for (const file of jsonFiles(LISTS)) visit(JSON.parse(readFileSync(file, 'utf8')));
  return { repositories, commits };
}

describe('no benchmark repository names in source', () => {
  const { repositories, commits } = frozenEntries();

  it('reads the frozen lists', () => {
    expect(repositories.size).toBeGreaterThan(1000);
    expect(commits.size).toBeGreaterThan(1000);
  });

  it('finds no owner/repo, owner__repo or pinned commit in non-test source', () => {
    const found: string[] = [];
    for (const file of SOURCES.flatMap((source) => sourceFiles(join(ROOT, source)))) {
      const name = relative(ROOT, file);
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const repository of candidates(text)) {
        if (repositories.has(repository) && !ALLOWED[`${name}: ${repository}`])
          found.push(`${name}: ${repository}`);
      }
      for (const sha of text.match(/\b[0-9a-f]{40}\b/g) ?? [])
        if (commits.has(sha)) found.push(`${name}: commit ${sha}`);
    }
    expect(found).toEqual([]);
  });

  it('catches a planted name, and every allow-list entry is still needed', () => {
    const planted = 'if (repository === "Ankit-Sharma1011/Quill") return;'.toLowerCase();
    expect(candidates(planted).some((name) => repositories.has(name))).toBe(true);
    expect(candidates('https://github.com/ankit-sharma1011/quill.')).toContain(
      'ankit-sharma1011/quill',
    );
    expect(candidates('repos/ankit-sharma1011__quill/run')).toContain('ankit-sharma1011/quill');
    for (const entry of Object.keys(ALLOWED)) {
      const [file, repository] = entry.split(': ');
      expect(repositories.has(repository)).toBe(true);
      expect(readFileSync(join(ROOT, file), 'utf8').toLowerCase()).toContain(repository);
    }
  });
});
