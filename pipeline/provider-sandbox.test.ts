import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupObjects,
  createStandIns,
  newProviderErrors,
  providerCaller,
  providerKeys,
  proxyConfig,
  proxyRecords,
  redactor,
  sandboxBlockers,
  sandboxGrade,
  unavailableSide,
  writeProxy,
  type SandboxAdapter,
  type SandboxRequest,
} from './provider-sandbox.ts';

// A second, made-up provider: nothing in the harness may assume Stripe.
const ACME: SandboxAdapter = {
  name: 'Acme',
  hosts: ['api.acme.test'],
  keyVariable: 'ACME_TEST_KEY',
  testKey: /^acme_test_[a-z0-9]{8,}$/,
  secret: /\bacme_(?:test|live)_[a-z0-9]{8,}/g,
  authorization: 'Token {key}',
  versionHeader: 'Acme-Version',
  rateLimit: { status: 429, retries: 2, backoffMs: 1 },
  tagField: 'labels[run]',
  taggable: (contract) =>
    ((contract as { creates: string[] }).creates ?? []).map((path) => `^POST ${path}$`),
  standIns: (sources) => ({
    wanted: [
      ...new Set(sources.flatMap((source) => source.content.match(/widget_[a-z0-9]{6,}/g) ?? [])),
    ].map((id) => ({ id, kind: 'widget' })),
    unreproducible: sources.flatMap((source) => source.content.match(/vault_[a-z0-9]{6,}/g) ?? []),
  }),
  createStandIn: async (_wanted, call) => ({
    id: String((await call({ method: 'POST', path: '/widgets', tag: true })).id),
    assumption: 'a plain widget',
  }),
  cleanup: (object) =>
    object.object === 'widget' ? { method: 'DELETE', path: `/widgets/${object.id}` } : undefined,
  operation: (method, path) => `${method} ${path.replace(/widget_[a-z0-9]+/g, '{id}')}`,
};

const KEY = 'acme_test_aaaa1111';
const SECOND = 'acme_test_bbbb2222';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as AddressInfo).port;
}

// The provider: records what reached it, answers 429 once for the first key, echoes the key once.
async function fakeProvider() {
  const seen: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] =
    [];
  const port = await listen(
    createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        seen.push({ method: request.method!, url: request.url!, headers: request.headers, body });
        response.setHeader('content-type', 'application/json');
        if (request.url === '/limited' && request.headers.authorization === `Token ${KEY}`) {
          response.statusCode = 429;
          response.end('{}');
        } else if (request.url === '/echo')
          response.end(JSON.stringify({ seen: request.headers.authorization }));
        else if (request.method === 'POST' && request.url === '/widgets')
          response.end(JSON.stringify({ id: 'widget_new123', object: 'widget' }));
        else if (request.url?.startsWith('/widgets/'))
          response.end(JSON.stringify({ id: request.url.split('/')[2], object: 'widget' }));
        else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: { message: `no ${request.url}` } }));
        }
      });
    }),
  );
  return { seen, upstream: `http://127.0.0.1:${port}` };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Runs the proxy script outside Docker, as the sandbox's proxy container would.
async function localProxy(upstream: string, keys: string[], standIns = [] as never[]) {
  const directory = await mkdtemp(join(tmpdir(), 'refit-proxy-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const port = await freePort();
  await writeProxy(
    directory,
    'patched',
    proxyConfig(ACME, {
      runId: 'refit-run-1',
      version: '2026-01',
      contract: { creates: ['/widgets'] },
      standIns,
      upstream,
      port,
    }),
  );
  const child = spawn(
    process.execPath,
    [join(directory, 'proxy.mjs'), join(directory, 'proxy-patched.json')],
    {
      env: { PATH: process.env.PATH, REFIT_PROVIDER_KEYS: keys.join('\n') },
    },
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  await new Promise<void>((resolve) => {
    const ready = () =>
      stdout.includes('REFIT_SANDBOX_READY') ? resolve() : setTimeout(ready, 20);
    ready();
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  cleanups.push(async () => {
    child.kill();
    await closed;
  });
  const send = async (path: string, init: RequestInit & { host?: string } = {}) => {
    const { host = 'api.acme.test', ...rest } = init;
    // fetch refuses to set Host, so the test speaks raw HTTP like the sandbox preload does.
    const { request } = await import('node:http');
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: rest.method ?? 'GET',
          headers: {
            host,
            authorization: 'Bearer placeholder',
            ...(rest.headers as Record<string, string>),
          },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve({ status: response.statusCode!, body }));
        },
      );
      req.on('error', reject);
      req.end(rest.body as string | undefined);
    });
  };
  return { send, records: () => proxyRecords(stdout), output: () => stdout };
}

