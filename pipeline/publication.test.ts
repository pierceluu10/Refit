import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  findExistingMigration,
  publicationConfiguration,
  publishDraft,
  publicationWaiver,
  publishUnresolved,
} from './publication.ts';
import { createReviewArtifacts } from './review.ts';
import { migrationIdentity } from './migration-identity.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import type { validateMigration } from './validation.ts';
import * as githubApp from './github-app.ts';
import { DependencyPreparationError, preparationFailure } from './dependency-preparation.ts';
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
    // GitHub's own spelling of the repository, which may differ in case from the configured one.
    repository: 'example/application',
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
        html_url: `https://github.com/${state.repository}/pull/17`,
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

it('requires explicit valid target and credentials', () => {
  expect(() => publicationConfiguration('https://evil.test/x', 'main', 'secret')).toThrow(
    /--github/,
  );
  expect(() => publicationConfiguration('owner/repo', 'x/../main', 'secret')).toThrow(/--base/);
  expect(() => publicationConfiguration('owner/repo', 'main', '')).toThrow(/GITHUB_TOKEN/);
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
    dependencyFailure: preparationFailure(
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
  expect(request.body.body).toMatch(/^## Why this needs review\n/);
  expect(request.body.body).toContain(
    '- Refit ran no checks: preparing the dependencies failed because the committed lockfile is out of sync with package.json.',
  );
  expect(request.body.body).toMatch(
    /\n## Untested: checks did not run\n\n\*\*Refit did not run any checks on this patch\.\*\*/,
  );
  expect(request.body.body).toContain('the committed lockfile is out of sync with package.json');
  expect(request.body.body).toContain(
    '**What Refit could not do:** `package-lock.json` does not match `package.json`, so Refit could not install it, and none of its checks ran on this patch.',
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
    failure: { reason: 'lockfile-out-of-sync' },
  });
  expect(local.manifest).toMatchObject({ waivedGates: ['dependency-preparation'] });

  // Owner decision 1: other reasons join the untested draft, and an AI patch says so.
  const webhook = await untestedReport();
  webhook.findings[0].webhook = {
    schema: 'payment_intent',
    eventTypes: ['payment_intent.succeeded'],
    origin: { file: 'webhook.ts', line: 1, column: 1 },
    apiVersion: 'unverified',
  };
  webhook.patch.generator = 'openai' as typeof webhook.patch.generator;
  expect(publicationWaiver(webhook, true)?.map(({ gate }) => gate)).toEqual([
    'dependency-preparation',
    'ai-patch',
    'webhook-api-version',
  ]);
  // Untested with no recorded preparation failure says nothing about why; it never publishes.
  const unclassified = await untestedReport();
  delete unclassified.validation.dependencyFailure;
  expect(publicationWaiver(unclassified, true)).toBeUndefined();
  await expect(publishDraft(unclassified, allowed)).rejects.toThrow(/passing baseline/);
  const regression = await untestedReport();
  regression.validation.status = regression.patch.validation = 'regression';
  expect(publicationWaiver(regression, true)).toBeUndefined();
  await expect(publishDraft(regression, allowed)).rejects.toThrow(/passing baseline/);
  // #288: Refit's generated type check could not run and there are no tests, so no check ran
  // (get-convex/convex-saas's TS5069 in refit-bench run 40180681405, before the fix).
  const noCheck = await untestedReport();
  delete noCheck.validation.dependencyFailure;
  Object.assign(noCheck.validation, {
    typeCheckUnavailable:
      ".refit-tsconfig.json(1,34): error TS5069: Option 'tsBuildInfoFile' cannot be specified without specifying option 'incremental' or option 'composite'.",
  });
  expect(publicationWaiver(noCheck, true)?.map(({ gate }) => gate)).toContain('no-checks');
  expect(publicationWaiver(noCheck, false)).toBeUndefined();
});

// Owner decision 1: a repository checked without its submodules says so, naming each one.
it('lists every submodule Refit checked around as a reason to review', async () => {
  const evidence = await report();
  const validation = evidence.validation as typeof evidence.validation & { submodules: string[] };
  validation.submodules = ['docs/site', 'packages/ui'];
  const reviews = publicationWaiver(evidence, true)!;
  expect(reviews.map(({ gate }) => gate)).toEqual(['submodules']);
  const { manifest, files } = createReviewArtifacts(evidence, 'github', undefined, reviews);
  expect(manifest.title).toMatch(/^\[Needs review\] /);
  expect(files['pull-request.md']).toContain(
    '- Refit checked this repository without its submodules, so nothing in them was scanned, built or tested. **Check:** Check out the submodules, run your checks on this branch, and confirm the code in each one works with this patch.\n  - `docs/site`\n  - `packages/ui`',
  );
});

it('says the checks passed on the original when only the upgraded lockfile could not be installed', async () => {
  const evidence = await untestedReport();
  evidence.validation.baseline = { status: 'passed', exitCode: 0, stdout: '', stderr: '' };
  const { files } = createReviewArtifacts(
    evidence,
    'github',
    undefined,
    publicationWaiver(evidence, true),
  );
  const body = files['pull-request.md'];
  expect(body).toContain(
    '- Refit did not run the checks on this patch: preparing its upgraded dependencies failed because the committed lockfile is out of sync with package.json. They passed on the original code.',
  );
  expect(body).toMatch(
    /\n## Untested: checks did not run\n\n\*\*Refit did not run any checks on this patch\.\*\* `npm test` passed on the original code, but the upgraded lockfile this patch writes could not be installed because the committed lockfile is out of sync with package\.json, so the patched code was not built or tested\./,
  );
  expect(body).toContain(
    '`npm test` passed on the original code. **Not run on this patch: installing its upgraded lockfile failed (`lockfile-out-of-sync`); this patch is untested.**',
  );
  expect(body).toContain(
    'Install the upgraded dependencies and run your checks: Refit could not run them on this patch.',
  );
  expect(body).not.toContain('neither the original nor the patched code');
  // The generic reason says Refit could not install it, without repeating itself.
  evidence.validation.dependencyFailure = {
    ...evidence.validation.dependencyFailure!,
    ...preparationFailure(new DependencyPreparationError('npm dependency preparation failed (1).')),
  };
  const generic = createReviewArtifacts(
    evidence,
    'github',
    undefined,
    publicationWaiver(evidence, true),
  ).files['pull-request.md'];
  expect(generic).toContain(
    '`npm test` passed on the original code, but Refit could not install the upgraded lockfile this patch writes in its sandbox, so the patched code was not built or tested.',
  );
});

it('publishes for review by default and refuses both publication flags together', () => {
  expect(publishUnresolved({})).toBe(true);
  expect(publishUnresolved({ 'publish-unresolved': true })).toBe(true);
  expect(publishUnresolved({ 'publish-validated-only': true })).toBe(false);
  expect(() =>
    publishUnresolved({ 'publish-unresolved': true, 'publish-validated-only': true }),
  ).toThrow('Choose either --publish-unresolved or --publish-validated-only.');
});
