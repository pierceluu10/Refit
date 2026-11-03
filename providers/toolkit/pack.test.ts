import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolPack } from '../../shared/types.ts';
import { clearFetchCache } from './fetch.ts';
import {
  GENERIC_PLAYBOOKS_DIR,
  genericPlaybooks,
  loadToolPack,
  providerSlug,
  resolveProviderFolder,
} from './pack.ts';
import { MIGRATION_KINDS, parseFrontMatter } from './playbooks.ts';
import { discoverPages, searchDocs } from './searchDocs.ts';
import { recordedFetch } from './testing.ts';

const ctx = { repoDir: '.' };
const GENERIC = [
  'fetch_changelog',
  'package_lookup',
  'openapi_lookup',
  'openapi_check',
  'graphql_lookup',
  'graphql_check',
];
const tool = (pack: ToolPack, name: string) => {
  const found = pack.tools.find((t) => t.name === name);
  if (!found) throw new Error(`no ${name} in ${pack.tools.map((t) => t.name).join(', ')}`);
  return found;
};

beforeEach(() => clearFetchCache());

describe('resolveProviderFolder', () => {
  it('finds a folder by id, provider.json name or "<id>-<product>", and nothing else', () => {
    expect(resolveProviderFolder('stripe')).toBe('stripe');
    expect(resolveProviderFolder('Stripe ')).toBe('stripe');
    expect(resolveProviderFolder('meta-graph')).toBe('meta');
    expect(resolveProviderFolder('GitHub API')).toBe('github');
    expect(resolveProviderFolder('metabase')).toBeUndefined();
    expect(resolveProviderFolder('anthropic')).toBeUndefined();
    expect(resolveProviderFolder('../core')).toBeUndefined();
    expect(resolveProviderFolder('toolkit')).toBeUndefined();
    expect(providerSlug('Google Gemini API')).toBe('google-gemini-api');
  });
});

