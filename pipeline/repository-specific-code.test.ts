import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TEST_PATH } from './source-paths.ts';

// Owner decision D5 (Pierce, 2026-10-27): no repository-specific code anywhere. Shipped source
// never names a repository a benchmark subset measures; tests and fixtures may, to say where a
// case came from.

const root = join(import.meta.dirname, '..');
const SUBSETS = join(root, 'docs/benchmarks/subsets');
const SHIPPED = ['src', 'pipeline', 'bin', 'scripts'];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

function benchmarkRepositories() {
  const slugs = new Set<string>();
  for (const name of readdirSync(SUBSETS).filter((file) => file.endsWith('.json'))) {
    const subset = JSON.parse(readFileSync(join(SUBSETS, name), 'utf8')) as unknown;
    const entries = Array.isArray(subset)
      ? subset
      : ((subset as { repos?: unknown[]; repositories?: unknown[] }).repos ??
        (subset as { repositories?: unknown[] }).repositories ??
        []);
    for (const entry of entries) {
      const slug = typeof entry === 'string' ? entry : (entry as { repo?: unknown }).repo;
      if (typeof slug === 'string' && slug.includes('/')) slugs.add(slug);
    }
  }
  return slugs;
}

function shippedFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory())
      return ['node_modules', 'fixtures', 'test'].includes(entry.name) ? [] : shippedFiles(path);
    return SOURCE.test(entry.name) && !TEST_PATH.test(path) ? [path] : [];
  });
}

it('names no benchmark repository in shipped source', () => {
  const slugs = benchmarkRepositories();
  expect(slugs.size).toBeGreaterThan(100);
  const named = SHIPPED.flatMap(shippedFiles).flatMap((path) => {
    const content = readFileSync(join(root, path), 'utf8');
    return [...slugs].filter((slug) => content.includes(slug)).map((slug) => `${path}: ${slug}`);
  });
  expect(named).toEqual([]);
});
