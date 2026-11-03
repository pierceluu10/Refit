import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runToolLoop } from './agent.ts';
import { anyProviderWatcher, displayName, runAnyWatch } from './any-watcher.ts';
import type { Fetcher, JsonFetcher } from './fetch.ts';
import { BudgetLedger, type ModelClient, type ModelRequest, type ModelResponse } from './model.ts';
import { registryClient } from './packages.ts';
import { PageReader } from './page-tools.ts';
import { ANY_WATCH_PROMPT_VERSION } from './prompt.ts';
import { scriptedModel } from './testing.ts';
import { WatchFailedError, normaliseChanges } from './watcher.ts';

// Illustrative provider "Acme": made-up pages, packages and dates, not a real API.
const DOCS = 'https://docs.acme.test/api';
const LLMS = 'https://docs.acme.test/llms.txt';
const CHANGELOG = 'https://docs.acme.test/changelog';
const SDK_CHANGELOG = 'https://raw.githubusercontent.com/acme/acme-node/HEAD/CHANGELOG.md';

const PAGES: Record<string, string> = {
  [DOCS]: 'Acme API reference. Breaking changes are announced in the changelog.',
  [LLMS]:
    '# Acme docs\n- [Changelog](https://docs.acme.test/changelog): every API change\n- [Deprecations](https://docs.acme.test/deprecations)',
  [CHANGELOG]:
    '## 2026-09-01\nThe legacy /v1/charges endpoint will be removed on 2027-01-31. Use /v2/payments instead.',
  [SDK_CHANGELOG]:
    '# Changelog\n\n## [3.0.0](https://github.com/acme/acme-node/compare/v2.5.0...v3.0.0) (2026-06-01)\n\n### ⚠ BREAKING CHANGES\n\n* rename `charges.create` to `payments.create`\n* drop Node 18 support\n\n## [2.5.0](https://github.com/acme/acme-node/compare/v2.0.0...v2.5.0) (2026-01-10)\n\n* add payments\n\n## 2.0.0 (2025-01-05)\n\n### Breaking\n\n* require an API key in the constructor\n',
};

function fakeFetcher(pages = PAGES): Fetcher & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async fetch(url) {
      urls.push(url);
      const text = pages[url];
      return {
        url,
        status: text === undefined ? 404 : 200,
        ok: text !== undefined,
        fetchedAt: '2026-11-03T00:00:00.000Z',
        contentType: 'text/plain',
        text: text ?? '',
        ...(text === undefined ? { error: 'HTTP 404' } : {}),
      };
    },
  };
}

// A registry document trimmed to the fields the reader uses.
const NPM_DOC = {
  name: 'acme-node',
  description: 'Official Acme client',
  repository: { type: 'git', url: 'git+https://github.com/acme/acme-node.git' },
  'dist-tags': { latest: '3.1.0' },
  time: {
    '1.0.0': '2024-01-01T00:00:00Z',
    '2.0.0': '2025-01-05T00:00:00Z',
    '2.5.0': '2026-01-10T00:00:00Z',
    '3.0.0': '2026-06-01T00:00:00Z',
    '3.1.0': '2026-09-01T00:00:00Z',
    '4.0.0-beta.1': '2026-10-01T00:00:00Z',
  },
  versions: { '1.0.0': {}, '2.0.0': {}, '2.5.0': {}, '3.0.0': {}, '3.1.0': {}, '4.0.0-beta.1': {} },
};

const fakeJson = (docs: Record<string, unknown>): JsonFetcher => ({
  async json(url) {
    return url in docs
      ? { ok: true, status: 200, url, data: docs[url] }
      : { ok: false, status: 404, url, error: 'HTTP 404' };
  },
});
const registry = () =>
  registryClient({
    json: fakeJson({ 'https://registry.npmjs.org/acme-node': NPM_DOC }),
    today: () => '2026-11-03',
  });

const HINTS = { packages: ['acme-node'], hosts: ['api.acme.test'], docsUrls: [DOCS] };

