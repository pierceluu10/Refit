import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deadlineTitle } from './deadline-alerts.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import {
  githubDeadlineUses,
  githubRouteKey,
  scanGitHubCalls,
  type GitHubCall,
} from './github-api-calls.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(
  files: Record<string, string>,
  manifest: object = { name: 'app', dependencies: { '@octokit/rest': '^20.0.0' } },
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-github-api-'));
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
  return scanGitHubCalls(await repository(files, manifest));
}

function at(found: GitHubCall[], file: string, line: number) {
  const call = found.find((item) => item.file === file && item.line === line);
  expect(call, `${file}:${line}`).toBeDefined();
  return call!;
}

describe('githubRouteKey', () => {
  it('ignores parameter names, trailing slashes and query strings', () => {
    expect(githubRouteKey('get /repos/{o}/{r}/?page=2')).toBe(
      githubRouteKey('GET /repos/{owner}/{repo}'),
    );
    expect(githubRouteKey('GET /teams/:team_id')).toBe('GET /teams/{}');
    expect(githubRouteKey('GET /repos/{o}/{r}/compare/{base}...{head}')).toBe(
      githubRouteKey('GET /repos/{owner}/{repo}/compare/{basehead}'),
    );
    expect(githubRouteKey('POST /repos/{o}/{r}/releases/{id}/assets{?name,label}')).toBe(
      'POST /repos/{}/{}/releases/{}/assets',
    );
  });
});

