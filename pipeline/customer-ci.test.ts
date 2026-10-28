import { parse } from 'yaml';
import { expect, it } from 'vitest';
import {
  applyCustomerCiEvidence,
  CUSTOMER_CI_BRANCH,
  CUSTOMER_CI_MARKER,
  CUSTOMER_CI_WORKFLOW,
  customerCiOutcome,
  customerCiPullRequest,
  customerCiWorkflow,
  proposeCustomerCi,
  type GitHubRequest,
} from './customer-ci.ts';
import { GitHubRequestError } from './github.ts';

const HEAD = 'a'.repeat(40);
const CI = `
jobs:
  test:
    runs-on: ubuntu-24.04
    env:
      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - id: filter
        uses: dorny/paths-filter@v3
      - uses: actions/setup-node@v4
        if: steps.filter.outputs.code == 'true'
        with:
          node-version: 20
          registry-url: https://npm.pkg.github.com
      - run: npm ci && npm run build && npx vercel deploy --token $VERCEL_TOKEN
        if: steps.filter.outputs.code == 'true'
      - run: npm test
`;
const files = (extra: Record<string, string> = {}) =>
  new Map(
    Object.entries({
      'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' } }),
      'package-lock.json': '{}',
      ...extra,
    }),
  );

it("runs the repository's own CI setup with its secrets, on Refit branches only, read-only", () => {
  const workflow = customerCiWorkflow(files({ '.github/workflows/ci.yml': CI }))!;
  const value = parse(workflow.content);
  // Never on the proposal branch: nothing runs before the customer merges it.
  expect(value.on).toEqual({ push: { branches: ['refit/**', '!refit/validation-workflow'] } });
  expect(value.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(value.jobs)).toEqual(['baseline', 'patched']);
  const patched = value.jobs.patched;
  expect(patched['runs-on']).toBe('ubuntu-24.04');
  expect(patched.env).toEqual({ NPM_TOKEN: '${{ secrets.NPM_TOKEN }}' });
  expect(
    patched.steps.map((step: { uses?: string; run?: string }) => step.uses ?? step.run),
  ).toEqual(['actions/checkout@v4', 'actions/setup-node@v4', 'npm ci', 'npm test']);
  expect(patched.steps[0].with['persist-credentials']).toBe(false);
  expect(value.jobs.baseline.steps[1].run).toContain('git merge-base');
  expect(workflow.content).not.toMatch(/pull_request_target|write|steps\.filter|&a1|deploy|build/);
});

it('falls back to setup-node and the lockfile install, and avoids a watch-mode test script', () => {
  const workflow = customerCiWorkflow(
    new Map([
      [
        'package.json',
        JSON.stringify({
          packageManager: 'pnpm@9.15.9',
          scripts: { test: 'jest --watch', 'test:ci': 'jest --ci' },
        }),
      ],
      ['pnpm-lock.yaml', ''],
    ]),
  )!;
  const steps = parse(workflow.content).jobs.patched.steps;
  expect(
    steps.slice(1).map((step: { uses?: string; run?: string }) => step.uses ?? step.run),
  ).toEqual([
    'actions/setup-node@v4',
    'npm install --global pnpm@9.15.9',
    'pnpm install --frozen-lockfile',
    'pnpm run test:ci',
  ]);
  expect(customerCiWorkflow(new Map([['package.json', '{}']]))).toBeUndefined();
});

it('counts CI results under the offline gates', () => {
  expect(customerCiOutcome('success', 'success')).toBe('passed');
  expect(customerCiOutcome('success', 'failure')).toBe('regression');
  expect(customerCiOutcome('failure', 'success')).toBe('baseline-failed');
  // A cancelled, skipped or timed-out job is no evidence, and never closes a draft.
  expect(customerCiOutcome('success', 'cancelled')).toBe('inconclusive');
  expect(customerCiOutcome('success', 'missing')).toBe('inconclusive');
  expect(customerCiOutcome('cancelled', 'failure')).toBe('inconclusive');
  expect(customerCiOutcome('success', null)).toBe('pending');
  expect(customerCiOutcome(undefined, 'success')).toBe('missing');
});

it('says what the workflow does, what it can touch and what Refit reads', () => {
  const { title, body } = customerCiPullRequest('.github/workflows/ci.yml', 'npm test');
  expect(title).toBe('Add the Refit validation workflow');
  expect(body.startsWith(CUSTOMER_CI_MARKER)).toBe(true);
  for (const phrase of [
    'refit/**',
    'contents: read',
    'never merges',
    'never asks for those secrets',
  ])
    expect(body).toContain(phrase);
});

// A GitHub stand-in: routes by method and path prefix, recording every call.
function github(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request: GitHubRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = Object.keys(routes)
      .filter((route) => `${method} ${path}`.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new GitHubRequestError(404, method, path);
    const value = routes[key];
    return typeof value === 'function' ? value(body) : value;
  };
  return { request, calls };
}

