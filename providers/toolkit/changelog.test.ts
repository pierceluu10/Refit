import { beforeEach, describe, expect, it } from 'vitest';
import { changelogReport, changelogTarget, createChangelogTool } from './changelog.ts';
import { clearFetchCache } from './fetch.ts';
import {
  findDate,
  htmlPageToText,
  pageToText,
  parseFeed,
  splitEntries,
  PageStore,
} from './pages.ts';
import { recorded, recordedFetch } from './testing.ts';

const CHANGELOG = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@latest/CHANGELOG.md';
const RELEASES_API =
  'https://api.github.com/repos/anthropics/anthropic-sdk-typescript/releases?per_page=50';

beforeEach(() => clearFetchCache());

describe('pages', () => {
  it('keeps headings and list items from HTML and drops navigation', () => {
    const text = htmlPageToText(
      '<nav>menu</nav><main><h2>2026-10-01</h2><ul><li>Removed <code>foo</code></li></ul><script>x()</script></main>',
    );
    expect(text).toContain('## 2026-10-01');
    expect(text).toContain('- Removed foo');
    expect(text).not.toContain('menu');
    expect(text).not.toContain('x()');
  });

  it('reads a recorded Atom feed into entries', () => {
    const entries = parseFeed(recorded('releases-anthropic-sdk-typescript.atom.txt'));
    expect(entries.length).toBe(5);
    expect(entries[0].title).toMatch(/v\d+\.\d+\.\d+/);
    expect(entries[0].link).toMatch(
      /^https:\/\/github\.com\/anthropics\/anthropic-sdk-typescript\/releases\/tag\//,
    );
  });

  it('splits a changelog at its version headings and keeps sub-headings inside', () => {
    const entries = splitEntries(recorded('changelog-anthropic-sdk.md.txt'));
    const versioned = entries.filter((e) => e.version);
    expect(versioned[0]).toMatchObject({ version: '1.4.0', date: '2026-11-02' });
    expect(versioned[0].text).toContain('### Features');
    expect(versioned).toHaveLength(12);
  });

  it('finds dates in the forms changelogs use', () => {
    expect(findDate('March 3, 2026')).toBe('2026-03-03');
    expect(findDate('3 Mar 2026')).toBe('2026-03-03');
    expect(findDate('0.28.1 (6th December, 2024)')).toBe('2024-12-06');
    expect(findDate('Mon, 02 Nov 2026 15:47:21 +0000')).toBe('2026-11-02');
    expect(findDate('v2 (2025-12-01)')).toBe('2025-12-01');
    expect(findDate('no date')).toBeUndefined();
  });

  it('turns GitHub releases JSON into text', () => {
    const text = pageToText(
      recorded('github-releases-anthropic-sdk-typescript.json'),
      'application/json',
    );
    expect(text).toMatch(/^## .*\(sdk-v1\.4\.0, published \d{4}-\d{2}-\d{2}\)/m);
  });
});

describe('fetch_changelog on recorded pages', () => {
  it('filters a CHANGELOG by version and keeps what it read for the docs search', async () => {
    const store = new PageStore();
    const out = await changelogReport(
      { url: CHANGELOG, since: '1.2.0' },
      { fetch: recordedFetch(), store, provider: 'anthropic' },
    );
    expect(out).toContain(`Read ${CHANGELOG} (HTTP 200`);
    expect(out).toMatch(/after 1\.2\.0: 2 of \d+ entries/);
    expect(out).toContain('## [1.4.0]');
    expect(out).toContain('## [1.3.0]');
    expect(out).not.toContain('## [1.2.0]');
    expect(store.size).toBe(1);
  });

  it('ranks entries by a query', async () => {
    const out = await changelogReport(
      { url: CHANGELOG, query: 'compaction_limit_reached_error', limit: 1 },
      { fetch: recordedFetch(), provider: 'anthropic' },
    );
    expect(out).toContain('Showing 1 from offset 0');
    expect(out).toContain('compaction_limit_reached_error');
    expect(out).toContain('matching "compaction_limit_reached_error": 1 entries');
  });

  it('reads owner/repo as GitHub releases and falls back to the feed when the API refuses', async () => {
    expect(changelogTarget('anthropics/anthropic-sdk-typescript').url).toBe(RELEASES_API);
    const fetch = recordedFetch({ [RELEASES_API]: { status: 403, body: 'rate limited' } });
    const out = await changelogReport(
      { url: 'anthropics/anthropic-sdk-typescript' },
      { fetch, provider: 'anthropic' },
    );
    expect(out).toContain('The releases API answered HTTP 403; this is the releases feed');
    expect(out).toContain(
      'Read https://github.com/anthropics/anthropic-sdk-typescript/releases.atom',
    );
    expect(fetch.calls).toEqual([
      `GET ${RELEASES_API}`,
      'GET https://github.com/anthropics/anthropic-sdk-typescript/releases.atom',
    ]);
  });

  it('lists the known pages when no url is given, and reports pages it cannot read', async () => {
    const tool = createChangelogTool({
      fetch: recordedFetch(),
      provider: 'acme',
      sources: [{ label: 'changelog', url: 'https://acme.example.com/changelog' }],
    });
    expect(await tool.run({}, { repoDir: '.' })).toContain(
      '- changelog: https://acme.example.com/changelog',
    );
    expect(
      await tool.run({ url: 'https://acme.example.com/changelog' }, { repoDir: '.' }),
    ).toContain('Could not read https://acme.example.com/changelog: HTTP 404');
    expect(changelogTarget('https://github.com/o/r/blob/main/CHANGES.md').url).toBe(
      'https://raw.githubusercontent.com/o/r/main/CHANGES.md',
    );
  });

  it('reads a recorded RSS changelog and keeps the entries after a date', async () => {
    const out = await changelogReport(
      { url: 'https://github.blog/changelog/feed/', since: '2026-10-29' },
      { fetch: recordedFetch(), provider: 'github' },
    );
    expect(out).toContain('6 entries; after 2026-10-29: 3 of 6 entries');
    expect(out).toContain('## pull_request_target blocked by default December 2 (Mon, 02 Nov 2026');
    expect(out).toContain('## Webhook IP ranges added to the Meta API');
    expect(out).not.toContain('Copilot Fusion');
  });

  it('points to the feed a page announces (hand-written page)', async () => {
    const url = 'https://acme.example.com/changelog';
    const body =
      '<html><head><link rel="alternate" type="application/rss+xml" href="/changelog/feed.xml"></head><body><div id="app"></div></body></html>';
    const out = await changelogReport(
      { url },
      {
        fetch: recordedFetch({ [url]: { status: 200, body, contentType: 'text/html' } }),
        provider: 'acme',
      },
    );
    expect(out).toContain('The page links a feed: https://acme.example.com/changelog/feed.xml');
    expect(out).toContain('The page has almost no readable text.');
  });

  it('says when a page is drawn by script and has no text to read', async () => {
    const url = 'https://app.example.com/changelog';
    const out = await changelogReport(
      { url },
      {
        fetch: recordedFetch({
          [url]: {
            status: 200,
            body: '<html><body><div id="root"></div><script>x()</script></body></html>',
            contentType: 'text/html',
          },
        }),
        provider: 'acme',
      },
    );
    expect(out).toContain('The page has almost no readable text.');
    expect(out).toContain('Try its RSS or Atom feed');
  });

  it('pages through text that has no headings', async () => {
    const body = 'word '.repeat(5000);
    const out = await changelogReport(
      { url: 'https://acme.example.com/notes.txt' },
      {
        fetch: recordedFetch({ 'https://acme.example.com/notes.txt': { status: 200, body } }),
        provider: 'acme',
      },
    );
    expect(out).toContain('No dated or versioned headings found');
    expect(out).toContain('[more: call again with offset 12000]');
  });
});