describe('Octokit clients', () => {
  it('reads REST methods, request routes and paginate, with deprecations', async () => {
    const { calls, packages } = await scan({
      'src/a.ts': [
        "import { Octokit } from '@octokit/rest';",
        "const octokit = new Octokit({ auth: 'token' });",
        'export async function run() {',
        "  await octokit.rest.issues.create({ owner: 'o', repo: 'r', title: 't' });",
        "  await octokit.dependencyGraph.exportSbom({ owner: 'o', repo: 'r' });",
        "  await octokit.rest.migrations.getImportStatus({ owner: 'o', repo: 'r' });",
        "  await octokit.request('GET /teams/{team_id}/members', { team_id: 1 });",
        "  await octokit.paginate(octokit.rest.issues.listForRepo, { owner: 'o', repo: 'r' });",
        "  await octokit.paginate('GET /classrooms');",
        '  await octokit.rest.issues.notAMethod();',
        '  await app.webhooks.on();',
        '}',
      ].join('\n'),
    });
    expect(packages).toEqual([
      { name: '@octokit/rest', file: 'package.json', declared: '^20.0.0', locked: null },
    ]);
    expect(at(calls, 'src/a.ts', 4)).toMatchObject({
      kind: 'octokit',
      method: 'issues.create',
      route: 'POST /repos/{owner}/{repo}/issues',
      notices: [],
      use: 'live',
    });
    expect(at(calls, 'src/a.ts', 4).versionChanges.length).toBeGreaterThan(0);
    const legacy = at(calls, 'src/a.ts', 5);
    expect(legacy.route).toBe('GET /repos/{owner}/{repo}/dependency-graph/sbom');
    expect(legacy.notices).toEqual([
      expect.objectContaining({ source: 'openapi', date: '2026-11-13' }),
    ]);
    const imports = at(calls, 'src/a.ts', 6);
    expect(imports.notices.map((notice) => notice.source)).toEqual(['octokit', 'openapi']);
    expect(imports.notes[0]).toMatch(/not in @octokit\/plugin-rest-endpoint-methods/);
    expect(at(calls, 'src/a.ts', 7)).toMatchObject({
      kind: 'request',
      route: 'GET /teams/{team_id}/members',
      notices: [expect.objectContaining({ source: 'openapi' })],
    });
    expect(at(calls, 'src/a.ts', 8)).toMatchObject({ method: 'issues.listForRepo' });
    expect(at(calls, 'src/a.ts', 9)).toMatchObject({
      route: 'GET /classrooms',
      notices: [expect.objectContaining({ date: '2026-08-28' })],
    });
    expect(at(calls, 'src/a.ts', 10).notes[0]).toMatch(/not a method of any recorded/);
    // `webhooks` is not an Octokit REST scope.
    expect(calls.find((call) => call.line === 11)).toBeUndefined();
  });

  it('follows getOctokit, Probot handlers, class fields and runtime routes', async () => {
    const { calls } = await scan(
      {
        'src/action.ts': [
          "import * as github from '@actions/github';",
          "const client = github.getOctokit('token');",
          "client.rest.orgs.listSecurityManagerTeams({ org: 'o' });",
        ].join('\n'),
        'src/app.ts': [
          "import { Probot } from 'probot';",
          'export default (app: Probot) => {',
          "  app.on('issues.opened', async (context) => {",
          "    await context.octokit.issues.createComment(context.issue({ body: 'hi' }));",
          '  });',
          '};',
        ].join('\n'),
        'src/service.ts': [
          "import { Octokit } from 'octokit';",
          'export class Service {',
          '  constructor(private readonly octokit: Octokit) {}',
          '  run(route: string) {',
          '    return this.octokit.request(route);',
          '  }',
          '}',
        ].join('\n'),
        'test/app.test.ts': [
          "import { Octokit } from '@octokit/core';",
          "new Octokit().request('GET /teams/{team_id}');",
        ].join('\n'),
      },
      { name: 'app' },
    );
    expect(at(calls, 'src/action.ts', 3).notices.map((notice) => notice.source)).toEqual([
      'octokit',
      'openapi',
    ]);
    expect(at(calls, 'src/app.ts', 4)).toMatchObject({
      method: 'issues.createComment',
      route: 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    });
    expect(at(calls, 'src/service.ts', 5)).toMatchObject({
      route: null,
      unknown: ['the route comes from `route` at runtime'],
    });
    expect(at(calls, 'test/app.test.ts', 2)).toMatchObject({ use: 'test' });
  });

  it('follows a client made in another file', async () => {
    const { calls } = await scan({
      'src/client.ts': [
        "import { Octokit } from '@octokit/rest';",
        'export function client() {',
        '  return new Octokit();',
        '}',
      ].join('\n'),
      'src/use.ts': [
        "import { client } from './client';",
        'const gh = client();',
        "gh.rest.dependencyGraph.exportSbom({ owner: 'o', repo: 'r' });",
      ].join('\n'),
    });
    expect(at(calls, 'src/use.ts', 3).notices[0]?.date).toBe('2026-11-13');
  });

  it('ignores lookalike receivers', async () => {
    const { calls } = await scan({
      'src/a.ts': [
        "import { Octokit } from '@octokit/rest';",
        'const other = { issues: { create() {} } };',
        'other.issues.create();',
      ].join('\n'),
    });
    expect(calls).toEqual([]);
  });
});

