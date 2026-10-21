import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPayPalRequests, scanPayPalCalls, type PayPalCall } from './paypal-calls.ts';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>, manifest: object = { name: 'app' }) {
  const root = await mkdtemp(join(tmpdir(), 'refit-paypal-'));
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

async function calls(files: Record<string, string>, manifest?: object) {
  return (await scanPayPalCalls(await repository(files, manifest))).calls;
}

function at(found: PayPalCall[], file: string, line: number) {
  const call = found.find((item) => item.file === file && item.line === line);
  expect(call, `${file}:${line}`).toBeDefined();
  return call!;
}

const OLD = {
  'src/old.js': `const paypal = require('@paypal/checkout-server-sdk');
const { orders } = paypal;
const { CapturesRefundRequest } = paypal.payments;
const environment = new paypal.core.SandboxEnvironment('id', 'secret');
const client = new paypal.core.PayPalHttpClient(environment);
async function create() {
  const request = new paypal.orders.OrdersCreateRequest();
  request.requestBody({ intent: 'CAPTURE' });
  return client.execute(request);
}
async function capture(id) {
  let request;
  request = new orders.OrdersCaptureRequest(id);
  return client.execute(request);
}
const validate = (id) => client.execute(new paypal.orders.OrdersValidateRequest(id));
const refund = (id) => send(new CapturesRefundRequest(id));
const unsent = new paypal.orders.OrdersGetRequest('id');
const invented = new paypal.orders.OrdersDeleteRequest('id');
`,
};

describe('@paypal/checkout-server-sdk request classes', () => {
  it('reports each request class with the request it makes and how it is sent', async () => {
    const found = await calls(OLD, { dependencies: { '@paypal/checkout-server-sdk': '^1.0.3' } });
    expect(
      found.map((call) => [call.line, call.request, call.client, call.method, call.path]),
    ).toEqual([
      [7, 'orders.OrdersCreateRequest', 'client.execute', 'POST', '/v2/checkout/orders'],
      [
        13,
        'orders.OrdersCaptureRequest',
        'client.execute',
        'POST',
        '/v2/checkout/orders/{order_id}/capture',
      ],
      [
        16,
        'orders.OrdersValidateRequest',
        'client.execute',
        'POST',
        '/v2/checkout/orders/{order_id}/validate-payment-method',
      ],
      [
        17,
        'payments.CapturesRefundRequest',
        'send',
        'POST',
        '/v2/payments/captures/{capture_id}/refund',
      ],
      [18, 'orders.OrdersGetRequest', null, 'GET', '/v2/checkout/orders/{order_id}'],
      [19, 'orders.OrdersDeleteRequest', null, null, null],
    ]);
  });

  it('matches each request to the published operation and the new SDK method', async () => {
    const found = await calls(OLD);
    expect(at(found, 'src/old.js', 7)).toMatchObject({
      kind: 'checkout-sdk',
      use: 'live',
      hosts: [],
      operation: { document: 'checkout_orders_v2.json', operationId: 'orders.create' },
      counterpart: ['OrdersController.createOrder'],
      notes: [],
      unknown: [],
    });
    expect(at(found, 'src/old.js', 13).counterpart).toEqual(['OrdersController.captureOrder']);
  });

  it('notes a request the published documents and the new SDK do not have', async () => {
    expect(at(await calls(OLD), 'src/old.js', 16)).toMatchObject({
      operation: null,
      counterpart: [],
      notes: [
        expect.stringMatching(
          /^POST \/v2\/checkout\/orders\/\{order_id\}\/validate-payment-method is not in PayPal's published checkout_orders_v2\.json \(paypal-rest-api-specifications [0-9a-f]{7}\)$/,
        ),
      ],
    });
  });

  it('says what it could not trace', async () => {
    const found = await calls(OLD);
    expect(at(found, 'src/old.js', 17).unknown).toEqual([
      'the request is passed to `send`; whether it is executed is not traced',
    ]);
    expect(at(found, 'src/old.js', 18).unknown).toEqual([
      'no `execute` call was traced for this request',
    ]);
    expect(at(found, 'src/old.js', 19).unknown).toEqual([
      '`orders.OrdersDeleteRequest` is not a request class of @paypal/checkout-server-sdk 1.0.3',
      'no `execute` call was traced for this request',
    ]);
  });

  it('reads ES module imports of the package and its areas', async () => {
    const found = await calls({
      'src/orders.ts': `import paypal from '@paypal/checkout-server-sdk';
import { orders as checkout } from '@paypal/checkout-server-sdk';
export const get = (client: any, id: string) => client.execute(new paypal.orders.OrdersGetRequest(id));
export const patch = (client: any, id: string) => client.execute(new checkout.OrdersPatchRequest(id));
`,
    });
    expect(found.map((call) => [call.line, call.method, call.path])).toEqual([
      [3, 'GET', '/v2/checkout/orders/{order_id}'],
      [4, 'PATCH', '/v2/checkout/orders/{order_id}'],
    ]);
  });

  it('reports the deprecated package declaration', async () => {
    const scan = await scanPayPalCalls(
      await repository(OLD, { dependencies: { '@paypal/checkout-server-sdk': '^1.0.3' } }),
    );
    expect(scan.packages).toEqual([
      {
        name: '@paypal/checkout-server-sdk',
        file: 'package.json',
        declared: '^1.0.3',
        locked: null,
        deprecated: expect.stringContaining('@paypal/paypal-server-sdk'),
      },
    ]);
  });
});

const NEW = {
  'src/new.ts': `import { Client, OrdersController, PaymentsController } from '@paypal/paypal-server-sdk';
import * as sdk from '@paypal/paypal-server-sdk';
const client = new Client({});
const ordersController = new OrdersController(client);
export const create = () => ordersController.createOrder({ body: {} as never });
export const legacy = () => ordersController.ordersCreate({ body: {} as never });
class Payments {
  private payments = new PaymentsController(client);
  private vault: any;
  constructor() {
    this.vault = new sdk.VaultController(client);
  }
  refund(captureId: string) {
    return this.payments.refundCapturedPayment({ captureId });
  }
  tokens() {
    return this.vault.listCustomerPaymentTokens({});
  }
}
export const get = (id: string) => new OrdersController(client).getOrder({ id });
export const invented = () => ordersController.deleteOrder({});
`,
};

describe('@paypal/paypal-server-sdk controller calls', () => {
  it('reports calls on controllers in variables, class properties and inline', async () => {
    const found = await calls(NEW, { dependencies: { '@paypal/paypal-server-sdk': '2.5.0' } });
    expect(found.map((call) => [call.line, call.request, call.method, call.path])).toEqual([
      [5, 'OrdersController.createOrder', 'POST', '/v2/checkout/orders'],
      [6, 'OrdersController.ordersCreate', 'POST', '/v2/checkout/orders'],
      [
        14,
        'PaymentsController.refundCapturedPayment',
        'POST',
        '/v2/payments/captures/{captureId}/refund',
      ],
      [17, 'VaultController.listCustomerPaymentTokens', 'GET', '/v3/vault/payment-tokens'],
      [20, 'OrdersController.getOrder', 'GET', '/v2/checkout/orders/{id}'],
      [21, 'OrdersController.deleteOrder', null, null],
    ]);
    expect(at(found, 'src/new.ts', 5)).toMatchObject({
      kind: 'server-sdk',
      client: 'OrdersController.createOrder',
      operation: { document: 'checkout_orders_v2.json', operationId: 'orders.create' },
      notes: [],
      unknown: [],
    });
    expect(at(found, 'src/new.ts', 21).unknown).toEqual([
      '`OrdersController.deleteOrder` is not a method in any recorded @paypal/paypal-server-sdk release (0.5.1 to 2.5.0)',
    ]);
  });

  it('notes a method the locked release does not define', async () => {
    const found = await calls(NEW, { dependencies: { '@paypal/paypal-server-sdk': '2.5.0' } });
    expect(at(found, 'src/new.ts', 6).notes).toEqual([
      '`OrdersController.ordersCreate` is not in @paypal/paypal-server-sdk 2.5.0; it is in 0.5.1 to 0.6.1',
    ]);
  });

  it('names the newer method for a 0.x method the repository still uses', async () => {
    const lock = {
      name: 'app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: { '@paypal/paypal-server-sdk': '^0.6.0' } },
        'node_modules/@paypal/paypal-server-sdk': { version: '0.6.1' },
      },
    };
    const found = await calls(
      { ...NEW, 'package-lock.json': JSON.stringify(lock) },
      { name: 'app', dependencies: { '@paypal/paypal-server-sdk': '^0.6.0' } },
    );
    expect(at(found, 'src/new.ts', 6).notes).toEqual([
      '`ordersCreate` is not in @paypal/paypal-server-sdk 2.5.0, which makes this request with `OrdersController.createOrder`',
    ]);
    expect(at(found, 'src/new.ts', 5).notes).toEqual([
      '`OrdersController.createOrder` is not in @paypal/paypal-server-sdk 0.6.1; it is in 0.7.0 to 2.5.0',
    ]);
  });

  it('does not check method availability without an exact version', async () => {
    const found = await calls(NEW, { dependencies: { '@paypal/paypal-server-sdk': '^2.0.0' } });
    expect(at(found, 'src/new.ts', 5).unknown).toEqual([
      'no locked or exact @paypal/paypal-server-sdk version, so whether the release defines `createOrder` is not checked',
    ]);
  });

  it('reads CommonJS requires', async () => {
    const found = await calls({
      'src/subscriptions.js': `const { SubscriptionsController } = require('@paypal/paypal-server-sdk');
module.exports = (client) => new SubscriptionsController(client).cancelSubscription({ id: 'I-1' });
`,
    });
    expect(found.map((call) => [call.line, call.method, call.path, call.operation])).toEqual([
      [
        2,
        'POST',
        '/v1/billing/subscriptions/{id}/cancel',
        { document: 'billing_subscriptions_v1.json', operationId: 'subscriptions.cancel' },
      ],
    ]);
  });
});

