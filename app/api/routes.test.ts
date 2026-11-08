import { readFileSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BehindItem } from '../../shared/types.ts';
import { GITHUB_API, GitHubApiError } from '../github.ts';
import { withMarker } from '../lifecycle/marker.ts';
import { isServiceToken } from './auth.ts';
import type { PullRequest } from './pulls.ts';
import { createApiRoutes, publicReport } from './routes.ts';
import type { ApiDeps, PrView, ReportReader, StoredReport } from './routes.ts';

const TOKEN = 'test-service-token';
const BILLING = 'refit-example-org/billing-api';
const STOREFRONT = 'refit-example-org/storefront';
const BILLING_INSTALLATION = 11;
const STOREFRONT_INSTALLATION = 22;
const FALLBACK_STATUS = 418;
const ROUTE_PATHS = ['/api/repos', `/api/report?repo=${BILLING}`, '/api/prs'];
// Assembled at runtime so secret scanners don't flag this file; redactSecrets matches its shape.
const SECRET = ['sk', 'live', 'x'.repeat(24)].join('_');

const fixture = JSON.parse(
  readFileSync(new URL('fixtures/pulls.list.json', import.meta.url), 'utf8'),
) as PullRequest[];
const [refitPull, humanPull] = fixture;

const pullsPath = (repo: string) =>
  `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`;

type Reply = { status?: number; body: unknown };

