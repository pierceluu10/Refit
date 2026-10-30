import { expect, it } from 'vitest';
import { applySourceEdits } from './patches.ts';
import { shopifySdkSourceChanges, shopifyVersionStringPins } from './shopify-sdk-source.ts';
import { pinnedShopifySchema, shopifySchema } from './shopify-schemas.ts';

const API = '@shopify/shopify-api';
const REMIX = '@shopify/shopify-app-remix';
const EXPRESS = '@shopify/shopify-app-express';

function changes(
  files: Record<string, string>,
  primary = REMIX,
  moves: { name: string; from: string | null; to: string }[] = [],
) {
  const result = shopifySdkSourceChanges(
    {
      root: '/repository',
      files: Object.entries(files).map(([path, content]) => ({ path, content })),
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    primary,
    'April26',
    moves,
  );
  return {
    ...result,
    reasons: result.stops.map((stop) => stop.reason),
    after: (path: string) =>
      applySourceEdits(
        files[path],
        result.edits.filter((edit) => edit.file === path),
      ),
  };
}

it('pins ApiVersion where LATEST_API_VERSION set apiVersion and drops removeRest: true', () => {
  const server = `import { LATEST_API_VERSION, shopifyApp } from '${REMIX}/server';
export const shopify = shopifyApp({
  apiVersion: LATEST_API_VERSION,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
});
`;
  const result = changes({ 'app/shopify.server.ts': server });
  expect(result.stops).toEqual([]);
  expect(result.edits.every((edit) => edit.changeId === 'shopify-sdk-upgrade')).toBe(true);
  expect(result.after('app/shopify.server.ts'))
    .toBe(`import { ApiVersion, shopifyApp } from '${REMIX}/server';
export const shopify = shopifyApp({
  apiVersion: ApiVersion.April26,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
});
`);
});

it('reuses an ApiVersion import, drops an import left unused and follows destructured require()', () => {
  const result = changes(
    {
      'app/shopify.server.ts': `import { ApiVersion, LATEST_API_VERSION, shopifyApp } from '${REMIX}/server';
export const shopify = shopifyApp({ apiVersion: LATEST_API_VERSION, future: { removeRest: true } });
`,
      'app/unused.ts': `import { LATEST_API_VERSION } from '${API}';
export const ready = true;
`,
      // johnshields/northstar
      'src/api/clients/shopifyClient.js': `const { shopifyApi, LATEST_API_VERSION, LogSeverity } = require('${API}');
module.exports = shopifyApi({ apiVersion: LATEST_API_VERSION, logger: { level: LogSeverity.Info } });
`,
    },
    API,
  );
  expect(result.stops).toEqual([]);
  expect(result.after('app/shopify.server.ts'))
    .toBe(`import { ApiVersion, shopifyApp } from '${REMIX}/server';
export const shopify = shopifyApp({ apiVersion: ApiVersion.April26, future: {} });
`);
  expect(result.after('app/unused.ts')).toBe('export const ready = true;\n');
  expect(result.after('src/api/clients/shopifyClient.js')).toBe(
    `const { shopifyApi, ApiVersion, LogSeverity } = require('${API}');
module.exports = shopifyApi({ apiVersion: ApiVersion.April26, logger: { level: LogSeverity.Info } });
`,
  );
});

it('finds the shopify-api settings of an express app under api', () => {
  // Manuel1996-coder/shoppulseai, without its billing flag.
  const server = `import { LATEST_API_VERSION } from '${API}';
import { shopifyApp } from '${EXPRESS}';
export const shopify = shopifyApp({
  api: { apiVersion: LATEST_API_VERSION, future: { customerAddressDefaultFix: true } },
  auth: { path: '/api/auth', callbackPath: '/api/auth/callback' },
});
`;
  const result = changes({ 'web/shopify.js': server }, EXPRESS);
  expect(result.stops).toEqual([]);
  expect(result.after('web/shopify.js')).toBe(
    server
      .replace('{ LATEST_API_VERSION }', '{ ApiVersion }')
      .replace('apiVersion: LATEST_API_VERSION', 'apiVersion: ApiVersion.April26'),
  );
});

it('stops where LATEST_API_VERSION cannot become a dated member', () => {
  const result = changes({
    'app/log.ts': `import { LATEST_API_VERSION } from '${API}';
console.log(LATEST_API_VERSION);
`,
    'app/alias.ts': `import { LATEST_API_VERSION as latest, shopifyApi } from '${API}';
export const shopify = shopifyApi({ apiVersion: latest });
`,
    'app/default.js': `const { LATEST_API_VERSION = '2025-01' } = require('${API}');
`,
    'app/namespace.ts': `import * as sdk from '${API}';
export const shopify = sdk.shopifyApi({ apiVersion: sdk.LATEST_API_VERSION });
`,
  });
  expect(result.edits).toEqual([]);
  expect(result.stops).toEqual([
    {
      file: 'app/log.ts',
      line: 2,
      column: 13,
      reason:
        'LATEST_API_VERSION, removed in the upgraded SDK, is used where Refit cannot pin a dated ApiVersion (outside an apiVersion setting, or without its import).',
    },
    {
      file: 'app/alias.ts',
      line: 1,
      column: 10,
      reason:
        'LATEST_API_VERSION is imported under another name, as a type, with a default value or beside a default import; replace it with a dated ApiVersion member by hand.',
    },
    expect.objectContaining({
      file: 'app/default.js',
      line: 1,
      column: 9,
      reason: expect.stringContaining('with a default value'),
    }),
    expect.objectContaining({
      file: 'app/namespace.ts',
      line: 2,
      reason: expect.stringContaining('cannot pin a dated ApiVersion'),
    }),
  ]);
});

it('checks future flags against the upgraded package and stops on billing and changed APIs', () => {
  const result = changes({
    'app/flags.ts': `import { shopifyApp } from '${REMIX}/server';
const extra = { v3_lineItemBilling: true };
export const shopify = shopifyApp({
  apiVersion: ApiVersion.April26,
  future: { removeRest: false, v3_webhookAdminContext: true, ...extra, ['dynamic']: true },
});
`,
    'app/opaque.ts': `import { shopifyApp } from '${REMIX}/server';
const future = { unstable_newEmbeddedAuthStrategy: true, removeRest: true };
export const shopify = shopifyApp({ apiVersion: ApiVersion.April26, future });
export const other = shopifyApp({ apiVersion: ApiVersion.April26, future: future });
`,
    'app/billing.ts': `import { shopifyApi } from '${API}';
export const shopify = shopifyApi({
  apiVersion: ApiVersion.April26,
  billing: { plan: { amount: 5 } },
  future: { lineItemBilling: true },
});
export async function check(request) {
  const { billing } = await authenticate.admin(request);
  return shopify.billing.check({ session: request.session });
}
`,
    'app/changed.ts': `import { shopifyApi, RELEASE_CANDIDATE_API_VERSION, setCrypto } from '${API}';
setCrypto(globalThis.crypto);
export const jwt = (session) => shopify.session.getJwt(session);
export const again = (session) => shopify.session.getJwt(session);
export const rc = RELEASE_CANDIDATE_API_VERSION;
`,
  });
  // The adopted lineItemBilling flag goes (a5be0d0); the flat plan and shopify.billing still stop.
  expect(result.after('app/billing.ts')).toContain(
    '  billing: { plan: { amount: 5 } },\n  future: {},\n});',
  );
  expect(result.edits.map((edit) => edit.file)).toEqual(['app/billing.ts']);
  const byFile = (file: string) =>
    result.stops.filter((stop) => stop.file === file).map((stop) => stop.reason);
  expect(byFile('app/flags.ts')).toEqual([
    'future.removeRest is false; @shopify/shopify-app-remix 4.0.0 (d7bd799) removed REST and the flag, so REST use needs review.',
    `future.v3_webhookAdminContext is not a flag of the upgraded ${REMIX}.`,
    'A future flag is a spread, shorthand or computed name Refit cannot check.',
  ]);
  // `{ future }` and `{ future: future }` both stop, once per file.
  expect(byFile('app/opaque.ts')).toEqual([
    'removeRest appears outside the shopifyApp future flags Refit edits; @shopify/shopify-app-remix 4.0.0 (d7bd799) removed it with REST.',
    'The future flags are not an object literal Refit can check.',
  ]);
  expect(
    changes({
      'app/shorthand.ts': `import { shopifyApp } from '${REMIX}/server';
const future = { v3_webhookAdminContext: true };
export const shopify = shopifyApp({ apiVersion: ApiVersion.April26, future });
`,
    }).stops,
  ).toEqual([
    {
      file: 'app/shorthand.ts',
      line: 3,
      column: 69,
      reason: 'The future flags are not an object literal Refit can check.',
    },
  ]);
  const billing =
    'Billing changed in @shopify/shopify-api 12.0.0: the lineItemBilling future flags and the billing config they changed were removed (a5be0d0), and billing.check returns an object (docs/migrating-to-v12.md).';
  expect(byFile('app/billing.ts')).toEqual([billing]);
  expect(byFile('app/changed.ts')).toEqual([
    'RELEASE_CANDIDATE_API_VERSION was removed in @shopify/shopify-api 12.0.0 (48d3631); choose a dated ApiVersion member.',
    '@shopify/shopify-api 12.0.0 (dc41d09) uses globalThis.crypto and says to remove setCrypto calls.',
    'getJwt became asynchronous in @shopify/shopify-api 12.0.0 (dc41d09); its callers must await it.',
  ]);
});

it('stops where a config does not visibly set the apiVersion 12.0.0 requires', () => {
  const reason =
    'apiVersion is required from @shopify/shopify-api 12.0.0 (48d3631), and this shopifyApp or shopifyApi config sets none Refit can see; choose a dated ApiVersion member.';
  const result = changes({
    'app/missing.ts': `import { shopifyApi } from '${API}';
export const shopify = shopifyApi({ apiKey: 'key' });
`,
    'app/variable.ts': `import { shopifyApp } from '${REMIX}/server';
const config = { apiVersion: '2025-07' };
export const shopify = shopifyApp(config);
`,
    'web/express.js': `import { shopifyApp } from '${EXPRESS}';
export const shopify = shopifyApp({ api: { restResources }, auth: { path: '/api/auth' } });
`,
  });
  expect(result.edits).toEqual([]);
  expect(result.stops).toEqual([
    { file: 'app/missing.ts', line: 2, column: 24, reason },
    { file: 'app/variable.ts', line: 3, column: 24, reason },
    { file: 'web/express.js', line: 2, column: 24, reason },
  ]);
});

it('leaves files without a Shopify import and names that only match Object.prototype alone', () => {
  const result = changes({
    'app/plain.ts': 'export const token = (session) => session.getJwt();\n',
    // jgasimli04/marketoracle and peterwalker-svg/pos-ui stopped on `toLocaleString` before.
    'app/format.ts': `import { shopifyApp } from '${REMIX}/server';
export const label = (value) => value.toLocaleString() + value.toString() + value.constructor.name;
export const shopify = shopifyApp({
  apiVersion: ApiVersion.April26,
  future: { expiringOfflineAccessTokens: true },
});
`,
  });
  expect(result.stops).toEqual([]);
  expect(result.edits).toEqual([]);
});

it('applies or stops on the breaking changes of the majors an upgrade crosses', () => {
  const ROUTER = '@shopify/shopify-app-react-router';
  const server = `import { shopifyApp, ApiVersion } from '${ROUTER}/server';
export const shopify = shopifyApp({
  apiVersion: ApiVersion.October26,
  isEmbeddedApp: true,
  customShopDomains: ['shop.example.com'],
});
export const register = (webhook) => webhook.subTopic;
`;
  const app = `import { AppProvider } from '${ROUTER}/react';
export const App = () => <AppProvider embedded apiKey="k">x</AppProvider>;
export const Other = () => <AppProvider embedded={false} apiKey="k">x</AppProvider>;
`;
  const files = { 'app/shopify.server.ts': server, 'app/root.tsx': app };
  const moves = [
    { name: API, from: '12.3.0', to: '14.0.0' },
    { name: ROUTER, from: '1.1.1', to: '2.0.0' },
  ];
  const result = changes(files, ROUTER, moves);
  expect(result.reasons).toEqual([
    expect.stringContaining('removed customShopDomains for domainTransformations'),
    expect.stringContaining('removed subTopic (84397d9)'),
    expect.stringContaining('serves embedded apps only (0dbb90c)'),
  ]);
  expect(result.stops.map((stop) => `${stop.file}:${stop.line}`)).toEqual([
    'app/shopify.server.ts:5',
    'app/shopify.server.ts:7',
    'app/root.tsx:3',
  ]);
  expect(result.after('app/shopify.server.ts')).not.toContain('isEmbeddedApp');
  expect(result.after('app/root.tsx')).toContain('<AppProvider apiKey="k">x</AppProvider>;');
  // Without crossing those majors, none of it applies.
  expect(changes(files, ROUTER).stops).toEqual([]);
});

it('stops on refresh tokens across prisma session storage 8 only where the app turns them on', () => {
  const PRISMA = '@shopify/shopify-app-session-storage-prisma';
  const moves = [{ name: PRISMA, from: '6.0.0', to: '10.0.0' }];
  const server = (flag: string) => `import { shopifyApp, ApiVersion } from '${REMIX}/server';
export const shopify = shopifyApp({ apiVersion: ApiVersion.April26, future: { ${flag} } });
`;
  expect(
    changes(
      { 'app/shopify.server.ts': server('unstable_newEmbeddedAuthStrategy: true') },
      REMIX,
      moves,
    ).reasons,
  ).toEqual([]);
  expect(
    changes({ 'app/shopify.server.ts': server('expiringOfflineAccessTokens: true') }, REMIX, moves)
      .reasons,
  ).toEqual([expect.stringContaining('stores refresh tokens (700377f)')]);
});

it('stops where LATEST_API_VERSION sets a Storefront version', () => {
  const result = changes(
    {
      'app/clients.ts': `import { LATEST_API_VERSION } from '${API}';
import { createStorefrontApiClient } from '@shopify/storefront-api-client';
export const storefront = createStorefrontApiClient({ storeDomain: 'x', apiVersion: LATEST_API_VERSION });
`,
      '.graphqlrc.ts': `import { LATEST_API_VERSION } from '${API}';
import { ApiType, shopifyApiProject } from '@shopify/api-codegen-preset';
export default { projects: { storefront: shopifyApiProject({ apiType: ApiType.Storefront, apiVersion: LATEST_API_VERSION }) } };
`,
    },
    API,
  );
  expect(result.edits).toEqual([]);
  expect(result.reasons).toEqual([
    expect.stringContaining('sets a Storefront API version here'),
    expect.stringContaining('sets a Storefront API version here'),
  ]);
});

it("keeps the templates' SHOP_CUSTOM_DOMAIN line, which 13.0.0 ignores, and stops on other customShopDomains", () => {
  const moves = [{ name: API, from: '11.12.0', to: '14.0.1' }];
  const result = changes(
    {
      'app/shopify.server.ts': `import { shopifyApp } from '${REMIX}/server';
export const shopify = shopifyApp({
  apiVersion: ApiVersion.April26,
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});
`,
      'app/static.server.ts': `import { shopifyApp } from '${REMIX}/server';
export const shopify = shopifyApp({ apiVersion: ApiVersion.April26, customShopDomains: ['a\\.example\\.com'] });
`,
    },
    REMIX,
    moves,
  );
  expect(result.edits).toEqual([]);
  expect(result.notes).toEqual([expect.stringContaining('fa091e35')]);
  expect(result.stops).toEqual([
    expect.objectContaining({
      file: 'app/static.server.ts',
      reason: expect.stringContaining('78c8968'),
    }),
  ]);
});

it('replaces <AppProvider embedded={false}> with what it rendered, as 0dbb90c says', () => {
  const ROUTER = '@shopify/shopify-app-react-router';
  const moves = [{ name: ROUTER, from: '1.1.1', to: '2.0.1' }];
  const login = `import { AppProvider } from '${ROUTER}/react';
import { useState } from 'react';

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <s-page>Log in</s-page>
    </AppProvider>
  );
}
`;
  const result = changes(
    {
      'app/routes/auth.login/route.tsx': login,
      'app/routes/other.tsx': `import { AppProvider, other } from '${ROUTER}/react';
export const a = <AppProvider embedded={false} i18n={x}><p /></AppProvider>;
export const b = <AppProvider embedded={false}><p /></AppProvider>;
`,
      'app/routes/app.tsx': `import { AppProvider as ShopifyAppProvider } from '${ROUTER}/react';
export const app = <ShopifyAppProvider embedded apiKey={key}><p /></ShopifyAppProvider>;
`,
    },
    ROUTER,
    moves,
  );
  expect(result.after('app/routes/auth.login/route.tsx')).toBe(`import { useState } from 'react';

export default function Auth() {
  return (
    <>
      <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
      <s-page>Log in</s-page>
    </>
  );
}
`);
  // An aliased import is the same component.
  expect(result.after('app/routes/app.tsx')).toContain('<ShopifyAppProvider apiKey={key}>');
  // Another prop stops, and the import stays while an element still uses it.
  expect(result.after('app/routes/other.tsx')).toContain(`import { AppProvider, other }`);
  expect(result.stops).toEqual([
    expect.objectContaining({
      file: 'app/routes/other.tsx',
      reason: expect.stringContaining('0dbb90c'),
    }),
  ]);
});

it("lets line-item and one-time billing plans and the adapters' billing context through", () => {
  const result = changes({
    'app/shopify.server.ts': `import { shopifyApp, BillingInterval } from '${REMIX}/server';
export const shopify = shopifyApp({
  apiVersion: ApiVersion.April26,
  billing: {
    Pro: { lineItems: [{ amount: 5, currencyCode: 'USD', interval: BillingInterval.Every30Days }] },
    Once: { amount: 9, currencyCode: 'USD', interval: BillingInterval.OneTime },
  },
});
`,
    'app/routes/app.tsx': `import { authenticate } from '${REMIX}/server';
import '${REMIX}/server';
export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  return billing.require({ plans: ['Pro'] });
};
`,
    'app/flat.server.ts': `import { shopifyApp, BillingInterval } from '${REMIX}/server';
export const flat = shopifyApp({
  apiVersion: ApiVersion.April26,
  billing: { Pro: { amount: 5, currencyCode: 'USD', interval: BillingInterval.Every30Days } },
});
`,
  });
  expect(result.stops.map((stop) => stop.file)).toEqual(['app/flat.server.ts']);
});

it('pins the dated string on the locked SDK only for GraphQL-only apps, webhook topics included', () => {
  const schema = shopifySchema(pinnedShopifySchema('admin', '2026-10').content);
  const pins = (files: Record<string, string>, release = '11.12.0', rest = 0) => {
    const repository = {
      root: '/repository',
      files: Object.entries(files).map(([path, content]) => ({ path, content })),
      dependencies: [],
      lockfiles: [],
      warnings: [],
    };
    const result = shopifyVersionStringPins(
      repository,
      {
        rest: Array.from({ length: rest }, () => ({
          file: 'a',
          line: 1,
          column: 1,
          expression: '',
        })),
        versions: [],
      },
      release,
      '2026-10',
      schema,
    );
    return 'reason' in result
      ? result.reason
      : Object.fromEntries(
          Object.entries(files).map(([path, content]) => [
            path,
            applySourceEdits(
              content,
              result.edits.filter((edit) => edit.file === path),
            ),
          ]),
        );
  };
  const server = `import { LATEST_API_VERSION, shopifyApp, DeliveryMethod } from '${REMIX}/server';
const shopify = shopifyApp({
  apiVersion: LATEST_API_VERSION,
  webhooks: { APP_UNINSTALLED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: '/webhooks' } },
  hooks: { afterAuth: async ({ session }) => shopify.registerWebhooks({ session }) },
});
`;
  expect(
    pins({
      'app/shopify.server.ts': server,
      'app/codegen.js': `const { ApiVersion } = require('${API}');\nmodule.exports = { apiVersion: ApiVersion.October24 };\n`,
    }),
  ).toEqual({
    'app/shopify.server.ts': server
      .replace('LATEST_API_VERSION, shopifyApp', 'ApiVersion, shopifyApp')
      .replace('apiVersion: LATEST_API_VERSION', "apiVersion: '2026-10' as ApiVersion"),
    'app/codegen.js': `const { ApiVersion } = require('${API}');\nmodule.exports = { apiVersion: '2026-10' };\n`,
  });
  expect(
    pins({ 'app/shopify.server.ts': server.replace('APP_UNINSTALLED', 'NOT_A_TOPIC') }),
  ).toContain(
    'registers the webhook topic NOT_A_TOPIC, which is not a 2026-10 WebhookSubscriptionTopic',
  );
  expect(pins({ 'app/shopify.server.ts': server }, '14.0.1')).toContain('majors 8 to 13 only');
  expect(pins({ 'app/shopify.server.ts': server }, '11.12.0', 1)).toContain('REST Admin requests');
  expect(
    pins({
      'app/shopify.server.ts': server,
      'app/routes/app.tsx': `import { authenticate } from '../shopify.server';\nexport const loader = async ({ request }) => (await authenticate.admin(request)).billing.require({});\n`,
    }),
  ).toContain('uses billing');
});

it('drops the template restResources crossing remix 4 when no code reads .rest', () => {
  const moves = [{ name: REMIX, from: '3.8.2', to: '5.0.1' }];
  const server = `import { shopifyApp } from '${REMIX}/server';
import { restResources } from '${API}/rest/admin/2024-07';
export const shopify = shopifyApp({
  apiVersion: ApiVersion.April26,
  restResources,
  future: {},
});
`;
  const result = changes({ 'app/shopify.server.ts': server }, REMIX, moves);
  expect(result.after('app/shopify.server.ts')).toBe(`import { shopifyApp } from '${REMIX}/server';
export const shopify = shopifyApp({
  apiVersion: ApiVersion.April26,
  future: {},
});
`);
  // A `.rest` read anywhere keeps it, and REST stops elsewhere.
  const rest = changes(
    {
      'app/shopify.server.ts': server,
      'app/routes/app.tsx': `export const count = (admin) => admin.rest.resources.Product.count({});\n`,
    },
    REMIX,
    moves,
  );
  expect(rest.edits).toEqual([]);
});

it('pins LATEST_API_VERSION in an Admin API URL to the member apiVersion gets', () => {
  // Shopify/subscriptions-reference-app's test mocks build the URL the SDK requests this way.
  const constants = `import {LATEST_API_VERSION} from '${API}';
export const GRAPHQL_URL = \`https://\${TEST_SHOP}/admin/api/\${LATEST_API_VERSION}/graphql.json\`;
`;
  const storefront = `import {LATEST_API_VERSION} from '${API}';
export const URL = \`https://\${TEST_SHOP}/api/\${LATEST_API_VERSION}/graphql.json\`;
`;
  const result = changes({ 'test/constants.ts': constants, 'test/storefront.ts': storefront });
  expect(result.after('test/constants.ts')).toBe(`import {ApiVersion} from '${API}';
export const GRAPHQL_URL = \`https://\${TEST_SHOP}/admin/api/\${ApiVersion.April26}/graphql.json\`;
`);
  // Any other URL is not the Admin API version; it keeps stopping.
  expect(result.stops).toEqual([
    expect.objectContaining({
      file: 'test/storefront.ts',
      reason: expect.stringContaining('cannot pin a dated ApiVersion'),
    }),
  ]);
});

it('drops unstable_newEmbeddedAuthStrategy: true, which no React Router release reads', () => {
  const ROUTER = '@shopify/shopify-app-react-router';
  const server = `import { ApiVersion, shopifyApp } from '${ROUTER}/server';
export const shopify = shopifyApp({
  apiVersion: ApiVersion.October25,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
});
`;
  const result = changes({ 'app/shopify.server.ts': server }, ROUTER);
  expect(result.stops).toEqual([]);
  expect(result.after('app/shopify.server.ts'))
    .toBe(`import { ApiVersion, shopifyApp } from '${ROUTER}/server';
export const shopify = shopifyApp({
  apiVersion: ApiVersion.October25,
  future: {
  },
});
`);
  // Any other value, and the remix flag remix 5 still accepts, stay as they are.
  expect(
    changes({ 'app/shopify.server.ts': server.replace(': true,', ': false,') }, ROUTER).reasons,
  ).toEqual([`future.unstable_newEmbeddedAuthStrategy is not a flag of the upgraded ${ROUTER}.`]);
  expect(changes({ 'app/shopify.server.ts': server.replaceAll(ROUTER, REMIX) }).edits).toEqual([]);
});
