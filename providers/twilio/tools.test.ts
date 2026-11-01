import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearFetchCache, loadPlaybookMeta, type FetchLike } from '../toolkit/index.ts';
import {
  createToolPack,
  endpointLookup,
  fetchOaiPaths,
  findLibrary,
  loadEndpoints,
  loadSdkVersions,
  parseMajor,
  parseTarget,
  sdkVersions,
  toolPack,
} from './tools.ts';

const offline = { fetch: null } as const;
const ctx = { repoDir: '.' };

function tool(name: string, options: Parameters<typeof createToolPack>[0] = offline) {
  const found = createToolPack(options).tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(() => clearFetchCache());

describe('snapshot data', () => {
  it('has sources, retrieval date and reasonable size', () => {
    for (const file of ['endpoints.json', 'sdk-versions.json', 'docs-index.json']) {
      const path = new URL(`./tools-data/${file}`, import.meta.url);
      expect(statSync(path).size).toBeLessThan(300_000);
      const data = JSON.parse(readFileSync(path, 'utf8')) as { retrieved: string };
      expect(data.retrieved).toBe('2026-11-01');
    }
    const endpoints = loadEndpoints();
    expect(endpoints.source.length).toBeGreaterThan(0);
    expect(endpoints.products.length).toBeGreaterThan(40);
    for (const p of endpoints.products) expect(p.sources.length).toBeGreaterThan(0);
    expect(loadSdkVersions().libraries.map((l) => l.id)).toEqual([
      'twilio-node',
      'twilio-python',
      'twilio-ruby',
      'twilio-php',
      'twilio-java',
      'twilio-csharp',
      'twilio-go',
    ]);
  });

  it('has a docs index with enough pages', () => {
    const index = JSON.parse(
      readFileSync(new URL('./tools-data/docs-index.json', import.meta.url), 'utf8'),
    ) as { provider: string; pages: { url: string; passages: string[] }[] };
    expect(index.provider).toBe('twilio');
    expect(index.pages.length).toBeGreaterThanOrEqual(15);
    for (const page of index.pages) expect(page.passages.length).toBeGreaterThan(0);
  });
});

describe('parseTarget', () => {
  it('reads URLs, bare paths and SDK chains', () => {
    expect(parseTarget('https://verify.twilio.com/v2/Services/VA1/Verifications?x=1')).toEqual({
      kind: 'url',
      host: 'verify.twilio.com',
      path: '/v2/Services/VA1/Verifications',
    });
    expect(parseTarget('/2010-04-01/Accounts/AC1/Calls.json').host).toBe('api.twilio.com');
    const sdk = parseTarget('client.verify.v2.services("VA1").verifications.create({to})');
    expect(sdk).toMatchObject({
      kind: 'sdk',
      domain: 'verify',
      version: 'v2',
      resources: ['services', 'verifications'],
      method: 'POST',
    });
    expect(parseTarget('$twilio->messages->create($to, [])')).toMatchObject({
      domain: 'messages',
      method: 'POST',
    });
    expect(parseTarget('').kind).toBe('unknown');
  });
});

describe('twilio_endpoint_lookup', () => {
  it('matches a 2010 API URL and its methods', async () => {
    const out = await tool('twilio_endpoint_lookup').run(
      { query: 'https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json', method: 'post' },
      ctx,
    );
    expect(out).toContain('[api]');
    expect(out).toContain('/2010-04-01/Accounts/{AccountSid}/Messages.json');
    expect(out).toContain('POST is listed');
    expect(out).toContain('client.api.v2010');
  });

  it('accepts endpoint and call as aliases for query', async () => {
    const out = await tool('twilio_endpoint_lookup').run(
      { endpoint: 'https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json' },
      ctx,
    );
    expect(out).toContain('[api]');
    const call = await tool('twilio_endpoint_lookup').run({ call: 'client.messages.create' }, ctx);
    expect(call).toContain('Messages');
  });

  it('flags a method that a path does not have', async () => {
    const out = await endpointLookup('https://verify.twilio.com/v2/Services/VA1/Verifications', {
      ...offline,
      method: 'DELETE',
    });
    expect(out).toContain('DELETE is NOT listed');
  });

  it('reports Programmable Chat as end-of-life with Conversations as target', async () => {
    const out = await endpointLookup('chat.twilio.com/v2', offline);
    expect(out).toContain('end-of-life');
    expect(out).toContain('Conversations');
    expect(out).not.toContain('A higher version');
  });

  it('reports Notify EOL and the preview host', async () => {
    expect(await endpointLookup('notify.twilio.com/v1', offline)).toContain('2025-12-31');
    expect(await endpointLookup('preview.twilio.com', offline)).toContain(
      'Product status: preview',
    );
  });

  it('keeps Video current (EOL reversed)', async () => {
    const out = await endpointLookup('https://video.twilio.com/v1/Rooms', offline);
    expect(out).toContain('Product status: current');
    expect(out).toContain('REVERSED');
  });

  it('handles legacy hosts not in the OAI spec', async () => {
    const old = await endpointLookup(
      'https://api.twilio.com/2008-08-01/Accounts/AC1/SMS/Messages',
      offline,
    );
    expect(old).toContain('2023-12-15');
    expect(await endpointLookup('fax.twilio.com/v1/Faxes', offline)).toContain('2021-12-17');
    expect(
      await endpointLookup('https://api.authy.com/protected/json/users/new', offline),
    ).toContain('Verify v2');
  });

  it('resolves SDK shortcuts and versioned SDK calls', async () => {
    const shortcut = await endpointLookup('client.messages.create', offline);
    expect(shortcut).toContain('shortcut for client.api.v2010');
    expect(shortcut).toContain('/2010-04-01/Accounts/{AccountSid}/Messages.json');

    const verify = await endpointLookup(
      'client.verify.v2.services(sid).verifications.create',
      offline,
    );
    expect(verify).toMatch(/- POST \/v2\/Services\/\{ServiceSid\}\/Verifications\n/);

    const lookups = await endpointLookup('client.lookups.v1.phoneNumbers("+1").fetch', offline);
    expect(lookups).toContain('Version v1 status: deprecated');
    expect(lookups).toContain('A higher version (v2)');

    expect(await endpointLookup('client.api.v2010', offline)).toContain('path templates in v2010');
    expect(await endpointLookup('client.chat.v2', offline)).toContain('end-of-life');
  });

  it('gives best-effort answers for unknown input instead of refusing', async () => {
    const host = await endpointLookup('https://newthing.twilio.com/v1/Foo', offline);
    expect(host).toContain('not in the Twilio snapshot');
    expect(host).toContain('twilio-oai');
    const domain = await endpointLookup('client.verfy.v2.services', offline);
    expect(domain).toContain('Did you mean');
    const path = await endpointLookup('https://verify.twilio.com/v2/Servics', offline);
    expect(path).toContain('did not match');
    const version = await endpointLookup('https://verify.twilio.com/v9/Services', offline);
    expect(version).toContain('not in the snapshot');
    expect(await tool('twilio_endpoint_lookup').run({}, ctx)).toContain('Pass "query"');
    expect(await endpointLookup('???', offline)).toContain('Could not read');
  });

  it('checks the live OAI spec through an injected fetch and caches it on disk', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'twilio-oai-test-'));
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(url);
      expect(init?.method ?? 'GET').toBe('GET');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ paths: { '/v2/Services/{ServiceSid}/Verifications': { post: {} } } }),
      };
    };
    const lookup = tool('twilio_endpoint_lookup', { fetch, cacheDir });
    const out = await lookup.run(
      { query: 'https://verify.twilio.com/v2/Services/VA1/Verifications', method: 'POST' },
      ctx,
    );
    expect(calls[0]).toContain('twilio_verify_v2.json');
    expect(out).toContain('Live OAI check');
    expect(out).toContain('POST present');

    clearFetchCache();
    const version = loadEndpoints().products.find((p) => p.id === 'verify')!.versions[0];
    const cached = await fetchOaiPaths(version, { fetch, cacheDir });
    expect(cached.ok && cached.from).toContain('cached');
    expect(calls.length).toBe(1);
  });

  it('survives a failing live fetch', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('network down');
    };
    const out = await endpointLookup('https://verify.twilio.com/v2/Services', {
      fetch,
      cacheDir: mkdtempSync(join(tmpdir(), 'twilio-oai-fail-')),
    });
    expect(out).toContain('Verify');
    expect(out).toContain('Live OAI check skipped');
  });
});