describe('clients Refit cannot resolve', () => {
  it('reads recorded methods on client-like receivers, destructured scopes and GraphQL holders', async () => {
    const { calls } = await scan(
      {
        'lib/publish.js': [
          'export default async function publish(config, { Octokit }) {',
          '  const octokit = new Octokit();',
          "  await octokit.request('POST /repos/{owner}/{repo}/releases', {});",
          '}',
        ].join('\n'),
        'src/driver.js': [
          "const { Octokit } = require('@octokit/rest');",
          "const { withCustomRequest } = require('@octokit/graphql');",
          'const client = (token) => new Octokit({ auth: token });',
          'async function run(token) {',
          '  const { issues, paginate, repos } = client(token);',
          "  await issues.createComment({ owner: 'o', repo: 'r', issue_number: 1, body: 'b' });",
          '  await paginate(repos.listCommentsForCommit, {});',
          '  const graphql = withCustomRequest(client(token).request);',
          '  await graphql(`{ viewer { login } }`);',
          '}',
          'async function helper(github) {',
          '  await github.search.commits({ q: "x" });',
          '  const cache = new Map();',
          '  cache.get("x");',
          '}',
        ].join('\n'),
        'src/changelog.js': [
          "const { graphql } = require('@octokit/graphql');",
          'class Fetcher {',
          '  constructor() {',
          '    this.client = graphql.defaults({});',
          '  }',
          '  run() {',
          '    return this.client(`{ viewer { login } }`);',
          '  }',
          '}',
        ].join('\n'),
        'src/other.ts': [
          'export function run(thing: { rest: { repos: { get(): void } } }) {',
          '  thing.rest.repos.get();',
          '  thing.repos.get();',
          '}',
        ].join('\n'),
      },
      { name: 'app' },
    );
    expect(at(calls, 'lib/publish.js', 3).route).toBe('POST /repos/{owner}/{repo}/releases');
    expect(at(calls, 'src/driver.js', 6).method).toBe('issues.createComment');
    expect(at(calls, 'src/driver.js', 7).method).toBe('repos.listCommentsForCommit');
    expect(at(calls, 'src/driver.js', 9).kind).toBe('graphql');
    expect(at(calls, 'src/driver.js', 12).method).toBe('search.commits');
    expect(at(calls, 'src/changelog.js', 7).kind).toBe('graphql');
    // `.rest.<scope>.<method>` is specific enough without a GitHub import; `thing.repos.get` is not.
    expect(calls.filter((call) => call.file === 'src/other.ts').map((call) => call.line)).toEqual([
      2,
    ]);
    expect(calls.filter((call) => call.file === 'src/driver.js').map((call) => call.line)).toEqual([
      6, 7, 9, 12,
    ]);
  });
});

describe('raw requests and version headers', () => {
  it('reads api.github.com URLs and pinned API versions', async () => {
    const { calls, pins } = await scan(
      {
        'src/a.ts': [
          "const API = 'https://api.github.com';",
          'export async function run(id: string, endpoint: string) {',
          '  await fetch(`${API}/teams/${id}/repos`, {',
          "    headers: { 'X-GitHub-Api-Version': '2022-11-28' },",
          '  });',
          "  await fetch(`https://api.github.com/classrooms`, { method: 'GET' });",
          '  await fetch(`https://api.github.com/${endpoint}`);',
          '}',
          "const headers = { 'x-github-api-version': '2021-01-01' };",
        ].join('\n'),
      },
      { name: 'app' },
    );
    expect(at(calls, 'src/a.ts', 3)).toMatchObject({
      kind: 'url',
      route: 'GET /teams/{id}/repos',
      client: 'fetch',
      notices: [expect.objectContaining({ source: 'openapi', date: '2021-02-01' })],
    });
    expect(at(calls, 'src/a.ts', 6).notices[0]?.date).toBe('2026-08-28');
    expect(at(calls, 'src/a.ts', 7)).toMatchObject({
      route: null,
      unknown: ['path is built at runtime from `endpoint`'],
    });
    expect(pins).toEqual([
      expect.objectContaining({ line: 4, version: '2022-11-28', endOfSupport: '2028-03-10' }),
      expect.objectContaining({
        line: 9,
        version: '2021-01-01',
        endOfSupport: null,
        notes: [expect.stringMatching(/not a REST API version GitHub lists/)],
      }),
    ]);
  });
});

describe('URLs built from a default base', () => {
  it('follows a request URL back to an env fallback or a parameter default', async () => {
    const { calls } = await scan(
      {
        'src/a.ts': [
          'export async function run(path: string, id: string) {',
          "  const base = process.env.API_URL || 'https://api.github.com';",
          '  const url = path.startsWith("http") ? path : `${base}/${path}`;',
          "  await fetch(url, { method: 'DELETE' });",
          '  const token = `${base}/app/installations/${id}/access_tokens`;',
          "  return fetch(token, { method: 'POST' });",
          '}',
          "export async function query({ endpoint = 'https://api.github.com/graphql' }) {",
          "  return fetch(endpoint, { method: 'POST' });",
          '}',
          "const unused = 'https://api.github.com/graphql';",
        ].join('\n'),
      },
      { name: 'app' },
    );
    expect(calls.map((call) => [call.line, call.route])).toEqual([
      [4, null],
      [6, 'POST /app/installations/{id}/access_tokens'],
      [9, 'POST /graphql'],
    ]);
  });
});

