import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { detectProviders } from './agent-catalog.ts';
import { detectApiVersionPins, fileApiVersionPins } from './commerce-api-versions.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry, type DeadlineRegistry } from './deadline-registry.ts';

const NOW = new Date('2026-10-22T12:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-commerce-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(
      join(root, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }
  return root;
}

// Pins in one file as `provider version form line use` lines.
function pins(path: string, content: string) {
  return fileApiVersionPins(path, content).map(
    (pin) => `${pin.provider} ${pin.version} ${pin.form} ${pin.line} ${pin.use}`,
  );
}

it('reads version headers in object literals, header calls and assignments', () => {
  // The plaid-node README's client setup.
  expect(
    pins(
      'src/plaid.ts',
      [
        "import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';",
        'const configuration = new Configuration({',
        '  basePath: PlaidEnvironments.sandbox,',
        '  baseOptions: {',
        '    headers: {',
        "      'PLAID-CLIENT-ID': CLIENT_ID,",
        "      'Plaid-Version': '2020-09-14',",
        '    },',
        '  },',
        '});',
      ].join('\n'),
    ),
  ).toEqual(['plaid 2020-09-14 header 7 live']);
  expect(
    pins(
      'lib/http.js',
      [
        "const SQUARE_VERSION = '2024-01-18';",
        "fetch(url, { headers: { 'Square-Version': SQUARE_VERSION } });",
        "headers.set('Braintree-Version', '2019-01-01');",
        "axios.defaults.headers.common['SHIPPO-API-VERSION'] = '2018-02-08';",
        "request.headers.append('Lob-Version', '2020-02-11');",
        "const paddle = { 'Paddle-Version': 1 };",
        "const commerce = { headers: { 'X-CC-Version': '2018-03-22' } };",
      ].join('\n'),
    ),
  ).toEqual([
    'square 2024-01-18 header 2 live',
    'braintree 2019-01-01 header 3 live',
    'shippo 2018-02-08 header 4 live',
    'lob 2020-02-11 header 5 live',
    'paddle 1 header 6 live',
    'coinbase-commerce 2018-03-22 header 7 live',
  ]);
});

it('reads SDK version options only where the SDK takes them', () => {
  // The Shippo README's client and the legacy Square client.
  expect(
    pins(
      'src/shipping.ts',
      [
        "import { Shippo } from 'shippo';",
        'const shippo = new Shippo({',
        "  shippoApiVersion: '2018-02-08',",
        "  apiKeyHeader: '<YOUR_API_KEY_HERE>',",
        '});',
      ].join('\n'),
    ),
  ).toEqual(['shippo 2018-02-08 option 3 live']);
  expect(
    pins(
      'src/square.ts',
      [
        "import { SquareClient } from 'square';",
        "import { Client } from 'square/legacy';",
        "const legacy = new Client({ squareVersion: '2024-12-18', bearerAuthCredentials });",
        "await client.payments.create(request, { version: '2024-05-04' });",
      ].join('\n'),
    ),
  ).toEqual(['square 2024-12-18 option 3 live', 'square 2024-05-04 option 4 live']);
  // lob-node's `apiVersion` counts on its own client, not on another SDK's in the same file.
  expect(
    pins(
      'src/mail.js',
      [
        "const Stripe = require('stripe');",
        "const Lob = require('lob')(process.env.LOB_KEY, { apiVersion: '2020-02-11' });",
        "const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2024-06-20' });",
      ].join('\n'),
    ),
  ).toEqual(['lob 2020-02-11 option 2 live']);
  expect(
    pins(
      'src/mail.ts',
      [
        "import Lob from 'lob';",
        "const lob = new Lob(process.env.LOB_KEY!, { apiVersion: '2020-02-11' });",
      ].join('\n'),
    ),
  ).toEqual(['lob 2020-02-11 option 2 live']);
  // Without the SDK, the same keys are not its pins.
  expect(
    pins('src/other.ts', "const config = { version: '2024-05-04', squareVersion: '2024-01-18' };"),
  ).toEqual([]);
});