describe('twilio_sdk_versions', () => {
  it('lists breaking changes since an old twilio-node', async () => {
    const out = await tool('twilio_sdk_versions').run(
      { package: 'twilio', version: '^3.84.1' },
      ctx,
    );
    expect(out).toContain('3 major version(s) behind');
    expect(out).toContain('4.0.0');
    expect(out).toContain('IpMessagingGrant');
    expect(out).toContain('Node.js raised to 20');
    expect(out).toContain('UPGRADE.md');
  });

  it('handles python, java and current majors', async () => {
    const py = await sdkVersions('twilio-python', '7.16.0', offline);
    expect(py).toContain('available_phone_number_country');
    expect(py).not.toContain('\n7.0.0');
    const java = await sdkVersions('com.twilio.sdk', '11.0.0', offline);
    expect(java).toContain('SecureDigestAlgorithm');
    expect(await sdkVersions('go', 'v1.20.0', offline)).toContain('current major');
  });

  it('covers client SDK notes, unknown packages and no package', async () => {
    expect(await sdkVersions('twilio-video', undefined, offline)).toContain('NOT end-of-life');
    expect(await sdkVersions('authy', undefined, offline)).toContain('Verify');
    expect(await sdkVersions('twilo-nod', undefined, offline)).toContain('not one of');
    expect(await sdkVersions(undefined, undefined, offline)).toContain('twilio-csharp');
    expect(await sdkVersions('twilio-ruby', 'latest', offline)).toContain('Could not read a major');
    expect(await sdkVersions('twilio-php', '99.0.0', offline)).toContain('newer than');
  });

  it('adds the latest GitHub release when online (stubbed)', async () => {
    const fetch: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('twilio-node')
          ? JSON.stringify({ tag_name: '6.9.9', published_at: '2026-10-30T00:00:00Z' })
          : '{}',
    });
    const out = await sdkVersions('node', '5.0.0', { fetch });
    expect(out).toContain('Live: latest GitHub release is 6.9.9 (2026-10-30)');
  });

  it('parses versions and aliases', () => {
    expect(parseMajor('^4.23.0')).toBe(4);
    expect(parseMajor('~> 7.1')).toBe(7);
    expect(parseMajor('v1.2.3')).toBe(1);
    expect(parseMajor('latest')).toBeUndefined();
    expect(findLibrary(loadSdkVersions(), 'twilio/sdk')?.id).toBe('twilio-php');
    expect(findLibrary(loadSdkVersions(), 'C#')?.id).toBe('twilio-csharp');
  });
});

