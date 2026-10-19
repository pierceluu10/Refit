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
