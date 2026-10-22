import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectApiHosts, excludedHost, loadApiHosts, providerOf } from './api-hosts.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scan(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-api-hosts-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'app' }),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return detectApiHosts(root, {
    list: [
      {
        host: 'api.github.com',
        provider: 'GitHub',
        docs: 'https://docs.github.com/en/rest',
        source: 'https://docs.github.com/en/rest',
        checkedAt: '2026-10-22',
      },
      {
        host: 'cdn.contentful.com',
        provider: 'Contentful',
        docs: 'https://www.contentful.com/developers/docs/references/content-delivery-api/',
        source: 'https://www.contentful.com/developers/docs/references/content-delivery-api/',
        checkedAt: '2026-10-22',
      },
      {
        host: '*.supabase.co',
        provider: 'Supabase',
        docs: 'https://supabase.com/docs',
        source: 'https://supabase.com/docs',
        checkedAt: '2026-10-22',
      },
    ],
  });
}

const hosts = async (files: Record<string, string>) =>
  (await scan(files)).hosts.map((host) => host.host);

describe('detectApiHosts clients', () => {
  it('reads fetch with a literal URL and reports its line, path prefix and provider', async () => {
    const { hosts: found } = await scan({
      'src/a.ts': `export async function load() {\n  const r = await fetch('https://api.github.com/repos/x/y');\n  return r.json();\n}\n`,
    });
    expect(found).toHaveLength(1);
    expect(found[0].host).toBe('api.github.com');
    expect(found[0].provider).toMatchObject({ name: 'GitHub', origin: 'api-hosts' });
    expect(found[0].calls[0]).toMatchObject({
      file: 'src/a.ts',
      line: 2,
      client: 'fetch',
      pathPrefix: '/repos/x/y',
    });
  });

  it('reads axios calls, axios({ url }) and axios.create({ baseURL })', async () => {
    const { hosts: found } = await scan({
      'src/a.js': `const axios = require('axios');
axios.get('https://api.openweathermap.org/data/2.5/weather');
axios({ method: 'post', url: 'https://hooks.example-chat.io/services/T0' });
const api = axios.create({ baseURL: 'https://api.thecatapi.com/v1' });
api.get('/images');
api.get('https://api.dogs.example-pets.io/breeds');
axios.defaults.baseURL = 'https://backend.acme-cloud.dev/api/';
`,
    });
    expect(found.map((host) => host.host).sort()).toEqual([
      'api.dogs.example-pets.io',
      'api.openweathermap.org',
      'api.thecatapi.com',
      'backend.acme-cloud.dev',
      'hooks.example-chat.io',
    ]);
    expect(found.find((host) => host.host === 'api.thecatapi.com')!.calls[0].pathPrefix).toBe(
      '/v1',
    );
    expect(found.find((host) => host.host === 'backend.acme-cloud.dev')!.calls[0].pathPrefix).toBe(
      '/api',
    );
  });

  it('reads got, ky, undici and superagent', async () => {
    expect(
      await hosts({
        'a.ts': `import got from 'got';\nawait got('https://got.vendor-one.com/a');\nconst client = got.extend({ prefixUrl: 'https://ext.vendor-one.com/v2' });\n`,
        'b.ts': `import ky from 'ky';\nky.get('https://ky.vendor-two.com/x').json();\n`,
        'c.ts': `import { request, fetch as ufetch } from 'undici';\nawait request('https://undici.vendor-three.com/y');\nawait ufetch('https://undici-fetch.vendor-three.com/z');\n`,
        'd.js': `const superagent = require('superagent');\nsuperagent.post('https://super.vendor-four.com/w').send({});\n`,
      }).then((list) => list.sort()),
    ).toEqual([
      'ext.vendor-one.com',
      'got.vendor-one.com',
      'ky.vendor-two.com',
      'super.vendor-four.com',
      'undici-fetch.vendor-three.com',
      'undici.vendor-three.com',
    ]);
  });

  it('reads node:http and node:https calls with a URL or with options', async () => {
    expect(
      await hosts({
        'a.js': `const https = require('node:https');
https.get('https://httpget.vendor-five.com/ping', (res) => res.resume());
https.request({ hostname: 'optreq.vendor-five.com', path: '/v1/things', method: 'POST' }, () => {});
`,
        'b.ts': `import * as http from 'http';\nhttp.request('http://plain.vendor-six.com/x');\n`,
      }).then((list) => list.sort()),
    ).toEqual(['httpget.vendor-five.com', 'optreq.vendor-five.com', 'plain.vendor-six.com']);
  });

  it('reads calls on a client held in a class property', async () => {
    expect(
      await hosts({
        'a.ts': `import axios from 'axios';
class Service {
  http = axios.create({ timeout: 100 });
  load() { return this.http.get('https://prop.vendor-seven.com/items'); }
}
`,
      }),
    ).toEqual(['prop.vendor-seven.com']);
  });

  it('ignores calls that are not an HTTP client', async () => {
    expect(
      await hosts({
        'a.ts': `const cache = new Map();\ncache.get('https://cache.vendor-eight.com/x');\nlogger.request('https://log.vendor-eight.com');\nconst fetch = (u) => u;\nfetch('https://shadow.vendor-eight.com');\n`,
      }),
    ).toEqual([]);
  });
});

