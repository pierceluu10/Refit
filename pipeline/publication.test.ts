import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { findExistingMigration, publicationConfiguration, publishDraft } from './publication.ts';
import { migrationIdentity } from './migration-identity.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import type { validateMigration } from './validation.ts';
import * as githubApp from './github-app.ts';

const REVISION = 'a'.repeat(40);
const BASE_TREE = 'b'.repeat(40);
const PATCH_TREE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const OPTIONS = publicationConfiguration('example/application', 'main', 'test-token');
type Report = Awaited<ReturnType<typeof validateMigration>>;

async function report(): Promise<Report> {
  const scan = await runPipeline({
    repository: resolve('pipeline/fixtures/repository'),
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    proposePatch: true,
  });
  if (!('diff' in scan.patch)) throw new Error('Expected fixture patch');
  const source = await readFile('pipeline/fixtures/repository/billing.ts', 'utf8');
  return {
    ...scan,
    patch: { ...scan.patch, validation: 'passed' },
    publicationFiles: [
      {
        path: 'billing.ts',
        mode: '100644',
        content: source.replace(
          'intent.charges.data',
          '(await stripe.charges.list({ payment_intent: intent.id })).data',
        ),
      },
    ],
    validation: {
      status: 'passed',
      revision: REVISION,
      image: `sha256:${'e'.repeat(64)}`,
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'f'.repeat(64),
      patchHash: digest(scan.patch.diff),
      baseline: { status: 'passed', exitCode: 0, stdout: 'PRIVATE LOG', stderr: '' },
      patched: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      limits: { timeoutMs: 120000, outputBytes: 1048576, network: 'none' },
      publishable: false,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Controlled publication test evidence.',
    },
  };
}

function github() {
  const state = {
    base: REVISION,
    branch: '',
    head: '',
    tree: PATCH_TREE,
    parents: [REVISION],
    pull: undefined as Record<string, unknown> | undefined,
    failPull: false,
    raceRef: false,
    racePull: false,
    moveBaseOnCommit: false,
    moveHeadOnPullList: false,
    author: 'example',
  };
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: string, options: RequestInit) => {
    expect(input.startsWith('https://api.github.com/repos/example/application/')).toBe(true);
    expect(options.redirect).toBe('error');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname.replace('/repos/example/application', ''));
    const method = options.method!;
    const body = JSON.parse(String(options.body ?? '{}'));
    calls.push({ method, path, body });
    const response = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (method === 'GET' && path === '/git/ref/heads/main')
      return response({ object: { type: 'commit', sha: state.base } });
    if (method === 'GET' && path.startsWith('/git/ref/heads/refit/'))
      return state.head
        ? response({ object: { type: 'commit', sha: state.head } })
        : response({}, 404);
    if (method === 'GET' && path === `/git/commits/${REVISION}`)
      return response({ tree: { sha: BASE_TREE } });
    if (method === 'GET' && path === `/git/commits/${HEAD}`)
      return response({
        tree: { sha: state.tree },
        parents: state.parents.map((sha) => ({ sha })),
      });
    if (method === 'POST' && path === '/git/trees') return response({ sha: PATCH_TREE }, 201);
    if (method === 'POST' && path === '/git/commits') {
      if (state.moveBaseOnCommit) state.base = HEAD;
      return response({ sha: HEAD }, 201);
    }
    if (method === 'POST' && path === '/git/refs') {
      state.head = body.sha;
      state.branch = body.ref.replace('refs/heads/', '');
      return response({}, state.raceRef ? 422 : 201);
    }
    if (method === 'GET' && path === '/pulls') {
      expect(url.searchParams.get('state')).toBe('all');
      expect(url.searchParams.get('head')).toMatch(/^example:refit\//);
      expect(url.searchParams.get('base')).toBe('main');
      if (state.moveHeadOnPullList) state.head = REVISION;
      return response(state.pull ? [state.pull] : []);
    }
    if (method === 'POST' && path === '/pulls') {
      if (state.failPull) return response({ message: 'test-token PRIVATE SERVER ERROR' }, 503);
      state.pull = {
        number: 17,
        html_url: 'https://github.com/example/application/pull/17',
        head: { sha: state.head },
        base: { ref: 'main' },
        draft: true,
        state: 'open',
        user: { login: state.author },
      };
      return response(state.pull, state.racePull ? 422 : 201);
    }
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { state, calls, fetch };
}

afterEach(() => vi.unstubAllGlobals());

