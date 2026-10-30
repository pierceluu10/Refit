import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSdkEdges, scanGraphCalls, splitFields, type GraphCall } from './meta-graph-calls.ts';

const execute = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('./fixtures/meta-graph', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>, manifest: object = { name: 'app' }) {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-graph-'));
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

async function calls(files: Record<string, string>, manifest?: object) {
  return (await scanGraphCalls(await repository(files, manifest))).calls;
}

function at(found: GraphCall[], file: string, line: number) {
  const call = found.find((item) => item.file === file && item.line === line);
  expect(call, `${file}:${line}`).toBeDefined();
  return call!;
}

describe('the fixture repository', () => {
  it('reports each raw and SDK request with what is known about it', async () => {
    const scan = await scanGraphCalls(FIXTURE);
    expect(scan.sdk).toMatchObject({
      version: 'v20.0',
      declared: '^20.0.2',
      locked: null,
      file: 'package.json',
      line: 6,
    });
    expect(
      scan.calls.map((call) => [call.file, call.line, call.method, call.version, call.path]),
    ).toEqual([
      ['__tests__/pages.ts', 4, null, 'v19.0', '/me/accounts'],
      ['src/ads/campaigns.js', 9, 'GET', 'v20.0', '/{AdAccount}/campaigns'],
      ['src/ads/campaigns.js', 10, 'POST', 'v20.0', '/{AdAccount}/campaigns'],
      ['src/ads/campaigns.js', 14, 'GET', 'v20.0', '/{Campaign}/adsets'],
      ['src/ads/campaigns.js', 15, 'GET', 'v20.0', '/{AdSet}'],
      ['src/pages.ts', 7, 'GET', 'v19.0', '/me/accounts'],
      ['src/pages.ts', 11, 'GET', 'v18.0', '/{pageId}'],
      ['src/pages.ts', 19, 'POST', 'v18.0', '/{pageId}/feed'],
      ['src/pages.ts', 27, 'GET', 'v18.0', '/{mediaId}/insights'],
      ['src/pages.ts', 32, 'GET', 'v18.0', '/{postId}/comments'],
      ['src/pages.ts', 38, 'GET', null, null],
      ['src/pages.ts', 42, 'GET', null, '/me'],
    ]);
  });

  it('follows an exported base through an import and an alias to its pin', async () => {
    const call = at((await scanGraphCalls(FIXTURE)).calls, 'src/pages.ts', 7);
    expect(call).toMatchObject({
      kind: 'url',
      client: 'graphGet',
      // graphGet passes its URL to fetch unchanged, with no options.
      method: 'GET',
      versionSource: 'constant',
      pin: { file: 'src/shared/graph.ts', line: 2 },
      edge: 'accounts',
      fields: ['id', 'name', 'access_token'],
      parameters: ['access_token', 'fields'],
    });
    expect(call.unknown).toEqual([]);
  });

  it('reads axios params and bodies, and a URL held in a variable', async () => {
    const found = (await scanGraphCalls(FIXTURE)).calls;
    expect(at(found, 'src/pages.ts', 11)).toMatchObject({
      client: 'axios.get',
      edge: null,
      fields: ['name', 'instagram_business_account{id,username}'],
      parameters: ['access_token', 'fields'],
      unknown: [],
    });
    // The request is made on line 19; the version is written on line 18.
    expect(at(found, 'src/pages.ts', 19)).toMatchObject({
      client: 'axios.post',
      pin: { file: 'src/pages.ts', line: 18 },
      edge: 'feed',
      fields: [],
      parameters: ['access_token', 'message'],
    });
    expect(at(found, 'src/pages.ts', 27)).toMatchObject({
      metrics: ['reach', 'saved'],
      fields: [],
      parameters: ['access_token', 'metric'],
    });
  });

  it('marks runtime fields, versions and edges unknown without guessing', async () => {
    const found = (await scanGraphCalls(FIXTURE)).calls;
    expect(at(found, 'src/pages.ts', 32)).toMatchObject({
      fields: null,
      pin: { file: 'src/pages.ts', line: 33 },
      unknown: ['`fields` is built at runtime'],
    });
    expect(at(found, 'src/pages.ts', 38)).toMatchObject({
      version: null,
      versionSource: 'unknown',
      pin: null,
      path: null,
      edge: null,
      unknown: [
        'version is built at runtime from `version`',
        'edge is built at runtime from `name`',
      ],
    });
    expect(at(found, 'src/pages.ts', 42)).toMatchObject({
      version: null,
      versionSource: 'unversioned',
      fields: ['id', 'name'],
    });
  });

  it('maps business SDK resource-class calls to Graph edges and fields', async () => {
    const found = (await scanGraphCalls(FIXTURE)).calls;
    expect(at(found, 'src/ads/campaigns.js', 9)).toMatchObject({
      kind: 'sdk',
      client: 'AdAccount.getCampaigns',
      versionSource: 'sdk-package',
      pin: { file: 'package.json', line: 6 },
      edge: 'campaigns',
      fields: ['name', 'status'],
      parameters: ['limit'],
    });
    expect(at(found, 'src/ads/campaigns.js', 10)).toMatchObject({
      client: 'AdAccount.createCampaign',
      fields: [],
      parameters: ['name', 'objective'],
    });
    expect(at(found, 'src/ads/campaigns.js', 14)).toMatchObject({
      client: 'Campaign.getAdSets',
      edge: 'adsets',
      fields: ['daily_budget'],
    });
    expect(at(found, 'src/ads/campaigns.js', 15)).toMatchObject({
      client: 'AdSet.get',
      fields: null,
      unknown: ["fields come from `process.env.FIELDS.split(',')` at runtime"],
    });
    // FacebookAdsApi.init is set-up, not a request.
    expect(found.some((call) => call.client?.includes('init'))).toBe(false);
  });

  it('keeps test files apart and never counts comments', async () => {
    const found = (await scanGraphCalls(FIXTURE)).calls;
    expect(found.filter((call) => call.use === 'test').map((call) => call.file)).toEqual([
      '__tests__/pages.ts',
    ]);
    // The commented-out v17.0 call on line 31 is not a request.
    expect(found.some((call) => call.version === 'v17.0')).toBe(false);
  });
});

describe('raw Graph requests', () => {
  it('decodes fields in the URL and reads fetch options', async () => {
    const [call] = await calls({
      'a.js': `fetch('https://graph.facebook.com/v21.0/me/accounts?fields=id%2Cname%2Cpicture.type(large)', {
  method: 'POST',
  body: JSON.stringify({ name: 'x' }),
});`,
    });
    expect(call).toMatchObject({
      method: 'POST',
      version: 'v21.0',
      edge: 'accounts',
      fields: ['id', 'name', 'picture.type(large)'],
      parameters: ['fields', 'name'],
      unknown: [],
    });
  });

  it('ignores line breaks in a template split over several lines', async () => {
    const [call] = await calls({
      'a.js': `fetch(\`https://graph.facebook.com/oauth/access_token
  ?client_id=\${id}
  &grant_type=client_credentials\`);`,
    });
    expect(call).toMatchObject({
      path: '/oauth/access_token',
      edge: 'access_token',
      parameters: ['client_id', 'grant_type'],
    });
  });

  it('reads string concatenation and a query a variable adds to a URL', async () => {
    const found = await calls({
      'a.js': `async function templates(id) {
  const url = 'https://graph.facebook.com/v17.0/' + id + '/message_templates';
  const query = new URLSearchParams({ fields: 'name,status', limit: '20' });
  return fetch(url + '?' + query);
}`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      line: 4,
      pin: { file: 'a.js', line: 2 },
      path: '/{id}/message_templates',
      edge: 'message_templates',
      fields: ['name', 'status'],
      parameters: ['fields', 'limit'],
    });
  });

  it('reads parameters set step by step under literal names', async () => {
    const [call] = await calls({
      'a.js': `async function post(page, caption) {
  const params = new URLSearchParams();
  params.set('fields', 'id');
  const body = { message: 'hi' };
  body.link = 'https://example.com';
  const form = new FormData();
  form.append('source', file);
  if (caption) form.append('caption', caption);
  await fetch(\`https://graph.facebook.com/v19.0/\${page}/photos\`, { method: 'POST', body: form });
  return fetch(\`https://graph.facebook.com/v19.0/\${page}/feed?\${params}\`, {
    method: 'POST',
    body: qs.stringify(body),
  });
}`,
    });
    expect(call).toMatchObject({
      edge: 'photos',
      method: 'POST',
      parameters: ['caption', 'source'],
      unknown: [],
    });
  });

  it('keeps fields set inside a nested block unknown', async () => {
    const [call] = await calls({
      'a.js': `async function read(page, wide) {
  const params = new URLSearchParams({ access_token: token });
  if (wide) params.set('fields', 'id,name');
  return fetch(\`https://graph.facebook.com/v19.0/\${page}?\${params.toString()}\`);
}`,
    });
    expect(call).toMatchObject({ fields: null, parameters: ['access_token', 'fields'] });
  });

  it('treats parameters that change after their declaration as unknown', async () => {
    const [call] = await calls({
      'a.js': `async function post(page, key) {
  const params = new URLSearchParams();
  params.set(key, 'id');
  const body = { message: 'hi' };
  delete body.message;
  return fetch(\`https://graph.facebook.com/v19.0/\${page}/feed?\${params}\`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}`,
    });
    expect(call).toMatchObject({ fields: null, parameters: null, edge: 'feed' });
    expect(call.unknown).toEqual([
      'query parameters in `params` are changed after it is declared',
      'body parameters in `body` are changed after it is declared',
    ]);
  });

  it('reads a version held in a constant and a fields list built from an array', async () => {
    const [call] = await calls({
      'a.ts': `const VERSION = 'v22.0';
const FIELDS = ['id', 'caption'];
export const media = (id: string) =>
  fetch(\`https://graph.facebook.com/\${VERSION}/\${id}/media?fields=\${FIELDS.join(',')}\`);`,
    });
    expect(call).toMatchObject({
      version: 'v22.0',
      versionSource: 'constant',
      pin: { file: 'a.ts', line: 1 },
      edge: 'media',
      // A substitution that is the whole value is read when the list is written literally.
      fields: ['id', 'caption'],
    });
  });

  it('reads axios config objects, axios(config) and spread options', async () => {
    const found = await calls({
      'a.js': `const axios = require('axios');
const shared = { params: { fields: 'id' } };
axios.get('https://graph.facebook.com/v20.0/me', shared);
axios({ method: 'delete', url: 'https://graph.facebook.com/v20.0/123/subscribed_apps' });
axios.get('https://graph.facebook.com/v20.0/me', { ...defaults, params: { fields: 'id' } });`,
    });
    expect(found.map((call) => [call.line, call.method, call.fields, call.parameters])).toEqual([
      [3, 'GET', ['id'], ['fields']],
      [4, 'DELETE', [], []],
      [5, 'GET', ['id'], null],
    ]);
    expect(found[2].unknown).toEqual(['request options spread `defaults`']);
  });

  it('reports a reassigned URL variable with an unknown path', async () => {
    const [call] = await calls({
      'a.js': `async function all(id) {
  let next = \`https://graph.facebook.com/v17.0/\${id}/message_templates?limit=50\`;
  while (next) {
    const page = await (await fetch(next)).json();
    next = page.paging?.next;
  }
}`,
    });
    expect(call).toMatchObject({
      version: 'v17.0',
      path: null,
      edge: null,
      fields: null,
      parameters: null,
      unknown: ['`next` is reassigned, so the request may use another URL'],
    });
  });

  it('reports a URL no call uses, and a versioned base passed to a function', async () => {
    const found = await calls({
      'oauth.ts': `export const facebook = {
  tokenEndpoint: 'https://graph.facebook.com/v18.0/oauth/access_token',
};
export const client = createClient('https://graph.facebook.com/v18.0');
export const plain = createClient('https://graph.facebook.com');`,
    });
    expect(found.map((call) => [call.line, call.client, call.path, call.unknown])).toEqual([
      [2, null, '/oauth/access_token', ['no request call was traced for this URL']],
      [
        4,
        null,
        null,
        ['the base URL is passed to `createClient`; requests built from it are not traced'],
      ],
    ]);
  });

  it('treats a whole runtime segment named like a path as an unknown path', async () => {
    const [call] = await calls({
      'a.js': `const GRAPH = 'https://graph.facebook.com/v20.0';
export const get = (endpoint) => fetch(\`\${GRAPH}/\${endpoint}\`);
export const raw = (path) => fetch(\`\${GRAPH}\${path}\`);`,
    });
    expect(call).toMatchObject({ path: null, edge: null });
    expect(call.unknown).toContain('path is built at runtime from `endpoint`');
    const second = (
      await calls({
        'a.js': `const G = 'https://graph.facebook.com/v20.0';
fetch(\`\${G}\${path}?fields=id\`);`,
      })
    )[0];
    expect(second).toMatchObject({ path: null, version: 'v20.0', fields: ['id'] });
    expect(second.unknown).toContain('path is built at runtime from `path`');
  });

  it('does not mistake a parameter or loop variable for an outer constant', async () => {
    const found = await calls({
      'a.js': `const url = 'https://graph.facebook.com/v18.0/me/accounts';
export function send(url) {
  return fetch(url);
}
for (const url of urls) fetch(url);
export const accounts = () => fetch(url);`,
    });
    expect(found.map((call) => call.line)).toEqual([6]);
  });

  it('marks a runtime first segment of an unversioned URL as unknown', async () => {
    const found = await calls({
      'a.js': `fetch(\`https://graph.facebook.com/\${pageId}/feed\`);
fetch(\`https://graph.facebook.com/\${apiVersion}/\${pageId}/feed\`);`,
    });
    expect(found.map((call) => [call.version, call.versionSource, call.path, call.edge])).toEqual([
      [null, 'unknown', null, null],
      [null, 'unknown', '/{pageId}/feed', 'feed'],
    ]);
    expect(found[0].unknown).toEqual([
      'the segment after the host comes from `pageId` at runtime; it may be the version or a node',
    ]);
    expect(found[1].unknown).toEqual(['version is built at runtime from `apiVersion`']);
  });

  it('reports an exported URL through the file that imports it, once', async () => {
    const found = await calls({
      'lib/urls.ts': `export const TOKEN_URL = 'https://graph.facebook.com/v18.0/oauth/access_token';`,
      'lib/auth.ts': `import { TOKEN_URL } from './urls';
export const exchange = (code: string) => fetch(\`\${TOKEN_URL}?code=\${code}\`);`,
    });
    expect(found.map((call) => [call.file, call.line, call.pin, call.parameters])).toEqual([
      ['lib/auth.ts', 2, { file: 'lib/urls.ts', line: 1 }, ['code']],
    ]);
  });

  it('never gives a helper an HTTP method from its name', async () => {
    const [call] = await calls({
      'a.js': `cache.get('https://graph.facebook.com/v18.0/me');`,
    });
    expect(call).toMatchObject({ client: 'cache.get', method: null });
  });

  it('ignores other hosts, host names without a URL and comments', async () => {
    const found = await calls({
      'a.js': `fetch('https://b-graph.facebook.com/auth/login');
const hosts = { 'graph.facebook.com': { retry: 2 } };
// fetch('https://graph.facebook.com/v19.0/me')
/* axios.get('https://graph.facebook.com/v19.0/me') */
fetch('https://api.instagram.com/oauth/access_token');`,
    });
    expect(found).toEqual([]);
  });

  it('reads graph.instagram.com requests and environment defaults for the version', async () => {
    const found = await calls({
      'a.ts': `const VERSION = process.env.IG_GRAPH_VERSION || 'v21.0';
const BASE = process.env.GRAPH_URL ?? 'https://graph.facebook.com/v19.0';
export const me = () => fetch(\`https://graph.instagram.com/\${VERSION}/me?fields=id,username\`);
export const page = (id: string) => fetch(\`\${BASE}/\${id}?fields=name\`);`,
    });
    expect(found).toMatchObject([
      {
        host: 'graph.instagram.com',
        version: 'v21.0',
        versionSource: 'env-default',
        pin: { file: 'a.ts', line: 1 },
        path: '/me',
        fields: ['id', 'username'],
      },
      {
        host: 'graph.facebook.com',
        version: 'v19.0',
        versionSource: 'env-default',
        pin: { file: 'a.ts', line: 2 },
        path: '/{id}',
      },
    ]);
  });

  it('follows requests made on an axios instance built from a Graph base', async () => {
    const found = await calls({
      'a.ts': `import axios from 'axios';
const graph = axios.create({ baseURL: 'https://graph.facebook.com/v20.0' });
export const me = () => graph.get('/me', { params: { fields: 'id,name' } });
export const post = (id: string) => graph.post(\`/\${id}/feed\`, { message: 'hi' });`,
    });
    expect(found).toMatchObject([
      {
        line: 3,
        method: 'GET',
        version: 'v20.0',
        pin: { line: 2 },
        path: '/me',
        fields: ['id', 'name'],
        unknown: [],
      },
      { line: 4, method: 'POST', path: '/{id}/feed', parameters: ['message'], unknown: [] },
    ]);
    const shared = await calls({
      'a.ts': `import axios from 'axios';
export const graph = axios.create({ baseURL: 'https://graph.facebook.com/v20.0' });
export const me = () => graph.get('/me');`,
    });
    expect(shared[0].unknown).toEqual([
      'the axios instance `graph` is exported; requests in other files are not traced',
    ]);
  });

  it('reads helpers that write their own fetch options from literals and one body parameter', async () => {
    const found = await calls({
      'a.mjs': `async function get(url, extraHeaders) {
  const res = await fetch(url, { headers: { 'User-Agent': 'x', ...(extraHeaders || {}) } });
  return res.text();
}
async function postJson(url, payload) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}
async function sneaky(url, payload, verb) {
  return fetch(url, { method: verb, body: JSON.stringify(payload) });
}
await get('https://graph.facebook.com/v22.0/me/accounts?fields=id,name');
await postJson('https://graph.facebook.com/v22.0/123/messages', { messaging_product: 'whatsapp', to: '1' });
await sneaky('https://graph.facebook.com/v22.0/123/feed', { message: 'hi' }, 'POST');`,
    });
    expect(found).toMatchObject([
      {
        line: 11,
        client: 'get',
        method: 'GET',
        fields: ['id', 'name'],
        parameters: ['fields'],
        unknown: [],
      },
      {
        line: 12,
        client: 'postJson',
        method: 'POST',
        parameters: ['messaging_product', 'to'],
        unknown: [],
      },
      { line: 13, client: 'sneaky', method: null, parameters: null },
    ]);
  });

  it('reads helpers that pass the URL and options to fetch unchanged, and no others', async () => {
    const found = await calls({
      'lib.ts': `export async function metaFetch(ctx: Ctx, url: string, init?: RequestInit) {
  const res = await ctx.fetch(url, init);
  return res.json();
}
export async function signed(url: string) {
  return fetch(\`\${url}&appsecret_proof=x\`);
}`,
      'a.ts': `import { metaFetch as fb, signed } from './lib';
export const post = (ctx: Ctx, id: string) =>
  fb(ctx, \`https://graph.facebook.com/v21.0/\${id}/feed\`, { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
export const me = () => signed('https://graph.facebook.com/v21.0/me?fields=id');`,
    });
    expect(found).toMatchObject([
      { line: 3, client: 'fb', method: 'POST', parameters: ['message'], unknown: [] },
      { line: 4, client: 'signed', method: null, parameters: null },
    ]);
  });

  it('reads FB.api requests with the version FB.init sets', async () => {
    const found = await calls({
      'init.tsx': `window.FB.init({ appId: '1', cookie: true, version: 'v20.0' });`,
      'a.ts': `FB.api('/me', { fields: 'id,name' }, (response) => console.log(response));
FB.api(\`/\${pageId}/feed\`, 'post', { message: 'hi' }, done);`,
    });
    expect(found).toMatchObject([
      {
        file: 'a.ts',
        line: 1,
        client: 'FB.api',
        method: 'GET',
        version: 'v20.0',
        pin: { file: 'init.tsx', line: 1 },
        path: '/me',
        fields: ['id', 'name'],
        unknown: [],
      },
      {
        file: 'a.ts',
        line: 2,
        method: 'POST',
        path: '/{pageId}/feed',
        parameters: ['message'],
        unknown: [],
      },
    ]);
    const alone = await calls({ 'init.tsx': `FB.init({ appId: '1', version: 'v20.0' });` });
    expect(alone).toMatchObject([
      { client: 'FB.init', version: 'v20.0', pin: { file: 'init.tsx', line: 1 }, path: null },
    ]);
  });

  it('marks example and spec files as tests', async () => {
    const found = await calls({
      'examples/send.ts': `fetch('https://graph.facebook.com/v18.0/1/messages', { method: 'POST' });`,
      'src/send.spec.ts': `fetch('https://graph.facebook.com/v18.0/1/messages', { method: 'POST' });`,
    });
    expect(found.map((call) => call.use)).toEqual(['test', 'test']);
  });

  it('follows a base exported through require', async () => {
    const found = await calls({
      'lib/graph.js': `export const BASE = 'https://graph.facebook.com/v19.0';`,
      'lib/send.js': `const { BASE: GRAPH } = require('./graph');
fetch(\`\${GRAPH}/\${phone}/messages\`, { method: 'POST', body: JSON.stringify({ to }) });`,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      file: 'lib/send.js',
      pin: { file: 'lib/graph.js', line: 1 },
      edge: 'messages',
      parameters: ['to'],
    });
  });
});

describe('business SDK calls', () => {
  const manifest = {
    name: 'app',
    dependencies: { 'facebook-nodejs-business-sdk': '^21.0.0' },
  };

  it('reads named imports, namespace members and the locked SDK version', async () => {
    const root = await repository(
      {
        'package-lock.json': JSON.stringify({
          name: 'app',
          lockfileVersion: 3,
          packages: {
            '': { name: 'app', dependencies: { 'facebook-nodejs-business-sdk': '^21.0.0' } },
            'node_modules/facebook-nodejs-business-sdk': { version: '22.0.3' },
          },
        }),
        'a.ts': `import { AdAccount, Campaign } from 'facebook-nodejs-business-sdk';
import * as sdk from 'facebook-nodejs-business-sdk';
new AdAccount('act_1').getInsights(['spend'], { date_preset: 'last_7d' });
new sdk.Business('1').getOwnedAdAccounts([]);
new Campaign('1').update({ status: 'PAUSED' });
new Campaign('1').delete();`,
      },
      manifest,
    );
    const scan = await scanGraphCalls(root);
    expect(scan.sdk).toMatchObject({
      version: 'v22.0',
      locked: '22.0.3',
      file: 'package-lock.json',
    });
    expect(
      scan.calls.map((call) => [call.line, call.client, call.method, call.path, call.version]),
    ).toEqual([
      [3, 'AdAccount.getInsights', 'GET', '/{AdAccount}/insights', 'v22.0'],
      [4, 'Business.getOwnedAdAccounts', 'GET', '/{Business}/owned_ad_accounts', 'v22.0'],
      [5, 'Campaign.update', 'POST', '/{Campaign}', 'v22.0'],
      [6, 'Campaign.delete', 'DELETE', '/{Campaign}', 'v22.0'],
    ]);
    expect(scan.calls[2].parameters).toEqual(['status']);
  });

  it('uses the per-class edge where a method name maps to different edges', async () => {
    const edges = await loadSdkEdges();
    const entry = edges.methods.get('getAdAccounts')!;
    expect(entry.edge).toBeNull();
    const [user, other] = await calls(
      {
        'a.js': `const { User, CPASBusinessSetupConfig } = require('facebook-nodejs-business-sdk');
new User('me').getAdAccounts(['id']);
new CPASBusinessSetupConfig('1').getAdAccounts(['id']);`,
      },
      manifest,
    );
    expect(user.edge).toBe('adaccounts');
    expect(other.edge).toBe('ad_accounts');
  });

  it('ignores objects that are not SDK classes and methods the SDK does not generate', async () => {
    const found = await calls(
      {
        'a.js': `const { AdAccount } = require('facebook-nodejs-business-sdk');
class Ads { getCampaigns() {} }
new Ads().getCampaigns(['name']);
new AdAccount('act_1').getSomethingElse(['name']);
api.getCampaigns(['name']);`,
      },
      manifest,
    );
    expect(found).toEqual([]);
  });

  it('marks the version unknown without a declared SDK', async () => {
    const [call] = await calls({
      'a.js': `const { AdAccount } = require('facebook-nodejs-business-sdk');
new AdAccount('act_1').getAds(['name']);`,
    });
    expect(call).toMatchObject({ version: null, versionSource: 'unknown', pin: null });
    expect(call.unknown).toEqual([
      'no facebook-nodejs-business-sdk version is declared in a manifest',
    ]);
  });
});

it('splits fields at top-level commas only', () => {
  expect(splitFields('id, posts{message,from{id}},picture.type(large),,')).toEqual([
    'id',
    'posts{message,from{id}}',
    'picture.type(large)',
  ]);
});

it('runs as a review-only CLI command with readable and JSON output', async () => {
  const text = await execute(process.execPath, [CLI, 'meta-graph', '--repository', FIXTURE]);
  expect(text.stdout).toContain('Review only: nothing was changed or sent to Meta.');
  expect(text.stdout).toContain(
    '11 requests in live code: version known in 9, path known in 10, fields known in 9.',
  );
  expect(text.stdout).toContain('src/pages.ts:19  POST /{pageId}/feed');
  expect(text.stdout).toContain('  Version    v19.0 (src/shared/graph.ts:2)');
  expect(text.stdout).toContain('  Unknown    `fields` is built at runtime');
  expect(text.stdout).toContain('In tests and examples (1): __tests__/pages.ts:4');
  const json = await execute(process.execPath, [
    CLI,
    'meta-graph',
    '--repository',
    FIXTURE,
    '--json',
  ]);
  const report = JSON.parse(json.stdout);
  expect(report.calls).toHaveLength(12);
  expect(report.sdk.version).toBe('v20.0');
}, 60_000);
