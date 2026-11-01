import { describe, expect, it } from 'vitest';
// One suite for every provider folder, so a new provider (folder + prompt +
// knowledge + fixtures) is tested with no new code.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeProblems } from './knowledge.ts';
import { BudgetLedger } from './model.ts';
import { containsQuote, snapshotFetcher } from './fetch.ts';
import { listProviderIds, loadProvider } from './registry.ts';
import { fixtureDir, loadExpected, replayModel } from './testing.ts';
import { normaliseChanges, runWatch } from './watcher.ts';
import type { LiveRunRecord } from './types.ts';
import type { SnapshotManifest } from './fetch.ts';

const ids = listProviderIds();

describe('provider folders', () => {
  it('has the five required providers plus at least one added with no new code', () => {
    expect(ids).toEqual(expect.arrayContaining(['stripe', 'shopify', 'meta', 'openai', 'twilio']));
    expect(ids.length).toBeGreaterThanOrEqual(6);
  });
});

describe.each(ids)('%s', (id) => {
  const provider = loadProvider(id);

  it('has a spec, a prompt and sources', () => {
    expect(provider.name).toBeTruthy();
    expect(provider.prompt.trim().length).toBeGreaterThan(40);
    expect(provider.sources.length).toBeGreaterThan(0);
    const sourceIds = provider.sources.map((source) => source.id);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    for (const source of provider.sources) {
      expect(source.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(source.url).toMatch(/^https:\/\//);
    }
  });

  it('has a knowledge.json where every entry is sourced and dated', () => {
    expect(provider.knowledge, 'knowledge.json is missing').toBeDefined();
    expect(knowledgeProblems(provider.knowledge)).toEqual([]);
    expect(provider.knowledge!.provider).toBe(id);
  });

  it('quotes knowledge.json word for word wherever the page is in the snapshot', () => {
    const dir = fixtureDir(provider);
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    ) as SnapshotManifest;
    const pages = new Map(
      manifest.sources.map((source) => [source.url, readFileSync(join(dir, source.file), 'utf8')]),
    );
    const k = provider.knowledge!;
    for (const entry of [k.versioning, ...k.versions, ...k.retirements, ...k.docs, ...k.sdks]) {
      const text = pages.get(entry.source.url);
      if (!entry.source.quote || text === undefined) continue;
      expect(containsQuote(text, entry.source.quote), entry.source.quote).toBe(true);
    }
  });

  it('has a saved live read of its sources', () => {
    const dir = fixtureDir(provider);
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    ) as SnapshotManifest;
    expect(manifest.provider).toBe(id);
    expect(manifest.sources.some((source) => source.ok && source.chars > 500)).toBe(true);
  });

  it('turns the saved snapshot into ProviderChange[] with verified quotes', async () => {
    const expected = loadExpected(provider);
    expect(expected, 'fixtures/expected.json is missing').toBeDefined();
    const model = replayModel(provider, expected!);
    const report = await runWatch(provider, undefined, {
      model,
      fetcher: snapshotFetcher(fixtureDir(provider)),
      budget: new BudgetLedger(1),
      today: '2026-11-01',
    });

    // The agent got the provider's own guidance and the whole page, unfiltered.
    expect(model.requests[0].system).toContain(provider.prompt.trim().slice(0, 60));
    const firstRead = model.requests[1].messages
      .at(-1)!
      .content.find((block) => block.type === 'tool_result');
    expect(JSON.stringify(firstRead)).toContain('Characters 0-');

    expect(report.issues).toEqual([]);
    expect(report.unverifiedQuotes).toEqual([]);
    expect(report.changes.length).toBe(expected!.changes.length);
    for (const change of report.changes) {
      expect(change.provider).toBe(id);
      expect(change.id.startsWith(`${id}:`)).toBe(true);
      expect(change.source.quote.length).toBeGreaterThan(10);
      expect(change.title).toBeTruthy();
    }
  });

  const liveRunPath = join(provider.dir, 'fixtures', 'live-run.json');
  it.runIf(existsSync(liveRunPath))('keeps its recorded live run checkable offline', () => {
    const record = JSON.parse(readFileSync(liveRunPath, 'utf8')) as LiveRunRecord;
    const { report } = record;
    expect(report.provider).toBe(id);
    expect(record.model).toBeTruthy();

    // Re-normalising the recorded changes gives back the same changes.
    const again = normaliseChanges(
      id,
      report.changes.map((change) => ({ ...change, id: change.id.slice(id.length + 1) })),
    );
    expect(again.changes).toEqual(report.changes);

    // Quotes taken from snapshot pages are still in the snapshot, unless the run flagged them.
    const dir = join(provider.dir, record.input.snapshot);
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    ) as SnapshotManifest;
    const pages = new Map(
      manifest.sources.map((source) => [source.url, readFileSync(join(dir, source.file), 'utf8')]),
    );
    for (const change of report.changes) {
      const text = pages.get(change.source.url);
      if (text === undefined || report.unverifiedQuotes.includes(change.id)) continue;
      expect(containsQuote(text, change.source.quote), change.id).toBe(true);
    }
  });
});
