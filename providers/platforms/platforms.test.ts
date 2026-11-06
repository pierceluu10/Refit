import { describe, expect, it, vi } from 'vitest';
// The platform watcher, offline at $0: fixtures/sources holds every starting page, and fixtures/live
// holds one recorded real read per source group, with hand-checked changes.

import { mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DependencyUsage,
  ExternalChange,
  ProviderChange,
  WatchPlatforms,
} from '../../shared/types.ts';
import type { TurnLog } from '../core/agent.ts';
import {
  containsQuote,
  snapshotFetcher,
  type FetchedPage,
  type Fetcher,
  type SnapshotManifest,
} from '../core/fetch.ts';
import { BudgetLedger, type ContentBlock } from '../core/model.ts';
import { replayRunModel, scriptedModel } from '../core/testing.ts';
import { WatchFailedError } from '../core/watcher.ts';
import { PLATFORM_SOURCES, SOURCE_GROUPS, runPlatformWatch, watchPlatforms } from './index.ts';
import { PLATFORM_WATCH_PROMPT_VERSION } from './prompt.ts';
import {
  dayCachingFetcher,
  normalisePlatformChanges,
  type PlatformWatchReport,
} from './watcher.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJson = <T>(...path: string[]) =>
  JSON.parse(readFileSync(join(ROOT, ...path), 'utf8')) as T;

const dep = (over: Partial<DependencyUsage> = {}): DependencyUsage => ({
  repo: 'example/repo',
  kind: 'infrastructure',
  name: 'aws-lambda',
  version: 'nodejs16.x',
  declaredIn: [{ file: 'serverless.yml', line: 3, text: 'runtime: nodejs16.x' }],
  ...over,
});

const PAGE_URL = 'https://docs.test/runtimes';
const QUOTE = 'nodejs16.x was deprecated on 2024-06-12.';
const onePage: Fetcher = {
  async fetch(url) {
    return {
      url,
      status: 200,
      ok: true,
      fetchedAt: 'now',
      contentType: 'text/plain',
      text: `Runtimes. ${QUOTE} Use nodejs22.x.`,
    };
  },
};
const change = (over: Record<string, unknown> = {}) => ({
  id: 'lambda-nodejs16',
  kind: 'serverless-runtime',
  title: 'Lambda retired nodejs16.x',
  effectiveDate: '2024-06-12',
  source: { url: PAGE_URL, quote: QUOTE },
  affects: {},
  fromVersions: ['nodejs16.x'],
  toVersion: 'nodejs22.x',
  severity: 'deadline',
  ...over,
});
const toolUse = (name: string, input: unknown, id = name): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const reads = (...steps: ContentBlock[][]) =>
  scriptedModel([
    [toolUse('read_page', { url: PAGE_URL })],
    ...steps,
    [{ type: 'text', text: 'Submitted.' }],
  ]);
const offline = { fetcher: onePage, webSearch: false as const };