it('has no provider name in the provider-neutral harness', async () => {
  const source = await readFile(new URL('./provider-sandbox.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/stripe/i);
});

it('reads keys only from the adapter variable and refuses live, malformed or missing keys', () => {
  expect(providerKeys(ACME, { ACME_TEST_KEY: `${KEY}, ${SECOND}` })).toEqual([KEY, SECOND]);
  expect(() => providerKeys(ACME, {})).toThrow('needs ACME_TEST_KEY');
  for (const value of ['acme_live_aaaa1111', `${KEY},acme_live_aaaa1111`, 'acme_test_short'])
    try {
      providerKeys(ACME, { ACME_TEST_KEY: value });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain('a live or malformed key is refused');
      // The refusal never repeats the value.
      expect(String(error)).not.toContain('aaaa1111');
    }
});

it('redacts the run keys and anything shaped like a provider credential', () => {
  const redact = redactor(ACME, [KEY]);
  expect(redact(`key ${KEY} and acme_live_zzzz9999 and acme_test_cccc3333`)).toBe(
    'key [redacted] and [redacted] and [redacted]',
  );
});

it('forwards only to the adapter hosts, adds the key, pins the version and tags creations', async () => {
  const provider = await fakeProvider();
  const proxy = await localProxy(provider.upstream, [KEY]);
  const created = await proxy.send('/widgets', { method: 'POST', body: 'name=a' });
  expect(created.status).toBe(200);
  const denied = await proxy.send('/anything', { host: 'evil.example' });
  expect(denied).toEqual({
    status: 403,
    body: 'Refit sandbox: egress to this host is not allowed.',
  });
  const sent = await proxy.send('/widgets/widget_abc123', {
    headers: { 'acme-version': '2025-01' },
  });
  expect(sent.status).toBe(200);
  // Only allowed hosts reached the provider, with the real key in place of the placeholder.
  expect(provider.seen.map((request) => [request.method, request.url])).toEqual([
    ['POST', '/widgets'],
    ['GET', '/widgets/widget_abc123'],
  ]);
  expect(provider.seen[0]).toMatchObject({
    headers: { authorization: `Token ${KEY}`, 'acme-version': '2026-01' },
    body: 'name=a&labels%5Brun%5D=refit-run-1',
  });
  // A version the code sends itself is kept and recorded as sent.
  expect(provider.seen[1].headers['acme-version']).toBe('2025-01');
  expect(proxy.records()).toEqual([
    expect.objectContaining({
      method: 'POST',
      path: '/widgets',
      status: 200,
      tagged: true,
      version: '2026-01',
      versionSent: false,
      created: { id: 'widget_new123', object: 'widget' },
    }),
    { method: 'GET', path: '/anything', host: 'evil.example', status: 403, denied: true },
    expect.objectContaining({
      path: '/widgets/widget_abc123',
      tagged: false,
      version: '2025-01',
      versionSent: true,
    }),
  ]);
});

it('never lets the key reach the code under test or the records', async () => {
  const provider = await fakeProvider();
  const proxy = await localProxy(provider.upstream, [KEY]);
  const echoed = await proxy.send('/echo');
  expect(echoed.body).toBe(JSON.stringify({ seen: 'Token [redacted]' }));
  expect(proxy.output()).not.toContain(KEY);
});

it('retries a rate-limited request with the next key of the pool', async () => {
  const provider = await fakeProvider();
  const proxy = await localProxy(provider.upstream, [KEY, SECOND]);
  expect((await proxy.send('/limited')).status).toBe(404);
  expect(provider.seen.map((request) => request.headers.authorization)).toEqual([
    `Token ${KEY}`,
    `Token ${SECOND}`,
  ]);
  expect(proxy.records()[0]).toMatchObject({ attempts: 2, status: 404 });
  // A pool of one key stays limited after every retry: unavailable, never a regression.
  const single = await localProxy(provider.upstream, [KEY]);
  expect((await single.send('/limited')).status).toBe(429);
  expect(single.records()[0]).toMatchObject({ attempts: 3, rateLimited: true });
  expect(unavailableSide(single.records())).toBe(
    '1 request(s) stayed rate-limited after every retry.',
  );
});

it('swaps stand-ins in requests and back in responses', async () => {
  const provider = await fakeProvider();
  const proxy = await localProxy(provider.upstream, [KEY], [
    { id: 'widget_theirs1', kind: 'widget', standIn: 'widget_ours22', assumption: 'a widget' },
  ] as never[]);
  const response = await proxy.send('/widgets/widget_theirs1');
  expect(provider.seen[0].url).toBe('/widgets/widget_ours22');
  expect(JSON.parse(response.body)).toEqual({ id: 'widget_theirs1', object: 'widget' });
});

it('creates stand-ins, tags them and removes everything the run created, newest first', async () => {
  const provider = await fakeProvider();
  const call = providerCaller(ACME, [KEY], { runId: 'refit-run-1', upstream: provider.upstream });
  const prepared = await createStandIns(ACME, call, [
    { path: 'a.js', content: "get('widget_theirs1'); open('vault_secret1')" },
  ]);
  expect(prepared).toEqual({
    standIns: [
      {
        id: 'widget_theirs1',
        kind: 'widget',
        standIn: 'widget_new123',
        assumption: 'a plain widget',
      },
    ],
    unreproducible: ['vault_secret1'],
    objects: [{ id: 'widget_new123', object: 'widget' }],
  });
  expect(provider.seen[0].body).toBe('labels%5Brun%5D=refit-run-1');
  const result = await cleanupObjects(ACME, call, [
    ...prepared.objects,
    { id: 'gadget_1', object: 'gadget' },
    { id: 'widget_other9', object: 'widget' },
  ]);
  expect(result).toEqual({
    removed: ['widget widget_other9', 'widget widget_new123'],
    left: ['gadget gadget_1'],
    failed: [],
  });
  expect(provider.seen.slice(1).map((request) => `${request.method} ${request.url}`)).toEqual([
    'DELETE /widgets/widget_other9',
    'DELETE /widgets/widget_new123',
  ]);
  // A failure is recorded, redacted, and never stops the rest.
  const failing = await cleanupObjects(ACME, async () => {
    throw new Error(`denied for ${KEY}`);
  }, [{ id: 'widget_x12345', object: 'widget' }]);
  expect(failing.failed).toEqual([`widget widget_x12345: denied for ${KEY}`]);
  await expect(
    providerCaller(ACME, [KEY], { runId: 'r', upstream: provider.upstream })({
      method: 'GET',
      path: `/missing-${KEY}`,
    }),
  ).rejects.toThrow('GET /missing-[redacted] returned 404');
});

const request = (method: string, path: string, status: number, version = 'v2'): SandboxRequest => ({
  method,
  path,
  host: 'api.acme.test',
  status,
  version,
});

it('grants grade A only in a test environment, with nothing missing', () => {
  expect(sandboxGrade({ target: 'test-environment', passed: true, missing: [] })).toBe('A');
  expect(sandboxGrade({ target: 'mock', passed: true, missing: [] })).toBeNull();
  expect(sandboxGrade({ target: 'test-environment', passed: false, missing: [] })).toBeNull();
  expect(sandboxGrade({ target: 'test-environment', passed: true, missing: ['x'] })).toBeNull();
});

it('blocks grade A on new provider errors, wrong versions, denied hosts and unreproducible objects', () => {
  const original = [
    request('POST', '/widgets/widget_a1', 200, 'v1'),
    request('GET', '/nope', 404, 'v1'),
  ];
  const patched = [
    request('POST', '/widgets/widget_b2', 400),
    request('GET', '/nope', 404),
    request('GET', '/x', 403, 'v9'),
    { ...request('GET', '/y', 403), host: 'evil.example', denied: true as const },
  ];
  expect(newProviderErrors(ACME, original, patched)).toEqual([
    'POST /widgets/{id} 400',
    'GET /x 403',
  ]);
  expect(
    sandboxBlockers(ACME, {
      versions: { original: 'v1', patched: 'v2' },
      requests: { original, patched },
      unreproducible: ['vault_secret1'],
    }),
  ).toEqual([
    'The patched side tried to reach evil.example, which the sandbox denies.',
    'The patched side sent v9 instead of v2.',
    'Acme returned POST /widgets/{id} 400 on the patched side only.',
    'Acme returned GET /x 403 on the patched side only.',
    "vault_secret1 cannot be reproduced in Refit's test account.",
  ]);
  expect(
    sandboxBlockers(ACME, {
      versions: { original: 'v1', patched: 'v2' },
      requests: { original: [], patched: [request('GET', '/a', 200)] },
      unreproducible: [],
    }),
  ).toEqual(['No Acme request was made on the original side.']);
});