describe('detectApiHosts URL forms', () => {
  it('resolves templates, constants, concatenation and imported constants', async () => {
    const { hosts: found } = await scan({
      'src/config.ts': `export const BASE = 'https://imported.vendor-nine.com/v3';\n`,
      'src/a.ts': `import { BASE } from './config';
const API = 'https://api.vendor-nine.com';
const { id } = props;
fetch(\`\${API}/users/\${id}\`);
fetch(API + '/things');
fetch(\`\${BASE}/list\`);
fetch(new URL('/search', 'https://url.vendor-nine.com'));
`,
    });
    const names = found.map((host) => host.host).sort();
    expect(names).toEqual([
      'api.vendor-nine.com',
      'imported.vendor-nine.com',
      'url.vendor-nine.com',
    ]);
    expect(found.find((host) => host.host === 'api.vendor-nine.com')!.count).toBe(2);
    expect(
      found.find((host) => host.host === 'imported.vendor-nine.com')!.calls[0].pathPrefix,
    ).toBe('/v3/list');
  });

  it('uses the literal default of an environment variable and skips one without', async () => {
    expect(
      await hosts({
        'a.ts': `const base = process.env.API_URL || 'https://default.vendor-ten.com';
fetch(base + '/x');
fetch(import.meta.env.VITE_URL ?? 'https://vite.vendor-ten.com/api');
fetch(process.env.ONLY_ENV + '/y');
fetch(\`https://\${region}.dynamic.vendor-ten.com/z\`);
`,
      }).then((list) => list.sort()),
    ).toEqual(['default.vendor-ten.com', 'vite.vendor-ten.com']);
  });

  it('reads an object-held URL and a ternary default', async () => {
    expect(
      await hosts({
        'a.ts': `const config = { apiUrl: 'https://cfg.vendor-eleven.com' };
fetch(config.apiUrl + '/x');
const url = isProd ? 'https://prod.vendor-eleven.com' : 'https://staging.vendor-eleven.com';
fetch(url);
`,
      }).then((list) => list.sort()),
    ).toEqual(['cfg.vendor-eleven.com', 'prod.vendor-eleven.com']);
  });

  it('maps wildcard hosts and untracked hosts to a provider', async () => {
    const { hosts: found } = await scan({
      'a.ts': `fetch('https://abcd.supabase.co/rest/v1/t');\nfetch('https://api.stripe.com/v1/charges');\nfetch('https://nobody.vendor-twelve.com/x');\n`,
    });
    const by = Object.fromEntries(found.map((host) => [host.host, host.provider]));
    expect(by['abcd.supabase.co']).toMatchObject({ name: 'Supabase', origin: 'api-hosts' });
    expect(by['api.stripe.com']).toMatchObject({ id: 'stripe', origin: 'catalog' });
    expect(by['nobody.vendor-twelve.com']).toBeNull();
  });
});

