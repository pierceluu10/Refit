import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { compareApiVersion } from './api-version.ts';
import { parseProviderAdapter, STRIPE, type ProviderAdapter } from './providers.ts';
import type { Repository } from './types.ts';

const ORIGINAL = '2022-08-01';
const CHANGED = '2022-11-15';
const before = { info: { version: ORIGINAL } };
const after = { info: { version: CHANGED } };
const prefix = "import Stripe from 'stripe';";

function evidence(
  source: string,
  provider: ProviderAdapter = STRIPE,
  extra: Repository['files'] = [],
) {
  const repository: Repository = {
    root: '/refit-version-fixture',
    files: [{ path: 'application.ts', content: source }, ...extra],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const declarations = analyzeRepository(repository, [], provider).apiVersionDeclarations;
  return compareApiVersion(ORIGINAL, before, after, {
    configured: Boolean(provider.apiVersion),
    declarations,
  });
}

it('verifies literal client and request versions without exporting other constructor or request values', () => {
  const result = evidence(`${prefix}
    const stripe = new Stripe('secret-constructor-value', { apiVersion: '${ORIGINAL}' });
    await stripe.paymentIntents.retrieve('private-payment-id');
    await stripe.paymentIntents.create({ amount: 100 }, { apiVersion: '${ORIGINAL}', idempotencyKey: 'secret-request-value' });`);
  expect(result.source.status).toBe('verified');
  expect(
    result.source.declarations.map(({ kind, status, value }) => ({ kind, status, value })),
  ).toEqual([
    { kind: 'constructor', status: 'literal', value: ORIGINAL },
    { kind: 'request', status: 'inherited', value: null },
    { kind: 'request', status: 'literal', value: ORIGINAL },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/secret-|private-payment/);
});

it.each([
  `const apiVersion = '${ORIGINAL}'; const options = { apiVersion }; const stripe = new Stripe('test', options);`,
  `const version = '${ORIGINAL}'; const settings = { apiVersion: version }; const alias = settings; const stripe = new Stripe('test', alias);`,
  `const settings = { apiVersion: '${ORIGINAL}' } as const; const stripe = new Stripe('test', ({ apiVersion: settings.apiVersion } satisfies object));`,
  `const stripe = new Stripe('test', { 'apiVersion': \`${ORIGINAL}\` });`,
])(
  'resolves immutable options and string aliases under supported TypeScript wrappers',
  (initialization) => {
    expect(
      evidence(`${prefix} ${initialization} await stripe.paymentIntents.retrieve('id');`).source
        .status,
    ).toBe('verified');
  },
);

it('follows directly imported version constants and shared clients independently of source order', () => {
  const result = evidence(
    "import { stripe as billing } from './client.js'; await billing.paymentIntents.retrieve('id');",
    STRIPE,
    [
      {
        path: 'client.ts',
        content: `${prefix} import { version } from './version.js'; export const stripe = new Stripe('test', { apiVersion: version });`,
      },
      { path: 'version.ts', content: `export const version = '${ORIGINAL}' as const;` },
    ],
  );
  expect(result.source.status).toBe('verified');
  expect(result.source.declarations.find(({ kind }) => kind === 'constructor')).toMatchObject({
    file: 'client.ts',
    value: ORIGINAL,
  });
});

it.each([
  `const stripe = new Stripe('test', { apiVersion: '${CHANGED}' }); await stripe.paymentIntents.retrieve('id');`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe.paymentIntents.retrieve('id', { apiVersion: '${CHANGED}' });`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe.paymentIntents.retrieve('id', { expand: [] }, { apiVersion: '${CHANGED}' });`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); const request = { apiVersion: '${CHANGED}' }; await stripe.paymentIntents.create({}, request);`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe.paymentIntents.retrieve('id', { apiVersion: '${ORIGINAL}' }, { apiVersion: '${CHANGED}' });`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); const other = new Stripe('test', { apiVersion: '${CHANGED}' });`,
])(
  'rejects statically declared conflicts even when the operator pin matches the before contract',
  (initialization) => {
    const result = evidence(`${prefix} ${initialization}`);
    expect(result.applicability).toBe('conflicts-with-code');
    expect(result.source.status).toBe('conflict');
    expect(result.reason).toContain(CHANGED);
  },
);

it.each([
  "const stripe = new Stripe('test');",
  "const stripe = new Stripe('test', { apiVersion: process.env.STRIPE_VERSION });",
  "const stripe = new Stripe('test', readOptions());",
  `let version = '${ORIGINAL}'; const stripe = new Stripe('test', { apiVersion: version });`,
  `const options = { apiVersion: '${ORIGINAL}' }; const alias = options; alias.apiVersion = '${CHANGED}'; const stripe = new Stripe('test', options);`,
  `const options = { apiVersion: '${ORIGINAL}' }; customize(options); const stripe = new Stripe('test', options);`,
  `const options = { apiVersion: '${ORIGINAL}' }; const stripe = new Stripe('test', { ...options });`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}', [optionName]: '${CHANGED}' });`,
  `const stripe = new Stripe('test', { get apiVersion() { return '${ORIGINAL}'; } });`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}', apiVersion: '${CHANGED}' });`,
  `const options = () => ({ apiVersion: '${ORIGINAL}' }); const stripe = new Stripe('test', options());`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); stripe._api.version = '${CHANGED}';`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); expose(stripe);`,
  `Stripe.prototype.request = customRequest; const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' });`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe.paymentIntents.retrieve('id', runtimeOptions);`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe.paymentIntents.retrieve(...args);`,
  `const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe?.paymentIntents.retrieve('id');`,
])(
  'records dynamic or unsafe declarations as unverified rather than guessing an API version',
  (initialization) => {
    const result = evidence(`${prefix} ${initialization}`);
    expect(result.source.status).toBe('unknown');
    expect(result.applicability).toBe('matches-before');
    expect(
      compareApiVersion(
        ORIGINAL,
        before,
        after,
        { configured: true, declarations: result.source.declarations },
        'source-verified',
      ).applicability,
    ).toBe('unknown');
  },
);

