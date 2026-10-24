import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  findExistingMigration,
  publicationConfiguration,
  publishDraft,
  publicationWaiver,
} from './publication.ts';
import { createReviewArtifacts } from './review.ts';
import { migrationIdentity } from './migration-identity.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import type { validateMigration } from './validation.ts';
import * as githubApp from './github-app.ts';
import { repositoryDependencyFailure } from './dependency-preparation.ts';
import { validatedReport } from './fixtures/publication-report.ts';
import { PipelineInputError } from './types.ts';

const REVISION = 'a'.repeat(40);
const BASE_TREE = 'b'.repeat(40);
const PATCH_TREE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const OPTIONS = publicationConfiguration('example/application', 'main', 'test-token');
type Report = Awaited<ReturnType<typeof validateMigration>>;

const report = () => validatedReport(REVISION);

it('refuses webhook publication even with otherwise passing validation evidence', async () => {
  const evidence = await report();
  evidence.findings[0].webhook = {
    schema: 'payment_intent',
    eventTypes: ['payment_intent.succeeded'],
    origin: { file: 'webhook.ts', line: 1, column: 1 },
    apiVersion: 'unverified',
  };
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(publishDraft(evidence, OPTIONS)).rejects.toThrow(/migration-policy/);
  expect(fetch).not.toHaveBeenCalled();
});