const RAW = {
  'src/config.ts': `export const PAYPAL_API =
  process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
`,
  'src/raw.ts': `import axios from 'axios';
import { PAYPAL_API } from './config';
const BASE = 'https://api-m.sandbox.paypal.com';
export const token = () =>
  fetch(\`\${BASE}/v1/oauth2/token\`, { method: 'POST', body: 'grant_type=client_credentials' });
export const capture = (orderId: string) =>
  fetch(\`\${PAYPAL_API}/v2/checkout/orders/\${orderId}/capture\`, { method: 'POST' });
export const read = (orderId: string) => fetch(PAYPAL_API + '/v2/checkout/orders/' + orderId);
export const plan = (body: object) => axios.post(\`\${PAYPAL_API}/v1/billing/plans\`, body);
export const any = (path: string) => paypalFetch(\`\${BASE}\${path}\`);
export const list = () => axios.get('https://api.paypal.com/v1/billing/subscriptions');
export async function pages() {
  let url = \`\${BASE}/v1/billing/plans\`;
  url = next(url);
  return fetch(url);
}
`,
  'test/raw.test.ts': `fetch('https://api-m.sandbox.paypal.com/v2/checkout/orders', { method: 'POST' });
`,
};

describe('raw PayPal REST calls', () => {
  it('reports each call with its method, hosts and path', async () => {
    const found = await calls(RAW);
    expect(
      found.map((call) => [call.file, call.line, call.client, call.method, call.hosts, call.path]),
    ).toEqual([
      ['src/raw.ts', 5, 'fetch', 'POST', ['api-m.sandbox.paypal.com'], '/v1/oauth2/token'],
      [
        'src/raw.ts',
        7,
        'fetch',
        'POST',
        ['api-m.paypal.com', 'api-m.sandbox.paypal.com'],
        '/v2/checkout/orders/{orderId}/capture',
      ],
      [
        'src/raw.ts',
        8,
        'fetch',
        'GET',
        ['api-m.paypal.com', 'api-m.sandbox.paypal.com'],
        '/v2/checkout/orders/{orderId}',
      ],
      [
        'src/raw.ts',
        9,
        'axios.post',
        'POST',
        ['api-m.paypal.com', 'api-m.sandbox.paypal.com'],
        '/v1/billing/plans',
      ],
      ['src/raw.ts', 10, 'paypalFetch', null, ['api-m.sandbox.paypal.com'], null],
      ['src/raw.ts', 11, 'axios.get', 'GET', ['api.paypal.com'], '/v1/billing/subscriptions'],
      ['src/raw.ts', 14, 'next', null, ['api-m.sandbox.paypal.com'], null],
      ['src/raw.ts', 15, 'fetch', 'GET', ['api-m.sandbox.paypal.com'], null],
      ['test/raw.test.ts', 1, 'fetch', 'POST', ['api-m.sandbox.paypal.com'], '/v2/checkout/orders'],
    ]);
    expect(at(found, 'test/raw.test.ts', 1).use).toBe('test');
  });

  it('matches raw calls to published operations and new SDK methods', async () => {
    const found = await calls(RAW);
    expect(at(found, 'src/raw.ts', 7)).toMatchObject({
      kind: 'url',
      request: null,
      operation: { document: 'checkout_orders_v2.json', operationId: 'orders.capture' },
      counterpart: ['OrdersController.captureOrder'],
      notes: [],
      unknown: [],
    });
    expect(at(found, 'src/raw.ts', 5)).toMatchObject({
      operation: null,
      counterpart: ['OAuthAuthorizationController.requestToken'],
      notes: [expect.stringMatching(/^no published PayPal OpenAPI document covers \/v1\/oauth2 /)],
    });
  });

  it('notes a host the published documents do not list', async () => {
    expect(at(await calls(RAW), 'src/raw.ts', 11).notes).toEqual([
      "api.paypal.com is not a server in PayPal's published OpenAPI documents, which list api-m.paypal.com and api-m.sandbox.paypal.com",
      expect.stringMatching(
        /^GET \/v1\/billing\/subscriptions is not in PayPal's published billing_subscriptions_v1\.json /,
      ),
    ]);
  });

  it('names every unlisted host in one note', async () => {
    const found = await calls({
      'src/disputes.ts': `const BASE = process.env.LIVE ? 'https://api.paypal.com' : 'https://api.sandbox.paypal.com';
export const dispute = (id: string) => fetch(\`\${BASE}/v1/customer/disputes/\${id}\`);
`,
    });
    expect(at(found, 'src/disputes.ts', 2)).toMatchObject({
      hosts: ['api.paypal.com', 'api.sandbox.paypal.com'],
      operation: { document: 'customer_disputes_v1.json', operationId: 'disputes.get' },
      notes: [
        "api.paypal.com and api.sandbox.paypal.com are not servers in PayPal's published OpenAPI documents, which list api-m.paypal.com and api-m.sandbox.paypal.com",
      ],
    });
  });

  it('says what it could not read', async () => {
    const found = await calls(RAW);
    expect(at(found, 'src/raw.ts', 10).unknown).toEqual([
      'path is built at runtime from `path`',
      'HTTP method of helper `paypalFetch` is not known',
    ]);
    expect(at(found, 'src/raw.ts', 15).unknown).toEqual([
      '`url` is reassigned, so the request may use another URL',
    ]);
  });
});