it.each([
  ['setApiVersion', `stripe.setApiVersion('${CHANGED}');`],
  ['a write to the private API field', `(stripe as any)._api.version = '${CHANGED}';`],
  ['a raw Stripe-Version header', `send({ headers: { 'Stripe-Version': '${CHANGED}' } });`],
  ['a Stripe-Version header set on Headers', `headers.set('stripe-version', '${CHANGED}');`],
])('leaves a traced literal pin unknown when the repository has %s', (_case, code) => {
  const source = `${prefix} const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe.customers.list();`;
  expect(evidence(source).source.status).toBe('verified');
  expect(evidence(source, STRIPE, [{ path: 'other.ts', content: code }]).source.status).toBe(
    'unknown',
  );
});

it('still reports a conflicting literal pin when the repository has an escape hatch', () => {
  const source = `${prefix} const stripe = new Stripe('test', { apiVersion: '${CHANGED}' }); await stripe.customers.list();`;
  const header = `send({ headers: { 'Stripe-Version': '${CHANGED}' } });`;
  const result = evidence(source, STRIPE, [{ path: 'edge.ts', content: header }]);
  expect(result.source.status).toBe('conflict');
  expect(result.applicability).toBe('conflicts-with-code');
  expect(result.source.declarations[0]).toMatchObject({
    status: 'unknown',
    value: CHANGED,
    reason: expect.stringContaining('Stripe-Version header'),
  });
});

// pipeline/fixtures/stripe-sdk/contract.mjs: a simulated server that reads the header the SDK sent.
it('keeps a traced literal pin verified next to code that reads an incoming Stripe-Version header', () => {
  const server = `apiVersions.push(request.headers['stripe-version'] ?? null); request.headers.get('Stripe-Version');`;
  expect(
    evidence(
      `${prefix} const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe.customers.list();`,
      STRIPE,
      [{ path: 'simulator/contract.mjs', content: server }],
    ).source.status,
  ).toBe('verified');
});

// Eziox-Development/eziox-web src/routeTree.gen.ts: a TanStack route id, not Stripe's private field.
it('keeps a traced literal pin verified next to an `_api` route path', () => {
  const route = `export const routes = { id: '/_api/sitemap', path: '/_api/rss' };`;
  expect(
    evidence(
      `${prefix} const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' }); await stripe.customers.list();`,
      STRIPE,
      [{ path: 'routeTree.gen.ts', content: route }],
    ).source.status,
  ).toBe('verified');
});

