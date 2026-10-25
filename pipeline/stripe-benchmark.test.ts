import { expect, it, vi } from 'vitest';
import { forkAtCommit, stripeOperations, summaryTable } from './stripe-benchmark.ts';

const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const returns = (schema: unknown) => ({
  operationId: 'Op',
  responses: { '200': { content: { 'application/json': { schema } } } },
});

it('maps stripe-node methods to the objects they return in the application contract', () => {
  const sdk = {
    components: {
      schemas: {
        customer: {
          'x-stripeOperations': [
            {
              method_name: 'retrieve',
              method_on: 'service',
              operation: 'get',
              path: '/v1/customers/{customer}',
            },
            {
              method_name: 'delete',
              method_on: 'service',
              operation: 'delete',
              path: '/v1/customers/{customer}',
            },
            { method_name: 'list', method_on: 'service', operation: 'get', path: '/v1/customers' },
          ],
        },
        cash_balance: {
          'x-stripeOperations': [
            {
              method_name: 'retrieve',
              method_on: 'service',
              operation: 'get',
              path: '/v1/customers/{customer}/cash_balance',
            },
          ],
        },
        payment_intent: {
          'x-stripeOperations': [
            {
              method_name: 'cancel',
              method_on: 'service',
              operation: 'post',
              path: '/v1/payment_intents/{intent}/cancel',
            },
          ],
        },
        'checkout.session': {
          'x-stripeOperations': [
            {
              method_name: 'create',
              method_on: 'service',
              operation: 'post',
              path: '/v1/checkout/sessions',
            },
          ],
        },
      },
    },
  };
  const before = {
    paths: {
      '/v1/customers/{customer}': {
        get: returns({ anyOf: [ref('customer'), ref('deleted_customer')] }),
        delete: returns(ref('customer')),
      },
      '/v1/customers': { get: returns({ type: 'object' }) },
      '/v1/customers/{customer}/cash_balance': { get: returns(ref('cash_balance')) },
      '/v1/payment_intents/{intent}/cancel': { post: returns(ref('payment_intent')) },
      '/v1/checkout/sessions': { post: returns(ref('checkout.session')) },
    },
  };
  expect(stripeOperations(sdk, before)).toEqual([
    { resource: 'customers', method: 'retrieve', schema: 'customer', operationId: 'Op' },
    { resource: 'customers', method: 'del', schema: 'customer', operationId: 'Op' },
    { resource: 'paymentIntents', method: 'cancel', schema: 'payment_intent', operationId: 'Op' },
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'Op',
    },
  ]);
});

it('maps list and search methods to the objects their pages hold', () => {
  const operation = (method_name: string, path: string) => ({
    method_name,
    method_on: 'service',
    operation: 'get',
    path,
  });
  const sdk = {
    components: {
      schemas: {
        subscription: {
          'x-stripeOperations': [
            operation('list', '/v1/subscriptions'),
            operation('search', '/v1/subscriptions/search'),
          ],
        },
        // A list of another object, and a page that is not a Stripe list, map to nothing.
        invoice: { 'x-stripeOperations': [operation('list', '/v1/invoices')] },
        customer: { 'x-stripeOperations': [operation('list', '/v1/customers')] },
      },
    },
  };
  // The shapes of spec3.sdk.json's GET /v1/subscriptions and /v1/subscriptions/search.
  const page = (object: string, schema: string) => ({
    type: 'object',
    properties: {
      object: { type: 'string', enum: [object] },
      data: { type: 'array', items: ref(schema) },
      has_more: { type: 'boolean' },
      url: { type: 'string' },
    },
  });
  const before = {
    paths: {
      '/v1/subscriptions': { get: returns(page('list', 'subscription')) },
      '/v1/subscriptions/search': { get: returns(page('search_result', 'subscription')) },
      '/v1/invoices': { get: returns(page('list', 'invoiceitem')) },
      '/v1/customers': { get: returns(page('customer', 'customer')) },
    },
  };
  expect(stripeOperations(sdk, before)).toEqual([
    {
      resource: 'subscriptions',
      method: 'list',
      schema: 'subscription',
      operationId: 'Op',
      list: true,
    },
    {
      resource: 'subscriptions',
      method: 'search',
      schema: 'subscription',
      operationId: 'Op',
      list: true,
    },
  ]);
});

it('forks into the organization and points refit-base at the validated commit', async () => {
  const commit = 'a'.repeat(40);
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push(`${init.method} ${url.replace('https://api.github.com', '')}`);
      if (init.method === 'GET' && url.endsWith('/repos/refit-dev/app'))
        return Response.json({ message: 'Not Found' }, { status: 404 });
      if (url.endsWith('/forks'))
        return Response.json({ full_name: 'refit-dev/app' }, { status: 202 });
      if (url.includes('/commits/'))
        return new Response('{}', { status: calls.length > 3 ? 200 : 404 });
      return Response.json({}, { status: 201 });
    }),
  );
  try {
    expect(await forkAtCommit('refit-dev', 'someone/app', commit, 'token', 0)).toBe(
      'refit-dev/app',
    );
  } finally {
    vi.unstubAllGlobals();
  }
  expect(calls).toEqual([
    'GET /repos/refit-dev/app',
    'POST /repos/someone/app/forks',
    `GET /repos/refit-dev/app/commits/${commit}`,
    `GET /repos/refit-dev/app/commits/${commit}`,
    'POST /repos/refit-dev/app/git/refs',
  ]);
  await expect(forkAtCommit('refit-dev', 'someone/app', commit, undefined)).rejects.toThrow(
    /GITHUB_TOKEN/,
  );
});

