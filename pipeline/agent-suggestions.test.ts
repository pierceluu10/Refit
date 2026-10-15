import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { suggestAgentsForPullRequest, SUGGESTION_MARKER } from './agent-suggestions.ts';
import { GitHubRequestError } from './github.ts';
import { parseWebhook } from './github-webhooks.ts';
import { runLocalService } from './local-service.ts';
import type { ServiceTarget } from './service-configuration.ts';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const files = vi.hoisted(() => ({ refs: {} as Record<string, Record<string, unknown>> }));
const posts = vi.hoisted(() => [] as { path: string; body: unknown }[]);

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
function contents(value: unknown) {
  return { encoding: 'base64', content: Buffer.from(text(value)).toString('base64') };
}
// Lists the files that differ between BASE and HEAD like GitHub's pull request files API, with a
// patch that removes every base line and adds every head line.
function changedFiles() {
  const base = files.refs[BASE] ?? {};
  const head = files.refs[HEAD] ?? {};
  return [...new Set([...Object.keys(base), ...Object.keys(head)])]
    .filter((filename) => text(base[filename]) !== text(head[filename]))
    .map((filename) => ({
      filename,
      status: !(filename in base) ? 'added' : !(filename in head) ? 'removed' : 'modified',
      patch: [
        ...(filename in base
          ? text(base[filename])
              .split('\n')
              .map((line) => `-${line}`)
          : []),
        ...(filename in head
          ? text(head[filename])
              .split('\n')
              .map((line) => `+${line}`)
          : []),
      ].join('\n'),
    }));
}
// Serves repository files per ref like GitHub's contents API, and records comment posts.
async function fakeGitHub(method: string, path: string, body?: unknown) {
  if (method === 'POST') {
    posts.push({ path, body });
    return { id: 1 };
  }
  if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files\?/.test(path)) return changedFiles();
  const match = path.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)\?ref=([a-f0-9]{40})$/);
  if (!match)
    return { id: 789, full_name: path.slice('/repos/'.length), archived: false, disabled: false };
  const file = files.refs[match[2]]?.[decodeURIComponent(match[1])];
  if (file === undefined) throw new GitHubRequestError(404, method, path);
  return contents(file);
}

vi.mock('./github-app.ts', () => ({
  authenticateGitHubRead: vi.fn(async () => ({
    token: 'read-test-token',
    appId: 123,
    installationId: 456,
  })),
  authenticateGitHubComment: vi.fn(async () => ({ token: 'comment-test-token' })),
}));
vi.mock('./github.ts', async (original) => ({
  ...(await original<typeof import('./github.ts')>()),
  requestGitHub: vi.fn((_token: string, method: string, path: string, body?: unknown) =>
    fakeGitHub(method, path, body),
  ),
}));
vi.mock('./watch.ts', () => ({
  watchOnce: vi.fn(async () => ({
    status: 'already-processed',
    provider: 'stripe',
    jobKey: 'job',
    sourceHash: 'source',
    previousStatus: 'existing-pr',
    output: '/tmp/evidence',
  })),
}));