it('does not use a shadowing parameter or a similarly named imported SDK as version evidence', () => {
  expect(
    evidence(
      `${prefix} function read(Stripe) { const client = new Stripe('test', { apiVersion: '${ORIGINAL}' }); }`,
    ).source.status,
  ).toBe('unknown');
  expect(
    evidence(
      `import Stripe from 'unrelated-sdk'; const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' });`,
    ).source.status,
  ).toBe('unknown');
});

it('uses the same resolver for another provider with a nested option path and nested resources', () => {
  const provider = parseProviderAdapter({
    id: 'example',
    packageName: '@example/sdk',
    defaultImport: true,
    namedExport: null,
    operations: [{ resource: 'chat.completions', method: 'create', schema: 'Result' }],
    apiVersion: { constructorArgument: 0, property: 'headers.version', requestArguments: [1] },
  });
  const result = evidence(
    `import Client from '@example/sdk'; const client = new Client({ headers: { version: '${ORIGINAL}' } }); await client.chat.completions.create({}, { headers: { version: '${CHANGED}' } });`,
    provider,
  );
  expect(result.applicability).toBe('conflicts-with-code');
  expect(result.source.declarations).toHaveLength(2);
});

it.each([
  { constructorArgument: -1, property: 'apiVersion', requestArguments: [] },
  { constructorArgument: 17, property: 'apiVersion', requestArguments: [] },
  { constructorArgument: 0, property: 'headers[version]', requestArguments: [] },
  { constructorArgument: 0, property: 'apiVersion', requestArguments: [1, 1] },
  { constructorArgument: 0, property: 'apiVersion', requestArguments: ['1'] },
  { constructorArgument: 0, property: 'apiVersion', requestArguments: [], extra: true },
])('rejects invalid generic version mappings %j', (apiVersion) => {
  expect(() =>
    parseProviderAdapter({
      id: 'example',
      packageName: 'example',
      defaultImport: true,
      namedExport: null,
      operations: [{ resource: 'items', method: 'get', schema: 'Item' }],
      apiVersion,
    }),
  ).toThrow(/Provider apiVersion/);
});

it('verifies a client created inside a handler passed to a framework call and used with type annotations', () => {
  // The shape Convex actions use: the client is local to a handler function passed as an argument.
  const result = evidence(`${prefix}
    export const pay = action({
      handler: async (ctx: unknown) => {
        const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' });
        const intent: Stripe.Response<Stripe.PaymentIntent> = await stripe.paymentIntents.retrieve('pi');
        return (intent as Stripe.PaymentIntent).id;
      },
    });`);
  expect(result.source.status).toBe('verified');
  expect(result.source.declarations[0]).toMatchObject({ kind: 'constructor', status: 'literal' });
});

it('still refuses a handler-local client that escapes through a call or a returned function', () => {
  for (const escape of ['register(stripe);', 'return () => stripe;'])
    expect(
      evidence(`${prefix}
        export const pay = action({
          handler: async () => {
            const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' });
            ${escape}
          },
        });`).source.status,
    ).toBe('unknown');
});

it('trusts a client created inside a callback passed to an unknown function, but not one it leaks or mutates', () => {
  const statuses = (source: string) =>
    evidence(`${prefix}\nimport { action } from './server';\n${source}`)
      .source.declarations.filter((entry) => entry.kind === 'constructor')
      .map((entry) => entry.status);
  // Convex-style handler: the client is local to the callback.
  expect(
    statuses(`export const pay = action({ handler: async () => {
      const stripe = new Stripe('k', { apiVersion: '${ORIGINAL}' });
      return (await stripe.paymentIntents.retrieve('id')).id;
    } });`),
  ).toEqual(['literal']);
  // An outer client returned from the callback reaches the unknown caller.
  expect(
    statuses(`const stripe = new Stripe('k', { apiVersion: '${ORIGINAL}' });
    export const pay = action({ handler: () => stripe });`),
  ).toEqual(['unknown']);
  // An outer client mutated inside the callback.
  expect(
    statuses(`const stripe = new Stripe('k', { apiVersion: '${ORIGINAL}' });
    export const pay = action({ handler: () => { (stripe as any).config = {}; } });`),
  ).toEqual(['unknown']);
});