describe('detectApiHosts indirect forms', () => {
  it('reads the request library, with options held in a variable', async () => {
    const { hosts: found } = await scan({
      'a.js': `const request = require('request');
var url = 'https://old.vendor-fourteen.com/v1/' + id;
var options = { url: url, headers: { a: 'b' } };
request(options, () => {});
request.get('https://get.vendor-fourteen.com/x', () => {});
`,
    });
    expect(found.map((host) => host.host).sort()).toEqual([
      'get.vendor-fourteen.com',
      'old.vendor-fourteen.com',
    ]);
    expect(found.every((host) => host.calls[0].client === 'request')).toBe(true);
  });

  it('reads a let that is never reassigned and skips one that is', async () => {
    expect(
      await hosts({
        'a.ts': `import axios from 'axios';
let once = 'https://once.vendor-fifteen.com';
let twice = 'https://first.vendor-fifteen.com';
twice = other;
axios.get(once);
axios.get(twice);
`,
      }),
    ).toEqual(['once.vendor-fifteen.com']);
  });

  it('reads a class field set once, with the default of a constructor parameter', async () => {
    expect(
      await hosts({
        'a.ts': `import axios from 'axios';
class Api {
  private readonly apiUrl: string;
  constructor(url?: string) { this.apiUrl = url || 'https://field.vendor-sixteen.com'; }
  http() { return axios.create({ baseURL: this.apiUrl }); }
}
`,
      }),
    ).toEqual(['field.vendor-sixteen.com']);
  });

  it('reads a request on an untraced client or a request helper, only when used as a request', async () => {
    expect(
      await hosts({
        'a.ts': `const json = await client.request.post('https://held.vendor-seventeen.com/a', { json: {} }).json();
const text = await proxyFetch('https://wrap.vendor-seventeen.com/b');
cache.get('https://key.vendor-seventeen.com/c');
set.add(fetchedAt('https://date.vendor-seventeen.com/d'));
`,
      }).then((list) => list.sort()),
    ).toEqual(['held.vendor-seventeen.com', 'wrap.vendor-seventeen.com']);
  });

  it('reads URL objects and keeps documented API hosts that look like a CDN', async () => {
    const { hosts: found } = await scan({
      'a.ts': `const u = new URL('https://img.vendor-eighteen.com/p');
fetch(u.toString());
fetch('https://cdn.contentful.com/spaces/1');
`,
    });
    expect(found.map((host) => host.host)).toEqual(['cdn.contentful.com']);
  });
});

describe('detectApiHosts exclusions', () => {
  it('names and counts each exclusion', async () => {
    const result = await scan({
      'a.ts': `fetch('http://localhost:3000/api');
fetch('http://127.0.0.1:8080/x');
fetch('http://192.168.1.20/status');
fetch('http://10.0.0.5:9000/x');
fetch('http://172.20.0.3/x');
fetch('https://images.unsplash.com/photo-1?w=200');
fetch('https://cdn.vendor-thirteen.com/lib.js');
fetch('https://static.vendor-thirteen.com/logo.png');
fetch('https://www.w3.org/2001/XMLSchema');
fetch('https://json-schema.org/draft-07/schema');
fetch('https://api.example.com/v1');
fetch('https://real.vendor-thirteen.com/v1');
`,
      'test/a.test.ts': `fetch('https://intest.vendor-thirteen.com/x');\n`,
      'src/__tests__/b.ts': `fetch('https://intest2.vendor-thirteen.com/x');\n`,
      'fixtures/c.ts': `fetch('https://fixture.vendor-thirteen.com/x');\n`,
      'examples/d.js': `fetch('https://example-app.vendor-thirteen.com/x');\n`,
      'scripts/test-audit.mjs': `fetch('https://script-test.vendor-thirteen.com/x');\n`,
      'docs/e.ts': `fetch('https://docs-sample.vendor-thirteen.com/x');\n`,
    });
    expect(result.hosts.map((host) => host.host)).toEqual(['real.vendor-thirteen.com']);
    expect(result.excluded).toEqual({
      localhost: 2,
      'private-range': 3,
      'asset-url': 3,
      'schema-url': 2,
      placeholder: 1,
      'test-file': 5,
      'docs-file': 1,
    });
  });

  it('classifies hosts directly', () => {
    expect(excludedHost('localhost', null)).toBe('localhost');
    expect(excludedHost('api.local', null)).toBe('localhost');
    expect(excludedHost('172.15.0.1', null)).toBeUndefined();
    expect(excludedHost('172.16.0.1', null)).toBe('private-range');
    expect(excludedHost('169.254.169.254', null)).toBe('private-range');
    expect(excludedHost('api.vendor.com', '/logo.svg')).toBe('asset-url');
    expect(excludedHost('api.vendor.com', '/v1/items')).toBeUndefined();
  });
});

describe('the shipped host list', () => {
  it('has unique hosts that no catalog hostname already names', async () => {
    const list = await loadApiHosts();
    expect(new Set(list.map((entry) => entry.host)).size).toBe(list.length);
    for (const entry of list) {
      const mapped = providerOf(entry.host.replace(/^\*\./, 'x.'), list);
      expect(mapped?.origin, entry.host).not.toBe('catalog');
      expect(entry.docs, entry.host).toMatch(/^https:\/\//);
      expect(entry.source, entry.host).toMatch(/^https:\/\//);
      expect(entry.checkedAt, entry.host).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
