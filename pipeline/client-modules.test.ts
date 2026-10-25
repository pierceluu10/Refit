import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { compareApiVersion } from './api-version.ts';
import { applySourceEdits } from './patches.ts';
import { parseProviderAdapter, STRIPE, type ProviderAdapter } from './providers.ts';
import type { Repository } from './types.ts';

const ORIGINAL = '2022-08-01';
const CHANGED = '2022-11-15';
const change = {
  id: 'charges',
  schema: 'payment_intent',
  property: 'charges',
  pointer: '/charges',
};
const options = `{ apiVersion: '${ORIGINAL}' }`;
const read = `async function history() { const intent = await billing.paymentIntents.retrieve('pi'); return intent.charges.data; }`;
const cjsClient = `const Stripe = require('stripe'); const client = Stripe('test', ${options});`;
const esmClient = `import Stripe from 'stripe'; const client = new Stripe('test', ${options});`;
function analyze(files: Record<string, string>, provider: ProviderAdapter = STRIPE) {
  const repository: Repository = {
    root: '/module-fixture',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const result = analyzeRepository(repository, [change], provider);
  return {
    ...result,
    repository,
    migrated: repository.files.map((file) => ({
      ...file,
      content: applySourceEdits(
        file.content,
        result.edits.filter((edit) => edit.file === file.path),
      ),
    })),
  };
}

it.each([
  `const Stripe = require('stripe'); const billing = new Stripe('test', ${options});`,
  `const Stripe = require('stripe'); const billing = Stripe('test', ${options});`,
  `const billing = require('stripe')('test', ${options});`,
  `const billing = new (require('stripe'))('test', ${options});`,
  `const { Stripe: Constructor } = require('stripe'); const billing = new Constructor('test', ${options});`,
  `const Constructor = require('stripe').default; const Alias = Constructor; const billing = Alias('test', ${options});`,
  `import Stripe = require('stripe'); const billing = new Stripe('test', ${options});`,
])('traces the documented static constructor shape and version: %s', (initialization) => {
  const result = analyze({ 'billing.cts': initialization + read });
  expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(result.edits).toHaveLength(1);
  expect(result.apiVersionDeclarations).toMatchObject([
    { kind: 'constructor', status: 'literal', value: ORIGINAL },
    { kind: 'request', status: 'inherited' },
  ]);
});

it.each([
  ['default binding', `${esmClient} export default client;`, "import billing from './client.js';"],
  [
    'inline default',
    `import Stripe from 'stripe'; export default new Stripe('test', ${options});`,
    "import billing from './client.js';",
  ],
  [
    'default factory',
    `import Stripe from 'stripe'; export default Stripe('test', ${options});`,
    "import billing from './client.js';",
  ],
  [
    'default alias',
    `${esmClient} const alias = client; export default alias;`,
    "import billing from './client.js';",
  ],
])('traces %s ESM exports in reverse source order', (_name, client, consumer) => {
  const result = analyze({ 'billing.ts': consumer + read, 'client.ts': client });
  expect(result.findings).toMatchObject([{ file: 'billing.ts', confidence: 'confirmed' }]);
  expect(result.edits).toHaveLength(1);
  expect(result.apiVersionDeclarations.find((entry) => entry.kind === 'constructor')).toMatchObject(
    { status: 'literal', value: ORIGINAL },
  );
});

it.each([
  ['direct', 'module.exports = client;', "const billing = require('./client.cjs');"],
  [
    'object shorthand',
    'module.exports = { client };',
    "const {client: billing} = require('./client.cjs');",
  ],
  [
    'object property',
    'module.exports = { billing: client };',
    "const billing = require('./client.cjs').billing;",
  ],
  ['exports property', 'exports.billing = client;', "const {billing} = require('./client.cjs');"],
  [
    'module property',
    'module.exports.billing = client;',
    "const billing = require('./client.cjs').billing;",
  ],
  ['import equals', 'module.exports = client;', "import billing = require('./client.cjs');"],
])(
  'traces %s CommonJS exports and verifies their declared version',
  (_name, exported, consumer) => {
    const result = analyze({ 'billing.cts': consumer + read, 'client.cts': cjsClient + exported });
    expect(result.findings).toMatchObject([{ file: 'billing.cts', confidence: 'confirmed' }]);
    expect(result.edits).toHaveLength(1);
    expect(
      result.apiVersionDeclarations.find((entry) => entry.kind === 'constructor'),
    ).toMatchObject({ status: 'literal', value: ORIGINAL });
  },
);

it.each([
  ['direct', 'module.exports = client;', "const billing = require('./client.cjs');"],
  ['named', 'module.exports = {client};', "const {client: billing} = require('./client.cjs');"],
  ['default ESM', 'export default client;', "import billing from './client.js';"],
])('carries mutations through %s client imports in another module', (_name, exported, consumer) => {
  const esm = exported.startsWith('export');
  const result = analyze({
    [esm ? 'client.ts' : 'client.cts']: (esm ? esmClient : cjsClient) + exported,
    [esm ? 'billing.ts' : 'billing.cts']: consumer + read,
    [esm ? 'mutator.ts' : 'mutator.cts']:
      consumer + 'const alias = billing; alias.paymentIntents.retrieve = replacement;',
  });
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
  expect(result.apiVersionDeclarations.find((entry) => entry.kind === 'constructor')?.status).toBe(
    'unknown',
  );
});

it.each([
  'module.exports = { ...container, client };',
  'module.exports = { [key]: client };',
  'module.exports = { get client() { return client; } };',
  'module.exports = client; module.exports = replacement;',
  'module.exports = {client}; exports.client = replacement;',
  'if (flag) module.exports = {client};',
  'module.exports = client; mutate(module.exports);',
  'module.exports.client = client; module.exports[key] = replacement;',
  'module.exports = {client, client};',
])('rejects dynamic, mutable or ambiguous CommonJS export graphs: %s', (exported) => {
  const result = analyze({
    'client.cts': cjsClient + exported,
    'billing.cts': "const {client: billing} = require('./client.cjs');" + read,
  });
  expect(result.findings.every((entry) => entry.confidence === 'review')).toBe(true);
  expect(result.edits).toEqual([]);
});

it.each([
  "function fake(require) { const billing = require('stripe')('test');",
  "const require = fake; { const billing = require('stripe')('test');",
  "function fake(Stripe) { const billing = new Stripe('test');",
  "const Stripe = require(packageName); { const billing = new Stripe('test');",
  "let Stripe = require('stripe'); { const billing = new Stripe('test');",
])('does not use a shadowed or dynamic loader or constructor: %s', (prefix) => {
  const result = analyze({ 'billing.cts': prefix + read + '}' });
  expect(result.findings.every((entry) => entry.confidence === 'review')).toBe(true);
  expect(result.edits).toEqual([]);
  expect(result.apiVersionDeclarations).toEqual([]);
});

it.each([
  "const namespace = require('./client.cjs'); namespace.client.paymentIntents.retrieve = replacement;",
  "const {client, ...rest} = require('./client.cjs');",
  "const client = require('./client.cjs');",
  "mutate(require('./client.cjs'));",
  "export {client} from './client.cjs';",
])('invalidates shared clients exposed through unsupported consumers: %s', (consumer) => {
  const result = analyze({
    'client.cts': cjsClient + 'module.exports = {client};',
    'billing.cts': "const {client: billing} = require('./client.cjs');" + read,
    'mutator.cts': consumer,
  });
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it('declines CommonJS/ESM namespace guessing and ambiguous source/output files', () => {
  expect(
    analyze({
      'client.ts': esmClient + 'export default client;',
      'billing.cts': "const billing = require('./client.js');" + read,
    }).edits,
  ).toEqual([]);
  expect(
    analyze({
      'client.cts': cjsClient + 'module.exports = client;',
      'billing.ts': "import billing from './client.cjs';" + read,
    }).edits,
  ).toEqual([]);
  expect(
    analyze({
      'client.cts': cjsClient + 'module.exports = client;',
      'client.cjs': cjsClient + 'module.exports = client;',
      'billing.cts': "const billing = require('./client.cjs');" + read,
    }).edits,
  ).toEqual([]);
});

it('keeps a conflicting source API version visible through CommonJS client imports', () => {
  const result = analyze({
    'client.cts': cjsClient.replace(ORIGINAL, CHANGED) + 'module.exports = client;',
    'billing.cts': "const billing = require('./client.cjs');" + read,
  });
  expect(
    compareApiVersion(
      ORIGINAL,
      { info: { version: ORIGINAL } },
      { info: { version: CHANGED } },
      { configured: true, declarations: result.apiVersionDeclarations },
      'source-verified',
    ).applicability,
  ).toBe('conflicts-with-code');
});

it('requires an adapter to explicitly approve callable constructor semantics', () => {
  const configuration = {
    id: 'example',
    packageName: 'example-sdk',
    defaultImport: false,
    namedExport: 'Client',
    operations: [{ resource: 'paymentIntents', method: 'retrieve', schema: 'payment_intent' }],
  };
  const content =
    "const {Client: Constructor} = require('example-sdk'); const billing = Constructor('test');" +
    read;
  expect(analyze({ 'billing.cjs': content }, parseProviderAdapter(configuration)).edits).toEqual(
    [],
  );
  expect(
    analyze(
      { 'billing.cjs': content },
      parseProviderAdapter({ ...configuration, constructorCalls: true }),
    ).findings,
  ).toMatchObject([{ confidence: 'confirmed' }]);
  expect(() => parseProviderAdapter({ ...configuration, constructorCalls: 'yes' })).toThrow(
    /constructorCalls/,
  );
});

it.each([
  [
    'ESM default',
    'client.ts',
    esmClient + 'export default client;',
    'payments.ts',
    "import billing from './client.js';",
    'history.ts',
    "import {retrieve} from './payments.js';",
    'export function',
    '',
    'import refitStripe from "./client.js";',
  ],
  [
    'ESM inline',
    'client.ts',
    `import Stripe from 'stripe';export default new Stripe('test', ${options});`,
    'payments.ts',
    "import billing from './client.js';",
    'history.ts',
    "import {retrieve} from './payments.js';",
    'export function',
    '',
    'import refitStripe from "./client.js";',
  ],
  [
    'CommonJS direct',
    'client.cjs',
    cjsClient + 'module.exports = client;',
    'payments.cjs',
    "const billing = require('./client.cjs');",
    'history.cjs',
    "const {retrieve} = require('./payments.cjs');",
    'function',
    'module.exports = {retrieve};',
    'const refitStripe = require("./client.cjs");',
  ],
  [
    'CommonJS named',
    'client.cjs',
    cjsClient + 'module.exports = {client};',
    'payments.cjs',
    "const {client: billing} = require('./client.cjs');",
    'history.cjs',
    "const {retrieve} = require('./payments.cjs');",
    'function',
    'exports.retrieve = retrieve;',
    'const refitStripe = require("./client.cjs").client;',
  ],
])(
  'adds a valid shared-client import when migrating guarded history through %s wrappers',
  (
    _name,
    clientPath,
    client,
    paymentsPath,
    clientImport,
    historyPath,
    wrapperImport,
    functionPrefix,
    wrapperExport,
    addedImport,
  ) => {
    const history = `${wrapperImport} class MissingHistory extends Error {} async function history(id) {
    const intent = await retrieve(id);
    if (!intent.charges) { throw new MissingHistory('Missing history'); }
    return intent.charges.data;
  }`;
    const result = analyze({
      [historyPath]: history,
      [paymentsPath]: `${clientImport} ${functionPrefix} retrieve(id) { return billing.paymentIntents.retrieve(id); } ${wrapperExport}`,
      [clientPath]: client,
    });
    expect(result.findings).toMatchObject([
      { confidence: 'confirmed' },
      { confidence: 'confirmed' },
    ]);
    expect(result.edits).toHaveLength(1);
    const migrated = result.migrated.find((file) => file.path === historyPath)!.content;
    expect(migrated).toContain(addedImport);
    expect(migrated).toContain('for await (const refitCharge of refitStripe.charges.list');
    expect(
      analyze(Object.fromEntries(result.migrated.map((file) => [file.path, file.content])))
        .findings,
    ).toEqual([]);
  },
);

it.each([
  `${cjsClient} client.paymentIntents.retrieve = replacement; module.exports = client;`,
  `${cjsClient} Stripe.prototype.request = replacement; module.exports = client;`,
  `const Stripe = require('stripe'); const billing = new Stripe(...argumentsList);`,
])('does not patch a mutated constructor/client or dynamic construction: %s', (client) => {
  const shared = client.includes('module.exports');
  const result = analyze(
    shared
      ? { 'client.cjs': client, 'billing.cjs': "const billing = require('./client.cjs');" + read }
      : { 'billing.cjs': client + read },
  );
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it.each([
  "const {default: billing} = require('./client.cjs');",
  "const billing = require('./client.cjs').default;",
])('does not confuse a direct CommonJS value with a named default property: %s', (consumer) => {
  expect(
    analyze({
      'client.cjs': cjsClient + 'module.exports = client;',
      'billing.cjs': consumer + read,
    }).edits,
  ).toEqual([]);
});

it('traces an actual named CommonJS default property', () => {
  const result = analyze({
    'client.cjs': cjsClient + 'exports.default = client;',
    'billing.cjs': "const billing = require('./client.cjs').default;" + read,
  });
  expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(result.edits).toHaveLength(1);
});

it.each(['require = replacement;', 'configure(require);', 'const loader = require;'])(
  'declines rewritten or exposed loaders: %s',
  (mutation) => {
    const result = analyze({
      'billing.cjs': mutation + `const billing = require('stripe')('test', ${options});` + read,
    });
    expect(result.edits).toEqual([]);
    expect(result.apiVersionDeclarations).toEqual([]);
  },
);

it('does not verify versions for an unsupported module namespace escape', () => {
  const result = analyze({
    'client.ts': esmClient + 'export default client;',
    'billing.ts': "import billing from './client.js';" + read,
    'mutator.ts': "import * as namespace from './client.js'; configure(namespace);",
  });
  expect(result.apiVersionDeclarations.find((entry) => entry.kind === 'constructor')?.status).toBe(
    'unknown',
  );
});

it.each(['new (Stripe)', '(Stripe)'])(
  'preserves constructor mutation evidence through %s initialization',
  (expression) => {
    const source =
      `const Stripe = require('stripe'); Stripe.prototype.request = replacement; const billing = ${expression}('test', ${options});` +
      read;
    const result = analyze({ 'billing.cjs': source });
    expect(result.edits).toEqual([]);
    expect(
      result.apiVersionDeclarations.find((entry) => entry.kind === 'constructor')?.status,
    ).toBe('unknown');
  },
);

it('does not guess a mixed local ESM/CommonJS export module', () => {
  expect(
    analyze({
      'client.ts': esmClient + 'module.exports = client;',
      'billing.cts': "const billing = require('./client.js');" + read,
    }).edits,
  ).toEqual([]);
});

// smj1860/fieldstay lib/stripe/client.ts exports the client beside a type and a re-exported
// constant; importers that take only those must not unlink the client from its other importers.
const fieldstayClient = `${esmClient}
export const billing = client;
export type BillingInterval = 'monthly' | 'annual';
export function isPlatformPriceId(id: string) { return id.startsWith('price_'); }
export { MAX_SELF_SERVE_PROPERTIES } from './brackets';`;

it.each([
  ['a type imported without the type keyword', "import { BillingInterval } from './client';"],
  ['a re-exported constant', "import { MAX_SELF_SERVE_PROPERTIES } from './client';"],
  ['a function', "import { isPlatformPriceId } from './client';"],
  // akn3107/whatsapp-store-creator takes a function and a type alias from the module that builds
  // its client in one clause, without `type`.
  [
    'a function and a type without the type keyword',
    "import { isPlatformPriceId, BillingInterval } from './client';",
  ],
  // Ankit-Sharma1011/Quill and Princegupta101/SwiftScribe import a client module's function as a
  // type; Eziox-Development/eziox-web and papay0/Ideate.build import its type aliases with `type`.
  [
    'a function as a type',
    "import type { isPlatformPriceId } from './client';\ntype Check = ReturnType<typeof isPlatformPriceId>;",
  ],
  ['a type with import type', "import type { BillingInterval } from './client';"],
  // papay0/Ideate.build, guillermolg00/nextjs-stripe-store and beindigital-products/wedillybird
  // import the client module's values and an inline `type` name in one clause.
  [
    'an inline type beside a value',
    "import { isPlatformPriceId, type BillingInterval } from './client';",
  ],
])('keeps an ESM client traced when another importer takes %s', (_name, other) => {
  const result = analyze({
    'brackets.ts': 'export const MAX_SELF_SERVE_PROPERTIES = 5;',
    'client.ts': fieldstayClient,
    'core-billing.ts': `${other}\nexport const seen = 1;`,
    'history.ts': `import { billing } from './client';\n${read}`,
  });
  expect(result.findings).toMatchObject([{ file: 'history.ts', confidence: 'confirmed' }]);
  expect(result.edits).toHaveLength(1);
});

it('keeps the importing module linked when a re-exported name reaches another module', () => {
  const result = analyze({
    'audit.ts': `import Stripe from 'stripe'; export const audit = new Stripe('test', ${options});`,
    'audit-history.ts': `import { audit as billing } from './audit';\n${read}`,
    'client.ts': `${esmClient}\nexport const billing = client;\nexport { audit } from './audit';`,
    'core-billing.ts':
      "import { audit } from './client';\naudit.paymentIntents.retrieve = replacement;",
    'history.ts': `import { billing } from './client';\n${read}`,
  });
  // The mutated client is audit.ts's, re-exported through client.ts; only it stops for review.
  expect(result.findings).toMatchObject([
    { file: 'audit-history.ts', confidence: 'review' },
    { file: 'history.ts', confidence: 'confirmed' },
  ]);
  expect(result.edits).toMatchObject([{ file: 'history.ts' }]);
});

it.each([
  ['a name the module does not export', '', "import { missing } from './client';"],
  [
    'a type that shares its name with a mutable value',
    'export type Shared = string;\nexport let Shared = 1;',
    "import { Shared } from './client';",
  ],
  ['a namespace import', '', "import * as everything from './client';"],
  // A type merged with a namespace that holds a value, or a destructured export, is a value: P5's
  // counterexamples monkeypatched the client through each of them.
  [
    'an interface merged with a namespace',
    'export interface Box { id: string }\nexport namespace Box { export const inner = client; }',
    "import { Box } from './client';\nBox.inner.paymentIntents.retrieve = replacement;",
  ],
  [
    'an interface merged with a declared namespace',
    'export interface Box { id: string }\nexport declare namespace Box { const inner: typeof client; }',
    "import { Box } from './client';\nBox.inner.paymentIntents.retrieve = replacement;",
  ],
  [
    'an interface merged with a destructured export',
    'export interface inner { id: string }\nexport const { inner } = { inner: client };',
    "import { inner } from './client';\ninner.paymentIntents.retrieve = replacement;",
  ],
  [
    'a name re-exported from an unscanned package',
    "export { Stripe } from 'stripe';",
    "import { Stripe } from './client';\nStripe.prototype.request = replacement;",
  ],
])('still unlinks the ESM client when another importer takes %s', (_name, exported, other) => {
  const result = analyze({
    'brackets.ts': 'export const MAX_SELF_SERVE_PROPERTIES = 5;',
    'client.ts': `${fieldstayClient}\n${exported}`,
    'core-billing.ts': `${other}\nexport const seen = 1;`,
    'history.ts': `import { billing } from './client';\n${read}`,
  });
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
  // The client module escapes, so its constructor no longer declares a verified version.
  expect(result.apiVersionDeclarations.find((entry) => entry.kind === 'constructor')?.status).toBe(
    'unknown',
  );
});

// Barrels expose the client module to importers Refit does not follow, so they stay review:
// named re-exports as in marketstandard/onix and profullstack/vibe-stack, default re-exports as in
// nabarvn/documon and nirholas/crypto-data-aggregator, and `export *` as in kondax-com/Bocker and
// pretzelai/stripe-no-webhooks.
it.each([
  ['a named re-export', "export { billing } from './client';", 'export const billing = client;'],
  [
    'a default re-export',
    "export { default as billing } from './client';",
    'export default client;',
  ],
  ['export *', "export * from './client';", 'export const billing = client;'],
])('keeps a client reached through %s for review', (_name, barrel, exported) => {
  const result = analyze({
    'client.ts': `${esmClient}\n${exported}`,
    'index.ts': barrel,
    'history.ts': `import { billing } from './index';\n${read}`,
  });
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});
