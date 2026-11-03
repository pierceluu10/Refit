import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFetcher, type Fetcher, type PageLink } from './fetch.ts';
import { PageReader, pageTools, savePages } from './page-tools.ts';

const LONG = `${'intro '.repeat(3000)}## 2.0.0\nBREAKING: removed widgets.list\n${'filler '.repeat(3000)}`;

function fetcher(pages: Record<string, { text: string; links?: PageLink[] }>) {
  let calls = 0;
  const f: Fetcher & { calls: () => number } = {
    calls: () => calls,
    async fetch(url) {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      const page = pages[url];
      return {
        url,
        status: page ? 200 : 404,
        ok: Boolean(page),
        fetchedAt: '2026-11-03T00:00:00.000Z',
        contentType: 'text/plain',
        text: page?.text ?? '',
        ...(page?.links ? { links: page.links } : {}),
      };
    },
  };
  return f;
}

const tool = (reader: PageReader, name: string) =>
  pageTools(reader).find((candidate) => candidate.name === name)!;

describe('page tools', () => {
  it('search_page gives offsets that read_page can jump to', async () => {
    const reader = new PageReader(fetcher({ 'https://a.test/changelog': { text: LONG } }), []);
    const found = await tool(reader, 'search_page').run({
      url: 'https://a.test/changelog',
      query: 'breaking',
    });
    const offset = Number(/offset (\d+)/.exec(found.content)?.[1]);
    expect(found.content).toContain('1 match in https://a.test/changelog');
    expect(LONG.slice(offset, offset + 8)).toBe('BREAKING');
    const read = await tool(reader, 'read_page').run({ url: 'https://a.test/changelog', offset });
    expect(read.content).toContain('BREAKING: removed widgets.list');
    const none = await tool(reader, 'search_page').run({
      url: 'https://a.test/changelog',
      query: 'nope',
    });
    expect(none.content).toMatch(/^No match/);
  });

  it("list_links filters a page's links by a word the agent picks", async () => {
    const links = [
      { url: 'https://a.test/changelog', text: 'Changelog' },
      { url: 'https://a.test/pricing', text: 'Pricing' },
    ];
    const reader = new PageReader(fetcher({ 'https://a.test/': { text: 'home', links } }), []);
    const result = await tool(reader, 'list_links').run({
      url: 'https://a.test/',
      contains: 'change',
    });
    expect(result.content).toBe(
      '1 of 2 links on https://a.test/ contain "change":\n- https://a.test/changelog (Changelog)',
    );
  });

  it('shares one fetch between reads of a page that start together', async () => {
    const f = fetcher({ 'https://a.test/x': { text: 'x' } });
    const reader = new PageReader(f, []);
    await Promise.all([reader.read('https://a.test/x'), reader.read('https://a.test/x')]);
    expect(f.calls()).toBe(1);
  });
});

describe('savePages', () => {
  it('keeps only what the agent was shown, so the run replays and the fixture stays small', async () => {
    const reader = new PageReader(fetcher({ 'https://a.test/changelog': { text: LONG } }), []);
    await tool(reader, 'search_page').run({ url: 'https://a.test/changelog', query: 'BREAKING' });
    const dir = mkdtempSync(join(tmpdir(), 'apt-pages-'));
    try {
      const manifest = savePages(reader, dir, { provider: 'acme' });
      expect(manifest.sources).toHaveLength(1);
      expect(manifest.sources[0]).toMatchObject({
        url: 'https://a.test/changelog',
        truncated: true,
      });
      const saved = readFileSync(join(dir, manifest.sources[0].file), 'utf8');
      expect(saved.length).toBeLessThan(500);
      expect(saved).toMatch(/^\[\.\.\. \d+ characters not shown \.\.\.\]\n/);
      expect(saved).toContain('BREAKING: removed widgets.list');
      const replayed = await snapshotFetcher(dir).fetch('https://a.test/changelog');
      expect(replayed.text).toContain('BREAKING: removed widgets.list');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