it('reads versioned API paths, naming the Adyen API each version belongs to', () => {
  expect(
    pins(
      'src/payments.ts',
      [
        "const checkout = 'https://checkout-test.adyen.com/v71/payments';",
        'const live = `https://${prefix}-checkout-live.adyenpayments.com/checkout/v70/sessions`;',
        "const classic = 'https://pal-test.adyen.com/pal/servlet/Payment/v68/authorise';",
        "const management = 'https://management-live.adyen.com/v3/merchants';",
        "const platform = 'https://balanceplatform-api-test.adyen.com/bcl/v2/accountHolders';",
        "const easypost = 'https://api.easypost.com/v2/shipments';",
        'const lemon = `https://api.lemonsqueezy.com/v1/checkouts`;',
        "const lob = 'https://api.lob.com/v1/postcards';",
      ].join('\n'),
    ),
  ).toEqual([
    'adyen checkout/v71 path 1 live',
    'adyen checkout/v70 path 2 live',
    'adyen Payment/v68 path 3 live',
    'adyen management/v3 path 4 live',
    'adyen bcl/v2 path 5 live',
    'easypost v2 path 6 live',
    'lemon-squeezy v1 path 7 live',
    'lob v1 path 8 live',
  ]);
});

it('skips computed values, comments and non-version strings, and marks tests', () => {
  expect(
    pins(
      'src/plaid.ts',
      [
        "// 'Plaid-Version': '2019-05-29' was the old pin.",
        "const headers = { 'Plaid-Version': process.env.PLAID_VERSION };",
        "const docs = 'See https://docs.adyen.com/api-explorer/Checkout/71/overview';",
        "const other = { 'Plaid-Version': 'latest' };",
      ].join('\n'),
    ),
  ).toEqual([]);
  expect(pins('test/plaid.test.ts', "const headers = { 'Plaid-Version': '2020-09-14' };")).toEqual([
    'plaid 2020-09-14 header 1 test',
  ]);
});

it('lists pins with their provider in detection and matches them against API-version deadlines', async () => {
  const root = await repository({
    'package.json': {
      name: 'app',
      dependencies: { plaid: '^29.0.0', '@adyen/api-library': '^20.0.0' },
    },
    'src/plaid.ts': "const headers = { 'Plaid-Version': '2019-05-29' };",
    'src/adyen.ts': "const url = 'https://checkout-test.adyen.com/v68/payments';",
  });
  expect((await detectApiVersionPins(root)).map((pin) => `${pin.provider} ${pin.version}`)).toEqual(
    ['adyen checkout/v68', 'plaid 2019-05-29'],
  );
  const detections = Object.fromEntries(
    (await detectProviders(root)).map((item) => [
      item.agent.id,
      (item.apiVersions ?? []).map((pin) => `${pin.version} ${pin.file}:${pin.line}`),
    ]),
  );
  expect(detections).toEqual({
    plaid: ['2019-05-29 src/plaid.ts:1'],
    adyen: ['checkout/v68 src/adyen.ts:1'],
  });
  // A hand-built registry: no API-version end of life for these providers was readable on
  // 2026-10-22, so the shipped registry has none.
  const registry: DeadlineRegistry = {
    formatVersion: 1,
    deadlines: [
      {
        id: 'plaid-2019-05-29',
        provider: 'plaid',
        kind: 'api-version',
        versions: ['2019-05-29'],
        date: '2027-01-01',
        summary: 'Illustrative only: Plaid API version 2019-05-29 retires.',
        replacement: '2020-09-14',
        source: 'https://example.com/plaid',
        checkedAt: '2026-10-22',
      },
      {
        id: 'adyen-checkout-v68',
        provider: 'adyen',
        kind: 'api-version',
        versions: ['checkout/v68'],
        date: '2027-01-01',
        summary: 'Illustrative only: Adyen Checkout API v68 retires.',
        replacement: 'checkout/v71',
        source: 'https://example.com/adyen',
        checkedAt: '2026-10-22',
      },
    ],
  };
  const scan = await scanDeadlines(root, registry, NOW);
  expect(
    scan.exposures.map(
      (exposure) =>
        `${exposure.deadline.id} ${exposure.evidence.map((item) => `${item.file}:${item.line}`)}`,
    ),
  ).toEqual(['adyen-checkout-v68 src/adyen.ts:1', 'plaid-2019-05-29 src/plaid.ts:1']);
});