it.each([
  ['an object or undefined', '{ stripeAccount: account }', 'undefined', 'absent'],
  [
    'two objects without the option',
    '{ stripeAccount: account }',
    '{ idempotencyKey: key }',
    'absent',
  ],
  ['a branch that sets the option', `{ apiVersion: '${CHANGED}' }`, 'undefined', 'unknown'],
  ['a branch from a call', 'options()', 'undefined', 'unknown'],
  ['a shadowed undefined', '{ stripeAccount: account }', 'undefined', 'unknown'],
])('reads conditional request options choosing %s', (name, whenTrue, whenFalse, expected) => {
  const shadow =
    name === 'a shadowed undefined' ? 'const undefined = { apiVersion: account };\n' : '';
  const repository: Repository = {
    root: '/refit-version-fixture',
    files: [
      {
        path: 'application.ts',
        content: `${prefix}
const stripe = new Stripe('key');
declare const account: string | undefined;
declare const key: string;
declare function options(): object;
export async function charge() {
  ${shadow}return stripe.paymentIntents.create({ amount: 100 }, account ? ${whenTrue} : ${whenFalse});
}`,
      },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const request = analyzeRepository(repository, [], STRIPE).apiVersionDeclarations.find(
    (entry) => entry.kind === 'request',
  );
  expect(request?.status).toBe(expected === 'absent' ? 'inherited' : 'unknown');
});

it('treats an undefined argument before the request options as no override', () => {
  const repository: Repository = {
    root: '/refit-version-fixture',
    files: [
      {
        path: 'application.ts',
        content: `${prefix}
const stripe = new Stripe('key');
export const charge = (id: string, account: string) =>
  stripe.charges.retrieve(id, undefined, { stripeAccount: account });`,
      },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const requests = analyzeRepository(repository, [], STRIPE).apiVersionDeclarations.filter(
    (entry) => entry.kind === 'request',
  );
  expect(requests.map((entry) => entry.status)).toEqual(['inherited']);
});

it.each([
  [
    'instanceof on an error class',
    'export const known = (error: unknown) => error instanceof Stripe.errors.StripeError;',
  ],
  [
    'a conditional on an error class',
    "export function message(error: unknown) { const text = error instanceof Stripe.errors.StripeError ? error.message : 'failed'; return text; }",
  ],
  ['an identity comparison', 'export const same = (value: unknown) => value === Stripe;'],
])('keeps a client without a version option absent after %s', (_name, use) => {
  const repository: Repository = {
    root: '/refit-version-fixture',
    files: [
      {
        path: 'application.ts',
        content: `${prefix}\nexport const stripe = new Stripe('key');\n${use}`,
      },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const declarations = analyzeRepository(repository, [], STRIPE).apiVersionDeclarations;
  expect(declarations.find((entry) => entry.kind === 'constructor')).toMatchObject({
    absent: true,
  });
});

it('still treats a client whose constructor escapes into a call as uncertain', () => {
  const repository: Repository = {
    root: '/refit-version-fixture',
    files: [
      {
        path: 'application.ts',
        content: `${prefix}\nexport const stripe = new Stripe('key');\nexport const wrapped = wrap(Stripe.errors);`,
      },
    ],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const declarations = analyzeRepository(repository, [], STRIPE).apiVersionDeclarations;
  expect(declarations.find((entry) => entry.kind === 'constructor')?.absent).toBeUndefined();
});

const requestStatuses = (source: string) =>
  analyzeRepository(
    {
      root: '/refit-version-fixture',
      files: [{ path: 'application.ts', content: `${prefix}\n${source}` }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    [],
    STRIPE,
  )
    .apiVersionDeclarations.filter((entry) => entry.kind === 'request')
    .map((entry) => entry.status);

// stripe-node reads the last argument as request options when it has any option key, so a
// spread there is an override unless every object it can add is spelled out without one.
const priceOf = `function priceOf(id: string | null) {
  if (!id) return { price_data: { currency: 'usd', unit_amount: 100 } };
  return { price: id };
}`;
it.each([
  [
    'a local function returning object literals',
    `${priceOf}\nexport const update = (id: string) => stripe.subscriptionItems.update(id, { ...priceOf(id), proration_behavior: 'none' });`,
  ],
  [
    'a const holding its result',
    `${priceOf}\nexport const update = (id: string) => { const price = priceOf(id); const params = { ...price, proration_behavior: 'none' }; return stripe.subscriptionItems.update(id, params); };`,
  ],
  [
    'an arrow function',
    `const priceOf = (id: string) => ({ price: id });\nexport const update = (id: string) => stripe.subscriptionItems.update(id, { ...priceOf(id) });`,
  ],
])('treats a request spread of %s without option keys as inheriting', (_label, source) => {
  expect(requestStatuses(`const stripe = new Stripe('key');\n${source}`)).toEqual(['inherited']);
});

it.each([
  [
    'a returned option key',
    `const extra = () => ({ apiVersion: '${CHANGED}' });\nexport const update = (id: string) => stripe.subscriptionItems.update(id, { ...extra() });`,
  ],
  [
    'a returned parameter',
    `const extra = (value: object) => value;\nexport const update = (id: string, value: object) => stripe.subscriptionItems.update(id, { ...extra(value) });`,
  ],
  [
    'a bare return',
    `function extra(flag: boolean) { if (flag) return; return { price: 'p' }; }\nexport const update = (id: string) => stripe.subscriptionItems.update(id, { ...extra(true) });`,
  ],
  [
    'an async function',
    `async function extra() { return { price: 'p' }; }\nexport const update = async (id: string) => stripe.subscriptionItems.update(id, { ...(await extra()) });`,
  ],
  [
    'an imported function',
    `import { extra } from './extra';\nexport const update = (id: string) => stripe.subscriptionItems.update(id, { ...extra() });`,
  ],
  [
    'a reassigned function',
    `let extra = () => ({ price: 'p' }); extra = () => ({ apiVersion: '${CHANGED}' });\nexport const update = (id: string) => stripe.subscriptionItems.update(id, { ...extra() });`,
  ],
])('keeps a request spread of %s unverified', (_label, source) => {
  expect(requestStatuses(`const stripe = new Stripe('key');\n${source}`)).toEqual(['unknown']);
});

it('keeps a spread result unverified once anything but a spread uses it', () => {
  expect(
    requestStatuses(`const stripe = new Stripe('key');
${priceOf}
export const update = (id: string) => { const price = priceOf(id); Object.assign(price, { apiVersion: '${CHANGED}' }); return stripe.subscriptionItems.update(id, { ...price }); };`),
  ).toEqual(['unknown']);
});

it('trusts request params passed to SDK calls and spread, but not ones handed to other code', () => {
  const shared = `const stripe = new Stripe('key');
${priceOf}
export const save = async (id: string, item?: string) => {
  const params = { ...priceOf(id), proration_behavior: 'none' as const };`;
  expect(
    requestStatuses(`${shared}
  if (item) return stripe.subscriptionItems.update(item, params);
  return stripe.subscriptionItems.create({ subscription: id, ...params });
};`),
  ).toEqual(['inherited', 'inherited']);
  expect(
    requestStatuses(`${shared}
  customize(params);
  return stripe.subscriptionItems.update(id, params);
};`),
  ).toEqual(['unknown']);
});

it('verifies a pin whose client goes to an exported helper Refit traces, but not one whose argument may leave it', () => {
  const helper = `${prefix}
    const stripe = new Stripe('test', { apiVersion: '${ORIGINAL}' });
    export function listCharges(client: Stripe) {
      return client.charges.list();
    }`;
  expect(evidence(`${helper}\n    listCharges(stripe);`).source.status).toBe('verified');
  expect(
    evidence(`${helper.replace('client: Stripe', '...clients: Stripe[]').replace('client.charges', 'clients[0].charges')}
    listCharges(stripe);`).source.status,
  ).toBe('unknown');
  expect(
    evidence(
      `${helper.replace('return client', 'eval("");\n      return client')}\n    listCharges(stripe);`,
    ).source.status,
  ).toBe('unknown');
});
