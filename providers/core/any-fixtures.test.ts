import { describe, expect, it } from 'vitest';
// Saved live reads of providers with no folder in providers/ (fixtures/any/<provider>/): the hints
// the codebase reader would give, the registry lookups, the pages the agent was shown, a recorded
// real run and hand-checked changes. Everything here runs offline at $0.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderChange, ProviderHints } from '../../shared/types.ts';
import { runAnyWatch, type AnyWatchReport } from './any-watcher.ts';
import { containsQuote, snapshotFetcher, type SnapshotManifest } from './fetch.ts';
import { BudgetLedger } from './model.ts';
import { savedRegistry, type PackageInfo } from './packages.ts';
import { listProviderIds } from './registry.ts';
import { replayRunModel, scriptedModel, type ExpectedFixture } from './testing.ts';
import { normaliseChanges } from './watcher.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'any');
const ids = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

type AnyLiveRun = {
  note: string;
  runAt: string;
  model: string;
  promptVersion: string;
  input: { provider: string; hints: ProviderHints; since?: string; capUsd: number };
  report: AnyWatchReport;
};

const read = <T>(dir: string, file: string) =>
  JSON.parse(readFileSync(join(ROOT, dir, file), 'utf8')) as T;

describe('saved any-provider reads', () => {
  it('cover Anthropic, Gemini and one smaller API, none of which has a provider folder', () => {
    expect(ids).toEqual(expect.arrayContaining(['anthropic', 'gemini']));
    expect(ids.length).toBeGreaterThanOrEqual(3);
    for (const id of ids) expect(listProviderIds()).not.toContain(id);
  });
});

describe.each(ids)('%s', (id) => {
  const record = read<AnyLiveRun>(id, 'live-run.json');
  const hints = read<{ provider: string; hints: ProviderHints }>(id, 'hints.json');
  const packages = read<PackageInfo[]>(id, 'packages.json');
  const expected = read<ExpectedFixture>(id, 'expected.json');
  const pagesDir = join(ROOT, id, 'pages');
  const manifest = JSON.parse(
    readFileSync(join(pagesDir, 'manifest.json'), 'utf8'),
  ) as SnapshotManifest;
  const pages = new Map(
    manifest.sources.map((source) => [
      source.url,
      readFileSync(join(pagesDir, source.file), 'utf8'),
    ]),
  );
  const replay = (model: ReturnType<typeof scriptedModel>) =>
    runAnyWatch(hints.provider, hints.hints, record.input.since, {
      model,
      fetcher: snapshotFetcher(pagesDir),
      registry: savedRegistry(packages),
      budget: new BudgetLedger(1),
      today: record.runAt.slice(0, 10),
    });

  it('turns the saved pages into quoted ProviderChange[] for a provider with no folder', async () => {
    // Read every page the hand-checked changes cite, then submit them.
    const cited = [...new Set(expected.changes.map((change) => change.source.url))];
    const model = scriptedModel([
      cited.map((url, i) => ({
        type: 'tool_use' as const,
        id: `read-${i}`,
        name: 'read_page',
        input: { url },
      })),
      [
        {
          type: 'tool_use',
          id: 'submit',
          name: 'submit_changes',
          input: { changes: expected.changes },
        },
      ],
      [{ type: 'text', text: 'Submitted.' }],
    ]);
    const report = await replay(model);
    expect(report.folder).toBeUndefined();
    expect(report.issues).toEqual([]);
    expect(report.unverifiedQuotes).toEqual([]);
    expect(report.changes).toHaveLength(expected.changes.length);
    for (const change of report.changes) {
      expect(change.provider).toBe(id);
      expect(change.id.startsWith(`${id}:`)).toBe(true);
      expect(change.source.quote.length).toBeGreaterThan(10);
    }
    // SDK majors carry the versions they break, for the match agent to compare with a repo's pin.
    for (const change of report.changes.filter((c) => c.kind === 'sdk-major')) {
      expect(change.affects.sdk).toBeTruthy();
      expect(change.affects.versions?.length).toBeGreaterThan(0);
    }
    expect(report.changes.some((change) => change.kind === 'sdk-major')).toBe(true);
    // The prompt showed the registries' major lines and release notes.
    const prompt = JSON.stringify(model.requests[0].messages[0]);
    for (const info of packages.filter((p) => p.majors.length > 1))
      expect(prompt).toContain(`${info.ecosystem === 'npm' ? 'npm' : 'PyPI'} package ${info.name}`);
  });

  it('keeps its recorded live run checkable offline', () => {
    const { report } = record;
    expect(report.provider).toBe(id);
    expect(record.model).toBeTruthy();
    expect(record.promptVersion).toMatch(/^any-watch-v\d+$/);
    expect(record.input.capUsd).toBeGreaterThan(0);
    expect(report.costUsd).toBeLessThanOrEqual(record.input.capUsd);
    expect(report.changes.length).toBeGreaterThan(0);

    // Re-normalising the recorded changes gives back the same changes.
    const again = normaliseChanges(
      id,
      report.changes.map((change) => ({ ...change, id: change.id.slice(id.length + 1) })),
    );
    expect(again.changes).toEqual(report.changes);

    // Every quote is on the page it cites, in what the agent was shown, unless the run flagged it.
    for (const change of report.changes) {
      if (report.unverifiedQuotes.includes(change.id)) continue;
      const text = pages.get(change.source.url);
      expect(text, `${change.id}: ${change.source.url} is not in pages/`).toBeDefined();
      expect(containsQuote(text!, change.source.quote), change.id).toBe(true);
    }
  });

  it('replays the recorded run: the same reads on the saved pages verify every quote', async () => {
    const changes: Omit<ProviderChange, 'provider'>[] = record.report.changes;
    const report = await replay(replayRunModel(record.report.log, changes));
    expect(report.issues).toEqual([]);
    expect(report.unverifiedQuotes).toEqual([]);
    expect(report.changes).toEqual(record.report.changes);
  });
});
