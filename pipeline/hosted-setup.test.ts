import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { runHostedService } from './hosted-service.ts';
import { hostedContact, hostedPages, type HostedSetup } from './hosted-setup.ts';
import { hostedTenancy } from './hosted-tenancy.ts';

const DATABASE = process.env.REFIT_POSTGRES_URL;
const APP_ID = 123;
const INSTALLATION = 4567;
const CONTACT = 'mailto:privacy@refit.example';
const MINUTE = 60 * 1000;
const realFetch = globalThis.fetch;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const cleanups: (() => Promise<unknown>)[] = [];
let keyFile = '';

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-setup-'));
  keyFile = join(directory, 'app.pem');
  await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return () => rm(directory, { recursive: true, force: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A fake GitHub API that knows some installations of this App and checks each App JWT it gets.
function fakeGitHub(installations: Record<number, unknown>, failure?: number) {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL, options?: RequestInit) => {
    const target = String(url);
    if (!target.startsWith('https://api.github.com/')) return realFetch(url, options);
    requests.push(`${options?.method} ${target.slice('https://api.github.com'.length)}`);
    const jwt = String(new Headers(options?.headers).get('authorization')).replace('Bearer ', '');
    const [header, claims, signature] = jwt.split('.');
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        keys.publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: String(APP_ID),
    });
    if (failure) return new Response('{"message":"Server Error"}', { status: failure });
    const id = Number(/^\/app\/installations\/(\d+)$/.exec(new URL(target).pathname)?.[1]);
    return id in installations
      ? Response.json(installations[id])
      : Response.json({ message: 'Not Found' }, { status: 404 });
  });
  return requests;
}

function installation(
  login: string,
  options: { type?: string; appId?: number; changed?: number; suspended?: boolean } = {},
) {
  const changed = new Date(Date.now() - (options.changed ?? 0)).toISOString();
  return {
    id: INSTALLATION,
    app_id: options.appId ?? APP_ID,
    account: { login, type: options.type ?? 'User' },
    created_at: changed,
    updated_at: changed,
    suspended_at: options.suspended ? changed : null,
  };
}