const roots: string[] = [];
afterEach(async () => {
  files.refs = {};
  posts.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const request = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  fakeGitHub(method, path, body);

it('comments once on agents for provider SDKs a pull request adds', async () => {
  files.refs[BASE] = {
    'package.json': { dependencies: { stripe: '^17.7.0' } },
    '.refit.json': {
      formatVersion: 1,
      before: './b.json',
      after: './a.json',
      image: 'node:22-alpine',
      command: ['npm', 'test'],
    },
  };
  files.refs[HEAD] = {
    'package.json': {
      dependencies: {
        stripe: '^17.7.0',
        openai: '4.80.0',
        '@anthropic-ai/sdk': '0.40.0',
        lodash: '4.17.21',
      },
    },
  };
  const options = { request, repository: 'example/app', number: 7, base: BASE, head: HEAD };
  expect(await suggestAgentsForPullRequest(options)).toEqual({
    status: 'commented',
    agents: ['openai'],
  });
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe('/repos/example/app/issues/7/comments');
  const body = String((posts[0].body as { body: string }).body);
  expect(body).toContain(SUGGESTION_MARKER);
  expect(body).toContain('refit agents --add openai');
  expect(body).not.toContain('stripe');
  expect(body).not.toContain('Anthropic');
  expect(await suggestAgentsForPullRequest({ ...options, alreadySuggested: ['openai'] })).toEqual({
    status: 'no-new-agents',
    agents: [],
  });
  expect(posts).toHaveLength(1);
});

it('treats a missing base manifest or configuration as empty and skips configured adapters', async () => {
  files.refs[BASE] = {};
  files.refs[HEAD] = {
    'package.json': { devDependencies: { stripe: '17.7.0' } },
    '.refit.json': { formatVersion: 1 },
  };
  expect(
    await suggestAgentsForPullRequest({
      request,
      repository: 'example/app',
      number: 1,
      base: BASE,
      head: HEAD,
    }),
  ).toMatchObject({ status: 'commented', agents: ['stripe'] });
  files.refs[BASE] = {
    'package.json': {},
    '.refit.json': {
      formatVersion: 2,
      integrations: [{ id: 'ai', providerConfig: './refit/ai.provider.json' }],
    },
    'refit/ai.provider.json': { id: 'ai', packageName: 'openai' },
  };
  files.refs[HEAD] = { 'package.json': { dependencies: { openai: '4.80.0' } } };
  expect(
    await suggestAgentsForPullRequest({
      request,
      repository: 'example/app',
      number: 2,
      base: BASE,
      head: HEAD,
    }),
  ).toEqual({ status: 'no-new-agents', agents: [] });
});

it('suggests agents for SDKs a workspace manifest adds and raw API hostnames new source calls', async () => {
  const options = { request, repository: 'example/monorepo', number: 9, base: BASE, head: HEAD };
  files.refs[BASE] = {
    'package.json': { private: true, workspaces: ['packages/*'] },
    'packages/api/package.json': { dependencies: { express: '5.0.0' } },
  };
  files.refs[HEAD] = {
    ...files.refs[BASE],
    'packages/api/package.json': { dependencies: { express: '5.0.0', openai: '4.80.0' } },
    'node_modules/stripe/package.json': { dependencies: { stripe: '17.7.0' } },
  };
  expect(await suggestAgentsForPullRequest(options)).toEqual({
    status: 'commented',
    agents: ['openai'],
  });
  expect(String((posts[0].body as { body: string }).body)).toContain(
    '`openai@4.80.0` in `packages/api/package.json`',
  );

  posts.length = 0;
  files.refs[BASE] = { 'packages/billing/src/pay.ts': 'export const pay = () => 1;' };
  files.refs[HEAD] = {
    'packages/billing/src/pay.ts':
      "export const pay = () => fetch('https://api.stripe.com/v1/charges');",
  };
  expect(await suggestAgentsForPullRequest(options)).toEqual({
    status: 'commented',
    agents: ['stripe'],
  });
  expect(String((posts[0].body as { body: string }).body)).toContain(
    'calls `api.stripe.com` in `packages/billing/src/pay.ts`',
  );

  // Moving an existing call, or calling a provider whose agent is configured, suggests nothing.
  posts.length = 0;
  files.refs[BASE] = { 'src/a.ts': "fetch('https://api.stripe.com/v1/charges');" };
  files.refs[HEAD] = { 'src/a.ts': "await fetch('https://api.stripe.com/v1/charges');" };
  expect(await suggestAgentsForPullRequest(options)).toEqual({
    status: 'no-new-agents',
    agents: [],
  });
  files.refs[BASE] = { '.refit.json': { formatVersion: 1 } };
  files.refs[HEAD] = { ...files.refs[BASE], 'src/b.ts': "fetch('https://api.stripe.com/v1/x');" };
  expect(await suggestAgentsForPullRequest(options)).toEqual({
    status: 'no-new-agents',
    agents: [],
  });
  expect(posts).toHaveLength(0);
});

it('parses pull request webhooks for opened, reopened and synchronized pull requests only', () => {
  const payload = (action: string) =>
    new TextEncoder().encode(
      JSON.stringify({
        action,
        installation: { id: 456 },
        repository: { full_name: 'Example/App' },
        pull_request: { number: 7, base: { sha: BASE }, head: { sha: HEAD } },
      }),
    );
  expect(parseWebhook(payload('synchronize'), 'pull_request', 123)).toEqual({
    kind: 'pull_request',
    installation: 456,
    repository: 'example/app',
    number: 7,
    base: BASE,
    head: HEAD,
  });
  expect(parseWebhook(payload('closed'), 'pull_request', 123)).toEqual({ kind: 'ignored' });
  expect(() =>
    parseWebhook(
      new TextEncoder().encode(
        JSON.stringify({
          action: 'opened',
          installation: { id: 456 },
          repository: { full_name: 'example/app' },
          pull_request: { number: 7, base: { sha: 'short' }, head: { sha: HEAD } },
        }),
      ),
      'pull_request',
      123,
    ),
  ).toThrow('incomplete');
});

it('records a pull request webhook for a configured repository and comments from the service loop', async () => {
  files.refs[BASE] = { 'package.json': { dependencies: { stripe: '^17.7.0' } } };
  files.refs[HEAD] = { 'package.json': { dependencies: { stripe: '^17.7.0', openai: '4.80.0' } } };
  const root = await mkdtemp(join(tmpdir(), 'refit-agent-service-'));
  roots.push(root);
  const secret = 'webhook-secret-for-agent-tests-123';
  const control = 'control-token-for-agent-tests-456';
  const target: ServiceTarget = {
    id: 'app',
    repository: 'example/app',
    base: 'main',
    workflow: {
      repository: undefined,
      before: resolve('pipeline/fixtures/before.json'),
      after: resolve('pipeline/fixtures/after.json'),
      latestStripe: undefined,
      image: 'checks:local',
      command: ['npm', 'test'],
      baselineCommand: undefined,
      providerConfig: undefined,
      apiVersion: undefined,
      fullDiff: false,
    },
    source: { kind: 'file', path: resolve('pipeline/fixtures/after.json') },
    documentationSources: [],
  };
  const controller = new AbortController();
  let ready!: (url: string) => void;
  const address = new Promise<string>((resolve) => (ready = resolve));
  const completion = runLocalService({
    targets: [target],
    app: { appId: '123', privateKeyFile: 'unused' },
    directory: root,
    port: 0,
    intervalSeconds: 30,
    webhookSecret: secret,
    controlToken: control,
    signal: controller.signal,
    onReady: ready,
  });
  try {
    const url = await address;
    const deliver = async (repository: string, number: number) => {
      const body = JSON.stringify({
        action: 'opened',
        installation: { id: 456 },
        repository: { full_name: repository },
        pull_request: { number, base: { sha: BASE }, head: { sha: HEAD } },
      });
      return fetch(`${url}/github/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-GitHub-Delivery': randomUUID(),
          'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        },
        body,
      });
    };
    expect((await deliver('other/repository', 3)).status).toBe(202);
    expect((await deliver('example/app', 7)).status).toBe(202);
    let registry: { pullRequests?: Record<string, { status: string; suggested: string[] }> } = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      registry = await (
        await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${control}` } })
      ).json();
      if (registry.pullRequests?.['example/app#7']?.status === 'commented') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(registry.pullRequests).toEqual({
      'example/app#7': expect.objectContaining({ status: 'commented', suggested: ['openai'] }),
    });
    expect(posts.map((post) => post.path)).toEqual(['/repos/example/app/issues/7/comments']);
  } finally {
    controller.abort();
    await completion;
  }
}, 30_000);