describe('loadToolPack', () => {
  it('gives a provider with its own pack those tools plus the generic ones, without a second docs search', async () => {
    const pack = await loadToolPack('stripe', { fetch: null });
    const names = pack.tools.map((t) => t.name);
    expect(pack.provider).toBe('stripe');
    expect(names.slice(0, 4)).toEqual([
      'stripe_api_versions',
      'stripe_check_params',
      'stripe_webhook_events',
      'stripe_search_docs',
    ]);
    expect(names.slice(4)).toEqual(GENERIC);
    // Its own playbook wins for every kind it has.
    const own = readFileSync(
      join(import.meta.dirname, '../stripe/playbooks/api-version.md'),
      'utf8',
    );
    expect(own).toContain(pack.playbooks['api-version']?.slice(0, 200));
    expect(Object.keys(pack.playbooks).sort()).toEqual([...MIGRATION_KINDS].sort());
  });

  it('gives a folder provider without tools.ts the generic pack, searching its saved pages offline', async () => {
    const pack = await loadToolPack('github', { fetch: null });
    expect(pack.tools.map((t) => t.name)).toEqual(['search_docs', ...GENERIC]);
    const out = await tool(pack, 'search_docs').run(
      { query: 'CheckAnnotation databaseId fullDatabaseId' },
      ctx,
    );
    expect(out).toContain('https://docs.github.com/en/graphql/overview/breaking-changes');
    expect(out).toMatch(/\(saved \d{4}-\d{2}-\d{2}\)/);
    const sources = await tool(pack, 'fetch_changelog').run({}, ctx);
    expect(sources).toContain('changelog (changelog-feed): https://github.blog/changelog/feed/');
    expect(pack.playbooks['sdk-major']).toContain('any provider');
  });

  it('gives an unknown provider the generic pack and playbooks, led by the inventory hints', async () => {
    const pack = await loadToolPack('Anthropic', {
      fetch: null,
      hints: {
        packages: ['@anthropic-ai/sdk (npm)'],
        hosts: ['api.anthropic.com'],
        docsUrls: ['https://docs.anthropic.com/en/api/versioning', 'http://localhost:8080/docs'],
      },
    });
    expect(pack.provider).toBe('anthropic');
    expect(pack.tools.map((t) => t.name)).toEqual(['search_docs', ...GENERIC]);
    expect(Object.keys(pack.playbooks).sort()).toEqual([...MIGRATION_KINDS].sort());
    expect(tool(pack, 'package_lookup').description).toContain('@anthropic-ai/sdk (npm)');
    const sources = await tool(pack, 'fetch_changelog').run({}, ctx);
    expect(sources).toContain(
      'docs page from the inventory: https://docs.anthropic.com/en/api/versioning',
    );
    // A local URL from a hint is never offered or fetched.
    expect(sources).not.toContain('localhost');
    const none = await tool(pack, 'search_docs').run({ query: 'api versioning header' }, ctx);
    expect(none).toContain('No anthropic docs passages matched');
    expect(none).toContain('https://docs.anthropic.com/en/api/versioning');
  });

  it('lets the docs search find pages the other tools read in the same run', async () => {
    const pack = await loadToolPack('anthropic', { fetch: recordedFetch() });
    await tool(pack, 'fetch_changelog').run(
      { url: 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@latest/CHANGELOG.md' },
      ctx,
    );
    const out = await tool(pack, 'search_docs').run(
      { query: 'compaction_limit_reached_error session error', live: false },
      ctx,
    );
    expect(out).toContain(
      '(read this run) https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@latest/CHANGELOG.md',
    );
  });

  it('only returns information: every tool of every kind of pack answers bad input with a string', async () => {
    for (const provider of ['stripe', 'github', 'some-new-api']) {
      const pack = await loadToolPack(provider, { fetch: null });
      for (const t of pack.tools) {
        const harnessName = `${pack.provider}__${t.name}`
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 64);
        expect(harnessName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
        expect(t.description.length).toBeGreaterThan(40);
        expect((t.inputSchema as { type?: string }).type).toBe('object');
        for (const input of [{}, 'nonsense', null]) {
          await expect(t.run(input, ctx)).resolves.toEqual(expect.any(String));
        }
      }
    }
  });
});

describe('generic playbooks', () => {
  it('has one per MigrationKind, with front matter and the sections the harness injects', () => {
    const files = readdirSync(GENERIC_PLAYBOOKS_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(files).toEqual([...MIGRATION_KINDS].map((kind) => `${kind}.md`).sort());
    const playbooks = genericPlaybooks();
    for (const kind of MIGRATION_KINDS) {
      const { meta } = parseFrontMatter(
        readFileSync(join(GENERIC_PLAYBOOKS_DIR, `${kind}.md`), 'utf8'),
      );
      expect(meta).toMatchObject({ provider: 'generic', kind, reviewed: 'false' });
      const body = playbooks[kind] ?? '';
      for (const section of [
        '**What usually changes.**',
        '**How to spot it in code.**',
        '**What to check.**',
        '**Pitfalls.**',
        "**When you're unsure.**",
      ]) {
        expect(body, `${kind}: ${section}`).toContain(section);
      }
      expect(body.split(/\s+/).length, kind).toBeLessThan(500);
    }
  });

  it('reads as advice that always ends in an attempt, never as a gate', () => {
    for (const [kind, body] of Object.entries(genericPlaybooks())) {
      expect(body, kind).not.toMatch(
        /\b(skip|refuse|decline|give up|do not attempt|don't attempt|abort)\b/i,
      );
      expect(body, kind).toMatch(/PR/);
    }
  });

  it('only names tools that exist', async () => {
    const pack = await loadToolPack('unknown-provider', { fetch: null });
    const known = new Set([
      ...pack.tools.map((t) => t.name),
      // harness tools
      'list_files',
      'read_file',
      'write_file',
      'edit_file',
      'search',
      'shell',
      'install',
      'run_checks',
      'diff',
      'fetch_url',
      'retrieve_recipes',
      'finish',
    ]);
    for (const [kind, body] of Object.entries(pack.playbooks)) {
      for (const [, name] of body.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
        if (
          /^(snake_case|api_version|python_requires|per_page|starting_after|compare_to|spec_url|schema_url)$/.test(
            name,
          )
        )
          continue;
        expect(known.has(name), `${kind} names ${name}`).toBe(true);
      }
    }
  });
});

describe('searchDocs upgrades', () => {
  it('finds pages for a query through a recorded sitemap', async () => {
    const page = 'https://resend.com/docs/api-reference/api-keys/create-api-key';
    const fetch = recordedFetch({
      // Stand-in page text (hand-written); the sitemap that led to it is recorded.
      [page]: {
        status: 200,
        body: '<main><h1>Create API key</h1><p>POST /api-keys takes a name and a permission of full_access or sending_access.</p></main>',
        contentType: 'text/html',
      },
    });
    const found = await discoverPages('resend.com/docs', 'create api key', { fetch });
    expect(found.urls[0]).toBe(page);
    const passages = await searchDocs('resend', 'api key permission sending_access', {
      fetch,
      site: 'https://resend.com/docs',
    });
    expect(passages[0]).toMatchObject({ url: page, source: 'live' });
  });
});