describe('toolpack', () => {
  it('exposes the tools, search_docs and every playbook kind', async () => {
    expect(toolPack.provider).toBe('twilio');
    const names = toolPack.tools.map((t) => t.name);
    expect(names).toEqual(['twilio_endpoint_lookup', 'twilio_sdk_versions', 'twilio_search_docs']);
    for (const name of names) expect(name).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(Object.keys(toolPack.playbooks).sort()).toEqual(
      [
        'api-version',
        'auth-change',
        'endpoint-removed',
        'field-removed',
        'field-renamed',
        'model-retirement',
        'other',
        'pagination-or-limits',
        'product-shutdown',
        'rest-to-graphql',
        'sdk-major',
        'webhook-payload',
      ].sort(),
    );
    const meta = loadPlaybookMeta(new URL('./playbooks/', import.meta.url));
    for (const m of Object.values(meta)) {
      expect(m.provider).toBe('twilio');
      expect(m.reviewed).toBe('false');
    }
  });

  it('search_docs finds snapshot passages offline', async () => {
    const search = tool('twilio_search_docs');
    const sig = await search.run({ query: 'X-Twilio-Signature webhook validation' }, ctx);
    expect(sig).toContain('webhooks-security');
    const page = await search.run({ query: 'next_page_uri PageSize pagination' }, ctx);
    expect(page).toContain('twilios-response');
    const video = await search.run({ query: 'Video end of life reversed' }, ctx);
    expect(video).toContain('standalone');
  });

  it('search_docs uses live pages through an injected fetch', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => '<p>Live: rotate with the AuthTokens Promote endpoint zebra-marker.</p>',
    });
    const out = await tool('twilio_search_docs', { fetch }).run(
      { query: 'auth token promote rotation zebra-marker' },
      ctx,
    );
    expect(out).toContain('(live)');
  });
});