describe('GraphQL queries', () => {
  it('walks fields through fragments and reports upcoming removals', async () => {
    const { calls } = await scan({
      'src/a.ts': [
        "import { Octokit } from '@octokit/rest';",
        "import { graphql } from '@octokit/graphql';",
        'const octokit = new Octokit();',
        'const QUERY = /* GraphQL */ `',
        '  query ($id: ID!) {',
        '    node(id: $id) {',
        '      ... on CheckRun { annotations(first: 10) { nodes { ...Annotation } } }',
        '    }',
        '  }',
        '  fragment Annotation on CheckAnnotation { databaseId path }',
        '`;',
        'octokit.graphql(QUERY, { id: "x" });',
        'graphql(`{ viewer { login } }`);',
        'graphql(`{ not valid`);',
        'octokit.graphql(load());',
      ].join('\n'),
    });
    expect(at(calls, 'src/a.ts', 12)).toMatchObject({
      kind: 'graphql',
      fields: ['CheckAnnotation.databaseId'],
      notices: [expect.objectContaining({ source: 'graphql', date: '2027-01-01' })],
    });
    expect(at(calls, 'src/a.ts', 13)).toMatchObject({ fields: [], notices: [] });
    expect(at(calls, 'src/a.ts', 14).unknown).toEqual(['the query does not parse as GraphQL']);
    expect(at(calls, 'src/a.ts', 15).unknown).toEqual(['the query comes from `load()` at runtime']);
  });
});

describe('githubDeadlineUses', () => {
  it('matches pins, routes and GraphQL coordinates by the registry spelling', async () => {
    const root = await repository({
      'src/a.ts': [
        "import { Octokit } from '@octokit/rest';",
        'const octokit = new Octokit();',
        "octokit.request('GET /classrooms', { headers: { 'X-GitHub-Api-Version': '2022-11-28' } });",
        'octokit.graphql(`{ node(id: "x") { ... on CheckAnnotation { databaseId } } }`);',
      ].join('\n'),
    });
    const uses = await githubDeadlineUses(root, [
      '2022-11-28',
      'GET /classrooms',
      'CheckAnnotation.databaseId',
      'GET /teams/{team_id}',
    ]);
    expect(uses.map((use) => [use.version, use.line])).toEqual([
      ['2022-11-28', 3],
      ['GET /classrooms', 3],
      ['CheckAnnotation.databaseId', 4],
    ]);
  });
});

describe('the shipped deadline registry', () => {
  it('reports GitHub version pins, removed endpoints and GraphQL fields', async () => {
    const now = new Date('2026-10-22T00:00:00Z');
    const root = await repository({
      'src/a.ts': [
        "import { Octokit } from '@octokit/rest';",
        'const octokit = new Octokit();',
        "octokit.rest.dependencyGraph.exportSbom({ owner: 'o', repo: 'r', headers: { 'X-GitHub-Api-Version': '2022-11-28' } });",
        'octokit.graphql(`{ node(id: "x") { ... on CheckAnnotation { databaseId } } }`);',
      ].join('\n'),
    });
    const { exposures } = await scanDeadlines(
      root,
      await loadDeadlineRegistry(undefined, now),
      now,
    );
    expect(exposures.map(deadlineTitle)).toEqual([
      'GitHub API endpoint GET /repos/{owner}/{repo}/dependency-graph/sbom reaches its sunset on 2026-11-13',
      'GitHub API GraphQL field CheckAnnotation.databaseId reaches its sunset on 2027-01-01',
      'GitHub API REST API version 2022-11-28 reaches its sunset on 2028-03-10',
    ]);
  });
});