it('opens the workflow pull request once and leaves a closed one closed', async () => {
  const repository = 'acme/shop';
  const fresh = github({
    'GET /repos/acme/shop/pulls': [],
    'GET /repos/acme/shop/contents/': () => {
      throw new GitHubRequestError(404, 'GET', 'contents');
    },
    'GET /repos/acme/shop/git/ref/heads/main': { object: { sha: HEAD } },
    'GET /repos/acme/shop/git/trees/': {
      tree: [
        { type: 'blob', path: 'package.json', sha: 'p' },
        { type: 'blob', path: 'package-lock.json', sha: 'l' },
        { type: 'blob', path: 'src/index.ts', sha: 's' },
      ],
    },
    'GET /repos/acme/shop/git/blobs/p': {
      content: Buffer.from(JSON.stringify({ scripts: { test: 'vitest run' } })).toString('base64'),
    },
    'GET /repos/acme/shop/git/blobs/l': { content: Buffer.from('{}').toString('base64') },
    'GET /repos/acme/shop/git/commits/': { tree: { sha: 't' } },
    'POST /repos/acme/shop/git/trees': { sha: 'tree' },
    'POST /repos/acme/shop/git/commits': { sha: 'commit' },
    'POST /repos/acme/shop/git/refs': {},
    'POST /repos/acme/shop/pulls': { html_url: 'https://github.com/acme/shop/pull/7' },
    'GET /repos/acme/shop': { default_branch: 'main' },
  });
  expect(await proposeCustomerCi({ request: fresh.request, repository })).toEqual({
    status: 'opened',
    url: 'https://github.com/acme/shop/pull/7',
  });
  expect(fresh.calls.some((call) => call.path.includes('/git/blobs/s'))).toBe(false);
  const tree = fresh.calls.find(
    (call) => call.path.endsWith('/git/trees') && call.method === 'POST',
  )!;
  expect(tree.body).toMatchObject({ tree: [{ path: CUSTOMER_CI_WORKFLOW }] });
  expect(fresh.calls.find((call) => call.path.endsWith('/git/refs'))!.body).toMatchObject({
    ref: `refs/heads/${CUSTOMER_CI_BRANCH}`,
  });
  const pull = fresh.calls.find((call) => call.method === 'POST' && call.path.endsWith('/pulls'))!;
  expect(pull.body).toMatchObject({ head: CUSTOMER_CI_BRANCH, base: 'main' });
  expect(String((pull.body as { body: string }).body)).toContain('`npm test`');
  const closed = github({
    'GET /repos/acme/shop/pulls': [
      { html_url: 'https://github.com/acme/shop/pull/7', state: 'closed' },
    ],
    'GET /repos/acme/shop': { default_branch: 'main' },
  });
  expect(await proposeCustomerCi({ request: closed.request, repository })).toMatchObject({
    status: 'existing',
  });
  expect(closed.calls.every((call) => call.method === 'GET')).toBe(true);
});

it('records CI evidence on the draft and closes a regression only while Refit owns its head', async () => {
  const draft = (pushed: string) =>
    github({
      'GET /repos/acme/shop/pulls/3': {
        state: 'open',
        head: { sha: HEAD, ref: 'refit/stripe-endive' },
        body: `<!-- refit-pushed: ${pushed} -->`,
      },
      'GET /repos/acme/shop/actions/workflows/refit-validation.yml/runs': {
        workflow_runs: [
          { id: 9, status: 'completed', html_url: 'https://github.com/acme/shop/actions/runs/9' },
        ],
      },
      'GET /repos/acme/shop/actions/runs/9/jobs': {
        jobs: [
          { id: 1, name: 'baseline', status: 'completed', conclusion: 'success', html_url: 'b' },
          { id: 2, name: 'patched', status: 'completed', conclusion: 'failure', html_url: 'p' },
        ],
      },
      'GET /repos/acme/shop/issues/3/comments': [],
      'POST /repos/acme/shop/issues/3/comments': {},
      'PATCH /repos/acme/shop/pulls/3': {},
    });
  const log = async (job: number) => `log of job ${job}\nFAIL src/billing.test.ts`;
  const owned = draft(HEAD);
  const evidence = await applyCustomerCiEvidence({
    request: owned.request,
    log,
    repository: 'acme/shop',
    pull: 3,
    login: 'refit[bot]',
  });
  expect(evidence.outcome).toBe('regression');
  const comment = owned.calls.find((call) => call.method === 'POST')!.body as { body: string };
  expect(comment.body).toContain('regression');
  expect(comment.body).toContain('FAIL src/billing.test.ts');
  expect(owned.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { state: 'closed' } });
  // A customer pushed to the draft: Refit comments but never closes it.
  const edited = draft('b'.repeat(40));
  await applyCustomerCiEvidence({
    request: edited.request,
    log,
    repository: 'acme/shop',
    pull: 3,
    login: 'refit[bot]',
  });
  expect(edited.calls.some((call) => call.method === 'PATCH')).toBe(false);
});
