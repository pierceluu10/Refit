import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleToolPack,
  asObject,
  clearFetchCache,
  closest,
  defineTool,
  htmlToText,
  loadPlaybookMeta,
  loadPlaybooks,
  parseFrontMatter,
  rank,
  searchDocs,
  splitPassages,
  type DocsIndex,
  type FetchLike,
} from './index.ts';

const index: DocsIndex = {
  provider: 'demo',
  retrieved: '2026-11-01',
  pages: [
    {
      url: 'https://docs.example.com/versioning',
      title: 'Versioning',
      passages: ['Pin an API version with the Example-Version header. Versions are dated.'],
    },
    {
      url: 'https://docs.example.com/webhooks',
      title: 'Webhooks',
      passages: ['Webhook payloads are signed with a secret; verify the signature header.'],
    },
  ],
};

const offline = { fetch: null } as const;

describe('text helpers', () => {
  it('turns HTML into text and drops scripts', () => {
    const text = htmlToText('<html><script>x()</script><p>Hello &amp; bye</p><li>one</li></html>');
    expect(text).toContain('Hello & bye');
    expect(text).not.toContain('x()');
  });

  it('splits long text into passages', () => {
    const passages = splitPassages(
      Array.from({ length: 20 }, (_, i) => `para ${i} `.repeat(20)).join('\n'),
      300,
    );
    expect(passages.length).toBeGreaterThan(3);
  });

  it('ranks the matching document first', () => {
    const ranked = rank('webhook signature', index.pages, (p) => p.passages.join(' '));
    expect(ranked[0].item.title).toBe('Webhooks');
  });

  it('suggests close names', () => {
    expect(closest('custmer', ['customer', 'invoice'])).toEqual(['customer']);
  });
});

describe('defineTool', () => {
  it('turns thrown errors into information', async () => {
    const tool = defineTool({
      name: 'boom',
      description: 'd',
      inputSchema: {},
      run: async () => {
        throw new Error('kaput');
      },
    });
    const out = await tool.run({}, { repoDir: '.' });
    expect(out).toContain('kaput');
    expect(out).toContain('not a blocker');
  });

  it('accepts JSON strings and bare strings as input', () => {
    expect(asObject('{"a":1}')).toEqual({ a: 1 });
    expect(asObject('find me')).toEqual({ query: 'find me' });
    expect(asObject(null)).toEqual({});
  });
});

describe('playbooks', () => {
  it('parses front matter', () => {
    const { meta, body } = parseFrontMatter('---\nreviewed: false\nkind: api-version\n---\n# Hi\n');
    expect(meta).toEqual({ reviewed: 'false', kind: 'api-version' });
    expect(body).toBe('# Hi');
  });

  it('loads only MigrationKind files and strips front matter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-'));
    writeFileSync(join(dir, 'api-version.md'), '---\nreviewed: false\n---\nBody A');
    writeFileSync(join(dir, 'notes.md'), 'ignored');
    expect(loadPlaybooks(dir)).toEqual({ 'api-version': 'Body A' });
    expect(loadPlaybookMeta(dir)['api-version']).toEqual({ reviewed: 'false' });
    expect(loadPlaybooks(join(dir, 'missing'))).toEqual({});
  });
});

describe('searchDocs', () => {
  it('searches the snapshot offline', async () => {
    const results = await searchDocs('demo', 'version header', { index, ...offline });
    expect(results[0].url).toBe('https://docs.example.com/versioning');
    expect(results[0].source).toBe('snapshot');
  });

  it('adds live passages through the injected fetch', async () => {
    clearFetchCache();
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => '<p>Live: the signature header is Example-Signature and uses HMAC.</p>',
      };
    };
    const results = await searchDocs('demo', 'signature header', { index, fetch });
    expect(calls).toContain('https://docs.example.com/webhooks');
    expect(results.some((r) => r.source === 'live' && r.text.includes('HMAC'))).toBe(true);
  });

  it('survives a failing network', async () => {
    clearFetchCache();
    const fetch: FetchLike = async () => {
      throw new Error('down');
    };
    const results = await searchDocs('demo', 'webhook', { index, fetch });
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns nothing for an unknown provider without throwing', async () => {
    expect(await searchDocs('../etc', 'x', offline)).toEqual([]);
  });
});

describe('assembleToolPack', () => {
  it('adds a search_docs tool and loads playbooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-'));
    writeFileSync(join(dir, 'other.md'), 'Other advice');
    const pack = assembleToolPack({
      provider: 'demo',
      tools: [],
      playbooksDir: dir,
      options: { fetch: null, searchDocs: { index } },
    });
    expect(pack.tools.map((t) => t.name)).toEqual(['demo_search_docs']);
    expect(pack.playbooks.other).toBe('Other advice');
    const out = await pack.tools[0].run({ query: 'webhook signature' }, { repoDir: '.' });
    expect(out).toContain('https://docs.example.com/webhooks');
    const none = await pack.tools[0].run({ query: 'zzzz' }, { repoDir: '.' });
    expect(none).toContain('No demo docs passages matched');
    expect(await pack.tools[0].run({}, { repoDir: '.' })).toContain('query');
  });
});