function fakeGitHub(routes: Record<string, Reply> = {}) {
  const calls: { path: string; authorization: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(GITHUB_API.length);
    calls.push({ path, authorization: (init?.headers as Record<string, string>).Authorization });
    const reply = routes[path];
    if (!reply) throw new Error(`unrouted ${path}; calls so far: ${JSON.stringify(calls)}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function fakeReports(reports: StoredReport[]): ReportReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    latest: async (repo) => {
      reads.push(`latest ${repo}`);
      return reports.find((report) => report.repo === repo);
    },
    list: async () => {
      reads.push('list');
      return reports;
    },
  };
}

const item = (overrides: Partial<BehindItem> = {}): BehindItem => ({
  repo: BILLING,
  dependency: {
    repo: BILLING,
    kind: 'sdk',
    name: 'stripe',
    ecosystem: 'npm',
    version: '14.0.0',
    declaredIn: [{ file: 'package.json', line: 12 }],
    callSites: [{ file: 'src/pay.ts', line: 7, operation: 'charges.create', fields: ['amount'] }],
  },
  change: {
    provider: 'stripe',
    id: 'illustrative-change',
    kind: 'field-removed',
    title: 'Illustrative: a field goes away',
    source: { url: 'https://example.com/changelog', quote: 'Illustrative vendor quote.' },
    affects: { fields: ['amount'] },
    dependencyKind: 'sdk',
    dependency: 'stripe',
  },
  status: 'open',
  ...overrides,
});

const report = (repo: string, overrides: Partial<StoredReport> = {}): StoredReport => ({
  repo,
  scannedAt: '2026-11-05T12:00:00Z',
  items: [],
  costUsd: 0.25,
  errors: [],
  ...overrides,
});

const BILLING_REPORT = report(BILLING, { installationId: BILLING_INSTALLATION });
const STOREFRONT_REPORT = report(STOREFRONT, { installationId: STOREFRONT_INSTALLATION });

let server: Server | undefined;

async function start(overrides: Partial<ApiDeps> = {}) {
  const handled: boolean[] = [];
  const routes = createApiRoutes({
    reports: fakeReports([]),
    tokens: { token: async (id) => `installation-token-${id}` },
    serviceToken: TOKEN,
    fetchImpl: fakeGitHub().fetchImpl,
    ...overrides,
  });
  server = createServer((request, response) => {
    void routes(request, response).then((result) => {
      handled.push(result);
      if (!result) response.writeHead(FALLBACK_STATUS).end('fallback');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const get = (path: string, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { base, port, get, handled };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) =>
    server ? server.close((error) => (error ? reject(error) : resolve())) : resolve(),
  );
  server = undefined;
});

async function expectJsonError(response: Response, status: number) {
  const text = await response.text();
  expect(response.status, `body: ${text}`).toBe(status);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(JSON.parse(text)).toEqual({ error: expect.any(String) });
}

describe('isServiceToken', () => {
  it('accepts only the exact bearer token', () => {
    expect(isServiceToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isServiceToken(`Bearer ${TOKEN}x`, TOKEN), 'longer').toBe(false);
    expect(isServiceToken('Bearer t', TOKEN), 'shorter').toBe(false);
    expect(isServiceToken(TOKEN, TOKEN), 'no scheme').toBe(false);
    expect(isServiceToken(`Basic ${TOKEN}`, TOKEN), 'other scheme').toBe(false);
    expect(isServiceToken(`Bearer ${TOKEN} extra`, TOKEN), 'trailing text').toBe(false);
    expect(isServiceToken(undefined, TOKEN), 'no header').toBe(false);
  });

  it('fails closed on an empty expected token, even for an empty presented one', () => {
    expect(isServiceToken('Bearer ', '')).toBe(false);
    expect(isServiceToken('Bearer anything', '')).toBe(false);
  });

  it('reads the environment on each call, called with the header alone', () => {
    vi.stubEnv('REFIT_SERVICE_TOKEN', undefined as unknown as string);
    expect(isServiceToken(`Bearer ${TOKEN}`), 'unset').toBe(false);
    vi.stubEnv('REFIT_SERVICE_TOKEN', '');
    expect(isServiceToken('Bearer anything'), 'empty').toBe(false);
    vi.stubEnv('REFIT_SERVICE_TOKEN', TOKEN);
    expect(isServiceToken(`Bearer ${TOKEN}`), 'set').toBe(true);
  });
});

describe('every route', () => {
  it.each(ROUTE_PATHS)('%s answers 401 and reads nothing without the right token', async (path) => {
    const reports = fakeReports([BILLING_REPORT]);
    const github = fakeGitHub();
    const { get, base } = await start({ reports, fetchImpl: github.fetchImpl });

    await expectJsonError(await get(path, null), 401);
    await expectJsonError(await get(path, 'wrong-token-of-other-len'), 401);
    await expectJsonError(await get(path, `${TOKEN}x`), 401);
    await expectJsonError(
      await fetch(`${base}${path}`, { headers: { Authorization: `Basic ${TOKEN}` } }),
      401,
    );
    expect(reports.reads, 'store untouched').toEqual([]);
    expect(github.calls, 'GitHub untouched').toEqual([]);
  });

  it.each(ROUTE_PATHS)('%s answers 401 for any token when none is configured', async (path) => {
    vi.stubEnv('REFIT_SERVICE_TOKEN', undefined as unknown as string);
    const unset = await start({ serviceToken: undefined });
    await expectJsonError(await unset.get(path, 'anything'), 401);
    await new Promise((resolve) => server!.close(resolve));

    const empty = await start({ serviceToken: '' });
    await expectJsonError(await empty.get(path, 'anything'), 401);
  });

  it('falls back to REFIT_SERVICE_TOKEN, read per request', async () => {
    vi.stubEnv('REFIT_SERVICE_TOKEN', undefined as unknown as string);
    const { get } = await start({ serviceToken: undefined });
    expect((await get('/api/repos', 'rotated-token')).status).toBe(401);
    vi.stubEnv('REFIT_SERVICE_TOKEN', 'rotated-token');
    expect((await get('/api/repos', 'rotated-token')).status).toBe(200);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s answers 405 JSON', async (method) => {
    const reports = fakeReports([BILLING_REPORT]);
    const { base } = await start({ reports });
    for (const path of ROUTE_PATHS) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.headers.get('allow')).toBe('GET');
      await expectJsonError(response, 405);
    }
    expect(reports.reads).toEqual([]);
  });

  it('sets the JSON and no-store headers and no CORS headers on success', async () => {
    const reports = fakeReports([BILLING_REPORT]);
    const github = fakeGitHub({ [pullsPath(BILLING)]: { body: [] } });
    const { get } = await start({ reports, fetchImpl: github.fetchImpl });
    for (const path of ROUTE_PATHS) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe('application/json');
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin'), path).toBeNull();
    }
  });
});

describe('paths it does not own', () => {
  it.each([
    '/api/runs',
    '/api/audit',
    '/api/dependencies',
    '/api/repos/',
    '/api/reposx',
    '/API/REPOS',
    '/api',
    '/webhooks',
    '/healthz',
    '/',
  ])('%s resolves false and touches nothing', async (path) => {
    const reports = fakeReports([BILLING_REPORT]);
    const { base, handled } = await start({ reports });
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`${base}${path}`, { method });
      expect(response.status, method).toBe(FALLBACK_STATUS);
      expect(response.headers.get('cache-control'), method).toBeNull();
      expect(await response.text(), method).toBe('fallback');
    }
    expect(handled).toEqual([false, false]);
    expect(reports.reads).toEqual([]);
  });

  it('resolves false for a request line that does not parse as a URL', async () => {
    const { port, handled } = await start();
    const status = await new Promise((resolve, reject) => {
      httpGet({ host: '127.0.0.1', port, path: '//' }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    expect(status).toBe(FALLBACK_STATUS);
    expect(handled).toEqual([false]);
  });
});

describe('GET /api/repos', () => {
  it('returns a plain sorted list of the repos with reports', async () => {
    const reports = fakeReports([
      STOREFRONT_REPORT,
      report('refit-example-org/ops'),
      BILLING_REPORT,
    ]);
    const { get } = await start({ reports });
    expect(await (await get('/api/repos')).json()).toEqual([
      BILLING,
      'refit-example-org/ops',
      STOREFRONT,
    ]);
  });

  it('returns [] with no reports', async () => {
    const { get } = await start();
    expect(await (await get('/api/repos')).json()).toEqual([]);
  });
});

describe('GET /api/report', () => {
  it.each([
    ['no repo', ''],
    ['an empty repo', '?repo='],
    ['no slash', '?repo=no-slash'],
    ['a dot segment', '?repo=a/..'],
    ['an encoded traversal', '?repo=..%2F..%2Fetc%2Fpasswd'],
    ['too many segments', '?repo=a/b/c'],
  ])('answers 400 for %s without reading the store', async (_name, query) => {
    const reports = fakeReports([BILLING_REPORT]);
    const { get } = await start({ reports });
    await expectJsonError(await get(`/api/report${query}`), 400);
    expect(reports.reads).toEqual([]);
  });

  it('answers 404 JSON when there is no report', async () => {
    const { get } = await start({ reports: fakeReports([BILLING_REPORT]) });
    await expectJsonError(await get(`/api/report?repo=${STOREFRONT}`), 404);
  });

  it('serves the latest report for the repo asked about', async () => {
    const { get } = await start({ reports: fakeReports([STOREFRONT_REPORT, BILLING_REPORT]) });
    const body = (await (await get(`/api/report?repo=${BILLING}`)).json()) as StoredReport;
    expect(body.repo).toBe(BILLING);
    expect(body.scannedAt).toBe(BILLING_REPORT.scannedAt);
  });
});

describe('what a report may show', () => {
  const planted = (where: string) => `const ${where}Key = loadKey("${SECRET}", "${where}-only");`;
  const INSTALLATION_ID = 987654321;

  const leaky = (): StoredReport => {
    const clean = item();
    return report(BILLING, {
      installationId: INSTALLATION_ID,
      errors: [`could not read config.ts: ${SECRET}`],
      items: [
        {
          ...clean,
          dependency: {
            ...clean.dependency,
            declaredIn: [{ file: 'package.json', line: 12, text: planted('declaredIn') }],
            callSites: [
              {
                file: 'src/pay.ts',
                line: 7,
                operation: 'charges.create',
                fields: ['amount'],
                notes: planted('callSite'),
              },
            ],
            notes: planted('dependency'),
            // A field the contract doesn't name yet, as a later writer might store.
            rawFile: planted('rawFile'),
          } as BehindItem['dependency'],
        },
      ],
    });
  };

  it('never sends the planted source lines, secrets or installation id', async () => {
    const { get } = await start({ reports: fakeReports([leaky()]) });
    const response = await get(`/api/report?repo=${BILLING}`);
    const raw = Buffer.from(await response.arrayBuffer()).toString('utf8');

    expect(response.status, raw).toBe(200);
    for (const where of ['declaredIn', 'callSite', 'dependency', 'rawFile']) {
      expect(raw, `${where} source line leaked in ${raw}`).not.toContain(planted(where));
      expect(raw, `${where} marker leaked in ${raw}`).not.toContain(`${where}-only`);
    }
    expect(raw, `secret leaked in ${raw}`).not.toContain(SECRET);
    expect(raw, `installationId key leaked in ${raw}`).not.toContain('installationId');
    expect(raw, `installation id value leaked in ${raw}`).not.toContain(String(INSTALLATION_ID));
    expect(raw, 'errors stay, redacted').toContain('could not read config.ts: [redacted]');
  });

  it('keeps the locations, operations and vendor material the dashboard needs', async () => {
    const { get } = await start({ reports: fakeReports([leaky()]) });
    const body = (await (await get(`/api/report?repo=${BILLING}`)).json()) as StoredReport;
    expect(body.items[0].dependency).toEqual({
      repo: BILLING,
      kind: 'sdk',
      name: 'stripe',
      ecosystem: 'npm',
      version: '14.0.0',
      declaredIn: [{ file: 'package.json', line: 12 }],
      callSites: [{ file: 'src/pay.ts', line: 7, operation: 'charges.create', fields: ['amount'] }],
    });
    expect(body.items[0].change.source.quote).toBe('Illustrative vendor quote.');
    expect(body.costUsd).toBe(0.25);
  });

  it('does not change the stored report it is given', () => {
    const stored = leaky();
    const before = structuredClone(stored);
    publicReport(stored);
    expect(stored).toEqual(before);
  });

  it('redacts every error, including values held in the environment', () => {
    vi.stubEnv('FAKE_API_KEY', 'env-held-value-1');
    const { errors } = publicReport(
      report(BILLING, { errors: ['first env-held-value-1', `second ${SECRET}`] }),
    );
    expect(errors).toEqual(['first [redacted]', 'second [redacted]']);
  });

  it('known limit: a secretless source line quoted in an error survives', () => {
    const line = 'Unexpected token, "const plan = legacyPlan()" is not valid JSON';
    expect(publicReport(report(BILLING, { errors: [line] })).errors).toEqual([line]);
  });
});

describe('GET /api/prs', () => {
  const pull = (overrides: Partial<PullRequest>): PullRequest => ({ ...refitPull, ...overrides });
  const fork = (repo: { full_name: string } | null) =>
    pull({ number: 90, head: { ...refitPull.head, repo } });
  const startPrs = (routes: Record<string, Reply>, stored = [BILLING_REPORT]) => {
    const github = fakeGitHub(routes);
    return start({ reports: fakeReports(stored), fetchImpl: github.fetchImpl }).then((started) => ({
      ...started,
      github,
    }));
  };
  const prs = async (get: (path: string) => Promise<Response>, path = '/api/prs') => {
    const response = await get(path);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return { raw: text, views: JSON.parse(text) as PrView[] };
  };

  it('returns the exact view of a recorded Refit PR, reading every state with the right token', async () => {
    const { get, github } = await startPrs({ [pullsPath(BILLING)]: { body: [refitPull] } });
    const { views } = await prs(get);
    expect(views).toEqual([
      {
        repo: BILLING,
        number: refitPull.number,
        title: refitPull.title,
        url: refitPull.html_url,
        state: 'merged',
        draft: false,
        branch: refitPull.head.ref,
        updatedAt: refitPull.updated_at,
      },
    ]);
    expect(github.calls).toEqual([
      {
        path: pullsPath(BILLING),
        authorization: `Bearer installation-token-${BILLING_INSTALLATION}`,
      },
    ]);
  });

  it('excludes a human branch, a fork using refit/ and a deleted fork', async () => {
    const { get } = await startPrs({
      [pullsPath(BILLING)]: {
        body: [refitPull, humanPull, fork({ full_name: 'someone-else/billing-api' }), fork(null)],
      },
    });
    const { views } = await prs(get);
    expect(views.map((view) => view.number)).toEqual([refitPull.number]);
  });

  it('never includes a PR body', async () => {
    const { get } = await startPrs({ [pullsPath(BILLING)]: { body: [refitPull] } });
    const { raw } = await prs(get);
    expect(refitPull.body, 'fixture has a body to leak').toBeTruthy();
    expect(raw).not.toContain(refitPull.body);
    expect(raw).not.toContain('"body"');
  });

  it('reads dependency and target from the marker and sends nothing else from the body', async () => {
    const privateText = 'Private reasoning about the customer code.';
    const body = withMarker(privateText, {
      dependency: 'next',
      kind: 'framework-major',
      target: '16.0.0',
      changeId: 'illustrative-marker-change',
    });
    const { get } = await startPrs({ [pullsPath(BILLING)]: { body: [pull({ body })] } });
    const { raw, views } = await prs(get);

    expect(views[0].dependency).toBe('next');
    expect(views[0].target).toBe('16.0.0');
    for (const absent of [privateText, 'refit:lifecycle', 'illustrative-marker-change', '"kind"']) {
      expect(raw, `${absent} leaked in ${raw}`).not.toContain(absent);
    }
  });

  it.each([
    ['a body with no marker', 'Just prose.'],
    ['a null body', null],
    ['a malformed marker', 'Text <!-- refit:lifecycle {"dependency": -->'],
    ['a marker missing fields', '<!-- refit:lifecycle {"dependency":"next"} -->'],
  ])('omits dependency and target for %s', async (_name, body) => {
    const { get } = await startPrs({ [pullsPath(BILLING)]: { body: [pull({ body })] } });
    const { views } = await prs(get);
    expect(views).toHaveLength(1);
    expect(views[0]).not.toHaveProperty('dependency');
    expect(views[0]).not.toHaveProperty('target');
  });

  it.each([
    ['merged', { state: 'closed', merged_at: '2026-11-03T08:29:19Z', draft: false }],
    ['closed', { state: 'closed', merged_at: null, draft: false }],
    ['open', { state: 'open', merged_at: null, draft: true }],
  ] as const)('reports %s', async (state, fields) => {
    const { get } = await startPrs({ [pullsPath(BILLING)]: { body: [pull(fields)] } });
    const { views } = await prs(get);
    expect(views[0]).toMatchObject({ state, draft: fields.draft });
  });

  it('merges repos newest updated first, whichever repo each PR is in', async () => {
    const storefrontHead = { ...refitPull.head, repo: { full_name: STOREFRONT } };
    const { get, github } = await startPrs(
      {
        [pullsPath(BILLING)]: {
          body: [
            pull({ number: 3, updated_at: '2026-11-04T00:00:00Z' }),
            pull({ number: 1, updated_at: '2026-11-01T00:00:00Z' }),
          ],
        },
        [pullsPath(STOREFRONT)]: {
          body: [pull({ number: 2, updated_at: '2026-11-02T00:00:00Z', head: storefrontHead })],
        },
      },
      [BILLING_REPORT, STOREFRONT_REPORT],
    );
    const { views } = await prs(get);
    expect(views.map((view) => [view.repo, view.number])).toEqual([
      [BILLING, 3],
      [STOREFRONT, 2],
      [BILLING, 1],
    ]);
    expect(github.calls.map((call) => call.authorization).sort()).toEqual([
      `Bearer installation-token-${BILLING_INSTALLATION}`,
      `Bearer installation-token-${STOREFRONT_INSTALLATION}`,
    ]);
  });

  it('skips a report without an installation id, asking for no token', async () => {
    const token = vi.fn(async () => 'unused');
    const github = fakeGitHub();
    const { get } = await start({
      reports: fakeReports([report(BILLING)]),
      tokens: { token },
      fetchImpl: github.fetchImpl,
    });
    expect((await prs(get)).views).toEqual([]);
    expect(token).not.toHaveBeenCalled();
    expect(github.calls).toEqual([]);
  });

  it('narrows to one repo with ?repo=', async () => {
    const { get, github } = await startPrs({ [pullsPath(BILLING)]: { body: [refitPull] } }, [
      BILLING_REPORT,
      STOREFRONT_REPORT,
    ]);
    const { views } = await prs(get, `/api/prs?repo=${BILLING}`);
    expect(views.map((view) => view.repo)).toEqual([BILLING]);
    expect(github.calls.map((call) => call.path)).toEqual([pullsPath(BILLING)]);
  });

  it('returns [] for a repo with no report, without calling GitHub', async () => {
    const { get, github } = await startPrs({});
    expect((await prs(get, `/api/prs?repo=${STOREFRONT}`)).views).toEqual([]);
    expect(github.calls).toEqual([]);
  });

  it.each(['?repo=', '?repo=no-slash', '?repo=a/..', '?repo=..%2F..%2Fetc'])(
    'answers 400 for %s',
    async (query) => {
      const { get, github } = await startPrs({});
      await expectJsonError(await get(`/api/prs${query}`), 400);
      expect(github.calls).toEqual([]);
    },
  );
});

describe('failures', () => {
  const GITHUB_DETAIL = `rate limited for ${SECRET}`;
  const exactly = async (response: Response, status: number, body: unknown) => {
    const text = await response.text();
    expect(response.status, text).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text)).toEqual(body);
    return text;
  };
  const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {});
  const logged = (errors: ReturnType<typeof silenceErrors>) =>
    errors.mock.calls.map((call) => String(call[0])).join('\n');

  it('turns a GitHub failure into a bare 502 and logs the redacted reason', async () => {
    const errors = silenceErrors();
    const github = fakeGitHub({
      [pullsPath(BILLING)]: { status: 500, body: { message: GITHUB_DETAIL } },
    });
    const { get } = await start({
      reports: fakeReports([BILLING_REPORT]),
      fetchImpl: github.fetchImpl,
    });
    const text = await exactly(await get('/api/prs'), 502, { error: 'GitHub request failed' });

    expect(text).not.toContain('rate limited');
    expect(logged(errors)).toContain('/api/prs');
    expect(logged(errors)).toContain('rate limited for [redacted]');
    expect(logged(errors), 'secret in log').not.toContain(SECRET);
  });

  it("leaves out a suspended installation's PRs and keeps the rest of the list", async () => {
    const errors = silenceErrors();
    const github = fakeGitHub({ [pullsPath(STOREFRONT)]: { body: [] } });
    const { get } = await start({
      reports: fakeReports([BILLING_REPORT, STOREFRONT_REPORT]),
      fetchImpl: github.fetchImpl,
      tokens: {
        token: async (id) => {
          if (id !== BILLING_INSTALLATION) return `installation-token-${id}`;
          throw new GitHubApiError('POST', '/app/installations/11/access_tokens', 403, 'suspended');
        },
      },
    });
    const response = await get('/api/prs');
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual([]);
    expect(github.calls.map((call) => call.path)).toEqual([pullsPath(STOREFRONT)]);
    expect(logged(errors)).toContain(BILLING);
  });

  it('still answers 502 when GitHub is down rather than refusing one installation', async () => {
    silenceErrors();
    const { get } = await start({
      reports: fakeReports([BILLING_REPORT]),
      tokens: {
        token: async () => {
          throw new GitHubApiError('POST', '/app/installations/11/access_tokens', 503, 'down');
        },
      },
    });
    const text = await exactly(await get('/api/prs'), 502, { error: 'GitHub request failed' });
    expect(text).not.toContain('down');
  });

  it('answers a generic 500 for anything else, with the store error kept in the log only', async () => {
    const errors = silenceErrors();
    const { get } = await start({
      reports: {
        latest: async () => {
          throw new SyntaxError(`Unexpected token in "apiKey: ${SECRET}"`);
        },
        list: async () => {
          throw new Error('disk gone');
        },
      },
    });
    const body = { error: 'Internal server error' };
    const reportText = await exactly(await get(`/api/report?repo=${BILLING}`), 500, body);
    const reposText = await exactly(await get('/api/repos'), 500, body);

    expect(reportText).not.toContain('Unexpected token');
    expect(reposText).not.toContain('disk gone');
    expect(logged(errors)).toContain('disk gone');
    expect(logged(errors), 'secret in log').not.toContain(SECRET);
  });

  it('answers 500 when a network error stops GitHub being reached', async () => {
    silenceErrors();
    const { get } = await start({
      reports: fakeReports([BILLING_REPORT]),
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await exactly(await get('/api/prs'), 500, { error: 'Internal server error' });
  });

  it('still ends the response when the reply cannot be serialized', async () => {
    silenceErrors();
    const unserializable = report(BILLING, { costUsd: 1n as unknown as number });
    const { get } = await start({ reports: fakeReports([unserializable]) });
    await exactly(await get(`/api/report?repo=${BILLING}`), 500, {
      error: 'Internal server error',
    });
  });
});