async function serve(overrides: Partial<HostedSetup> = {}) {
  const progress: string[] = [];
  const pages = hostedPages({
    app: { appId: String(APP_ID), privateKeyFile: keyFile },
    tenancy: hostedTenancy({ REFIT_HOSTED_ACCOUNTS: 'example,refit-dev' }),
    publishDraft: false,
    publishUnresolved: false,
    aiPatch: false,
    contact: CONTACT,
    onProgress: (message) => progress.push(message),
    ...overrides,
  });
  const server: Server = createServer((request, response) => {
    void pages(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end('not handled');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address() as { port: number };
  const get = async (path: string, method = 'GET') => {
    const response = await realFetch(`http://127.0.0.1:${address.port}${path}`, { method });
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  return { get, progress };
}

it('names a confirmed, just-installed account and says what happens next', async () => {
  const requests = fakeGitHub({ [INSTALLATION]: installation('Example') });
  const { get } = await serve();
  const page = await get(`/github/setup?installation_id=${INSTALLATION}&setup_action=install`);
  console.log(page.text);
  expect(page.status).toBe(200);
  expect(requests).toEqual([`GET /app/installations/${INSTALLATION}`]);
  expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(page.headers.get('referrer-policy')).toBe('no-referrer');
  expect(page.text).not.toMatch(/<script|private-key|BEGIN/i);
  expect(page.text).toContain('Refit Agent is installed on <strong>Example</strong>.');
  for (const heading of ['1. Inventory', '2. Approval', '3. After approval', 'Uninstall'])
    expect(page.text).toContain(`<h2>${heading}</h2>`);
  expect(page.text).toContain(
    `<a href="https://github.com/settings/installations/${INSTALLATION}">`,
  );
  expect(page.text).toContain('It keeps file paths, line numbers and match counts, not your code.');
  expect(page.text).toContain('This service does not open pull requests');
  expect(page.text).toContain('It does not use AI.');
  expect(page.text).toContain(
    '<a href="/github/uninstalled">What Refit keeps after you uninstall</a>.',
  );
  expect(page.text).toContain('<a href="mailto:privacy@refit.example">privacy@refit.example</a>');
});

it('states the worker’s real draft and AI settings and links organization settings', async () => {
  fakeGitHub({ [INSTALLATION]: installation('refit-dev', { type: 'Organization' }) });
  const { get } = await serve({ publishDraft: true, aiPatch: true, contact: undefined });
  const { text } = await get(`/github/setup?installation_id=${INSTALLATION}`);
  expect(text).toContain(
    `<a href="https://github.com/organizations/refit-dev/settings/installations/${INSTALLATION}">`,
  );
  expect(text).toContain('Refit opens a draft pull request for you to review. It never merges.');
  // Under --publish-validated-only an AI patch never opens a draft (owner decision 8).
  expect(text).toContain(
    'using the operator’s own key and a capped budget, but it never opens a pull request for an AI patch.',
  );
  expect(text).toContain('ask the operator of this Refit service');
});

it('says which drafts open as [Needs review] when the worker publishes them (owner decision 1)', async () => {
  fakeGitHub({ [INSTALLATION]: installation('refit-dev') });
  const { get } = await serve({ publishDraft: true, publishUnresolved: true, aiPatch: true });
  const { text } = await get(`/github/setup?installation_id=${INSTALLATION}`);
  expect(text).toContain(
    'using the operator’s own key and a capped budget; that draft is always titled [Needs review].',
  );
  expect(text).toContain(
    'When it could not run the checks on a patch, or a change needs your decision, the draft is titled [Needs review] and lists every reason. It never opens one whose checks ran and failed, and it never merges.',
  );
  expect(text).not.toContain('When a migration passes its checks');
});

it('tells an account that is not allowed that nothing is read or cloned', async () => {
  fakeGitHub({ [INSTALLATION]: installation('someone-else') });
  const { get } = await serve();
  const { text } = await get(`/github/setup?installation_id=${INSTALLATION}`);
  expect(text).toContain('<strong>someone-else</strong>, but this account is not enabled');
  expect(text).toContain('It does not read, clone or run anything');
  expect(text).not.toContain('Inventory');
  expect(text).toContain('<a href="/github/uninstalled">');
});

it('shows only generic text unless GitHub confirms a recent installation of this App', async () => {
  const cases = [
    { name: 'unknown installation', installations: {}, path: '?installation_id=999' },
    {
      name: 'another App’s installation',
      installations: { [INSTALLATION]: installation('example', { appId: 999 }) },
      path: `?installation_id=${INSTALLATION}`,
    },
    {
      name: 'installed two hours ago',
      installations: { [INSTALLATION]: installation('example', { changed: 120 * MINUTE }) },
      path: `?installation_id=${INSTALLATION}`,
    },
    {
      name: 'suspended',
      installations: { [INSTALLATION]: installation('example', { suspended: true }) },
      path: `?installation_id=${INSTALLATION}`,
    },
  ];
  for (const sample of cases) {
    const requests = fakeGitHub(sample.installations);
    const { get, progress } = await serve();
    const { status, text } = await get(`/github/setup${sample.path}`);
    expect(status, sample.name).toBe(200);
    expect(requests, sample.name).toHaveLength(1);
    expect(text, sample.name).toContain('If you just installed Refit Agent');
    expect(text, sample.name).toContain('If it is not enabled, Refit records the installation');
    expect(text, sample.name).not.toContain('<strong>');
    if (sample.name === 'another App’s installation')
      expect(progress).toEqual([
        'Setup page lookup failed: PipelineInputError: GitHub returned an installation that does not match this App.',
      ]);
  }
  const failing = fakeGitHub({ [INSTALLATION]: installation('example') }, 500);
  const { get, progress } = await serve();
  expect((await get(`/github/setup?installation_id=${INSTALLATION}`)).text).toContain(
    'If you just installed Refit Agent',
  );
  expect(failing).toHaveLength(1);
  expect(progress[0]).toMatch(/^Setup page lookup failed: GitHubRequestError: .*HTTP 500/);
});

it('never calls GitHub for a missing or malformed installation ID', async () => {
  const requests = fakeGitHub({ [INSTALLATION]: installation('example') });
  const { get } = await serve();
  for (const query of [
    '',
    '?installation_id=',
    '?installation_id=abc',
    '?installation_id=0',
    '?installation_id=-1',
    '?installation_id=1e3',
    '?installation_id=12345678901234567',
    '?installation_id=..%2Fapp',
  ]) {
    const { status, text } = await get(`/github/setup${query}`);
    expect(status).toBe(200);
    expect(text).toContain('If you just installed Refit Agent');
  }
  expect(requests).toEqual([]);
  expect((await get('/github/setup', 'POST')).status).toBe(404);
});

it('bounds GitHub lookups from unauthenticated visits to 30 a minute', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-22T09:00:00Z') });
  const requests = fakeGitHub({ [INSTALLATION]: installation('example') });
  const { get } = await serve();
  for (let visit = 0; visit < 30; visit++)
    expect((await get(`/github/setup?installation_id=${INSTALLATION}`)).text).toContain(
      '<strong>example</strong>',
    );
  expect((await get(`/github/setup?installation_id=${INSTALLATION}`)).text).not.toContain(
    '<strong>',
  );
  expect(requests).toHaveLength(30);
  vi.setSystemTime(Date.now() + MINUTE);
  expect((await get(`/github/setup?installation_id=${INSTALLATION}`)).text).toContain(
    '<strong>example</strong>',
  );
  expect(requests).toHaveLength(31);
});

it('serves a static uninstall page that collects nothing', async () => {
  const requests = fakeGitHub({});
  const { get, progress } = await serve();
  const page = await get(`/github/uninstalled?installation_id=${INSTALLATION}&email=a@b.example`);
  expect(page.status).toBe(200);
  expect(page.text).toContain('<h1>Refit Agent was uninstalled</h1>');
  expect(page.text).toContain('This page collects nothing about your visit.');
  expect(page.text).not.toMatch(/<script|<form|<img|a@b\.example/);
  expect(page.text).toBe((await get('/github/uninstalled')).text);
  expect(requests).toEqual([]);
  expect(progress).toEqual([]);
});

it('serves security.txt only with a configured contact', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-22T09:00:00Z') });
  fakeGitHub({});
  const { get } = await serve();
  for (const path of ['/.well-known/security.txt', '/security.txt']) {
    const security = await get(path);
    expect(security.status).toBe(200);
    expect(security.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(security.text).toBe(
      'Contact: mailto:privacy@refit.example\nExpires: 2027-04-20T09:00:00.000Z\nPreferred-Languages: en\n',
    );
  }
  const unset = await serve({ contact: undefined });
  expect(await unset.get('/.well-known/security.txt')).toMatchObject({
    status: 404,
    text: 'No security contact is configured.\n',
  });
});

it('accepts only a mailto: or https: contact', () => {
  expect(hostedContact(undefined)).toBeUndefined();
  expect(hostedContact('')).toBeUndefined();
  expect(hostedContact(CONTACT)).toBe(CONTACT);
  expect(hostedContact('https://refit.example/privacy')).toBe('https://refit.example/privacy');
  for (const value of [
    'privacy@refit.example',
    'http://refit.example',
    'javascript:alert(1)',
    'mailto:a@b.example?subject=<x>',
    'https://refit.example/"onmouseover=x',
  ])
    expect(() => hostedContact(value), value).toThrow(
      'REFIT_HOSTED_CONTACT must be a mailto: or https: URI.',
    );
});

it.skipIf(!DATABASE)('is served by the hosted worker next to its other routes', async () => {
  const schema = `refit_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: DATABASE });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: DATABASE, options: `-c search_path=${schema}` });
  const state = await mkdtemp(join(tmpdir(), 'refit-setup-state-'));
  cleanups.push(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(state, { recursive: true, force: true });
  });
  const requests = fakeGitHub({ [INSTALLATION]: installation('example') });
  const controller = new AbortController();
  let ready: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
  const service = runHostedService({
    database: pool,
    app: { appId: String(APP_ID), privateKeyFile: keyFile },
    directory: state,
    webhookSecret: 'webhook-secret-for-setup-page-tests-123',
    controlToken: 'control-secret-for-setup-page-tests-456',
    tenancy: hostedTenancy({ REFIT_HOSTED_OWNER: 'example' }),
    contact: CONTACT,
    host: '127.0.0.1',
    port: 0,
    intervalSeconds: 3600,
    signal: controller.signal,
    onReady: (url) => ready(url),
  });
  cleanups.push(async () => {
    controller.abort();
    await service;
  });
  const url = await listening;
  const setup = await realFetch(`${url}/github/setup?installation_id=${INSTALLATION}`);
  expect(setup.status).toBe(200);
  expect(await setup.text()).toContain('Refit Agent is installed on <strong>example</strong>.');
  expect(requests).toEqual([`GET /app/installations/${INSTALLATION}`]);
  expect((await realFetch(`${url}/.well-known/security.txt`)).status).toBe(200);
  expect(await (await realFetch(`${url}/health`)).json()).toEqual({ status: 'listening' });
  expect((await realFetch(`${url}/github/setup`, { method: 'POST' })).status).toBe(404);
});
