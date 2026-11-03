import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolLoop } from './agent.ts';
import {
  containsQuote,
  githubReleasesToText,
  htmlToText,
  isFetchableUrl,
  lineDiff,
  recordSnapshot,
  snapshotFetcher,
  type Fetcher,
} from './fetch.ts';
import { draftKnowledge, knowledgeProblems } from './knowledge.ts';
import { BudgetExceededError, BudgetLedger, costOf, metered, type ContentBlock } from './model.ts';
import { listProviderIds, loadProvider } from './registry.ts';
import { scriptedModel } from './testing.ts';
import type { LoadedProvider, ProviderKnowledge } from './types.ts';
import { WatchFailedError, createWatcher, normaliseChanges, runWatch } from './watcher.ts';

const PAGE = `Breaking changes
On 2026-06-01 we remove the legacy_total field from list responses. Use has_more instead.
Version 2026-03-01 is now the default.`;

function fakeFetcher(pages: Record<string, string>): Fetcher {
  return {
    async fetch(url) {
      const text = pages[url];
      return {
        url,
        status: text === undefined ? 404 : 200,
        ok: text !== undefined,
        fetchedAt: '2026-11-01T00:00:00.000Z',
        contentType: 'text/plain',
        text: text ?? '',
        error: text === undefined ? 'HTTP 404' : undefined,
      };
    },
  };
}

const provider: LoadedProvider = {
  id: 'acme',
  name: 'Acme',
  dir: '/nonexistent',
  prompt: 'Acme pins API versions with an Acme-Version header. Watch the changelog for removals.',
  sources: [{ id: 'changelog', kind: 'changelog', url: 'https://acme.test/changelog' }],
};

