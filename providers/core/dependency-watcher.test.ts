import { mkdtempSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DependencyUsage, ExternalChange } from '../../shared/types.ts';
import { watchDependency as exported } from '../index.ts';
import {
  eolProduct,
  exactVersion,
  readOsv,
  renderOsv,
  sourcesFor,
  GROUPS_BY_KIND,
} from './dependency-sources.ts';
import { normaliseExternal, runDependencyWatch, watchDependency } from './dependency-watcher.ts';
import {
  cachingFetcher,
  cachingJsonFetcher,
  httpJsonFetcher,
  type Fetcher,
  type JsonFetcher,
} from './fetch.ts';
import { BudgetLedger } from './model.ts';
import { scriptedModel } from './testing.ts';
import { WatchFailedError } from './watcher.ts';

const dep = (over: Partial<DependencyUsage>): DependencyUsage => ({
  repo: 'refit-dev/demo',
  kind: 'runtime',
  name: 'node',
  declaredIn: [{ file: '.nvmrc', line: 1, text: 'SECRET-LOOKING-LINE' }],
  ...over,
});

const PAGE = 'Node 18 reaches end of life on 2025-04-30.';
const fetcher: Fetcher = {
  async fetch(url) {
    return {
      url,
      status: 200,
      ok: true,
      fetchedAt: '2026-11-06T00:00:00.000Z',
      contentType: 'text/plain',
      text: PAGE,
    };
  },
};

const submit = (changes: unknown[]) => [
  [{ type: 'tool_use' as const, id: 'r', name: 'read_page', input: { source_id: 'eol-nodejs' } }],
  [{ type: 'tool_use' as const, id: 's', name: 'submit_changes', input: { changes } }],
  [{ type: 'text' as const, text: 'Done.' }],
];

const offline = {
  fetcher,
  budget: new BudgetLedger(100),
  webSearch: false as const,
  registry: { lookup: async (name: string) => ({ name, found: [], errors: [] }) },
};

const nodeEol = {
  id: 'node-18-end-of-life',
  kind: 'runtime-eol',
  title: 'Node 18 is past end of life.',
  effectiveDate: '2025-04-30',
  source: { url: 'https://endoflife.date/api/nodejs.json', quote: PAGE },
  affects: {},
  fromVersions: ['18'],
  toVersion: '24',
  severity: 'deadline',
};