describe('the recorded PayPal requests', () => {
  it('maps every newest-release controller method to a published operation except the known gaps', async () => {
    const data = await loadPayPalRequests();
    const newest = data.server.releases.at(-1)!;
    const unmatched: string[] = [];
    for (const [controller, methods] of data.server.controllers)
      for (const [name, endpoint] of methods)
        if (endpoint.releases.includes(newest)) {
          const key = endpoint.path.replace(/\{[^}]+\}/g, '{}');
          const matched = data.specification.operations.some(
            (operation) => operation.method === endpoint.method && operation.key === key,
          );
          if (!matched) unmatched.push(`${controller}.${name} ${endpoint.method} ${endpoint.path}`);
        }
    expect(unmatched).toEqual([
      'OAuthAuthorizationController.requestToken POST /v1/oauth2/token',
      'SubscriptionsController.listSubscriptions GET /v1/billing/subscriptions',
    ]);
  });

  it('records where each fact comes from', async () => {
    const data = await loadPayPalRequests();
    expect(data.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.checkout.version).toBe('1.0.3');
    expect(data.checkout.deprecated).toMatch(/^Package no longer supported/);
    expect(data.specification).toMatchObject({
      repository: 'https://github.com/paypal/paypal-rest-api-specifications',
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(data.specification.hosts).toEqual(
      new Set(['api-m.sandbox.paypal.com', 'api-m.paypal.com']),
    );
  });
});

describe('refit paypal', () => {
  it('prints a review-only report and JSON', async () => {
    const root = await repository({ ...OLD, ...RAW });
    const { stdout } = await execute(process.execPath, [CLI, 'paypal', '--repository', root]);
    expect(stdout).toContain('Review only: nothing was changed or sent to PayPal.');
    expect(stdout).toContain('src/old.js:7  POST /v2/checkout/orders');
    expect(stdout).toContain('New SDK    OrdersController.createOrder');
    expect(stdout).toContain('In tests and examples (1): test/raw.test.ts:1');
    const { stdout: json } = await execute(process.execPath, [
      CLI,
      'paypal',
      '--repository',
      root,
      '--json',
    ]);
    const report = JSON.parse(json);
    expect(report.calls).toHaveLength(15);
    expect(report.specification.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a repository without PayPal requests', async () => {
    const root = await repository({ 'src/index.ts': 'export const answer = 42;\n' });
    const { stdout } = await execute(process.execPath, [CLI, 'paypal', '--repository', root]);
    expect(stdout).toContain('No PayPal REST request was found.');
  });
});