describe('fetch helpers', () => {
  it('turns HTML and RSS into readable text', () => {
    const text = htmlToText(
      '<html><head><title>x</title></head><body><script>bad()</script><h2>Removed</h2><p>The <code>foo</code> field&nbsp;is gone &amp; done.</p><ul><li>one</li></ul></body></html>',
    );
    expect(text).toContain('## Removed');
    expect(text).toContain('The foo field is gone & done.');
    expect(text).toContain('- one');
    expect(text).not.toContain('bad()');
    const rss = htmlToText(
      '<rss><item><title>Hi</title><description>&lt;p&gt;Body &amp;amp; more&lt;/p&gt;</description></item></rss>',
    );
    expect(rss).toContain('Hi');
    expect(rss).toContain('Body & more');
  });

  it('renders GitHub releases', () => {
    const text = githubReleasesToText(
      JSON.stringify([
        {
          tag_name: 'v2.0.0',
          name: 'v2.0.0',
          published_at: '2026-10-01T00:00:00Z',
          body: 'Breaking: drop Node 18',
        },
      ]),
    );
    expect(text).toContain('## v2.0.0 (v2.0.0, published 2026-10-01T00:00:00Z)');
    expect(text).toContain('Breaking: drop Node 18');
  });

  it('matches quotes despite whitespace and curly quotes', () => {
    expect(containsQuote('We’re   removing\nthe field', "we're removing the field")).toBe(true);
    expect(containsQuote('abc', '')).toBe(false);
  });

  it('only fetches public https URLs', () => {
    expect(isFetchableUrl('https://docs.stripe.com/changelog')).toBe(true);
    expect(isFetchableUrl('http://docs.stripe.com')).toBe(false);
    expect(isFetchableUrl('https://localhost/x')).toBe(false);
    expect(isFetchableUrl('https://169.254.169.254/latest')).toBe(false);
  });

  it('diffs lines', () => {
    expect(lineDiff('a\nb', 'a\nc')).toBe('- b\n+ c');
  });

  it('records and replays snapshots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apt-snap-'));
    try {
      const manifest = await recordSnapshot(provider, dir, {
        fetcher: fakeFetcher({ 'https://acme.test/changelog': PAGE }),
        snapshotChars: 50,
      });
      expect(manifest.sources[0]).toMatchObject({ ok: true, chars: 50, truncated: true });
      const page = await snapshotFetcher(dir).fetch('https://acme.test/changelog');
      expect(page.text.trim()).toBe(PAGE.slice(0, 50).trim());
      expect((await snapshotFetcher(dir).fetch('https://acme.test/other')).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('budget', () => {
  it('prices known models and stops at the cap', async () => {
    expect(
      costOf('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ).toBeCloseTo(3);
    const ledger = new BudgetLedger(0.001);
    const model = metered(
      scriptedModel([[{ type: 'text', text: 'hi' }]], 'claude-sonnet-5-5'),
      ledger,
    );
    await model.complete({ system: '', messages: [], tools: [], maxTokens: 10 });
    await expect(
      model.complete({ system: '', messages: [], tools: [], maxTokens: 10 }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('tool loop', () => {
  it('reports unknown tools back to the model instead of failing', async () => {
    const model = scriptedModel([
      [{ type: 'tool_use', id: 't1', name: 'nope', input: {} }],
      [{ type: 'text', text: 'ok' }],
    ]);
    const result = await runToolLoop({ model, system: 's', prompt: 'p', tools: [] });
    expect(result.ended).toBe('done');
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain('No tool named nope');
  });

  it('does not run a tool call cut off at max_tokens and tells the model why', async () => {
    let ran = 0;
    const model = scriptedModel([
      (): ContentBlock[] => [{ type: 'tool_use', id: 't1', name: 'count', input: {} }],
      [{ type: 'text', text: 'ok' }],
    ]);
    const cutModel = {
      model: model.model,
      async complete(request: Parameters<typeof model.complete>[0]) {
        const response = await model.complete(request);
        return model.requests.length === 1 ? { ...response, stopReason: 'max_tokens' } : response;
      },
    };
    const tool = {
      name: 'count',
      description: 'd',
      input_schema: { type: 'object' },
      async run() {
        ran++;
        return { content: 'ran' };
      },
    };
    await runToolLoop({ model: cutModel, system: 's', prompt: 'p', tools: [tool] });
    expect(ran).toBe(0);
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain('max_tokens limit');
  });

  it('reminds the model to wrap up when two turns are left', async () => {
    const model = scriptedModel([[{ type: 'tool_use', id: 't', name: 'nope', input: {} }]]);
    const result = await runToolLoop({
      model,
      system: 's',
      prompt: 'p',
      tools: [],
      maxTurns: 3,
      isDone: () => false,
      wrapUp: 'Submit now.',
    });
    expect(result.ended).toBe('max-turns');
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain(
      '2 model turns left. Submit now.',
    );
    expect(JSON.stringify(model.requests[2].messages.at(-1))).toContain(
      '1 model turn left. Submit now.',
    );
  });

  it('nudges once when the model stops before finishing', async () => {
    const model = scriptedModel([
      [{ type: 'text', text: 'done?' }],
      [{ type: 'text', text: 'still done' }],
    ]);
    const result = await runToolLoop({
      model,
      system: 's',
      prompt: 'p',
      tools: [],
      isDone: () => false,
      nudge: 'submit please',
    });
    expect(model.requests).toHaveLength(2);
    expect(result.finalText).toBe('still done');
  });
});

describe('normaliseChanges', () => {
  it('keeps every change, prefixes ids and lists problems', () => {
    const { changes, issues } = normaliseChanges('acme', [
      {
        id: 'Remove Legacy Total',
        kind: 'field-removed',
        title: 'x',
        source: { url: 'https://a', quote: 'q' },
        affects: { fields: ['legacy_total', ''] },
      },
      {
        id: 'remove-legacy-total',
        kind: 'made-up',
        title: 'y',
        source: { url: 'https://a', quote: 'q' },
        affects: {},
        effectiveDate: 'June',
      },
    ]);
    expect(changes.map((change) => change.id)).toEqual([
      'acme:remove-legacy-total',
      'acme:remove-legacy-total-2',
    ]);
    expect(changes[0].affects.fields).toEqual(['legacy_total']);
    expect(changes[1].kind).toBe('other');
    expect(issues.map((issue) => issue.message).join('\n')).toMatch(
      /not a MigrationKind[\s\S]*not YYYY-MM-DD/,
    );
  });
});

describe('runWatch', () => {
  const change = {
    id: 'remove-legacy-total',
    kind: 'field-removed',
    title: 'Acme removes legacy_total from list responses on 2026-06-01.',
    effectiveDate: '2026-06-01',
    source: {
      url: 'https://acme.test/changelog',
      quote: 'On 2026-06-01 we remove the legacy_total field from list responses.',
    },
    affects: { fields: ['legacy_total'], operations: ['list'] },
  };

  it('lets the model read, fix a bad quote, and submit', async () => {
    const model = scriptedModel([
      [{ type: 'tool_use', id: 'r', name: 'read_page', input: { source_id: 'changelog' } }],
      [
        {
          type: 'tool_use',
          id: 's1',
          name: 'submit_changes',
          input: { changes: [{ ...change, source: { ...change.source, quote: 'a paraphrase' } }] },
        },
      ],
      [{ type: 'tool_use', id: 's2', name: 'submit_changes', input: { changes: [change] } }],
      [{ type: 'text', text: 'never reached' }],
    ]);
    const report = await runWatch(provider, '2026-01-01', {
      model,
      fetcher: fakeFetcher({ 'https://acme.test/changelog': PAGE }),
      budget: new BudgetLedger(1),
      today: '2026-11-01',
    });
    expect(model.requests[0].messages[0].content[0]).toMatchObject({
      text: expect.stringContaining('on or after 2026-01-01'),
    });
    expect(JSON.stringify(model.requests[2].messages.at(-1))).toContain('quote not found');
    expect(report.issues).toEqual([]);
    expect(report.changes).toEqual([
      { provider: 'acme', ...change, id: 'acme:remove-legacy-total' },
    ]);
    expect(report.sourcesRead).toEqual(['https://acme.test/changelog']);
    expect(report.turns).toBe(3);
    expect(model.requests).toHaveLength(3);
  });

  it('never stops silently: an unfixed quote stays as an issue, not a dropped change', async () => {
    const bad = { ...change, source: { ...change.source, quote: 'not on the page' } };
    const model = scriptedModel([
      [{ type: 'tool_use', id: 's1', name: 'submit_changes', input: { changes: [bad] } }],
      [{ type: 'text', text: 'The quote is from a linked PDF I could not read.' }],
    ]);
    const report = await runWatch(provider, undefined, {
      model,
      fetcher: fakeFetcher({}),
      budget: new BudgetLedger(1),
    });
    expect(report.changes).toHaveLength(1);
    expect(report.unverifiedQuotes).toEqual(['acme:remove-legacy-total']);
    expect(report.summary).toContain('linked PDF');
  });

  it('returns what it has when the budget runs out', async () => {
    const model = scriptedModel(
      [[{ type: 'tool_use', id: 'r', name: 'list_sources', input: {} }]],
      'claude-opus-5-5',
    );
    // Each fake call costs $0.008 on Opus prices; the ledger refuses the call that could pass $0.05.
    const report = await runWatch(provider, undefined, {
      model,
      fetcher: fakeFetcher({}),
      budget: new BudgetLedger(0.05),
      maxTokens: 2_000,
    });
    expect(report.issues.map((issue) => issue.message).join(' ')).toMatch(/budget/);
    expect(report.costUsd).toBeGreaterThan(0);
    expect(report.costUsd).toBeLessThanOrEqual(0.05);
  });
});

describe('createWatcher', () => {
  it('throws instead of returning [] when the run never submitted', async () => {
    const model = scriptedModel([[{ type: 'text', text: 'I will not submit.' }]]);
    const reports: unknown[] = [];
    const watch = createWatcher(() => provider, {
      model,
      fetcher: fakeFetcher({}),
      budget: new BudgetLedger(1),
      onReport: (report) => reports.push(report),
    });
    await expect(watch()).rejects.toBeInstanceOf(WatchFailedError);
    expect(reports).toHaveLength(1);
  });

  it('returns an empty list when the agent submits no changes', async () => {
    const model = scriptedModel([
      [{ type: 'tool_use', id: 's', name: 'submit_changes', input: { changes: [] } }],
    ]);
    const watch = createWatcher(() => provider, {
      model,
      fetcher: fakeFetcher({}),
      budget: new BudgetLedger(1),
    });
    await expect(watch('2026-10-01')).resolves.toEqual([]);
  });
});

describe('knowledge', () => {
  const knowledge: ProviderKnowledge = {
    provider: 'acme',
    updatedAt: '2026-11-01',
    draftedBy: 'test',
    versioning: {
      scheme: 'Date versions in a header.',
      source: { url: 'https://acme.test/changelog', retrievedAt: '2026-11-01' },
    },
    versions: [
      {
        value: '2026-03-01',
        status: 'current',
        source: {
          url: 'https://acme.test/changelog',
          retrievedAt: '2026-11-01',
          quote: 'Version 2026-03-01 is now the default.',
        },
      },
    ],
    retirements: [],
    docs: [
      {
        label: 'Changelog',
        url: 'https://acme.test/changelog',
        source: { url: 'https://acme.test/changelog', retrievedAt: '2026-11-01' },
      },
    ],
    sdks: [],
  };

  it('flags unsourced or undated entries', () => {
    expect(knowledgeProblems(knowledge)).toEqual([]);
    const broken = structuredClone(knowledge) as unknown as {
      versions: { source: { retrievedAt?: string } }[];
    };
    delete broken.versions[0].source.retrievedAt;
    expect(knowledgeProblems(broken).join()).toContain('retrievedAt');
  });

  it('drafts knowledge with the agent', async () => {
    const model = scriptedModel([
      [{ type: 'tool_use', id: 'r', name: 'read_page', input: { source_id: 'changelog' } }],
      [{ type: 'tool_use', id: 's', name: 'submit_knowledge', input: { knowledge } }],
    ]);
    const result = await draftKnowledge(provider, [], {
      model,
      fetcher: fakeFetcher({ 'https://acme.test/changelog': PAGE }),
      budget: new BudgetLedger(1),
    });
    expect(result.problems).toEqual([]);
    expect(result.knowledge?.versions[0].value).toBe('2026-03-01');
  });
});

describe('registry', () => {
  it('discovers a provider from a folder alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'apt-reg-'));
    try {
      mkdirSync(join(root, 'acme'));
      mkdirSync(join(root, 'core'));
      writeFileSync(
        join(root, 'acme', 'provider.json'),
        JSON.stringify({ id: 'acme', name: 'Acme', sources: provider.sources }),
      );
      writeFileSync(join(root, 'acme', 'prompt.md'), provider.prompt);
      expect(listProviderIds(root)).toEqual(['acme']);
      expect(loadProvider('acme', root)).toMatchObject({ name: 'Acme', prompt: provider.prompt });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
