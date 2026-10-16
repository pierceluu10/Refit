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

it('summarizes affected repositories with their pull requests and stop reasons', () => {
  const table = summaryTable([
    {
      repo: 'a/one',
      fullAdapter: { confirmed: 2 },
      workflow: { status: 'validated', reason: 'publication was not requested' },
      publication: { url: 'https://github.com/refit-dev/one/pull/1' },
    },
    {
      repo: 'b/two',
      fullAdapter: { confirmed: 1 },
      workflow: { status: 'error', error: 'too | big' },
    },
    { repo: 'c/three', fullAdapter: { confirmed: 0 } },
  ]);
  expect(table).toContain('Repositories: 3. Affected: 2. Pull requests: 1.');
  expect(table).toContain(
    '| a/one | pull request | [link](https://github.com/refit-dev/one/pull/1) |  |',
  );
  expect(table).toContain('| b/two | error |  | too / big |');
  expect(table).not.toContain('c/three');
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