// The shipped registry's live exposures in a fixture, as `id file:line` lines.
async function shipped(files: Record<string, unknown>) {
  const registry = await loadDeadlineRegistry(undefined, NOW);
  const scan = await scanDeadlines(await repository(files), registry, NOW);
  return scan.exposures
    .flatMap((exposure) =>
      exposure.evidence.map((item) => `${exposure.deadline.id} ${item.file}:${item.line}`),
    )
    .sort();
}

it('reports each commerce SDK major past its support, and not the current one', async () => {
  const sources = {
    'src/pay.ts': [
      "import AdyenCheckout from '@adyen/adyen-web';",
      "import braintree from 'braintree';",
      "import client from 'braintree-web';",
      "import EasyPost from '@easypost/api';",
      "const coinbase = require('coinbase-commerce-node');",
    ].join('\n'),
  };
  expect(
    await shipped({
      'package.json': {
        name: 'old',
        dependencies: {
          '@adyen/adyen-web': '^3.23.0',
          braintree: '^2.24.0',
          'braintree-web': '2.32.1',
          '@easypost/api': '^7.4.0',
          'coinbase-commerce-node': '^1.0.4',
        },
      },
      ...sources,
    }),
  ).toEqual([
    'adyen-2025-10-01-adyen-web-v3 package.json:4',
    'braintree-2023-02-01-braintree-web-v2 package.json:6',
    'braintree-2023-09-01-braintree-node-v2 package.json:5',
    'coinbase-commerce-2021-06-10-commerce-node package.json:8',
    'easypost-2025-04-28-easypost-node-v7 package.json:7',
  ]);
  expect(
    await shipped({
      'package.json': { name: 'v4', dependencies: { '@adyen/adyen-web': '4.9.0' } },
      ...sources,
    }),
  ).toEqual(['adyen-2026-08-01-adyen-web-v4 package.json:4']);
  expect(
    await shipped({
      'package.json': {
        name: 'current',
        dependencies: {
          '@adyen/adyen-web': '^6.0.0',
          braintree: '^3.41.0',
          'braintree-web': '^3.147.0',
          '@easypost/api': '^8.9.0',
        },
      },
      ...sources,
    }),
  ).toEqual([]);
});

it('detects every list-A provider by package and by API host', async () => {
  const packages = {
    plaid: '^29.0.0',
    square: '^43.0.0',
    braintree: '^3.41.0',
    '@adyen/api-library': '^20.0.0',
    '@paddle/paddle-node-sdk': '^3.0.0',
    '@lemonsqueezy/lemonsqueezy.js': '^4.0.0',
    shippo: '^2.0.0',
    '@easypost/api': '^8.0.0',
    lob: '^6.0.0',
    'coinbase-commerce-node': '^1.0.4',
  };
  const hosts = [
    'https://production.plaid.com',
    'https://connect.squareup.com',
    'https://api.braintreegateway.com',
    'https://checkout-test.adyen.com/v71',
    'https://api.paddle.com',
    'https://api.lemonsqueezy.com/v1',
    'https://api.goshippo.com',
    'https://api.easypost.com/v2',
    'https://api.lob.com/v1',
    'https://api.commerce.coinbase.com',
  ];
  const byPackage = await detectProviders(
    await repository({ 'package.json': { name: 'app', dependencies: packages } }),
  );
  const byHost = await detectProviders(
    await repository({
      'src/hosts.ts': hosts.map((host, index) => `const url${index} = '${host}';`).join('\n'),
    }),
  );
  const ids = [
    'plaid',
    'square',
    'braintree',
    'adyen',
    'paddle',
    'lemon-squeezy',
    'shippo',
    'easypost',
    'lob',
    'coinbase-commerce',
  ];
  expect(byPackage.map((item) => item.agent.id)).toEqual(ids);
  expect(byHost.map((item) => item.agent.id)).toEqual(ids);
  expect(byHost.map((item) => item.hostnames.map((entry) => entry.line))).toEqual(
    ids.map((_, index) => [index + 1]),
  );
});