describe('watchPlatforms', () => {
  it('has the entry-point type F1 and O1 code against', () => {
    const typed: WatchPlatforms = watchPlatforms;
    expect(typed).toBe(watchPlatforms);
  });

  it('writes every field a change must carry', async () => {
    const budget = new BudgetLedger(5);
    const [written] = await watchPlatforms(dep(), '2026-01-01', {
      ...offline,
      budget,
      model: reads([toolUse('submit_changes', { changes: [change()] })]),
      onReport: () => {},
    });
    expect(written).toEqual({
      provider: 'aws-lambda',
      id: 'aws-lambda:lambda-nodejs16',
      kind: 'serverless-runtime',
      title: 'Lambda retired nodejs16.x',
      effectiveDate: '2024-06-12',
      source: { url: PAGE_URL, quote: QUOTE },
      affects: {},
      dependencyKind: 'infrastructure',
      dependency: 'aws-lambda',
      fromVersions: ['nodejs16.x'],
      toVersion: 'nodejs22.x',
      severity: 'deadline',
    } satisfies ExternalChange);
  });

  it("draws on the run's ledger, and says how much is left", async () => {
    const budget = new BudgetLedger(5);
    budget.charge('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 });
    const model = reads([toolUse('submit_changes', { changes: [] })]);
    await watchPlatforms(dep(), undefined, { ...offline, budget, model, onReport: () => {} });
    expect(budget.entries.length).toBeGreaterThan(1);
    expect(budget.entries.at(-1)?.label).toBe('watch-platform:aws-lambda');
    expect(JSON.stringify(model.requests[0].messages)).toContain('about $3.00 of AI left');
  });

  it('throws when the budget stops the run, so "no changes" is never silent', async () => {
    const model = scriptedModel([]);
    await expect(
      watchPlatforms(dep(), undefined, {
        ...offline,
        budget: new BudgetLedger(0),
        model,
        onReport: () => {},
      }),
    ).rejects.toBeInstanceOf(WatchFailedError);
    expect(model.requests).toEqual([]);
  });

  it('hands bad quotes, kinds and severities back to the agent, then accepts the fix', async () => {
    const model = reads(
      [
        toolUse('submit_changes', {
          changes: [
            change({
              kind: 'nonsense',
              severity: 'huge',
              source: { url: PAGE_URL, quote: 'words on no page' },
            }),
          ],
        }),
      ],
      [toolUse('submit_changes', { changes: [change()] })],
    );
    const report = await runPlatformWatch(dep(), undefined, {
      ...offline,
      budget: new BudgetLedger(5),
      model,
    });
    const feedback = JSON.stringify(model.requests[2].messages);
    expect(feedback).toContain('kind \\"nonsense\\"');
    expect(feedback).toContain('severity \\"huge\\"');
    expect(feedback).toContain('quote not found');
    expect(report.issues).toEqual([]);
    expect(report.unverifiedQuotes).toEqual([]);
    expect(report.changes[0].kind).toBe('serverless-runtime');
  });

  it('never drops a change the agent will not fix', () => {
    const { changes, issues } = normalisePlatformChanges(dep(), 'aws-lambda', [
      { title: 'A vague one', kind: 'nonsense' },
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('other');
    expect(issues.map((issue) => issue.message).join()).toMatch(/missing fromVersions/);
  });

  it('keeps repo lines out of the prompt, and names the files', async () => {
    const model = reads([toolUse('submit_changes', { changes: [] })]);
    await runPlatformWatch(dep(), undefined, { ...offline, budget: new BudgetLedger(5), model });
    const prompt = JSON.stringify(model.requests[0].messages);
    expect(prompt).toContain('serverless.yml');
    expect(prompt).not.toContain('runtime: nodejs16.x');
  });

  it('records a starting page it could not read, and a guessed 404 it can ignore', async () => {
    const fetcher: Fetcher = {
      async fetch(url) {
        const failed = url.includes('lambda') || url.includes('guess');
        return {
          url,
          status: url.includes('lambda') ? 503 : failed ? 404 : 200,
          ok: !failed,
          fetchedAt: 'now',
          contentType: 'text/plain',
          text: failed ? '' : `Page. ${QUOTE}`,
          ...(failed ? { error: `HTTP ${url.includes('lambda') ? 503 : 404}` } : {}),
        };
      },
    };
    const reports: PlatformWatchReport[] = [];
    const changes = await watchPlatforms(dep(), undefined, {
      fetcher,
      webSearch: false,
      budget: new BudgetLedger(5),
      model: scriptedModel([
        [
          toolUse('read_page', { source_id: 'lambda-runtimes' }, 'a'),
          toolUse('read_page', { url: 'https://docs.test/guess' }, 'b'),
          toolUse('read_page', { url: PAGE_URL }, 'c'),
        ],
        [toolUse('submit_changes', { changes: [change()] })],
        [{ type: 'text', text: 'Submitted.' }],
      ]),
      onReport: (report) => reports.push(report),
    });
    expect(changes).toHaveLength(1);
    expect(reports[0].errors).toEqual([
      `${PLATFORM_SOURCES.find((source) => source.id === 'lambda-runtimes')!.url}: HTTP 503`,
    ]);
  });

  it('warns about unread sources when no one asked for the report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const down: Fetcher = {
      async fetch(url) {
        return {
          url,
          status: 500,
          ok: false,
          fetchedAt: '',
          contentType: '',
          text: '',
          error: 'x',
        };
      },
    };
    await expect(
      watchPlatforms(dep(), undefined, {
        fetcher: down,
        webSearch: false,
        budget: new BudgetLedger(5),
        model: reads([toolUse('submit_changes', { changes: [] })]),
      }),
    ).rejects.toThrow(/no page could be read/);
    expect(warn).toHaveBeenCalledWith(`watchPlatforms: ${PAGE_URL}: x`);
    warn.mockRestore();
  });

  it('goes on without web search when the account cannot use it', async () => {
    let calls = 0;
    const model = {
      model: 'fake-model',
      async complete() {
        calls++;
        if (calls === 1) throw new Error('400 web_search is not enabled');
        return {
          content:
            calls === 2
              ? [toolUse('submit_changes', { changes: [] })]
              : [{ type: 'text', text: 'Done.' }],
          stopReason: calls === 2 ? 'tool_use' : 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    const report = await runPlatformWatch(dep(), undefined, {
      fetcher: onePage,
      budget: new BudgetLedger(5),
      model,
    });
    expect(calls).toBeGreaterThan(1);
    expect(report.issues[0].message).toMatch(/web search failed/);
  });
});

describe('the day cache', () => {
  const counting = () => {
    const inner = {
      calls: 0,
      async fetch(url: string): Promise<FetchedPage> {
        inner.calls++;
        const failed = inner.calls === 1 && url.endsWith('fail');
        return {
          url,
          status: failed ? 500 : 200,
          ok: !failed,
          fetchedAt: 'now',
          contentType: 'text/plain',
          text: `read ${inner.calls}`,
        };
      },
    };
    return inner;
  };
  const cacheDir = () => mkdtempSync(join(tmpdir(), 'refit-platform-cache-'));

  it('reads a page once a day, again after a day, and keeps no failures', async () => {
    const dir = cacheDir();
    const inner = counting();
    const cached = dayCachingFetcher(inner, { dir });
    expect((await cached.fetch('https://a.test/x')).text).toBe('read 1');
    expect((await cached.fetch('https://a.test/x')).text).toBe('read 1');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const file of readdirSync(dir)) utimesSync(join(dir, file), old, old);
    expect((await cached.fetch('https://a.test/x')).text).toBe('read 2');

    const failing = counting();
    const again = dayCachingFetcher(failing, { dir });
    await again.fetch('https://a.test/fail');
    expect((await again.fetch('https://a.test/fail')).ok).toBe(true);
  });

  it('goes on fetching when the cache cannot be written', async () => {
    const cached = dayCachingFetcher(counting(), { dir: '/dev/null/nowhere' });
    expect((await cached.fetch('https://a.test/x')).ok).toBe(true);
  });
});

describe('saved source pages', () => {
  const sourcesDir = join(ROOT, 'sources');
  const manifest = readJson<SnapshotManifest>('sources', 'manifest.json');
  const quotes: Record<string, string | null> = Object.assign(
    {},
    ...SOURCE_GROUPS.map((group) => readJson('quotes', `${group}.json`)),
  );

  it.each(PLATFORM_SOURCES.map((source) => source.id))('%s was saved and holds it', (id) => {
    const saved = manifest.sources.find((entry) => entry.id === id);
    expect(saved?.ok, id).toBe(true);
    const quote = quotes[id];
    expect(quote, `${id} has no hand-picked quote`).toBeTruthy();
    expect(containsQuote(readFileSync(join(sourcesDir, saved!.file), 'utf8'), quote!), id).toBe(
      true,
    );
  });

  it('every source has a unique id, and every group has sources', () => {
    expect(new Set(PLATFORM_SOURCES.map((source) => source.id)).size).toBe(PLATFORM_SOURCES.length);
    for (const group of SOURCE_GROUPS)
      expect(PLATFORM_SOURCES.some((source) => source.group === group)).toBe(true);
  });

  it('reads every saved page through the agent loop and checks a quote from each', async () => {
    const report = await runPlatformWatch(dep(), undefined, {
      fetcher: snapshotFetcher(sourcesDir),
      webSearch: false,
      budget: new BudgetLedger(5),
      maxTurns: 5,
      model: scriptedModel([
        PLATFORM_SOURCES.map((source) => toolUse('read_page', { source_id: source.id }, source.id)),
        [
          toolUse('submit_changes', {
            changes: PLATFORM_SOURCES.map((source) =>
              change({
                id: source.id,
                source: { url: source.url, quote: quotes[source.id] },
              }),
            ),
          }),
        ],
        [{ type: 'text', text: 'Submitted.' }],
      ]),
    });
    expect(report.issues).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.changes).toHaveLength(PLATFORM_SOURCES.length);
  });
});

type LiveRun = {
  note: string;
  model: string;
  promptVersion: string;
  input: { dependency: DependencyUsage; capUsd: number };
  report: PlatformWatchReport & { log: TurnLog[] };
};

describe.each(SOURCE_GROUPS)('recorded live read: %s', (group) => {
  const record = readJson<LiveRun>('live', group, 'live-run.json');
  const expected = readJson<{ note: string; changes: ExternalChange[] }>(
    'live',
    group,
    'expected.json',
  );
  const pagesDir = join(ROOT, 'live', group, 'pages');

  it('stayed under its cap, on this prompt, with nothing hidden', () => {
    const { report } = record;
    expect(record.promptVersion).toBe(PLATFORM_WATCH_PROMPT_VERSION);
    expect(report.costUsd).toBeGreaterThan(0);
    expect(report.costUsd).toBeLessThanOrEqual(record.input.capUsd);
    expect(report.failed).toBe(false);
    expect(report.unverifiedQuotes).toEqual([]);
    expect(expected.note).toMatch(/Example fixture/);
  });

  it('replays on the saved pages: every hand-checked change passes every check', async () => {
    const report = await runPlatformWatch(record.input.dependency, undefined, {
      fetcher: snapshotFetcher(pagesDir),
      webSearch: false,
      budget: new BudgetLedger(5),
      model: replayRunModel(
        record.report.log,
        expected.changes as unknown as Omit<ProviderChange, 'provider'>[],
      ),
    });
    expect(report.issues).toEqual([]);
    expect(report.unverifiedQuotes).toEqual([]);
    expect(report.changes).toEqual(expected.changes);
  });

  it('every hand-checked change carries what the plan asks for', () => {
    expect(expected.changes.length).toBeGreaterThan(0);
    for (const entry of expected.changes) {
      expect(entry.dependency, entry.id).toBe(record.input.dependency.name);
      expect(entry.dependencyKind, entry.id).toBe(record.input.dependency.kind);
      expect(entry.severity, entry.id).toBeTruthy();
      expect(entry.fromVersions?.length, entry.id).toBeGreaterThan(0);
      expect(entry.source.url, entry.id).toMatch(/^https:/);
      expect(entry.source.quote, entry.id).toBeTruthy();
    }
  });
});

describe('recorded spend', () => {
  it('is within the $3 cap across every saved read', () => {
    const total = SOURCE_GROUPS.reduce(
      (sum, group) => sum + readJson<LiveRun>('live', group, 'live-run.json').report.costUsd,
      0,
    );
    expect(total).toBeLessThanOrEqual(3);
  });
});
