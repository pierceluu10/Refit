import { describe, expect, it } from 'vitest';
// One saved live read per source group (fixtures/dependency/<group>/): the dependency, the registry
// lookups, the pages the agent was shown, a recorded real run and hand-checked changes. Offline, $0.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DependencyUsage, ExternalChange, ProviderChange } from '../../shared/types.ts';
import { runDependencyWatch, type DependencyWatchReport } from './dependency-watcher.ts';
import { containsQuote, snapshotFetcher, type SnapshotManifest } from './fetch.ts';
import { BudgetLedger } from './model.ts';
import { savedRegistry, type PackageInfo } from './packages.ts';
import { replayRunModel } from './testing.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dependency');
const groups = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

type LiveRun = {
  runAt: string;
  promptVersion: string;
  input: { since?: string; capUsd: number };
  report: DependencyWatchReport;
};

const read = <T>(group: string, file: string) =>
  JSON.parse(readFileSync(join(ROOT, group, file), 'utf8')) as T;

const asSubmitted = (changes: ExternalChange[]) =>
  changes as unknown as Omit<ProviderChange, 'provider'>[];

it('saves a live read for every source group', () => {
  expect(groups).toEqual(['advisories', 'ci', 'eol', 'models', 'packages']);
});

describe.each(groups)('%s', (group) => {
  const record = read<LiveRun>(group, 'live-run.json');
  const dependency = read<DependencyUsage>(group, 'dependency.json');
  const packages = read<PackageInfo[]>(group, 'packages.json');
  const expected = read<{ note: string; changes: ExternalChange[] }>(group, 'expected.json');
  const pagesDir = join(ROOT, group, 'pages');
  const manifest = read<SnapshotManifest>(group, join('pages', 'manifest.json'));
  const pages = new Map(
    manifest.sources.map((source) => [
      source.url,
      readFileSync(join(pagesDir, source.file), 'utf8'),
    ]),
  );
  const replay = (changes: ExternalChange[]) => {
    const fetcher = snapshotFetcher(pagesDir);
    return runDependencyWatch(dependency, record.input.since, {
      model: replayRunModel(record.report.log, asSubmitted(changes)),
      fetcher,
      registry: savedRegistry(packages),
      budget: new BudgetLedger(100),
      today: record.runAt.slice(0, 10),
      webSearch: false,
      advisories: () =>
        Promise.all(
          manifest.sources
            .filter((source) => source.url.startsWith('https://api.osv.dev/v1/query'))
            .map((source) => fetcher.fetch(source.url)),
        ),
    });
  };

  it('turns the saved pages into complete, quoted ExternalChange[]', async () => {
    const report = await replay(expected.changes);
    expect(report.issues).toEqual([]);
    expect(report.unverifiedQuotes).toEqual([]);
    expect(report.changes).toHaveLength(expected.changes.length);
    expect(report.changes.length).toBeGreaterThan(0);
    for (const change of report.changes) {
      expect(change.dependency).toBe(dependency.name);
      expect(change.dependencyKind).toBe(dependency.kind);
      expect(change.severity).toBeTruthy();
      expect(change.fromVersions?.length).toBeGreaterThan(0);
      expect(change.source.quote.length).toBeGreaterThan(10);
      expect(change.source.url).toMatch(/^https:\/\//);
    }
  });

  it('keeps its recorded live run checkable offline', () => {
    const { report } = record;
    expect(record.promptVersion).toMatch(/^dependency-watch-v\d+$/);
    expect(report.costUsd).toBeLessThanOrEqual(record.input.capUsd);
    for (const change of report.changes) {
      if (report.unverifiedQuotes.includes(change.id)) continue;
      const { url, quote } = change.source;
      const text =
        pages.get(url) ??
        [...pages.values()].find((page) => page.includes(url) && containsQuote(page, quote));
      expect(text, `${change.id}: ${url} is not in pages/ or named by one`).toBeDefined();
      expect(containsQuote(text!, quote), change.id).toBe(true);
    }
  });
});
