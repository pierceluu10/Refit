import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProviders } from './agent-catalog.ts';
import {
  cloudflarePathKey,
  loadCloudflareEndpoints,
  scanCloudflareCalls,
  type CloudflareCall,
} from './cloudflare-calls.ts';
import { deadlineTitle } from './deadline-alerts.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { checkDeadlineRegistry, loadDeadlineRegistry } from './deadline-registry.ts';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const NOW = new Date('2026-10-22T00:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(
  files: Record<string, string>,
  manifest: object = { name: 'app', dependencies: { cloudflare: '^4.5.0' } },
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-cloudflare-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify(manifest, null, 2),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

async function scan(files: Record<string, string>, manifest?: object) {
  return scanCloudflareCalls(await repository(files, manifest), { now: NOW });
}

function summary(found: CloudflareCall[]) {
  return found.map(
    (call) => `${call.line} ${call.kind} ${call.property ?? '-'} ${call.method} ${call.path}`,
  );
}

function at(found: CloudflareCall[], line: number) {
  const call = found.find((item) => item.line === line);
  expect(call, `line ${line}`).toBeDefined();
  return call!;
}

describe('recorded endpoints', () => {
  it('pins the SDK releases, OpenAPI document and deprecations page it was built from', async () => {
    const data = await loadCloudflareEndpoints();
    expect(data.releases).toEqual(['3.5.0', '4.5.0', '5.2.0', '6.5.0', '7.3.0']);
    expect(data.properties.get('zones.settings.edit')).toEqual([
      {
        method: 'PATCH',
        path: '/zones/{zone_id}/settings/{settingID}',
        releases: '3.5.0..7.3.0',
      },
    ]);
    // `getAPIList(path, Page, { method: 'post' })` pages through a POST.
    expect(data.properties.get('d1.database.raw')).toEqual([
      {
        method: 'POST',
        path: '/accounts/{account_id}/d1/database/{databaseID}/raw',
        releases: '3.5.0..7.3.0',
      },
    ]);
    expect(data.sources.openapi.sha256).toBe(
      '528bae360f1cb45296ebd60b67571c1146b1b50b07b1cb74bf6b3cff7c2534ca',
    );
    expect(data.notices.get('GET /zones/{}/settings')?.map((notice) => notice.title)).toEqual([
      'Zone Settings Batch API',
      'Zone Setting: cname_flattening',
    ]);
    // "`GET` and `POST /accounts/…`" lists two methods for one path.
    expect(data.notices.get('POST /accounts/{}/workers/namespaces')?.[0]).toMatchObject({
      title: 'Workers KV: Legacy Namespace Routes',
      change: 'deprecated',
      endOfLife: '2026-10-15',
    });
    // A request shape the page retires, not the endpoint.
    expect(data.notices.get('POST /accounts/{}/gateway/rules')?.[0].change).toBe('affected');
    expect(cloudflarePathKey('GET', '/zones/{zone_identifier}/analytics/colos/')).toBe(
      'GET /zones/{}/analytics/colos',
    );
  });
});

describe('cloudflare SDK', () => {
  it('maps client methods to endpoints through variables, properties and functions', async () => {
    const { calls } = await scan({
      'src/dns.ts': `import Cloudflare from 'cloudflare';
const client = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });
export const zones = () => client.zones.list();
export class Dns {
  private cf = new Cloudflare();
  constructor(private readonly injected: Cloudflare) {}
  add(zone_id: string) { return this.cf.dns.records.create({ zone_id, type: 'A' }); }
  settings(zone_id: string) { return this.injected.zones.settings.get('ssl', { zone_id }); }
}
function make(): Cloudflare { return new Cloudflare(); }
make().radar.http.top.browser({});
export const raw = (id: string) => client.get(\`/zones/\${id}/settings\`);
client.zones.inventedMethod();
`,
      'src/require.js': `const Cloudflare = require('cloudflare');
const cf = new Cloudflare({ apiToken });
cf.accounts.roles.list({ account_id });
`,
    });
    expect(summary(calls)).toEqual([
      '3 sdk zones.list GET /zones',
      '7 sdk dns.records.create POST /zones/{zone_id}/dns_records',
      '8 sdk zones.settings.get GET /zones/{zone_id}/settings/{settingID}',
      '11 sdk radar.http.top.browser GET /radar/http/top/browser',
      '12 sdk - GET /zones/{id}/settings',
      '13 sdk zones.inventedMethod null null',
      '3 sdk accounts.roles.list GET /accounts/{account_id}/roles',
    ]);
    const dns = calls.filter((call) => call.file === 'src/dns.ts');
    expect(at(dns, 11).notices).toEqual([
      {
        source: 'deprecations-page',
        title: 'Cloudflare Radar: Top browsers and NetFlows summary endpoints',
        change: 'deprecated',
        deprecationDate: '2026-10-02',
        endOfLife: '2027-04-02',
      },
    ]);
    expect(at(dns, 12).notices.map((notice) => notice.change)).toEqual(['deprecated', 'affected']);
    expect(at(dns, 13).notes).toEqual([
      '`zones.inventedMethod` is not a method of any recorded cloudflare release (3.5.0 to 7.3.0)',
    ]);
  });

  it('maps each method as the locked major defines it, and flags an unknown major', async () => {
    const files = {
      'src/vectors.ts': `import Cloudflare from 'cloudflare';
const client = new Cloudflare();
client.vectorize.indexes.query('docs', { account_id, vector });
`,
    };
    const v3 = await scan(files, { name: 'app', dependencies: { cloudflare: '^3.4.0' } });
    expect(summary(v3.calls)).toEqual([
      '3 sdk vectorize.indexes.query POST /accounts/{account_id}/vectorize/indexes/{indexName}/query',
    ]);
    expect(v3.calls[0].unknown).toEqual([]);
    const v4 = await scan(files);
    expect(summary(v4.calls)).toEqual([
      '3 sdk vectorize.indexes.query POST /accounts/{account_id}/vectorize/v2/indexes/{indexName}/query',
    ]);
    const mixed = await scan({
      ...files,
      'package.json': JSON.stringify({
        name: 'app',
        workspaces: ['tools'],
        dependencies: { cloudflare: '^3.4.0' },
      }),
      'tools/package.json': JSON.stringify({
        name: 'tools',
        dependencies: { cloudflare: '^5.0.0' },
      }),
    });
    expect(summary(mixed.calls)).toEqual([
      '3 sdk vectorize.indexes.query POST /accounts/{account_id}/vectorize/v2/indexes/{indexName}/query',
    ]);
    expect(mixed.calls[0].unknown).toEqual([
      'the endpoint differs across cloudflare releases and the locked major is unknown; mapped as in 7.3.0',
    ]);
  });

  it('reports 2.x factory clients without mapping their methods', async () => {
    const { calls } = await scan(
      {
        'index.js': `const cf = require('cloudflare')({ token: process.env.CF_TOKEN });
cf.zones.browse();
cf.dnsRecords.add(zoneId, record);
`,
      },
      { name: 'app', dependencies: { cloudflare: '^2.9.1' } },
    );
    expect(summary(calls)).toEqual([
      '2 sdk zones.browse null null',
      '3 sdk dnsRecords.add null null',
    ]);
    expect(calls[0].notes).toEqual([
      'cloudflare 2.x is the earlier hand-written client; its methods are not mapped to endpoints',
    ]);
  });

  it('ignores other modules and untyped parameters', async () => {
    const { calls } = await scan({
      'src/other.ts': `import Cloudflare from './my-cloudflare';
new Cloudflare().zones.list();
export const run = (client) => client.zones.list();
`,
    });
    expect(calls).toEqual([]);
  });
});

describe('clients reached across files', () => {
  it('follows exported aliases, client functions and inherited client methods', async () => {
    const { calls } = await scan({
      'src/client.ts': `import Cloudflare from 'cloudflare';
export type { Cloudflare };
export type CloudflareApiClient = Cloudflare;
export const createClient = (apiToken: string): CloudflareApiClient => new Cloudflare({ apiToken });
export class Manager {
  protected getClient(): Cloudflare { return new Cloudflare(); }
}
`,
      'src/resources.ts': `import type { Cloudflare } from './client';
import { createClient } from './client';
export const query = (client: Cloudflare, id: string) => client.d1.database.query(id, {});
export const accounts = () => createClient('t').accounts.list();
`,
      'src/images.ts': `import { Manager } from './client';
export class Images extends Manager {
  list() { return this.getClient().images.v2.list({ account_id }); }
}
export class Other { list() { return this.getClient().images.v2.list({}); } }
`,
    });
    expect(summary(calls)).toEqual([
      '3 sdk images.v2.list GET /accounts/{account_id}/images/v2',
      '3 sdk d1.database.query POST /accounts/{account_id}/d1/database/{databaseID}/query',
      '4 sdk accounts.list GET /accounts',
    ]);
  });

  it('skips clients pointed at another host', async () => {
    const { calls } = await scan({
      'src/local.ts': `import Cloudflare from 'cloudflare';
const local = new Cloudflare({ baseURL: new URL('/client/v4', process.env.BASE).href });
const real = new Cloudflare({ baseURL: 'https://api.cloudflare.com/client/v4' });
local.accounts.list();
real.accounts.list();
`,
    });
    expect(summary(calls)).toEqual(['5 sdk accounts.list GET /accounts']);
  });
});

describe('raw API requests', () => {
  it('reads the method and path of requests to api.cloudflare.com/client/v4', async () => {
    const { calls } = await scan({
      'src/api.js': `import axios from 'axios';
const BASE = 'https://api.cloudflare.com/client/v4';
export async function run(zone, account, path) {
  await fetch(\`\${BASE}/zones/\${zone}/analytics/dashboard?since=-60\`);
  await fetch(\`https://api.cloudflare.com/client/v4/accounts/\${account}/gateway/rules\`, { method: 'POST' });
  await axios.patch(\`\${BASE}/zones/\${zone}/settings\`, body);
  await fetch(\`\${BASE}\${path}\`);
  await cfRequest(BASE);
}
`,
    });
    expect(summary(calls)).toEqual([
      '4 url - GET /zones/{zone}/analytics/dashboard',
      '5 url - POST /accounts/{account}/gateway/rules',
      '6 url - PATCH /zones/{zone}/settings',
      '7 url - GET null',
      '8 url - null null',
    ]);
    expect(at(calls, 4).notices[0]).toMatchObject({
      title: 'Zone Analytics API',
      change: 'deprecated',
    });
    expect(at(calls, 5).notices).toEqual([
      expect.objectContaining({ title: 'Gateway Audit SSH rules', change: 'affected' }),
    ]);
    expect(at(calls, 7).unknown).toEqual(['path is built at runtime from `path`']);
    expect(at(calls, 8).unknown).toEqual([
      'the base URL is passed to `cfRequest`; requests built from it are not traced',
    ]);
  });

  it('follows request options objects and new URL(…) to the request', async () => {
    const { calls } = await scan({
      'src/n8n.ts': `export async function run(this: Ctx, zoneId: string, accountId: string, endpoint: string, method: string) {
  const options = {
    method: 'POST' as const,
    url: \`https://api.cloudflare.com/client/v4/zones/\${zoneId}/dns_records/import\`,
  };
  await this.helpers.httpRequestWithAuthentication.call(this, 'cloudflareApi', options);
  const buckets = \`https://api.cloudflare.com/client/v4/accounts/\${accountId}/r2/buckets\`;
  const list = new URL(\`\${buckets}\`);
  await fetch(list);
  await request({ method, url: \`https://api.cloudflare.com/client/v4\${endpoint}\` });
}
`,
    });
    expect(
      calls.map((call) => [call.line, call.client, call.method, call.path, call.unknown]),
    ).toEqual([
      [
        6,
        'this.helpers.httpRequestWithAuthentication.call',
        'POST',
        '/zones/{zoneId}/dns_records/import',
        [],
      ],
      [9, 'fetch', 'GET', '/accounts/{accountId}/r2/buckets', []],
      [
        10,
        'request',
        null,
        null,
        ['path is built at runtime from `endpoint`', 'HTTP method is chosen at runtime'],
      ],
    ]);
  });

  it('separates tests from live code', async () => {
    const { calls } = await scan({
      'test/api.test.ts': "fetch('https://api.cloudflare.com/client/v4/user/organizations');\n",
    });
    expect(calls.map((call) => [call.use, call.notices[0]?.source])).toEqual([['test', 'openapi']]);
  });
});

describe('Workers compatibility', () => {
  it('reads dates and flags from wrangler.toml, wrangler.json and wrangler.jsonc', async () => {
    const { workers } = await scan({
      'worker/wrangler.toml': `name = "api"
main = "src/index.ts"
compatibility_date = "2024-01-15" # pinned
compatibility_flags = [
  "nodejs_compat",
  "not_a_real_flag",
]
[vars]
compatibility_date = "1999-01-01"
[env.staging]
compatibility_date = "2026-09-01"
`,
      'site/wrangler.jsonc': `{
  // Pages project
  "name": "site",
  "compatibility_date": "2026-10-01",
  "env": { "preview": { "compatibility_date": "2025-01-01", "compatibility_flags": ["nodejs_als"] } }
}
`,
      'bare/wrangler.json':
        '{ "name": "bare", "main": "index.js", "compatibility_flags": ["nodejs_compat"] }\n',
      'node_modules/pkg/wrangler.toml': 'compatibility_date = "2020-01-01"\n',
      'test/fixture/wrangler.toml': 'compatibility_date = "2024-02-01"\n',
    });
    expect(
      workers.map((item) => [
        item.file,
        item.line,
        item.environment,
        item.compatibilityDate,
        item.flags,
        item.ageDays,
      ]),
    ).toEqual([
      ['bare/wrangler.json', 1, null, null, ['nodejs_compat'], null],
      ['site/wrangler.jsonc', 4, null, '2026-10-01', [], 21],
      ['site/wrangler.jsonc', 5, 'preview', '2025-01-01', ['nodejs_als'], 659],
      ['test/fixture/wrangler.toml', 1, null, '2024-02-01', [], 994],
      ['worker/wrangler.toml', 3, null, '2024-01-15', ['nodejs_compat', 'not_a_real_flag'], 1011],
      ['worker/wrangler.toml', 11, 'staging', '2026-09-01', [], 51],
    ]);
    expect(workers.map((item) => item.use)).toEqual([
      'live',
      'live',
      'live',
      'test',
      'live',
      'live',
    ]);
    expect(workers[0].notes).toEqual([
      'no compatibility_date; Cloudflare uses the oldest date (2021-11-02) when an upload sets none',
    ]);
    expect(workers[4].notes).toEqual([
      'the compatibility date is 1011 days old (more than a year)',
      "`not_a_real_flag` is not on Cloudflare's compatibility flags page",
    ]);
    expect(workers[1].notes).toEqual([]);
    // Flags on by default only for dates after each Worker's date.
    expect(workers[4].laterDefaults).toContain('allow_custom_ports');
    expect(workers[5].laterDefaults).not.toContain('allow_custom_ports');
  });
});

describe('inventory and deadlines', () => {
  it('lists the package and the catalog detects Cloudflare', async () => {
    const root = await repository({
      'src/a.ts': "fetch('https://api.cloudflare.com/client/v4/zones');\n",
    });
    const result = await scanCloudflareCalls(root, { now: NOW });
    expect(result.packages.map((item) => `${item.name}@${item.declared}`)).toEqual([
      'cloudflare@^4.5.0',
    ]);
    const cloudflare = (await detectProviders(root)).find((item) => item.agent.id === 'cloudflare');
    expect(cloudflare?.packages.map((item) => item.name)).toEqual(['cloudflare']);
    expect(cloudflare?.hostnames).toEqual([
      expect.objectContaining({ file: 'src/a.ts', line: 1, hostname: 'api.cloudflare.com' }),
    ]);
  });

  it('matches retired endpoints in the registry with file and line', async () => {
    const root = await repository({
      'src/kv.ts': `import Cloudflare from 'cloudflare';
const client = new Cloudflare();
const KV = 'https://api.cloudflare.com/client/v4';
export const list = (account: string) => fetch(\`\${KV}/accounts/\${account}/workers/namespaces\`);
export const settings = (zone_id: string) => client.get(\`/zones/\${zone_id}/settings\`);
`,
    });
    const result = await scanDeadlines(root, await loadDeadlineRegistry(), NOW);
    expect(
      result.exposures.map((exposure) => [
        exposure.deadline.id,
        exposure.days,
        exposure.evidence.map((item) => `${item.file}:${item.line} ${item.version}`),
      ]),
    ).toEqual([
      [
        'cloudflare-kv-legacy-namespace-routes',
        -7,
        ['src/kv.ts:4 GET /accounts/{account_id}/workers/namespaces'],
      ],
      ['cloudflare-zone-settings-batch', 160, ['src/kv.ts:5 GET /zones/{zone_id}/settings']],
    ]);
    expect(deadlineTitle(result.exposures[1])).toBe(
      'Cloudflare endpoint GET /zones/{zone_id}/settings reaches its sunset on 2027-03-31',
    );
  });

  it('accepts endpoint entries', () => {
    const entry = {
      id: 'cloudflare-x',
      provider: 'cloudflare',
      kind: 'endpoint',
      versions: ['GET /zones'],
      date: '2027-01-01',
      summary: 'x',
      replacement: null,
      source: 'https://example.com',
      checkedAt: '2026-10-22',
    };
    expect(checkDeadlineRegistry({ formatVersion: 1, deadlines: [entry] }, NOW).errors).toEqual([]);
  });
});

it('prints requests, Workers settings and JSON from the CLI', async () => {
  const root = await repository({
    'src/a.ts': "fetch('https://api.cloudflare.com/client/v4/radar/verified_bots/top/bots');\n",
    'wrangler.toml': 'compatibility_date = "2024-01-15"\n',
  });
  const text = (await execute(process.execPath, [CLI, 'cloudflare', '--repository', root])).stdout;
  expect(text).toContain('1 request in live code, 1 to a deprecated endpoint.');
  expect(text).toContain('src/a.ts:1  GET /radar/verified_bots/top/bots');
  expect(text).toContain(
    'Deprecated Cloudflare Radar: Verified Bots APIs, end of life 2026-01-01 (deprecations page)',
  );
  expect(text).toContain('wrangler.toml:1  2024-01-15');
  const json = JSON.parse(
    (await execute(process.execPath, [CLI, 'cloudflare', '--repository', root, '--json'])).stdout,
  );
  expect(json.calls).toHaveLength(1);
  expect(json.workers[0].compatibilityDate).toBe('2024-01-15');
});