it('summarizes affected repositories production mode first, with pull requests and stop reasons', () => {
  const commit = 'a'.repeat(40);
  const scan = { status: 'affected', confirmed: 1, review: 0, findings: [] };
  const table = summaryTable([
    {
      repo: 'a/one',
      commit,
      fullAdapter: { ...scan, confirmed: 2 },
      productionMode: { ...scan, stop: null },
      workflow: { status: 'validated', reason: 'publication was not requested', fullDiff: true },
      production: { status: 'validated', reason: 'publication was not requested' },
      publication: { url: 'https://github.com/refit-dev/one/pull/1' },
    },
    {
      repo: 'b/two',
      commit,
      fullAdapter: scan,
      workflow: { status: 'error', error: 'too | big' },
    },
    {
      repo: 'c/three',
      commit,
      fullAdapter: { ...scan, confirmed: 0 },
    },
    // Production mode stops on an operation impact before validation; benchmark mode validates.
    {
      repo: 'd/four',
      commit,
      fullAdapter: scan,
      productionMode: {
        ...scan,
        stop: 'Refit traced 1 SDK call site to unresolved breaking OpenAPI changes.',
      },
      workflow: { status: 'validated', fullDiff: false },
      production: {
        status: 'needs-review',
        stage: 'scan',
        reason: 'Refit traced 1 SDK call site to unresolved breaking OpenAPI changes.',
      },
    },
    // Only production mode is affected: an impact on a called operation, no removed-field read.
    {
      repo: 'e/five',
      commit,
      fullAdapter: { ...scan, confirmed: 0, status: 'needs-review' },
      productionMode: { ...scan, confirmed: 0, stop: 'Refit traced 2 SDK call sites.' },
    },
  ]);
  expect(table).toContain('Repositories: 5. Affected in either mode: 4.');
  expect(table).toContain('Pull requests: 1.');
  expect(table).toContain('| Outcome | Production | Benchmark |');
  expect(table).toContain('| needs-review | 2 | 0 |');
  expect(table).toContain('| validated | 0 | 1 |');
  expect(table).toContain('| pull request | 1 | 1 |');
  expect(table).toContain(
    '| a/one | pull request | pull request | [link](https://github.com/refit-dev/one/pull/1) |  |',
  );
  expect(table).toContain('| b/two | not affected | error |  | too / big |');
  expect(table).toContain(
    '| d/four | needs-review | validated |  | Refit traced 1 SDK call site to unresolved breaking OpenAPI changes. |',
  );
  expect(table).toContain(
    '| e/five | needs-review | not affected |  | Refit traced 2 SDK call sites. |',
  );
  expect(table).not.toContain('c/three');
  expect(table).toContain(
    'These results predate /*/outcomeClass; rows were classified from their fields.',
  );
});

it('says production mode was not measured for rows from before it was recorded', () => {
  const commit = 'a'.repeat(40);
  const table = summaryTable([
    {
      repo: 'a/one',
      commit,
      outcomeClass: 'repository',
      fullAdapter: { status: 'affected', confirmed: 1, review: 0, findings: [] },
      productionMode: { status: 'affected', confirmed: 1, review: 0, findings: [] },
      workflow: { status: 'validated' },
    },
  ]);
  expect(table).toContain('| a/one | not measured | validated |  |  |');
});

it('lists infrastructure errors apart from the counts and refuses rows that break the schema', () => {
  const commit = 'a'.repeat(40);
  const affected = {
    fullAdapter: { status: 'affected', confirmed: 1, review: 0, findings: [] },
    outcomeClass: 'repository',
  };
  const table = summaryTable([
    { repo: 'a/one', commit, ...affected, workflow: { status: 'validated' } },
    {
      repo: 'b/two',
      commit,
      outcomeClass: 'infrastructure',
      infrastructure: { kind: 'clone', message: 'the checkout is at 0000, not the pinned one' },
    },
    // Classified from its fields: the registry timed out during dependency preparation.
    {
      repo: 'c/three',
      commit,
      fullAdapter: { status: 'affected', confirmed: 1, review: 0, findings: [] },
      workflow: {
        status: 'error',
        error: 'npm dependency preparation failed (1). npm error code ETIMEDOUT\nnpm error network',
      },
    },
  ]);
  expect(table).toContain('Repositories: 1. Affected in either mode: 1.');
  expect(table).toContain('Pull requests: 0.');
  expect(table).toContain('| validated | 0 | 1 |');
  expect(table).not.toContain('| error |');
  expect(table).toContain('Infrastructure errors, not counted above: 2. Rerun them with --resume.');
  expect(table).toContain('| b/two | clone | the checkout is at 0000, not the pinned one |');
  expect(table).toContain(
    '| c/three | registry | npm dependency preparation failed (1). npm error code ETIMEDOUT |',
  );
  expect(() => summaryTable([{ repo: 'a/one', commit: 'HEAD', ...affected }])).toThrow(
    '/0/commit must match',
  );
});

it('reuses the organization fork instead of creating name-1', async () => {
  const commit = 'b'.repeat(40);
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${url.replace('https://api.github.com', '')}`);
      if (url.endsWith('/repos/refit-dev/app'))
        return Response.json({ full_name: 'refit-dev/app', parent: { full_name: 'someone/app' } });
      if (url.includes('/commits/')) return new Response('{}', { status: 200 });
      if (url.endsWith('/git/refs')) return Response.json({}, { status: 422 });
      return Response.json({ object: { sha: commit } });
    }),
  );
  try {
    expect(await forkAtCommit('refit-dev', 'someone/app', commit, 'token', 0)).toBe(
      'refit-dev/app',
    );
  } finally {
    vi.unstubAllGlobals();
  }
  expect(calls.some((call) => call.endsWith('/forks'))).toBe(false);
});