describe('watchDependency', () => {
  it('is exported from providers/index.ts', () => {
    expect(exported).toBe(watchDependency);
  });

  it('writes an ExternalChange with every field the match agent needs', async () => {
    const model = scriptedModel(submit([nodeEol]));
    const changes = await watchDependency(dep({ version: '18' }), undefined, {
      ...offline,
      model,
      onReport: () => {},
    });
    expect(changes).toEqual([
      {
        provider: 'node',
        id: 'node:18-end-of-life',
        kind: 'runtime-eol',
        title: 'Node 18 is past end of life.',
        effectiveDate: '2025-04-30',
        source: nodeEol.source,
        affects: {},
        dependencyKind: 'runtime',
        dependency: 'node',
        fromVersions: ['18'],
        toVersion: '24',
        severity: 'deadline',
      } satisfies ExternalChange,
    ]);
  });

  it('tells the agent the version and files, never the repo lines themselves', async () => {
    const model = scriptedModel(submit([nodeEol]));
    await watchDependency(dep({ version: '18' }), undefined, {
      ...offline,
      model,
      onReport: () => {},
    });
    const prompt = JSON.stringify(model.requests[0]);
    expect(prompt).toContain("this repository's version: 18");
    expect(prompt).toContain('.nvmrc');
    expect(prompt).not.toContain('SECRET-LOOKING-LINE');
    expect(model.requests[0].system).toContain('End of life and support dates');
    expect(model.requests[0].system).not.toContain('AI model retirements');
  });

  it('keeps the API path: a provider folder as head start and the tuned brief', async () => {
    const model = scriptedModel([
      [
        {
          type: 'tool_use',
          id: 'r',
          name: 'read_page',
          input: { url: 'https://docs.stripe.com/changelog' },
        },
      ],
      ...submit([
        { ...nodeEol, id: 'basil', kind: 'api-version', source: { ...nodeEol.source } },
      ]).slice(1),
    ]);
    const report = await runDependencyWatch(dep({ kind: 'api', name: 'stripe' }), undefined, {
      ...offline,
      model,
    });
    expect(report.folder).toBe('stripe');
    expect(model.requests[0].system).toContain('API change watcher for Stripe');
    expect(model.requests[0].system).toContain('severity:');
    expect(report.changes[0]).toMatchObject({
      provider: 'stripe',
      id: 'stripe:basil',
      kind: 'api-version',
      dependency: 'stripe',
      dependencyKind: 'api',
    });
  });

  it('gives each kind its own source groups', () => {
    const urls = (kind: DependencyUsage['kind'], name: string, ecosystem?: string) =>
      sourcesFor(dep({ kind, name, ecosystem }), GROUPS_BY_KIND[kind] ?? []).map((s) => s.url);
    expect(urls('runtime', 'node')).toContain('https://endoflife.date/api/nodejs.json');
    expect(urls('container-image', 'python:3.9-slim')).toContain(
      'https://endoflife.date/api/python.json',
    );
    expect(urls('framework', 'next', 'npm')).toContain('https://nextjs.org/support-policy');
    expect(urls('library', 'flask', 'pypi')[0]).toContain('ecosystem=pip&affects=flask');
    expect(urls('ai-model', 'gpt-4o', 'openai').join()).toContain('platform.claude.com');
    expect(urls('ci', 'actions/checkout@v3', 'github-actions')[0]).toBe(
      'https://api.github.com/repos/actions/checkout/releases?per_page=100',
    );
    expect(urls('ci', 'ubuntu-20.04').join()).toContain('runner-images');
  });

  it('hands a platform dependency to the platform watcher, sharing the run budget', async () => {
    const budget = new BudgetLedger(5);
    const platforms = vi.fn(async () => [] as ExternalChange[]);
    await watchDependency(dep({ kind: 'infrastructure', name: 'kubernetes' }), '2026-01-01', {
      budget,
      platforms,
      onReport: () => {},
    });
    expect(platforms).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'kubernetes' }),
      '2026-01-01',
      expect.objectContaining({ budget, onReport: expect.any(Function) }),
    );
  });

  it('records that platforms were not read while the platform module is missing', async () => {
    const report = await runDependencyWatch(dep({ kind: 'platform', name: 'ios' }), undefined, {
      budget: new BudgetLedger(0),
      platforms: null,
    });
    expect(report.changes).toEqual([]);
    expect(report.failed).toBe(false);
    expect(report.errors[0]).toMatch(/platforms not read for ios/);
  });

  it("keeps the platform watcher's unread sources in the report", async () => {
    const platformReport = {
      provider: 'ios',
      errors: ['https://developer.apple.com/news/: HTTP 503'],
      sourcesRead: ['https://developer.android.com/'],
      turns: 3,
    };
    const platforms = async (
      _dep: DependencyUsage,
      _since?: string,
      options?: { onReport?: (report: typeof platformReport) => void },
    ) => {
      options?.onReport?.(platformReport);
      return [] as ExternalChange[];
    };
    const report = await runDependencyWatch(dep({ kind: 'platform', name: 'ios' }), undefined, {
      budget: new BudgetLedger(5),
      platforms,
    });
    expect(report.errors).toEqual(platformReport.errors);
    expect(report.sourcesRead).toEqual(platformReport.sourcesRead);
    expect(report.turns).toBe(3);
    expect(report.failed).toBe(false);
  });

  it('keeps those sources when the platform watcher reports and then throws', async () => {
    const report = await runDependencyWatch(dep({ kind: 'platform', name: 'ios' }), undefined, {
      budget: new BudgetLedger(5),
      platforms: async (
        _dep: DependencyUsage,
        _since?: string,
        options?: { onReport?: (report: { errors: string[] }) => void },
      ) => {
        options?.onReport?.({ errors: ['https://developer.apple.com/news/: HTTP 503'] });
        throw new Error('never got to an answer');
      },
    });
    expect(report.failed).toBe(true);
    expect(report.errors).toEqual([
      'https://developer.apple.com/news/: HTTP 503',
      'platforms not read for ios: never got to an answer',
    ]);
  });

  it('says so when the platform watcher fails, and throws rather than return nothing', async () => {
    const deps = {
      budget: new BudgetLedger(5),
      platforms: async () => {
        throw new Error('down');
      },
      onReport: () => {},
    };
    await expect(
      watchDependency(dep({ kind: 'platform', name: 'ios' }), undefined, deps),
    ).rejects.toBeInstanceOf(WatchFailedError);
  });

  it('points regulated surfaces at the rules agent without spending', async () => {
    const budget = new BudgetLedger(0);
    const report = await runDependencyWatch(
      dep({ kind: 'regulated-surface', name: 'checkout' }),
      undefined,
      { budget },
    );
    expect(report.errors[0]).toMatch(/watchRegulations/);
    expect(report.failed).toBe(false);
  });

  it('throws when the budget stops the run, so "no changes" is never silent', async () => {
    await expect(
      watchDependency(dep({}), undefined, {
        ...offline,
        budget: new BudgetLedger(0),
        model: scriptedModel([]),
        onReport: () => {},
      }),
    ).rejects.toBeInstanceOf(WatchFailedError);
  });

  it('records a page or advisory feed that failed', async () => {
    const model = scriptedModel([
      [{ type: 'tool_use', id: 's', name: 'submit_changes', input: { changes: [] } }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const report = await runDependencyWatch(
      dep({ kind: 'library', name: 'left-pad', ecosystem: 'npm', version: '1.0.0' }),
      undefined,
      {
        ...offline,
        model,
        json: { json: async (url) => ({ ok: false, status: 503, url, error: 'HTTP 503' }) },
      },
    );
    expect(report.errors.join()).toMatch(/api\.osv\.dev.*HTTP 503/);
  });
});

describe('normaliseExternal', () => {
  it('keeps a change with a bad severity and hands the problem back', () => {
    const { changes, issues } = normaliseExternal(dep({}), 'node', [
      {
        id: 'a',
        kind: 'runtime-eol',
        title: 't',
        source: { url: 'u', quote: 'q' },
        severity: 'urgent',
      },
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('runtime-eol');
    expect(issues.map((issue) => issue.message).join()).toMatch(/severity "urgent"/);
    expect(issues.some((issue) => issue.message === 'missing fromVersions')).toBe(true);
  });

  it('stores an unknown kind as "other" and falls back to affects.versions', () => {
    const { changes } = normaliseExternal(dep({}), 'node', [
      {
        id: 'a',
        kind: 'nonsense',
        title: 't',
        source: { url: 'u', quote: 'q' },
        affects: { versions: ['18'] },
        severity: 'notice',
      },
    ]);
    expect(changes[0].kind).toBe('other');
    expect(changes[0].fromVersions).toEqual(['18']);
  });
});

describe('sources', () => {
  it('reads product names and pinned versions', () => {
    expect(eolProduct('docker.io/library/node:18-bookworm')).toBe('nodejs');
    expect(eolProduct('Next')).toBe('nextjs');
    expect(eolProduct('ubuntu:20.04')).toBe('ubuntu');
    expect(exactVersion('^13.4.0')).toBe('13.4.0');
    expect(exactVersion('==3.2')).toBe('3.2');
    expect(exactVersion('18')).toBeUndefined();
    expect(exactVersion()).toBeUndefined();
  });

  it('renders an OSV answer with the links and fixed versions the agent cites', () => {
    const text = renderOsv('next', '13.4.0', {
      vulns: [
        {
          id: 'GHSA-xxxx',
          aliases: ['CVE-2024-1'],
          summary: 'Server actions SSRF',
          database_specific: { severity: 'HIGH' },
          affected: [
            {
              package: { name: 'next' },
              ranges: [{ events: [{ introduced: '13.4.0' }, { fixed: '14.1.1' }] }],
            },
            { package: { name: 'other' }, ranges: [{ events: [{ fixed: '9.9.9' }] }] },
          ],
        },
      ],
    });
    expect(text).toContain('https://osv.dev/vulnerability/GHSA-xxxx');
    expect(text).toContain('First fixed in: 14.1.1.');
    expect(text).not.toContain('9.9.9');
    expect(renderOsv('x', undefined, {})).toContain('x (all versions): 0.');
  });

  it('asks OSV for the exact version in each registry a name could be in', async () => {
    const asked: unknown[] = [];
    const json: JsonFetcher = {
      json: async (url, body) => {
        asked.push(body);
        return { ok: true, status: 200, url, data: { vulns: [] } };
      },
    };
    const pages = await readOsv(dep({ kind: 'library', name: 'flask', version: '~=2.0.1' }), json);
    expect(asked).toEqual([
      { package: { name: 'flask', ecosystem: 'npm' }, version: '2.0.1' },
      { package: { name: 'flask', ecosystem: 'PyPI' }, version: '2.0.1' },
    ]);
    expect(pages.every((page) => page.ok)).toBe(true);
  });
});

describe('the day cache', () => {
  const counting = () => {
    const inner = {
      calls: 0,
      async fetch(url: string) {
        inner.calls++;
        return {
          url,
          status: inner.calls === 1 && url.endsWith('fail') ? 500 : 200,
          ok: !(inner.calls === 1 && url.endsWith('fail')),
          fetchedAt: 'now',
          contentType: 'text/plain',
          text: `read ${inner.calls}`,
        };
      },
    };
    return inner;
  };
  const cacheDir = () => mkdtempSync(join(tmpdir(), 'refit-cache-'));

  it('reads a page once a day and keeps no failures', async () => {
    const dir = cacheDir();
    const inner = counting();
    const cached = cachingFetcher(inner, { dir });
    expect((await cached.fetch('https://a.test/x')).text).toBe('read 1');
    expect((await cached.fetch('https://a.test/x')).text).toBe('read 1');
    expect(inner.calls).toBe(1);

    const other = counting();
    const again = cachingFetcher(other, { dir });
    await again.fetch('https://a.test/fail');
    expect((await again.fetch('https://a.test/fail')).ok).toBe(true);
    expect(other.calls).toBe(2);
  });

  it('reads again after a day', async () => {
    const dir = cacheDir();
    const inner = counting();
    const cached = cachingFetcher(inner, { dir });
    await cached.fetch('https://a.test/x');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const file of readdirSync(dir)) utimesSync(join(dir, file), old, old);
    expect((await cached.fetch('https://a.test/x')).text).toBe('read 2');
  });

  it('keeps a page per format and a query per body', async () => {
    const dir = cacheDir();
    const inner = counting();
    const cached = cachingFetcher(inner, { dir });
    await cached.fetch('https://a.test/x', 'json');
    await cached.fetch('https://a.test/x', 'html');
    expect(inner.calls).toBe(2);

    let calls = 0;
    const json = cachingJsonFetcher(
      { json: async (url) => ({ ok: true, status: 200, url, data: ++calls }) },
      { dir },
    );
    await json.json('https://a.test/q', { a: 1 });
    await json.json('https://a.test/q', { a: 1 });
    await json.json('https://a.test/q', { a: 2 });
    expect(calls).toBe(2);
  });

  it('goes on fetching when the cache cannot be written', async () => {
    const inner = counting();
    const cached = cachingFetcher(inner, { dir: '/dev/null/nowhere' });
    expect((await cached.fetch('https://a.test/x')).ok).toBe(true);
  });
});

describe('POSTing JSON', () => {
  it('sends the body over the same checked request, and refuses a redirect', async () => {
    const sent: { method?: string; body?: string; headers: Record<string, string> }[] = [];
    const respond = (status: number, headers = {}) =>
      new Response(status === 200 ? '{"vulns":[]}' : null, { status, headers });
    const fetcherWith = (status: number, headers = {}) =>
      httpJsonFetcher({
        lookup: async () => ['93.184.216.34'],
        get: async (_url, init) => {
          sent.push(init);
          return respond(status, headers);
        },
      });
    const ok = await fetcherWith(200).json('https://api.osv.dev/v1/query', { a: 1 });
    expect(ok.ok).toBe(true);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].body).toBe('{"a":1}');
    expect(sent[0].headers['content-type']).toBe('application/json');

    const moved = await fetcherWith(302, { location: 'https://evil.test/' }).json(
      'https://api.osv.dev/v1/query',
      { a: 1 },
    );
    expect(moved.ok).toBe(false);

    await fetcherWith(200).json('https://registry.npmjs.org/x');
    expect(sent.at(-1)!.method).toBeUndefined();
  });

  it('sends the GitHub token to advisories, and still to nothing else', async () => {
    const auth: (string | undefined)[] = [];
    const client = httpJsonFetcher({
      githubToken: 'tok',
      lookup: async () => ['93.184.216.34'],
      get: async (_url, init) => {
        auth.push(init.headers.authorization);
        return new Response('[]', { status: 200 });
      },
    });
    await client.json('https://api.github.com/advisories?ecosystem=npm');
    await client.json('https://api.github.com/user');
    expect(auth).toEqual(['Bearer tok', undefined]);
  });
});