it('publishes only the candidate files on the existing base tree and creates a draft with evidence', async () => {
  const remote = github();
  const value = await report();
  const result = await publishDraft(value, OPTIONS);
  expect(result).toMatchObject({
    status: 'created',
    draft: true,
    revision: REVISION,
    head: HEAD,
    reviewRequired: true,
  });
  expect(remote.calls.find((call) => call.path === '/git/trees')?.body).toEqual({
    base_tree: BASE_TREE,
    tree: value.publicationFiles.map((file) => ({ ...file, type: 'blob' })),
  });
  expect(remote.calls.find((call) => call.path === '/git/commits')?.body).toMatchObject({
    parents: [REVISION],
    tree: PATCH_TREE,
  });
  const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
  expect(request.body).toMatchObject({ draft: true, base: 'main', maintainer_can_modify: false });
  expect(request.body.body).toContain(value.validation.patchHash);
  expect(request.body.body).not.toContain('PRIVATE LOG');
  expect(request.body.body).not.toContain('This is a local review artifact');
  expect(JSON.stringify(remote.calls)).not.toContain('Co-authored-by');
});

it('reuses an existing PR even after a human closes it or marks it ready', async () => {
  const remote = github();
  const value = await report();
  await publishDraft(value, OPTIONS);
  remote.state.pull!.state = 'closed';
  remote.state.pull!.draft = false;
  expect(await publishDraft(value, OPTIONS)).toMatchObject({
    status: 'existing',
    state: 'closed',
    draft: false,
  });
  expect(
    remote.calls.filter((call) => call.method === 'POST' && call.path === '/pulls'),
  ).toHaveLength(1);
  expect(
    remote.calls.filter((call) => call.method === 'POST' && call.path === '/git/refs'),
  ).toHaveLength(1);
});

it('stops failed, inconsistent and unresolved evidence before making a network request', async () => {
  const remote = github();
  const value = await report();
  value.validation.status = value.patch.validation = 'regression';
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/passing baseline/);
  value.validation.status = value.patch.validation = 'passed';
  value.patch.unresolvedFindings = 1;
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/zero unresolved/);
  value.patch.unresolvedFindings = 0;
  value.validation.patchHash = 'tampered';
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/consistent patch/);
  expect(remote.fetch).not.toHaveBeenCalled();
});

it('rejects a stale base before writing any Git objects', async () => {
  const remote = github();
  remote.state.base = HEAD;
  await expect(publishDraft(await report(), OPTIONS)).rejects.toThrow(/base changed/);
  expect(remote.calls.every((call) => call.method === 'GET')).toBe(true);
});

it('rechecks the base before creating a branch and checks the head before creating a PR', async () => {
  const remote = github();
  remote.state.moveBaseOnCommit = true;
  await expect(publishDraft(await report(), OPTIONS)).rejects.toThrow(/base changed/);
  expect(remote.calls.some((call) => call.path === '/git/refs')).toBe(false);
  remote.state.moveBaseOnCommit = false;
  remote.state.base = REVISION;
  remote.state.moveHeadOnPullList = true;
  await expect(publishDraft(await report(), OPTIONS)).rejects.toThrow(/branch changed/);
  expect(remote.calls.some((call) => call.path === '/pulls' && call.method === 'POST')).toBe(false);
});

it.each(['tree', 'parents'] as const)(
  'refuses to overwrite an existing branch with a different %s',
  async (key) => {
    const remote = github();
    remote.state.head = HEAD;
    if (key === 'tree') remote.state.tree = BASE_TREE;
    else remote.state.parents = [HEAD];
    await expect(publishDraft(await report(), OPTIONS)).rejects.toThrow(/Refusing to overwrite/);
    expect(remote.calls.some((call) => call.path === '/git/refs' || call.path === '/pulls')).toBe(
      false,
    );
  },
);

it('recovers after a failed PR request without exposing the response body or creating another branch', async () => {
  const remote = github();
  remote.state.failPull = true;
  const value = await report();
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/HTTP 503/);
  remote.state.failPull = false;
  expect(await publishDraft(value, OPTIONS)).toMatchObject({ status: 'created' });
  expect(remote.calls.filter((call) => call.path === '/git/refs')).toHaveLength(1);
});

it('reconciles simultaneous branch and PR creation without force updating', async () => {
  const remote = github();
  remote.state.raceRef = remote.state.racePull = true;
  expect(await publishDraft(await report(), OPTIONS)).toMatchObject({ status: 'existing' });
  expect(remote.calls.some((call) => call.method === 'PATCH' || call.method === 'DELETE')).toBe(
    false,
  );
});