it('publishes a webhook-only review as a [Needs review] draft only with --publish-unresolved', async () => {
  const webhookReport = async () => {
    const evidence = await report();
    evidence.findings[0].webhook = {
      schema: 'payment_intent',
      eventTypes: ['payment_intent.succeeded'],
      origin: { file: 'webhook.ts', line: 1, column: 1 },
      apiVersion: 'unverified',
    };
    return evidence;
  };
  const evidence = await webhookReport();
  const finding = evidence.findings[0];
  expect(publicationWaiver(evidence, false)).toBeUndefined();
  await expect(publishDraft(evidence, OPTIONS)).rejects.toThrow(/migration-policy/);

  const remote = github();
  const allowed = { ...OPTIONS, allowUnresolved: true };
  expect(await publishDraft(evidence, allowed)).toMatchObject({ status: 'created', draft: true });
  const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
  expect(request.body.title).toMatch(/^\[Needs review\] /);
  expect(request.body.body).toMatch(/^## Webhook API version not verified/);
  expect(request.body.body).toContain('Dashboard > Developers > Webhooks');
  expect(request.body.body).toContain(
    `\`${finding.file}:${finding.line}\` (\`payment_intent.succeeded\`)`,
  );
  const local = createReviewArtifacts(
    evidence,
    'local',
    undefined,
    publicationWaiver(evidence, true),
  );
  expect(JSON.parse(local.files['report.json']).waivedGates[0].gate).toBe('webhook-api-version');
  expect(local.manifest).toMatchObject({ waivedGates: ['webhook-api-version'] });

  // The waiver covers only the webhook version: any other review reason still refuses.
  const skipped = await webhookReport();
  skipped.skippedFiles = ['src/broken.ts'];
  expect(publicationWaiver(skipped, true)).toBeUndefined();
  await expect(publishDraft(skipped, allowed)).rejects.toThrow(/migration-policy/);
  const unknownVersion = await webhookReport();
  unknownVersion.apiVersion.applicability = 'unknown';
  await expect(publishDraft(unknownVersion, allowed)).rejects.toThrow(
    /Draft publication is blocked/,
  );
});

async function endpointReport(): Promise<Report> {
  const fixture = resolve('pipeline/fixtures/endpoint-replacement');
  const scan = await runPipeline({
    repository: `${fixture}/repository`,
    before: `${fixture}/before.json`,
    after: `${fixture}/after.json`,
    providerConfig: `${fixture}/provider.json`,
    apiVersion: '1',
    proposePatch: true,
  });
  if (!('diff' in scan.patch)) throw new Error('Expected endpoint patch');
  const base = await report();
  const source = await readFile(`${fixture}/repository/src/items.ts`, 'utf8');
  return {
    ...base,
    ...scan,
    specificationDiff: {
      engine: 'oasdiff',
      version: 'controlled',
      coverage: 'Controlled endpoint removal.',
      changes: [
        {
          id: 'api-path-removed-without-deprecation',
          level: 3,
          text: 'api path removed',
          path: '/legacy/items/{id}',
          operation: 'GET',
        },
      ],
    },
    patch: { ...scan.patch, validation: 'passed' },
    publicationFiles: [
      {
        path: 'src/items.ts',
        mode: '100644',
        content: source.replace('items.retrieveLegacy', 'items.retrieve'),
      },
    ],
    validation: {
      ...base.validation,
      patchHash: digest(scan.patch.diff),
      reason: 'Controlled publication evidence, not actual container checks.',
    },
  };
}

async function requestReport(): Promise<Report> {
  const fixture = resolve('pipeline/fixtures/request-renames');
  const scan = await runPipeline({
    repository: `${fixture}/repository`,
    before: `${fixture}/before.json`,
    after: `${fixture}/after.json`,
    providerConfig: `${fixture}/provider.json`,
    apiVersion: '1',
    proposePatch: true,
  });
  if (!('diff' in scan.patch)) throw new Error('Expected request migration patch');
  const base = await report();
  const source = await readFile(`${fixture}/repository/src/items.ts`, 'utf8');
  return {
    ...base,
    ...scan,
    specificationDiff: {
      engine: 'oasdiff',
      version: 'controlled',
      coverage: 'Controlled request rename.',
      changes: [
        {
          id: 'request-property-removed',
          text: 'removed the request property `legacy_name`',
          path: '/items',
          operation: 'POST',
          level: 2,
        },
        {
          id: 'new-required-request-property',
          text: 'added the new required request property `display_name`',
          path: '/items',
          operation: 'POST',
          level: 3,
        },
      ],
    },
    patch: { ...scan.patch, validation: 'passed' },
    publicationFiles: [
      {
        path: 'src/items.ts',
        mode: '100644',
        content: source.replace(
          '{ legacy_name, quantity }',
          '{ display_name: legacy_name, quantity }',
        ),
      },
    ],
    validation: {
      ...base.validation,
      patchHash: digest(scan.patch.diff),
      reason: 'Controlled request publication evidence; not actual container checks.',
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
    moveHeadOnCommitRead: false,
    author: 'example',
    // Other open pull requests on the base, which a new App draft may supersede.
    others: [] as Record<string, unknown>[],
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
    if (method === 'GET' && path === `/git/commits/${HEAD}`) {
      if (state.moveHeadOnCommitRead) state.head = REVISION;
      return response({
        tree: { sha: state.tree },
        parents: state.parents.map((sha) => ({ sha })),
      });
    }
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
      expect(url.searchParams.get('base')).toBe('main');
      if (url.searchParams.get('state') === 'open') {
        expect(url.searchParams.has('head')).toBe(false);
        return response([...(state.pull?.state === 'open' ? [state.pull] : []), ...state.others]);
      }
      expect(url.searchParams.get('state')).toBe('all');
      expect(url.searchParams.get('head')).toMatch(/^example:refit\//);
      return response(state.pull ? [state.pull] : []);
    }
    if (method === 'POST' && path === '/pulls') {
      if (state.failPull) return response({ message: 'test-token PRIVATE SERVER ERROR' }, 503);
      state.pull = {
        number: 17,
        html_url: 'https://github.com/example/application/pull/17',
        title: body.title,
        body: body.body,
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
  const commit = remote.calls.find((call) => call.path === '/git/commits')?.body;
  expect(commit).toMatchObject({ parents: [REVISION], tree: PATCH_TREE });
  // The commit names the change, the checks and the run, and carries no check logs.
  expect(commit?.message).toMatch(
    /^fix\(stripe\): [^\n]+\n\n[\s\S]*\nChecks: [\s\S]*\nRefit-Run: [0-9a-f]{12}\n$/,
  );
  expect(commit?.message).not.toContain('PRIVATE LOG');
  const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
  expect(request.body).toMatchObject({ draft: true, base: 'main', maintainer_can_modify: false });
  expect(request.body.body).toContain(value.validation.patchHash);
  expect(request.body.body).not.toContain('PRIVATE LOG');
  expect(request.body.body).not.toContain('This is a local review artifact');
  expect(JSON.stringify(remote.calls)).not.toContain('Co-authored-by');
});

it('publishes a configured endpoint replacement as a readable draft through the shared publisher', async () => {
  const remote = github();
  const value = await endpointReport();
  expect(await publishDraft(value, OPTIONS)).toMatchObject({ status: 'created', draft: true });
  const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
  expect(request.body.title).toBe('fix(catalog): replace retired items.retrieveLegacy calls');
  expect(request.body.body).toContain(
    'Retires `items.retrieveLegacy` (`GET /legacy/items/{id}`) in favor of `items.retrieve` (`GET /items/{id}`).',
  );
  expect(remote.calls.find((call) => call.path === '/git/trees')?.body.tree).toEqual(
    value.publicationFiles.map((file) => ({ ...file, type: 'blob' })),
  );
});

it('blocks endpoint publication when any mapped usage remains unsupported', async () => {
  const remote = github();
  const value = await endpointReport();
  value.operationChanges[0].supported = false;
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/unmapped breaking contract changes/);
  expect(remote.fetch).not.toHaveBeenCalled();
});

it('publishes request-field migrations with readable function, body field and endpoint context', async () => {
  const remote = github();
  const value = await requestReport();
  expect(await publishDraft(value, OPTIONS)).toMatchObject({ status: 'created', draft: true });
  const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
  expect(request.body.title).toBe('fix(catalog): update items.create after legacy_name removal');
  expect(request.body.body).toContain(
    'Renames request field `legacy_name` to `display_name` in `items.create`.',
  );
});

it('blocks request publication independently when usage evidence is unsupported or another breaking change is unhandled', async () => {
  const remote = github();
  const value = await requestReport();
  value.requestChanges![0].supported = false;
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/unmapped breaking contract changes/);
  value.requestChanges![0].supported = true;
  if (value.specificationDiff.engine !== 'oasdiff')
    throw new Error('Expected controlled full contract evidence');
  value.specificationDiff.changes.push({
    id: 'required-query-parameter-added',
    text: 'added another required parameter',
    path: '/items',
    operation: 'POST',
    level: 3,
  });
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/unmapped breaking contract changes/);
  expect(remote.fetch).not.toHaveBeenCalled();
});

it('reuses an open draft a person marked ready, and never writes to one they closed or merged', async () => {
  const remote = github();
  const value = await report();
  await publishDraft(value, OPTIONS);
  remote.state.pull!.draft = false;
  expect(await publishDraft(value, OPTIONS)).toMatchObject({ status: 'existing', draft: false });
  remote.state.pull!.state = 'closed';
  const writes = remote.calls.filter((call) => call.method !== 'GET').length;
  expect(await publishDraft(value, OPTIONS)).toMatchObject({ status: 'closed', state: 'closed' });
  remote.state.pull!.merged_at = '2026-10-24T08:00:00Z';
  expect(await publishDraft(value, OPTIONS)).toMatchObject({ status: 'merged', state: 'closed' });
  expect(remote.calls.filter((call) => call.method !== 'GET')).toHaveLength(writes);
});

it('publishes separate named integrations against the same base without sharing branch or PR markers', async () => {
  const value = await report();
  const branches: string[] = [];
  for (const integration of ['billing-stripe', 'secondary-stripe']) {
    const remote = github();
    const result = await publishDraft(value, { ...OPTIONS, integration });
    expect(result).toMatchObject({ status: 'created', integration });
    branches.push(result.branch);
    const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
    expect(request.body.title).toBe(
      `fix(${integration}): restore payment history after charges removal`,
    );
    expect(request.body.body).toContain(`, integration \`${integration}\`.`);
    expect(request.body.body).toContain(
      `<!-- refit-migration:${migrationIdentity(value, REVISION, integration)} -->`,
    );
    expect(request.body.body).not.toContain(
      `<!-- refit-migration:${migrationIdentity(value, REVISION)} -->`,
    );
    expect(remote.calls.find((call) => call.path === '/git/trees')?.body.tree).toEqual(
      value.publicationFiles.map((file) => ({ ...file, type: 'blob' })),
    );
    expect(await publishDraft(value, { ...OPTIONS, integration })).toMatchObject({
      status: 'existing',
      branch: result.branch,
    });
    expect(
      remote.calls.filter((call) => call.method === 'POST' && call.path === '/pulls'),
    ).toHaveLength(1);
  }
  expect(new Set(branches).size).toBe(2);
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

it('publishes a passing draft with unresolved findings only when explicitly allowed, and says so', async () => {
  const remote = github();
  const value = await report();
  value.patch.unresolvedFindings = 2;
  expect(await publishDraft(value, { ...OPTIONS, allowUnresolved: true })).toMatchObject({
    status: 'created',
    draft: true,
  });
  const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
  expect(request.body.body).toContain(
    '2 usages of the breaking changes are still unmigrated.** The checks passed without them;',
  );
  value.validation.status = value.patch.validation = 'regression';
  await expect(publishDraft(value, { ...OPTIONS, allowUnresolved: true })).rejects.toThrow(
    /passing baseline/,
  );
});

it('blocks publication when application API-version applicability is unknown', async () => {
  const remote = github();
  const value = await report();
  value.apiVersion.applicability = 'unknown';
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/Draft publication is blocked/);
  expect(remote.fetch).not.toHaveBeenCalled();
});

it('independently rejects conflicting or unverified strict source evidence before GitHub requests', async () => {
  const remote = github();
  const value = await report();
  value.apiVersion.source.status = 'conflict';
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/Draft publication is blocked/);
  value.apiVersion.source.status = 'unknown';
  value.apiVersion.policy = 'source-verified';
  await expect(publishDraft(value, OPTIONS)).rejects.toThrow(/Draft publication is blocked/);
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
  remote.state.moveHeadOnCommitRead = true;
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
    expect(
      remote.calls.some(
        (call) =>
          call.method !== 'GET' && (call.path.startsWith('/git/refs') || call.path === '/pulls'),
      ),
    ).toBe(false);
  },
);

it('leaves an open draft as it is when a personal token cannot tell its own commits apart', async () => {
  const remote = github();
  const value = await report();
  await publishDraft(value, OPTIONS);
  remote.state.tree = BASE_TREE;
  const writes = remote.calls.filter((call) => call.method !== 'GET' && call.path !== '/git/trees');
  expect(await publishDraft(value, OPTIONS)).toMatchObject({
    status: 'existing',
    leftUnchanged: 'Refit updates an existing draft only when it publishes as the GitHub App.',
  });
  expect(
    remote.calls.filter((call) => call.method !== 'GET' && call.path !== '/git/trees'),
  ).toEqual(writes);
});

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
    const url = new URL(input);
    const path = url.pathname;
    const response = url.searchParams.has('head')
      ? []
      : path.endsWith('/pulls')
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
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it('discovers only the selected integration draft and refuses unscoped legacy matches for named profiles', async () => {
  vi.spyOn(githubApp, 'authenticateGitHubApp').mockResolvedValue({
    token: 'test-token',
    author: { name: 'Refit Agent', email: '123+refit-agent[bot]@users.noreply.github.com' },
    publisher: { kind: 'github-app', appId: 123, name: 'Refit Agent', login: 'refit-agent[bot]' },
  });
  const value = await report();
  const pulls = [undefined, 'billing-stripe', 'secondary-stripe'].map((integration, index) => ({
    number: index + 1,
    html_url: `https://github.com/example/application/pull/${index + 1}`,
    body: `<!-- refit-migration:${migrationIdentity(value, REVISION, integration)} -->\n${integration ? `<!-- refit-integration:${integration} -->` : ''}\n"runId": "${value.runId}"`,
    state: 'open',
    draft: true,
    user: { login: 'refit-agent[bot]' },
    base: { ref: 'main', sha: REVISION },
    head: { sha: HEAD, ref: 'refit/example', repo: { full_name: 'example/application' } },
  }));
  const fetcher = vi.fn(async (input: string, options: RequestInit) => {
    expect(options.method).toBe('GET');
    const url = new URL(input);
    const path = url.pathname;
    return new Response(
      JSON.stringify(
        url.searchParams.has('head')
          ? []
          : path.endsWith('/pulls')
            ? pulls
            : path.includes('/git/commits/')
              ? { parents: [{ sha: REVISION }] }
              : { object: { sha: path.endsWith('/main') ? REVISION : HEAD } },
      ),
    );
  });
  vi.stubGlobal('fetch', fetcher);
  const options = publicationConfiguration('example/application', 'main', undefined, {
    appId: '123',
    privateKeyFile: '/unused.pem',
  });
  expect(
    await findExistingMigration(value, REVISION, { ...options, integration: 'billing-stripe' }),
  ).toMatchObject({ number: 2, duplicateCount: 1, integration: 'billing-stripe' });
  expect(
    await findExistingMigration(value, REVISION, { ...options, integration: 'secondary-stripe' }),
  ).toMatchObject({ number: 3, duplicateCount: 1, integration: 'secondary-stripe' });
  expect(
    await findExistingMigration(value, REVISION, { ...options, integration: 'another-stripe' }),
  ).toBeUndefined();
  expect(await findExistingMigration(value, REVISION, options)).toMatchObject({
    number: 1,
    duplicateCount: 1,
  });
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

// A dependency preparation failure the repository owner fixes: checks never ran.
async function untestedReport(): Promise<Report> {
  const value = await report();
  const notRun = { status: 'not-run' as const, exitCode: null, stdout: '', stderr: '' };
  value.validation = {
    ...value.validation,
    status: 'untested',
    baseline: notRun,
    patched: notRun,
    dependencyFailure: repositoryDependencyFailure(
      new PipelineInputError(
        'package.json dependencies differ from the committed package-lock.json: stripe is "11.0.0" in package.json but missing in the lockfile. Run npm install and commit the updated package-lock.json.',
      ),
    ),
  };
  value.patch.validation = 'untested';
  return value;
}

it('publishes an untested patch as [Needs review] only with --publish-unresolved, naming the fix', async () => {
  const evidence = await untestedReport();
  expect(publicationWaiver(evidence, false)).toBeUndefined();
  const refused = github();
  await expect(publishDraft(evidence, OPTIONS)).rejects.toThrow(/passing baseline/);
  expect(refused.fetch).not.toHaveBeenCalled();

  const remote = github();
  const allowed = { ...OPTIONS, allowUnresolved: true };
  expect(await publishDraft(evidence, allowed)).toMatchObject({ status: 'created', draft: true });
  const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
  expect(request.body.title).toMatch(/^\[Needs review\] /);
  expect(request.body.body).toMatch(
    /^## Untested: checks did not run\n\n\*\*Refit did not run any checks on this patch\.\*\*/,
  );
  expect(request.body.body).toContain('the committed lockfile is out of sync with package.json');
  expect(request.body.body).toContain(
    "**What to do:** Update `package-lock.json` so it matches `package.json` (run your package manager's install), commit it, then rerun your checks on this branch. Don't merge until they pass.",
  );
  expect(request.body.body).toContain(
    'Not run: dependency preparation failed (`lockfile-out-of-sync`)',
  );
  const local = createReviewArtifacts(
    evidence,
    'local',
    undefined,
    publicationWaiver(evidence, true),
  );
  expect(JSON.parse(local.files['report.json']).waivedGates[0]).toMatchObject({
    gate: 'dependency-preparation',
    reason: 'lockfile-out-of-sync',
  });
  expect(local.manifest).toMatchObject({ waivedGates: ['dependency-preparation'] });

  // Every other gate still refuses, and so do failures that are not a repository-side reason.
  const skipped = await untestedReport();
  skipped.skippedFiles = ['src/broken.ts'];
  const webhook = await untestedReport();
  webhook.findings[0].webhook = {
    schema: 'payment_intent',
    eventTypes: ['payment_intent.succeeded'],
    origin: { file: 'webhook.ts', line: 1, column: 1 },
    apiVersion: 'unverified',
  };
  const unclassified = await untestedReport();
  delete unclassified.validation.dependencyFailure;
  const ai = await untestedReport();
  ai.patch.generator = 'openai' as typeof ai.patch.generator;
  for (const value of [skipped, webhook, unclassified, ai]) {
    expect(publicationWaiver(value, true)).toBeUndefined();
    await expect(publishDraft(value, allowed)).rejects.toThrow();
  }
  const unknownVersion = await untestedReport();
  unknownVersion.apiVersion.applicability = 'unknown';
  await expect(publishDraft(unknownVersion, allowed)).rejects.toThrow(
    /Draft publication is blocked/,
  );
  const regression = await untestedReport();
  regression.validation.status = regression.patch.validation = 'regression';
  expect(publicationWaiver(regression, true)).toBeUndefined();
  await expect(publishDraft(regression, allowed)).rejects.toThrow(/passing baseline/);
});

// The request-rename fixture plus `items.archive`, whose target contract drops `note`: the rename
// migrates `legacy_name`, and the archive call still sends the removed `note`.
async function parameterScan(leaveRequestParameters?: boolean) {
  const fixture = resolve('pipeline/fixtures/request-renames');
  const root = await mkdtemp(join(tmpdir(), 'refit-parameter-'));
  try {
    await cp(fixture, root, { recursive: true });
    const archive = (fields: string[]) => ({
      post: {
        operationId: 'archiveItem',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: Object.fromEntries(fields.map((name) => [name, { type: 'string' }])),
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Item',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
          },
        },
      },
    });
    for (const [name, fields] of [
      ['before.json', ['reason', 'note']],
      ['after.json', ['reason']],
    ] as const) {
      const document = JSON.parse(await readFile(join(root, name), 'utf8'));
      document.paths['/items/{id}/archive'] = archive([...fields]);
      await writeFile(join(root, name), JSON.stringify(document));
    }
    const provider = JSON.parse(await readFile(join(root, 'provider.json'), 'utf8'));
    provider.operations.push({
      resource: 'items',
      method: 'archive',
      schema: 'Item',
      operationId: 'archiveItem',
    });
    await writeFile(join(root, 'provider.json'), JSON.stringify(provider));
    const items = join(root, 'repository/src/items.ts');
    await writeFile(
      items,
      `${await readFile(items, 'utf8')}
export async function archiveItem(id: string, note: string) {
  return catalog.items.archive(id, { reason: 'retired', note });
}
`,
    );
    return await runPipeline({
      repository: join(root, 'repository'),
      before: join(root, 'before.json'),
      after: join(root, 'after.json'),
      providerConfig: join(root, 'provider.json'),
      apiVersion: '1',
      proposePatch: true,
      leaveRequestParameters,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function parameterReport(): Promise<Report> {
  const scan = await parameterScan(true);
  if (!('diff' in scan.patch)) throw new Error('Expected request migration patch');
  const base = await report();
  const source = await readFile(
    'pipeline/fixtures/request-renames/repository/src/items.ts',
    'utf8',
  );
  return {
    ...base,
    ...scan,
    patch: { ...scan.patch, validation: 'passed' },
    publicationFiles: [
      {
        path: 'src/items.ts',
        mode: '100644',
        content: source.replace(
          '{ legacy_name, quantity }',
          '{ display_name: legacy_name, quantity }',
        ),
      },
    ],
    validation: { ...base.validation, patchHash: digest(scan.patch.diff) },
  };
}

it('migrates around a removed request parameter only when asked, and leaves it to the owner', async () => {
  expect((await parameterScan()).patch).toMatchObject({
    status: 'not-generated',
    reason: expect.stringMatching(/removed\. No reviewed replacement/),
  });
  const evidence = await parameterReport();
  expect(evidence.patch.diff).toContain('display_name: legacy_name');
  expect(evidence.patch.unresolvedFindings).toBe(1);
  expect(publicationWaiver(evidence, false)).toBeUndefined();
  const refused = github();
  await expect(publishDraft(evidence, OPTIONS)).rejects.toThrow(
    /removed\. No reviewed replacement/,
  );
  expect(refused.fetch).not.toHaveBeenCalled();

  const remote = github();
  const allowed = { ...OPTIONS, allowUnresolved: true };
  expect(await publishDraft(evidence, allowed)).toMatchObject({ status: 'created', draft: true });
  const request = remote.calls.find((call) => call.method === 'POST' && call.path === '/pulls')!;
  const body = String(request.body.body);
  expect(request.body.title).toMatch(/^\[Needs review\] /);
  expect(body).toMatch(
    /^## Removed request parameters left for you\n\n\*\*Don't merge until you change the calls below\.\*\*/,
  );
  expect(body).toContain('no longer accepts `note`, and this patch still sends it');
  expect(body).toContain('No reviewed replacement for `note` exists.');
  expect(body).toContain('- `src/items.ts:9`: `items.archive` sends `note`');
  expect(body).not.toContain('still unmigrated');
  const local = createReviewArtifacts(
    evidence,
    'local',
    undefined,
    publicationWaiver(evidence, true),
  );
  expect(JSON.parse(local.files['report.json']).waivedGates[0]).toMatchObject({
    gate: 'removed-request-parameter',
    calls: [{ file: 'src/items.ts', line: 9, call: 'items.archive', parameter: 'note' }],
  });
  expect(local.manifest).toMatchObject({ waivedGates: ['removed-request-parameter'] });

  // Stripe's payment_method_types explains why the similar-looking replacement is not one.
  const stripeParameter = await parameterReport();
  stripeParameter.findings.find((entry) => entry.requestParameter)!.requestParameter!.parameter =
    'payment_method_types';
  const stripeBody = createReviewArtifacts(
    stripeParameter,
    'github',
    undefined,
    publicationWaiver(stripeParameter, true),
  ).files['pull-request.md'];
  expect(stripeBody).toContain('filters the payment methods Stripe computes dynamically');

  const skipped = await parameterReport();
  skipped.skippedFiles = ['src/broken.ts'];
  const ai = await parameterReport();
  ai.patch.generator = 'openai' as typeof ai.patch.generator;
  for (const value of [skipped, ai]) {
    expect(publicationWaiver(value, true)).toBeUndefined();
    await expect(publishDraft(value, allowed)).rejects.toThrow();
  }
  const regression = await parameterReport();
  regression.validation.status = regression.patch.validation = 'regression';
  await expect(publishDraft(regression, allowed)).rejects.toThrow(/passing baseline/);
});