const endpointChange = {
  id: '2027-01-31-remove-v1-charges',
  kind: 'endpoint-removed',
  title: 'Acme removes /v1/charges on 2027-01-31; use /v2/payments',
  effectiveDate: '2027-01-31',
  source: {
    url: CHANGELOG,
    quote: 'The legacy /v1/charges endpoint will be removed on 2027-01-31.',
  },
  affects: { operations: ['/v1/charges'] },
};
const sdkChange = {
  id: 'npm-acme-node-3-0-0',
  kind: 'sdk-major',
  title: 'npm acme-node 3.0.0 renames charges.create to payments.create and drops Node 18',
  effectiveDate: '2026-06-01',
  source: { url: SDK_CHANGELOG, quote: '* rename `charges.create` to `payments.create`' },
  affects: { operations: ['charges.create'], versions: ['<3.0.0', '3.0.0'], sdk: 'acme-node' },
};

const text = (request: ModelRequest) =>
  JSON.stringify(request.messages[0].content[0]).replace(/\\n/g, '\n');

describe('runAnyWatch', () => {
  it('finds pages from the hints and registries, reads them and checks the quotes', async () => {
    const fetcher = fakeFetcher();
    const model = scriptedModel([
      [
        { type: 'tool_use', id: 'r1', name: 'read_page', input: { url: LLMS } },
        {
          type: 'tool_use',
          id: 'r2',
          name: 'list_links',
          input: { url: LLMS, contains: 'change' },
        },
      ],
      [{ type: 'tool_use', id: 'r3', name: 'read_page', input: { url: CHANGELOG } }],
      [
        {
          type: 'tool_use',
          id: 's',
          name: 'submit_changes',
          input: { changes: [endpointChange, sdkChange], notes: 'No deprecations page found.' },
        },
      ],
    ]);
    const report = await runAnyWatch('Acme', HINTS, undefined, {
      model,
      fetcher,
      registry: registry(),
      budget: new BudgetLedger(1),
      today: '2026-11-03',
      root: mkdtempSync(join(tmpdir(), 'apt-any-empty-')),
    });

    const first = model.requests[0];
    expect(first.system).toContain(ANY_WATCH_PROMPT_VERSION);
    expect(first.system).toContain('find where Acme publishes its changes');
    expect(first.serverTools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ]);
    expect(first.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read_page', 'search_page', 'list_links', 'lookup_package']),
    );
    const prompt = text(first);
    expect(prompt).toContain(`docs-1 [other] ${DOCS}`);
    expect(prompt).toContain(`llms-docs-acme-test [other] ${LLMS}`);
    expect(prompt).toContain('acme-node-npm-changelog [sdk-releases]');
    expect(prompt).toContain('- 3.x: 3.0.0 (2026-06-01) to 3.1.0 (2026-09-01), 2 releases');
    expect(prompt).toContain('Prereleases newer than the latest: 4.0.0-beta.1');
    expect(prompt).toContain('Release notes of 3.0.0');
    expect(prompt).toContain('* rename `charges.create` to `payments.create`');
    expect(prompt).toContain('about $1.00 of AI to spend');

    // The model only read the docs pages; the SDK changelog was read before it started, for the excerpts.
    expect(fetcher.urls).toEqual(expect.arrayContaining([SDK_CHANGELOG, LLMS, CHANGELOG]));
    expect(report.issues).toEqual([]);
    expect(report.unverifiedQuotes).toEqual([]);
    expect(report.provider).toBe('acme');
    expect(report.name).toBe('Acme');
    expect(report.folder).toBeUndefined();
    expect(report.changes.map((change) => change.id)).toEqual([
      'acme:2027-01-31-remove-v1-charges',
      'acme:npm-acme-node-3-0-0',
    ]);
    expect(report.changes.every((change) => change.provider === 'acme')).toBe(true);
    expect(report.summary).toBe('No deprecations page found.');
    expect(report.packages.map((info) => `${info.ecosystem}:${info.name}`)).toEqual([
      'npm:acme-node',
    ]);
    expect(report.startingPages).toEqual(
      expect.arrayContaining([
        DOCS,
        LLMS,
        SDK_CHANGELOG,
        'https://api.github.com/repos/acme/acme-node/releases?per_page=100',
        'https://raw.githubusercontent.com/acme/acme-node/HEAD/README.md',
      ]),
    );
  });

  it('uses a provider folder as a head start: its prompt, name, pages and knowledge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apt-any-folder-'));
    try {
      mkdirSync(join(root, 'acme'));
      writeFileSync(
        join(root, 'acme', 'provider.json'),
        JSON.stringify({
          id: 'acme',
          name: 'Acme Payments',
          sources: [{ id: 'changelog', kind: 'changelog', url: CHANGELOG }],
        }),
      );
      writeFileSync(
        join(root, 'acme', 'prompt.md'),
        'Acme pins versions with an Acme-Version header.',
      );
      const model = scriptedModel([
        [{ type: 'tool_use', id: 's', name: 'submit_changes', input: { changes: [] } }],
      ]);
      const report = await runAnyWatch('acme', {}, '2026-01-01', {
        model,
        fetcher: fakeFetcher(),
        registry: registry(),
        budget: new BudgetLedger(1),
        root,
      });
      expect(model.requests[0].system).toContain('Acme pins versions with an Acme-Version header.');
      expect(model.requests[0].system).toContain('watcher for Acme Payments');
      expect(text(model.requests[0])).toContain(`changelog [changelog] ${CHANGELOG}`);
      expect(text(model.requests[0])).toContain('on or after 2026-01-01');
      expect(report.folder).toBe('acme');
      expect(report.name).toBe('Acme Payments');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still attempts a read with no hints at all, and never falls back to returning nothing silently', async () => {
    const model = scriptedModel([[{ type: 'text', text: 'I found nothing to read.' }]]);
    const reports: unknown[] = [];
    const watch = anyProviderWatcher(
      'api.unknown.test',
      {},
      {
        model,
        fetcher: fakeFetcher({}),
        registry: registry(),
        budget: new BudgetLedger(1),
        onReport: (report) => reports.push(report),
      },
    );
    await expect(watch()).rejects.toBeInstanceOf(WatchFailedError);
    const prompt = text(model.requests[0]);
    expect(prompt).toContain('- packages: none');
    expect(prompt).toContain('(none yet: find them from the hints)');
    expect(model.requests[0].serverTools?.[0]).toMatchObject({ name: 'web_search' });
    // The nudge asked once for a submission before the run was reported as failed.
    expect(model.requests).toHaveLength(2);
    expect(reports).toHaveLength(1);
  });

  it('returns the changes when the agent submits', async () => {
    const model = scriptedModel([
      [{ type: 'tool_use', id: 'r', name: 'read_page', input: { url: CHANGELOG } }],
      [{ type: 'tool_use', id: 's', name: 'submit_changes', input: { changes: [endpointChange] } }],
    ]);
    const watch = anyProviderWatcher(
      'acme',
      {},
      {
        model,
        fetcher: fakeFetcher(),
        registry: registry(),
        budget: new BudgetLedger(1),
        webSearch: false,
      },
    );
    const changes = await watch();
    expect(changes.map((change) => change.id)).toEqual(['acme:2027-01-31-remove-v1-charges']);
    expect(model.requests[0].serverTools).toBeUndefined();
  });

  it('runs on without server tools when the account cannot use them', async () => {
    const seen: (string | undefined)[] = [];
    const model: ModelClient = {
      model: 'fake-model',
      async complete(request): Promise<ModelResponse> {
        seen.push(request.serverTools?.[0]?.name);
        if (request.serverTools)
          throw new Error('400 web search is not enabled for this organization');
        return {
          content: [{ type: 'tool_use', id: 's', name: 'submit_changes', input: { changes: [] } }],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    const report = await runAnyWatch('acme', {}, undefined, {
      model,
      fetcher: fakeFetcher(),
      registry: registry(),
      budget: new BudgetLedger(1),
    });
    expect(seen).toEqual(['web_search', undefined]);
    expect(report.issues).toEqual([
      {
        message: expect.stringMatching(
          /^server tools \(web_search\) failed, so the run went on without them/,
        ),
      },
    ]);
    expect(report.changes).toEqual([]);
  });

  it('looks up a package the agent finds and adds its pages to the sources', async () => {
    const model = scriptedModel([
      [{ type: 'tool_use', id: 'l', name: 'lookup_package', input: { name: 'acme-node' } }],
      [{ type: 'tool_use', id: 'ls', name: 'list_sources', input: {} }],
      [{ type: 'tool_use', id: 's', name: 'submit_changes', input: { changes: [sdkChange] } }],
    ]);
    const report = await runAnyWatch('acme', {}, undefined, {
      model,
      fetcher: fakeFetcher(),
      registry: registry(),
      budget: new BudgetLedger(1),
    });
    const results = JSON.stringify(model.requests[1].messages.at(-1));
    expect(results).toContain('npm package acme-node');
    expect(results).toContain('Release notes of 3.0.0');
    expect(JSON.stringify(model.requests[2].messages.at(-1))).toContain('acme-node-npm-changelog');
    expect(report.unverifiedQuotes).toEqual([]);
    expect(report.packages).toHaveLength(1);
  });

  it('names a provider id for people', () => {
    expect(displayName('google-gemini')).toBe('Google Gemini');
    expect(displayName('api.example.com')).toBe('api.example.com');
    expect(displayName('OpenWeather')).toBe('OpenWeather');
  });
});

describe('the tool loop for any-provider reads', () => {
  it('resumes a paused server-tool turn by sending the conversation back unchanged', async () => {
    const responses: ModelResponse[] = [
      {
        content: [
          {
            type: 'server_tool_use',
            id: 'srv',
            name: 'web_search',
            input: { query: 'acme changelog' },
          },
        ],
        stopReason: 'pause_turn',
        usage: { inputTokens: 10, outputTokens: 5, webSearches: 1 },
      },
      {
        content: [{ type: 'text', text: 'Found it.' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];
    const requests: ModelRequest[] = [];
    const model: ModelClient = {
      model: 'fake-model',
      async complete(request) {
        requests.push(structuredClone(request));
        return responses[requests.length - 1];
      },
    };
    const result = await runToolLoop({
      model,
      system: 's',
      prompt: 'p',
      tools: [],
      serverTools: [{ type: 'web_search_20250305', name: 'web_search' }],
    });
    expect(result.ended).toBe('done');
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(requests[1].serverTools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    expect(result.log[0].calls).toEqual([
      { tool: 'web_search', input: '{"query":"acme changelog"}' },
    ]);
  });

  it('tells the model to submit when the budget is nearly spent', async () => {
    // Each fake turn costs $0.004 on Sonnet pricing; after one, $0.006 of $0.01 is left.
    const model = scriptedModel(
      [
        [{ type: 'tool_use', id: 'r', name: 'list_sources', input: {} }],
        [{ type: 'text', text: 'ok' }],
      ],
      'claude-sonnet-5-5',
    );
    const report = await runAnyWatch('acme', {}, undefined, {
      model,
      fetcher: fakeFetcher(),
      registry: registry(),
      budget: new BudgetLedger(0.01),
    });
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain(
      "of this run's AI budget is left, enough for one or two more turns",
    );
    expect(report.costUsd).toBeGreaterThan(0);
  });
});

describe('quote checks', () => {
  it('asks for the page a quote is on when the change cites another page that was read', async () => {
    const reader = new PageReader(fakeFetcher(), []);
    await reader.read(DOCS);
    await reader.read(CHANGELOG);
    const { issues, unverifiedQuotes } = normaliseChanges(
      'acme',
      [{ ...endpointChange, source: { ...endpointChange.source, url: DOCS } }],
      reader,
    );
    expect(unverifiedQuotes).toEqual([]);
    expect(issues).toEqual([
      {
        changeId: 'acme:2027-01-31-remove-v1-charges',
        message: `quote is on ${CHANGELOG}, not on ${DOCS}: set source.url to the page it is on`,
      },
    ]);
  });

  it('accepts a cited page that differs only by a fragment or trailing slash', async () => {
    const reader = new PageReader(fakeFetcher(), []);
    await reader.read(CHANGELOG);
    const { issues } = normaliseChanges(
      'acme',
      [
        {
          ...endpointChange,
          source: { ...endpointChange.source, url: `${CHANGELOG}/#2026-09-01` },
        },
      ],
      reader,
    );
    expect(issues).toEqual([]);
  });
});