it('requires explicit valid target and credentials', () => {
  expect(() => publicationConfiguration('https://evil.test/x', 'main', 'secret')).toThrow(
    /--github/,
  );
  expect(() => publicationConfiguration('owner/repo', 'x/../main', 'secret')).toThrow(/--base/);
  expect(() => publicationConfiguration('owner/repo', 'main', '')).toThrow(/GITHUB_TOKEN/);
});

it('publishes with the verified app identity on a separate branch from personal-token runs', async () => {
  const remote = github();
  remote.state.author = 'refit-agent[bot]';
  const authentication = vi.spyOn(githubApp, 'authenticateGitHubApp').mockResolvedValue({
    token: 'test-token',
    author: { name: 'Refit Agent', email: '123+refit-agent[bot]@users.noreply.github.com' },
    publisher: { kind: 'github-app', appId: 123, name: 'Refit Agent', login: 'refit-agent[bot]' },
  });
  const value = await report();
  const app = { appId: '123', privateKeyFile: '/private/key.pem' };
  const result = await publishDraft(
    value,
    publicationConfiguration('example/application', 'main', 'ignored-personal-token', app),
  );
  expect(authentication).toHaveBeenCalledWith(app, 'example/application');
  expect(result.publisher?.login).toBe('refit-agent[bot]');
  expect(result.branch).not.toBe(
    `refit/${digest(`${value.runId}:${value.validation.patchHash}`).slice(0, 32)}`,
  );
  expect(remote.calls.find((call) => call.path === '/git/commits')?.body).toMatchObject({
    author: { name: 'Refit Agent', email: '123+refit-agent[bot]@users.noreply.github.com' },
    committer: { name: 'Refit Agent', email: '123+refit-agent[bot]@users.noreply.github.com' },
  });
  expect(JSON.stringify(result)).not.toContain('test-token');
  expect(JSON.stringify(remote.calls)).not.toContain('ignored-personal-token');
});

it('discovers equivalent App drafts before generation while ignoring foreign authors and reconciling legacy receipts', async () => {
  vi.spyOn(githubApp, 'authenticateGitHubApp').mockResolvedValue({
    token: 'test-token',
    author: { name: 'Refit Agent', email: '123+refit-agent[bot]@users.noreply.github.com' },
    publisher: { kind: 'github-app', appId: 123, name: 'Refit Agent', login: 'refit-agent[bot]' },
  });
  const value = await report();
  const makePull = (number: number, body: string, author = 'refit-agent[bot]') => ({
    number,
    html_url: `https://github.com/example/application/pull/${number}`,
    body,
    state: 'open',
    draft: true,
    user: { login: author },
    base: { ref: 'main', sha: REVISION },
    head: { sha: HEAD, ref: 'refit/example', repo: { full_name: 'example/application' } },
  });
  const fetcher = vi.fn(async (input: string, options: RequestInit) => {
    expect(options.method).toBe('GET');
    const path = new URL(input).pathname;
    const response = path.endsWith('/pulls')
      ? [
          makePull(1, `"runId": "${value.runId}"`, 'someone-else'),
          makePull(3, `"runId": "${value.runId}"`),
          makePull(2, `<!-- refit-migration:${migrationIdentity(value, REVISION)} -->`),
        ]
      : path.includes('/git/commits/')
        ? { parents: [{ sha: REVISION }] }
        : path.endsWith('/main')
          ? { object: { sha: REVISION } }
          : { object: { sha: HEAD } };
    return new Response(JSON.stringify(response));
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await findExistingMigration(
    value,
    REVISION,
    publicationConfiguration('example/application', 'main', undefined, {
      appId: '123',
      privateKeyFile: '/unused.pem',
    }),
  );
  expect(result).toMatchObject({
    number: 2,
    status: 'existing',
    duplicateCount: 2,
    validation: 'not-rerun',
    publisher: { login: 'refit-agent[bot]' },
  });
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it('does not authenticate an app until the candidate passes the existing publication gates', async () => {
  const authenticate = vi.spyOn(githubApp, 'authenticateGitHubApp');
  const value = await report();
  value.validation.status = value.patch.validation = 'regression';
  await expect(
    publishDraft(
      value,
      publicationConfiguration('example/application', 'main', undefined, {
        appId: '123',
        privateKeyFile: '/unused.pem',
      }),
    ),
  ).rejects.toThrow('passing baseline');
  expect(authenticate).not.toHaveBeenCalled();
});
