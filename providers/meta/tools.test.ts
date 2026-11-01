import { describe, expect, it } from 'vitest';
import {
  clearFetchCache,
  loadPlaybookMeta,
  MIGRATION_KINDS,
  type FetchLike,
} from '../toolkit/index.ts';
import {
  createToolPack,
  findChanges,
  loadChanges,
  loadVersions,
  parseVersion,
  toolPack,
} from './tools.ts';

const ctx = { repoDir: '.' };
const now = '2026-11-01T00:00:00Z';
const offline = createToolPack({ fetch: null, now });

function tool(name: string, pack = offline) {
  const found = pack.tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function stubFetch(body: string, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => body };
  };
}

describe('meta tool pack', () => {
  it('exposes prefixed tools plus search_docs and every playbook', () => {
    const names = toolPack.tools.map((t) => t.name);
    expect(names).toEqual([
      'meta_lookup_field',
      'meta_api_versions',
      'meta_permission_info',
      'meta_search_docs',
    ]);
    for (const name of names) expect(name).toMatch(/^[a-z0-9_]{1,64}$/);
    for (const kind of MIGRATION_KINDS) expect(toolPack.playbooks[kind]).toBeTruthy();
    const meta = loadPlaybookMeta(new URL('./playbooks/', import.meta.url));
    for (const kind of MIGRATION_KINDS) {
      expect(meta[kind]).toMatchObject({ provider: 'meta', kind, reviewed: 'false' });
    }
  });

  it('ships dated snapshots with sources', () => {
    const changes = loadChanges();
    expect(changes.retrieved).toBe('2026-11-01');
    expect(changes.entries.length).toBeGreaterThan(100);
    for (const entry of changes.entries) {
      expect(entry.source).toMatch(/^https:\/\//);
      expect(entry.version).toBeTruthy();
    }
    const versions = loadVersions();
    expect(versions.latest.graph).toBe('v26.0');
    expect(versions.graph.length).toBeGreaterThan(8);
  });
});

describe('helpers', () => {
  it('parses version strings', () => {
    expect(parseVersion('v17.0')).toBe(17);
    expect(parseVersion('21')).toBe(21);
    expect(parseVersion('v22')).toBe(22);
    expect(parseVersion('latest')).toBeUndefined();
  });

  it('matches names exactly, partially and fuzzily', () => {
    const entries = loadChanges().entries;
    expect(findChanges('instagram_actor_id', entries).how).toBe('exact');
    expect(
      findChanges('Page.page_fans', entries).matches.some((e) => e.metric === 'page_fans'),
    ).toBe(true);
    expect(
      findChanges('/{ig-user-id}/insights profile_views', entries).matches.length,
    ).toBeGreaterThan(0);
    expect(findChanges('instagram_actr_id', entries).suggestions).toContain('instagram_actor_id');
  });
});

describe('meta_lookup_field', () => {
  it('reports a rename with replacement, window and source', async () => {
    const out = await tool('meta_lookup_field').run(
      { name: 'instagram_actor_id', from_version: 'v21.0', to_version: 'v23.0' },
      ctx,
    );
    expect(out).toContain('instagram_user_id');
    expect(out).toContain('IN WINDOW');
    expect(out).toContain('ALL versions since 2025-09-09');
    expect(out).toContain('https://developers.facebook.com/docs/graph-api/changelog/version22.0');
  });

  it('marks changes already in effect before the from version', async () => {
    const out = await tool('meta_lookup_field').run(
      { name: 'publish_to_groups', from_version: 'v20.0' },
      ctx,
    );
    expect(out).toContain('already in effect');
  });

  it('flags future all-version dates relative to now', async () => {
    const pack = createToolPack({ fetch: null, now: '2025-01-01' });
    const out = await tool('meta_lookup_field', pack).run({ name: 'impressions' }, ctx);
    expect(out).toMatch(/will apply to ALL versions on 2025-04-21/);
  });

  it('gives a best-effort answer for unknown names', async () => {
    const out = await tool('meta_lookup_field').run({ name: 'zzqqxx_unknown' }, ctx);
    expect(out).toContain('not in the Meta change snapshot');
    expect(out).toContain('changelog');
    expect(await tool('meta_lookup_field').run({}, ctx)).toContain('name');
  });

  it('checks the live target changelog through the injected fetch', async () => {
    clearFetchCache();
    const calls: string[] = [];
    const pack = createToolPack({
      now,
      fetch: stubFetch('<p>The field fan_count is now deprecated on this version.</p>', calls),
    });
    const out = await tool('meta_lookup_field', pack).run(
      { name: 'Page.fan_count', to_version: 'v27.0' },
      ctx,
    );
    expect(calls[0]).toBe('https://developers.facebook.com/docs/graph-api/changelog/version27.0');
    expect(out).toContain('Live check: "fan_count" appears');
  });
});

describe('meta_api_versions', () => {
  it('computes days to expiry and expired status from injected now', async () => {
    const run = tool('meta_api_versions').run;
    const active = await run({ version: 'v21.0', api: 'graph' }, ctx);
    expect(active).toContain('supported until 2027-01-21 (81 days');
    const expired = await run({ version: 'v20', api: 'graph' }, ctx);
    expect(expired).toContain('EXPIRED on 2026-09-24 (38 days ago)');
    expect(expired).toContain('v21.0');
    const mkt = await run({ version: '23', api: 'marketing' }, ctx);
    expect(mkt).toContain('EXPIRED');
    expect(mkt).toContain('may fail or be upgraded');
  });

  it('lists everything with pin hints when no version is given', async () => {
    const out = await tool('meta_api_versions').run({}, ctx);
    expect(out).toContain('Graph API versions (latest v26.0');
    expect(out).toContain('Marketing API versions');
    expect(out).toContain('graph.facebook.com/v');
    expect(out).toContain('facebook-nodejs-business-sdk');
    expect(out).toContain('days computed against 2026-11-01');
  });

  it('handles versions outside the table and bad input', async () => {
    const run = tool('meta_api_versions').run;
    expect(await run({ version: 'v30.0', api: 'graph' }, ctx)).toContain('newer than the snapshot');
    expect(await run({ version: 'v9.0', api: 'graph' }, ctx)).toContain('expired long ago');
    expect(await run({ version: 'banana' }, ctx)).toContain('Could not read version');
  });

  it('notices a newer version on the live changelog', async () => {
    clearFetchCache();
    const pack = createToolPack({ now, fetch: stubFetch('<td>v27.0</td><td>v26.0</td>') });
    const out = await tool('meta_api_versions', pack).run({ version: 'v26.0' }, ctx);
    expect(out).toContain('Live changelog mentions v27.0');
  });
});

describe('meta_permission_info', () => {
  it('finds renamed Instagram scopes and product shutdowns', async () => {
    const run = tool('meta_permission_info').run;
    expect(await run({ name: 'business_basic' }, ctx)).toContain('instagram_business_basic');
    expect(await run({ permission: 'business_basic' }, ctx)).toContain('instagram_business_basic');
    expect(await run({ name: 'Instagram Basic Display' }, ctx)).toContain('2024-12-04');
    const all = await run({}, ctx);
    expect(all).toContain('publish_to_groups');
    expect(all).toContain('WhatsApp');
  });

  it('answers unknown permissions without refusing', async () => {
    const out = await tool('meta_permission_info').run({ name: 'pages_show_list' }, ctx);
    expect(out).toContain('no recorded permission or product change');
    expect(out).toContain('config_id');
  });
});

describe('meta_search_docs', () => {
  it('searches the snapshot offline', async () => {
    const out = await tool('meta_search_docs').run({ query: 'X-Hub-Signature-256 webhook' }, ctx);
    expect(out).toContain('webhooks/getting-started');
    expect(out).toContain('snapshot');
  });

  it('adds live passages via a stub fetch', async () => {
    clearFetchCache();
    const pack = createToolPack({
      now,
      fetch: stubFetch(
        '<p>Business Use Case rate limit header X-Business-Use-Case-Usage live note.</p>',
      ),
    });
    const out = await tool('meta_search_docs', pack).run(
      { query: 'business use case rate limit' },
      ctx,
    );
    expect(out).toContain('(live)');
  });
});
