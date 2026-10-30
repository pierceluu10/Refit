import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { analyzeRepository, syntaxErrors } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE } from './providers.ts';
import { runPipeline } from './run.ts';
import { STRIPE_SDK_RELEASES } from './stripe-package-upgrade.ts';
import { digest, findRemovedProperties } from './specifications.ts';
import { createReviewArtifacts } from './review.ts';
import {
  CHECKOUT_SHIPPING_HELPER,
  HELPER_GLOBALS,
  HELPER_NAMES,
  INVOICE_PRICE_ID_HELPER,
  INVOICE_SUBSCRIPTION_HELPER,
  PERIOD_HELPERS,
  subscriptionPeriodHelperModule,
} from './stripe-subscription-periods.ts';
import ts from 'typescript-compiler';
import { migrationReviewReason } from './migration-review.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const string = { type: 'string' };
const integer = { type: 'integer' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const list = (schema: string) => ({
  type: 'object',
  properties: { has_more: { type: 'boolean' }, data: { type: 'array', items: ref(schema) } },
});

// Reduced Stripe contracts for the 2025-03-31.basil field moves.
function schemas(after: boolean, moved = true): Record<string, unknown> {
  return {
    subscription: {
      type: 'object',
      properties: {
        id: string,
        items: list('subscription_item'),
        ...(after ? {} : { current_period_start: integer, current_period_end: integer }),
      },
    },
    subscription_item: {
      type: 'object',
      properties: {
        id: string,
        ...(after && moved ? { current_period_start: integer, current_period_end: integer } : {}),
      },
    },
    invoice: {
      type: 'object',
      properties: {
        id: string,
        lines: list('line_item'),
        ...(after
          ? {
              confirmation_secret: string,
              ...(moved ? { parent: { anyOf: [ref('invoice_parent')], nullable: true } } : {}),
            }
          : {
              payment_intent: string,
              subscription: { anyOf: [string, ref('subscription')], nullable: true },
            }),
      },
    },
    invoice_parent: {
      type: 'object',
      properties: { subscription_details: { anyOf: [ref('subscription_parent')], nullable: true } },
    },
    subscription_parent: {
      type: 'object',
      properties: { subscription: { anyOf: [string, ref('subscription')] } },
    },
    ...Object.fromEntries(
      ['line_item', 'invoiceitem'].map((schema) => [
        schema,
        {
          type: 'object',
          properties: {
            id: string,
            ...(after
              ? moved
                ? { pricing: { anyOf: [ref('pricing')], nullable: true } }
                : {}
              : { price: { anyOf: [ref('price')], nullable: true } }),
          },
        },
      ]),
    ),
    pricing: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['price_details'] },
        price_details: ref('pricing_price_details'),
      },
    },
    pricing_price_details: {
      type: 'object',
      properties: { price: { anyOf: [string, ref('price')] }, product: string },
    },
    price: { type: 'object', properties: { id: string, nickname: { ...string, nullable: true } } },
    'checkout.session': {
      type: 'object',
      properties: {
        id: string,
        ...(after ? {} : { shipping_details: { anyOf: [ref('shipping')], nullable: true } }),
        ...(!after || moved
          ? { collected_information: { anyOf: [ref('collected_information')], nullable: true } }
          : {}),
      },
    },
    collected_information: {
      type: 'object',
      properties: { shipping_details: { anyOf: [ref('address_details')], nullable: true } },
    },
    shipping: {
      type: 'object',
      properties: { address: string, carrier: string, name: string, phone: string },
    },
    address_details: { type: 'object', properties: { address: string, name: string } },
  };
}

const provider = {
  ...STRIPE,
  id: 'stripe-moves',
  operations: [
    { resource: 'subscriptions', method: 'retrieve', schema: 'subscription' },
    { resource: 'invoices', method: 'retrieve', schema: 'invoice' },
    { resource: 'invoiceItems', method: 'retrieve', schema: 'invoiceitem' },
    { resource: 'checkout.sessions', method: 'retrieve', schema: 'checkout.session' },
  ],
};
const header = `import Stripe from 'stripe';\nconst stripe = new Stripe('sk', { apiVersion: '2024-06-20' });\n`;

function analyze(body: string, path = 'billing.ts') {
  const content = header + body;
  const repository = {
    root: '/field-moves',
    files: [{ path, content }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const result = analyzeRepository(
    repository,
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    provider,
    schemas(false),
  );
  return {
    ...result,
    patched: applySourceEdits(
      content,
      result.edits.filter((edit) => edit.file === path),
    ),
  };
}

function helper(planText?: string) {
  const module: { exports: Record<string, (subscription: object, plan?: unknown) => unknown> } = {
    exports: {},
  };
  new Function(
    'module',
    subscriptionPeriodHelperModule('cjs', [PERIOD_HELPERS.current_period_end]),
  )(module);
  const plan = planText ? new Function(`return ${planText};`)() : undefined;
  return (subscription: object) => module.exports.getSubscriptionPeriodEnd(subscription, plan);
}
const planOf = (replacement: string) => /, (\(items\) => .*)\)\)$/.exec(replacement)?.[1];
const item = (end: number, price = 'price_basic') => ({
  current_period_end: end,
  price: { id: price },
});

it('reads every subscription period through the generated helper', () => {
  const result = analyze(`export async function period(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return [subscription.current_period_start, subscription?.current_period_end];
}`);
  expect(result.findings.map((finding) => finding.confidence)).toEqual(['confirmed', 'confirmed']);
  expect(result.edits.every((edit) => edit.rule === 'stripe-subscription-periods-helper')).toBe(
    true,
  );
  // The only calling file gets the helpers after its imports, with no module and no import.
  expect(result.edits.map((edit) => edit.file)).toEqual(['billing.ts', 'billing.ts', 'billing.ts']);
  expect(result.patched).toContain(
    `import Stripe from 'stripe';\n\n${subscriptionPeriodHelperModule('ts', Object.values(PERIOD_HELPERS), true)}const stripe = new Stripe(`,
  );
  expect(result.patched).not.toContain('export function');
  expect(result.patched).toContain(
    'return [(getSubscriptionPeriodStart(subscription)), (subscription == null ? undefined : getSubscriptionPeriodEnd(subscription))];',
  );
  expect(result.patched).not.toMatch(/Math\.(max|min)/);
  // Convex pushes every file in its functions folder and rejects names with characters other than
  // letters, digits, `_` and `.`.
  expect(result.edits.every((edit) => /^[\w./]+$/.test(edit.file))).toBe(true);
  expect(result.findings.map((finding) => finding.subscriptionPeriod)).toEqual([
    { rareCase: 'flagged' },
    { rareCase: 'flagged' },
  ]);
});

it('returns the old field, a shared period or undefined, never a widest period', () => {
  const read = helper();
  expect(read({ current_period_end: 100, items: { data: [item(200)] } })).toBe(100);
  expect(read({ items: { data: [item(200)] } })).toBe(200);
  expect(read({ items: { data: [item(300), item(300, 'price_addon')] } })).toBe(300);
  expect(read({ items: { data: [item(300), item(400, 'price_addon')] } })).toBeUndefined();
  expect(read({ items: { data: [{ price: { id: 'price_basic' } }] } })).toBeUndefined();
  expect(read({ items: { data: [] } })).toBeUndefined();
  expect(read({})).toBeUndefined();
});

it('uses the item the same function selects by index for mixed periods', () => {
  const result = analyze(`export async function access(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return { price: subscription.items.data[1].price.id, ends: subscription.current_period_end };
}`);
  expect(result.findings[0].subscriptionPeriod).toEqual({
    rareCase: 'item-in-code',
    selection: 'items.data[1]',
  });
  const call = result.edits.find((edit) => edit.replacement.includes('getSubscriptionPeriodEnd('))!;
  expect(planOf(call.replacement)).toBe('(items) => items[1]');
  expect(
    helper(planOf(call.replacement))({ items: { data: [item(300), item(400, 'price_addon')] } }),
  ).toBe(400);
});

it.each([
  ['a top-level constant', `const PRO = 'price_pro';\n`, 'PRO'],
  ['an environment variable', '', 'process.env.STRIPE_PRO_PRICE'],
  ['a literal', '', "'price_pro'"],
])('uses the item the code compares with %s for mixed periods', (_label, declaration, value) => {
  const result = analyze(`${declaration}export async function access(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  const paid = subscription.items.data.some((entry) => entry.price.id === ${value});
  return paid ? subscription.current_period_end : 0;
}`);
  expect(result.findings[0].subscriptionPeriod).toEqual({
    rareCase: 'item-in-code',
    selection: `price.id === ${value}`,
  });
  const plan = planOf(
    result.edits.find((edit) => edit.replacement.includes('getSubscriptionPeriodEnd('))!
      .replacement,
  );
  expect(plan).toBe(`(items) => items.find((item) => item.price?.id === ${value})`);
  if (value === "'price_pro'")
    expect(helper(plan)({ items: { data: [item(300), item(400, 'price_pro')] } })).toBe(400);
});

it('uses the configured price policy item when the code selects none', () => {
  const content = `${header}export async function ends(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}`;
  const result = analyzeRepository(
    {
      root: '/field-moves',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    {
      ...provider,
      stripeSubscriptionPeriods: {
        priceId: 'price_primary',
        beforeApiVersion: '2025-02-24.acacia',
        afterApiVersion: '2025-03-31.basil',
      },
    },
    schemas(false),
  );
  expect(result.findings[0].subscriptionPeriod).toEqual({
    rareCase: 'price-policy',
    selection: 'price.id === "price_primary"',
  });
  const plan = planOf(
    result.edits.find((edit) => edit.replacement.includes('getSubscriptionPeriodEnd('))!
      .replacement,
  );
  expect(helper(plan)({ items: { data: [item(300), item(400, 'price_primary')] } })).toBe(400);
});

it('reads webhook payloads and Stripe-typed values through the helper', () => {
  const result = analyze(`export function fromWebhook(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;
    return subscription.current_period_end;
  }
}
export function fromParameter(subscription: Stripe.Subscription) {
  return subscription.current_period_start;
}`);
  expect(result.findings.filter((finding) => finding.confidence === 'confirmed')).toHaveLength(2);
  expect(result.findings.find((finding) => finding.webhook)?.webhook?.migration).toEqual({
    rule: 'stripe-subscription-periods-helper',
  });
  expect(result.patched).toContain('return (getSubscriptionPeriodEnd(subscription));');
  expect(result.patched).toContain('return (getSubscriptionPeriodStart(subscription));');
});

const commonJs = `const Stripe = require('stripe');
const stripe = new Stripe('sk', { apiVersion: '2024-06-20' });
async function ends(id) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}
module.exports = { ends };
`;
const analyzeFiles = (files: Record<string, string>) => {
  const result = analyzeRepository(
    {
      root: '/field-moves',
      files: Object.entries(files).map(([path, content]) => ({ path, content })),
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), provider.id),
    provider,
    schemas(false),
  );
  const patched = (path: string) =>
    applySourceEdits(
      files[path],
      result.edits.filter((edit) => edit.file === path),
    );
  return { ...result, patched };
};

it('writes CommonJS helpers into the one CommonJS file that calls them', () => {
  const result = analyzeFiles({ 'lib/billing.js': commonJs });
  expect(result.edits.map((edit) => edit.file)).toEqual(['lib/billing.js', 'lib/billing.js']);
  expect(result.patched('lib/billing.js')).toContain(
    `const Stripe = require('stripe');\n\n${subscriptionPeriodHelperModule('cjs', [PERIOD_HELPERS.current_period_end], true)}const stripe = new Stripe(`,
  );
  expect(result.patched('lib/billing.js')).not.toMatch(
    /require\('\.\/|module\.exports = \{ getSub/,
  );
});

it('writes a CommonJS helper module for CommonJS files that share it', () => {
  const result = analyzeFiles({ 'lib/billing.js': commonJs, 'lib/portal.js': commonJs });
  for (const path of ['lib/billing.js', 'lib/portal.js'])
    expect(result.patched(path)).toContain(
      "const Stripe = require('stripe');\nconst { getSubscriptionPeriodEnd } = require('./stripeSubscriptionPeriod');\nconst stripe = new Stripe(",
    );
  expect(
    result.edits.find((edit) => edit.file === 'lib/stripeSubscriptionPeriod.js')?.replacement,
  ).toBe(subscriptionPeriodHelperModule('cjs', [PERIOD_HELPERS.current_period_end]));
});

// The Quill webhook route that nabarvn/documon, JensenMPillay/pdfai and 4lbatr0s/jiro (CRLF) share,
// and the Supabase admin module of the nextjs-subscription-payments template. Each is the only file
// that calls the helpers in its repository, as alanagoyal/branded's lib/billing-state.ts is in its
// own, whose tests load that file in a vm that allows only its known imports.
const quillRoute = {
  file: 'src/app/api/webhooks/stripe/route.ts',
  content: `import { headers } from 'next/headers';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-06-20' });
export async function POST(request: Request) {
  const session = JSON.parse(await request.text());
  const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
  console.log(headers(), subscription.items.data[0]?.price.id);
  return new Date(subscription.current_period_end * 1000);
}
`,
  helpers: ['getSubscriptionPeriodEnd'],
};
const supabaseAdmin = {
  file: 'utils/supabase/admin.ts',
  content: `import Stripe from 'stripe';
import { toDateTime } from '../helpers';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2024-06-20' });
export async function manageSubscriptionStatusChange(subscriptionId: string) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['default_payment_method'],
  });
  return {
    id: subscription.id,
    current_period_start: toDateTime(subscription.current_period_start).toISOString(),
    current_period_end: toDateTime(subscription.current_period_end).toISOString(),
  };
}
`,
  helpers: ['getSubscriptionPeriodStart', 'getSubscriptionPeriodEnd'],
};
const newlines = ['\n', '\r\n'];
// Every line keeps the file's own ending: no bare LF in a CRLF file, no CR in an LF one.
const ownLineEndings = (patched: string, newline: string) =>
  expect(newline === '\r\n' ? patched.match(/(?<!\r)\n/g) : patched.match(/\r/g)).toBeNull();

it.each(
  [quillRoute, supabaseAdmin].flatMap((repository) =>
    newlines.map((newline) => ({ ...repository, newline })),
  ),
)(
  'writes only the helpers $file calls into it, in its line endings ($newline)',
  ({ file, content: lf, helpers, newline }) => {
    const content = lf.replaceAll('\n', newline);
    const result = analyzeFiles({ [file]: content });
    expect(result.edits.every((edit) => edit.file === file)).toBe(true);
    const patched = result.patched(file);
    const inline = subscriptionPeriodHelperModule('ts', helpers, true).replaceAll('\n', newline);
    expect(patched).toContain(`${newline}${newline}${inline}const stripe = new Stripe(`);
    const unused = HELPER_NAMES.filter((name) => !helpers.includes(name));
    expect(unused.filter((name) => patched.includes(name))).toEqual([]);
    expect(patched).not.toContain('stripeSubscriptionPeriod');
    ownLineEndings(patched, newline);
  },
);

// Files whose first statement is not an import: a CommonJS sync script run by its shebang (also
// after a byte order mark), an ES module script, and a TypeScript file that turns checking off.
// Above the shebang Node rejects the script; above the pragma TypeScript ignores it.
const sync = `#!/usr/bin/env node
require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
async function sync(id) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}
sync(process.argv[2]).then(console.log);
`;
const headed = [
  { file: 'scripts/sync.js', kind: 'cjs', content: sync, head: '#!/usr/bin/env node' },
  {
    file: 'scripts/sync.js',
    kind: 'cjs',
    content: `\uFEFF${sync}`,
    head: '\uFEFF#!/usr/bin/env node',
  },
  {
    file: 'scripts/renewals.mjs',
    kind: 'esm',
    content: `#!/usr/bin/env node
// Prints when a subscription renews.

process.env.TZ ??= 'UTC';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const subscription = await stripe.subscriptions.retrieve(process.argv[2]);
console.log(new Date(subscription.current_period_end * 1000));
`,
    head: '#!/usr/bin/env node\n// Prints when a subscription renews.',
  },
  {
    file: 'lib/legacy-billing.ts',
    kind: 'ts',
    content: `// @ts-nocheck
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
export async function ends(id) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}
`,
    head: '// @ts-nocheck',
  },
] as const;

it.each(headed)(
  'writes the helpers below the head of $file ($head)',
  ({ file, kind, content, head }) => {
    const patched = analyzeFiles({ [file]: content }).patched(file);
    expect(patched).toContain('getSubscriptionPeriodEnd(subscription)');
    expect(
      patched.startsWith(
        `${head}\n\n${subscriptionPeriodHelperModule(kind, ['getSubscriptionPeriodEnd'], true)}`,
      ),
    ).toBe(true);
    expect(syntaxErrors(file, patched)).toEqual([]);
  },
);

// A comment directly above the first statement applies to that statement, so it stays on it.
it('keeps a line directive on the first statement below the helpers', () => {
  const directive = '// eslint-disable-next-line @typescript-eslint/no-require-imports';
  const content = sync.replace('#!/usr/bin/env node', directive);
  const patched = analyzeFiles({ 'scripts/sync.js': content }).patched('scripts/sync.js');
  expect(
    patched.startsWith(subscriptionPeriodHelperModule('cjs', ['getSubscriptionPeriodEnd'], true)),
  ).toBe(true);
  expect(patched).toContain(`\n\n${directive}\nrequire('dotenv').config();`);
});

it('imports the shared helper module below the shebang of each script', () => {
  const files = { 'scripts/sync.js': sync, 'scripts/renew.js': sync };
  const result = analyzeFiles(files);
  for (const file of Object.keys(files))
    expect(result.patched(file)).toMatch(
      /^#!\/usr\/bin\/env node\nconst \{ getSubscriptionPeriodEnd \} = require\('\.\/stripeSubscriptionPeriod'\);\nrequire\('dotenv'\)/,
    );
});

// The inlined helpers' private names would clash with this file's own `subscriptionPeriod`.
it('keeps the helpers in a module when the one calling file already uses a private helper name', () => {
  const result = analyzeFiles({
    'billing.ts': `${header}export async function ends(id: string) {
  const subscriptionPeriod = await stripe.subscriptions.retrieve(id);
  return subscriptionPeriod.current_period_end;
}`,
  });
  expect(result.edits.map((edit) => edit.file)).toContain('stripeSubscriptionPeriod.ts');
  expect(result.patched('billing.ts')).toContain(
    "import { getSubscriptionPeriodEnd } from './stripeSubscriptionPeriod';",
  );
  expect(result.patched('billing.ts')).not.toContain('function subscriptionPeriod(');
});

// The inlined helpers read Set; Immutable.js exports its own, which would replace it in this file.
it('keeps the helpers in a module when the one calling file shadows a global they read', () => {
  const content = `import { Set } from 'immutable';\n${header}export async function ends(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return [subscription.current_period_end, Set.of(id)];
}`;
  const result = analyzeFiles({ 'billing.ts': content });
  expect(result.edits.map((edit) => edit.file)).toContain('stripeSubscriptionPeriod.ts');
  expect(result.patched('billing.ts')).not.toContain('function subscriptionPeriod(');
});

it('lists every global the helper bodies read', () => {
  const free = new Set<string>();
  for (const kind of ['ts', 'esm', 'cjs'] as const) {
    const source = ts.createSourceFile(
      'helpers.ts',
      subscriptionPeriodHelperModule(kind, HELPER_NAMES, true),
      ts.ScriptTarget.Latest,
      true,
    );
    const declared = new Set<string>();
    const used = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent as ts.Node & { name?: ts.Node };
        if (parent.name !== node) used.add(node.text);
        else if (
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isTypeAliasDeclaration(parent) ||
          ts.isTypeParameterDeclaration(parent) ||
          ts.isBindingElement(parent)
        )
          declared.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const name of used) if (!declared.has(name)) free.add(name);
  }
  expect([...free].sort()).toEqual([...HELPER_GLOBALS].sort());
});

// Both shapes in one repository: two calling files share one module of the helpers either calls.
it.each(newlines)('shares one helper module between two calling files (%j)', (newline) => {
  const files = Object.fromEntries(
    [quillRoute, supabaseAdmin].map(({ file, content }) => [
      file,
      content.replaceAll('\n', newline),
    ]),
  );
  const result = analyzeFiles(files);
  const module = result.edits.find((edit) => edit.file === 'stripeSubscriptionPeriod.ts');
  expect(module?.replacement).toBe(subscriptionPeriodHelperModule('ts', supabaseAdmin.helpers));
  for (const [{ file, helpers }, lastImport, specifier] of [
    [quillRoute, "import Stripe from 'stripe';", '../../../../../stripeSubscriptionPeriod'],
    [supabaseAdmin, "import { toDateTime } from '../helpers';", '../../stripeSubscriptionPeriod'],
  ] as const) {
    const patched = result.patched(file);
    expect(patched).toContain(
      `${lastImport}${newline}import { ${helpers.join(', ')} } from '${specifier}';${newline}const stripe`,
    );
    expect(patched).not.toContain('function getSubscriptionPeriod');
    ownLineEndings(patched, newline);
  }
});

// Messages from a strict compile of in-memory files under /check; `stripe` resolves to
// /check/stripe.d.ts when given.
function strictDiagnostics(files: Map<string, string>) {
  const options = {
    strict: true,
    noEmit: true,
    noLib: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    paths: { stripe: ['/check/stripe.d.ts'] },
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (name) => files.get(name) ?? read(name);
  host.fileExists = (name) => files.has(name) || ts.sys.fileExists(name);
  host.directoryExists = (name) => name === '/check' || ts.sys.directoryExists(name);
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) =>
    files.has(name)
      ? ts.createSourceFile(name, files.get(name)!, version, true)
      : getSource(name, version);
  const program = ts.createProgram([...files.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

it('generates a TypeScript helper that compiles strictly without Stripe types', () => {
  const files = new Map([
    ['/check/helper.ts', subscriptionPeriodHelperModule('ts', HELPER_NAMES)],
    [
      '/check/use.ts',
      `import { getSubscriptionPeriodEnd, getInvoicePriceId, getCheckoutShippingDetails } from './helper';
const subscription = { items: { data: [{ price: { id: 'p' }, current_period_end: 1 }] } };
export const ends: number = getSubscriptionPeriodEnd(subscription, (items) => items.find((item) => item.price?.id === 'p'));
export const first: number = getSubscriptionPeriodEnd(subscription, (items) => items[0]);
export const price: string | undefined = getInvoicePriceId({ pricing: null });
const moved = { collected_information: { shipping_details: { address: 'a', name: 'n' } } };
export const shipping: { address: string; name: string } | null = getCheckoutShippingDetails(moved);
export const legacy: { carrier: string } = getCheckoutShippingDetails({ shipping_details: { carrier: 'c' } });
`,
    ],
  ]);
  expect(strictDiagnostics(files)).toEqual([]);
});

const mixed = `export async function ends(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}
export function invoiceOwner(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;
    return invoice.subscription;
  }
}`;

it('reads a webhook invoice.subscription through the generated helper for either version', async () => {
  const report = await run(mixed);
  expect(report.findings.find((finding) => finding.webhook)).toMatchObject({
    confidence: 'confirmed',
    expression: '.subscription',
    webhook: { migration: { rule: 'stripe-invoice-subscription-helper' } },
  });
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('getSubscriptionPeriodEnd(subscription)');
  expect(diff).toContain('+    return (getInvoiceSubscription(invoice));');
  expect(diff).toContain('+function getSubscriptionPeriodEnd(subscription: object');
  expect(diff).toContain('+function getInvoiceSubscription<T extends object>(invoice: T)');
  expect(diff).not.toContain('stripeSubscriptionPeriod');
  const helper = subscriptionPeriodHelperModule('cjs', [INVOICE_SUBSCRIPTION_HELPER]);
  const { getInvoiceSubscription } = new Function('module', `${helper}; return module.exports;`)(
    {},
  );
  expect(getInvoiceSubscription({ subscription: 'sub_old' })).toBe('sub_old');
  expect(getInvoiceSubscription({ subscription: null })).toBeNull();
  expect(
    getInvoiceSubscription({ parent: { subscription_details: { subscription: 'sub_new' } } }),
  ).toBe('sub_new');
  expect(getInvoiceSubscription({ parent: null })).toBeNull();
});

it('reads a typeof-narrowed invoice.subscription through one local', async () => {
  const report = await run(
    mixed.replace(
      'return invoice.subscription;',
      "return typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;",
    ),
  );
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain(
    '+    const invoiceSubscription = getInvoiceSubscription(invoice);\n' +
      "+    return typeof invoiceSubscription === 'string' ? invoiceSubscription : invoiceSubscription?.id;",
  );
});

it('declares the local once per receiver, before the first guard', async () => {
  const report = await run(`export async function paid(invoice: Stripe.Invoice) {
  if (!invoice.subscription) {
    return;
  }
  const id = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription.id;
  return id;
}
export function owner(event: Stripe.Event) {
  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      let id: string | null = null;
      if (typeof invoice.subscription === 'string') {
        id = invoice.subscription;
      }
      return id;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      if (typeof invoice.subscription === 'string') return invoice.subscription;
      return null;
    }
  }
}`);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain(
    '+  const invoiceSubscription = getInvoiceSubscription(invoice);\n+  if (!invoiceSubscription) {',
  );
  expect(diff).toContain(
    "+  const id = typeof invoiceSubscription === 'string'\n+    ? invoiceSubscription\n+    : invoiceSubscription.id;",
  );
  expect(diff).toContain(
    '+      const invoiceSubscription = getInvoiceSubscription(invoice);\n' +
      "+      if (typeof invoiceSubscription === 'string') {\n+        id = invoiceSubscription;",
  );
  expect(diff).toContain(
    '+      const invoiceSubscription = getInvoiceSubscription(invoice);\n' +
      "+      if (typeof invoiceSubscription === 'string') return invoiceSubscription;",
  );
  expect(diff.match(/const invoiceSubscription =/g)).toHaveLength(3);
});

it('leaves a typeof-narrowed invoice.subscription unresolved when the receiver changes', async () => {
  const report = await run(`export async function paid(id: string, fallback: Stripe.Invoice) {
  let invoice: Stripe.Invoice = await stripe.invoices.retrieve(id);
  if (!invoice.subscription) invoice = fallback;
  return typeof invoice.subscription === 'string' ? invoice.subscription : null;
}`);
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).not.toContain('getInvoiceSubscription(invoice)');
  expect(report.patch).toMatchObject({ unresolvedFindings: 3 });
});

it('leaves an SDK invoice.subscription unresolved when it is expanded', async () => {
  const report = await run(`export async function owner(id: string) {
  const invoice = await stripe.invoices.retrieve(id, { expand: ['subscription'] });
  return invoice.subscription;
}`);
  // The expand entry, which names the removed field (stripe-expand-paths.ts), and the read.
  expect(report.findings).toMatchObject([
    { expression: "invoices.retrieve expand 'subscription'", confidence: 'confirmed' },
    { expression: '.subscription', confidence: 'confirmed' },
  ]);
  expect(report.findings.some((finding) => finding.webhook)).toBe(false);
  expect(report.patch).toMatchObject({ status: 'unsupported' });
});

// Stripe never expands event payloads, so an expand elsewhere in the code does not hold a webhook
// read back. The SDK read beside it still stays.
it('reads a webhook invoice.subscription through the helper when other code expands it', async () => {
  const report = await run(
    `${mixed}
export const paid = (id: string) => stripe.invoices.retrieve(id, { expand: ['subscription'] });
export const owner = async (id: string) => (await paid(id)).subscription;`,
  );
  // The read and the expand entry, which names the removed field (stripe-expand-paths.ts).
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 2 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('+    return (getInvoiceSubscription(invoice));');
  expect(diff).not.toContain('getInvoiceSubscription(await');
  expect(report.findings.find((finding) => finding.webhook)).toMatchObject({
    webhook: { migration: { rule: 'stripe-invoice-subscription-helper' } },
  });
  expect(migrationReviewReason(report, true, true)).toBeUndefined();
});

// manu14357/smartdoc src/app/api/webhooks/stripe/route.ts at 9041f9b: the payload is cast once,
// before the event-type branches, and the repository's Tailwind config has an `expand` keyframe.
it('reads a webhook invoice.subscription cast before its event branch, beside an unrelated expand', async () => {
  const report =
    await run(`export const theme = { keyframes: { expand: { from: { opacity: 0 } } } };
export async function hook(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  const session = event.data.object as Stripe.Checkout.Session;
  if (event.type === 'invoice.payment_succeeded') {
    const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
    return subscription.id;
  }
}`);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain(
    '+    const subscription = await stripe.subscriptions.retrieve((getInvoiceSubscription(session)) as string);',
  );
});

// brunobola-portfolio/GitHub-Repo-Manager server/routes/stripe-webhooks.js at 982052f: several
// switch cases read invoice.subscription, and another file has an `expand` identifier.
it('reads webhook invoice.subscription in each switch case beside an unrelated expand', async () => {
  const report = await run(`export const toggleBranchExpand = { expand: true };
export async function hook(body: string, signature: string, db: { run(id: unknown): void }) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  } catch {
    return 400;
  }
  switch (event.type) {
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      if (invoice.subscription) {
        db.run(invoice.subscription);
      }
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      if (invoice.subscription) db.run(invoice.subscription);
      break;
    }
  }
  return 200;
}`);
  const reads = report.findings.filter((finding) => finding.webhook);
  expect(reads).toHaveLength(4);
  expect(
    reads.every(
      (finding) => finding.webhook?.migration?.rule === 'stripe-invoice-subscription-helper',
    ),
  ).toBe(true);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
});

const BASIL_RELEASE = STRIPE_SDK_RELEASES['2025-03-31.basil'];

async function run(
  body: string,
  moved = true,
  aiPatch?: { apiKey: string; model: string },
  options = `{ apiVersion: '2024-06-20' }`,
  // A release declared with no lockfile: the target's already declared needs no upgrade, so the pin
  // moves without a registry request.
  declared?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'refit-field-moves-'));
  roots.push(root);
  await writeFile(
    join(root, 'billing.ts'),
    header.replace(`{ apiVersion: '2024-06-20' }`, options) + body,
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { stripe: declared ?? '16.0.0' } }),
  );
  // Refit never upgrades stripe-node beside a bun lockfile, so these patches stay the field moves
  // and need no registry; stripe-package-upgrade.test.ts covers the upgrade. A TypeScript pin then
  // stays, as it moves only with the upgrade.
  if (!declared) await writeFile(join(root, 'bun.lockb'), '');
  const contract = (after: boolean) => ({
    openapi: '3.0.3',
    info: {
      title: 'Simulated Stripe contract',
      version: after ? '2025-03-31.basil' : '2024-06-20',
    },
    paths: {},
    components: { schemas: schemas(after, moved) },
  });
  await writeFile(join(root, 'before.json'), JSON.stringify(contract(false)));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract(true)));
  await writeFile(join(root, 'provider.json'), JSON.stringify(provider));
  return runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: '2024-06-20',
    ...(aiPatch ? { aiPatch } : { proposePatch: true }),
  });
}

const periodRead = `export async function ends(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return subscription.current_period_end;
}`;

it('proposes the field move and the API-version bump as one patch', async () => {
  const report = await run(periodRead, true, undefined, undefined, BASIL_RELEASE);
  expect(report.patch).toMatchObject({
    status: 'proposed',
    edits: 3,
    unresolvedFindings: 0,
    sources: [
      {
        url: 'https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end',
        files: ['billing.ts'],
      },
    ],
  });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain("+const stripe = new Stripe('sk', { apiVersion: '2025-03-31.basil' });");
  expect(diff).toContain('return (getSubscriptionPeriodEnd(subscription));');
  expect(diff).toContain('+function getSubscriptionPeriodEnd(');
  expect(diff).not.toContain('new file mode');
});

it('migrates reads for a client on the account default version without pinning one', async () => {
  const report = await run(periodRead, true, undefined, '{ apiVersion: null }');
  expect(report.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 2, unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('getSubscriptionPeriodEnd(subscription)');
  expect(diff).not.toContain('2025-03-31.basil');
});

it('does not move a field the target contract does not define', async () => {
  const report = await run(periodRead, false);
  expect(report.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0 });
});

it('sends only rule-free findings to AI and returns one patch with rule, AI and version edits', async () => {
  let evidence: { findings: { id: string; expression: string }[] } | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      evidence = JSON.parse(JSON.parse(init.body).input[0].content);
      const finding = evidence!.findings.find((entry) => entry.expression === '.payment_intent')!;
      return new Response(
        JSON.stringify({
          id: 'resp_patch',
          model: 'test-model',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    summary: 'Read the confirmation secret.',
                    uncertainties: [],
                    edits: [
                      {
                        file: 'billing.ts',
                        findingId: finding.id,
                        original: 'invoice.payment_intent',
                        replacement: 'invoice.confirmation_secret',
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
      );
    }),
  );
  const report = await run(
    `${periodRead}
export async function secret(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  return invoice.payment_intent;
}`,
    true,
    { apiKey: 'test-key', model: 'test-model' },
    undefined,
    BASIL_RELEASE,
  );
  expect(evidence!.findings.map((finding) => finding.expression)).toEqual(['.payment_intent']);
  expect(report.patch).toMatchObject({ status: 'proposed', edits: 4, unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('invoice.confirmation_secret');
  expect(diff).toContain('getSubscriptionPeriodEnd(subscription)');
  expect(diff).toContain("apiVersion: '2025-03-31.basil'");
});

it('lists mixed-period reads without a selection in the pull request text', async () => {
  const scan = await run(periodRead);
  if (!('diff' in scan.patch)) throw new Error('Expected a patch');
  expect(scan.findings[0].subscriptionPeriod).toEqual({ rareCase: 'flagged' });
  const body = createReviewArtifacts({
    ...scan,
    publicationFiles: [],
    patch: { ...scan.patch, validation: 'passed' },
    validation: {
      status: 'passed',
      revision: 'a'.repeat(40),
      image: `sha256:${'b'.repeat(64)}`,
      runtime: {
        configured: 'node:22-alpine',
        image: 'node:22-alpine',
        nodeVersion: '22.23.3',
        declarations: [],
        reason: 'The repository declares no Node.js version.',
      },
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'c'.repeat(64),
      patchHash: digest(scan.patch.diff),
      baseline: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      patched: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      limits: {
        timeoutMs: 120_000,
        outputBytes: 1024 * 1024,
        network: 'none',
        workspace: '512m' as const,
        memory: '1g' as const,
      },
      publishable: false,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Synthetic check results for PR text.',
    },
  }).files['pull-request.md'];
  expect(body).toContain(
    'Subscriptions with items on different billing periods are not handled; set `stripeSubscriptionPeriods` to choose the item at',
  );
  expect(body).toContain('`billing.ts:5`');
  // The one calling file holds the helper, so the draft names it there and no new file.
  expect(body).toContain(
    'Adds the generated helper `getSubscriptionPeriodEnd` to this file, which reads the removed fields under either API version.',
  );
  expect(body).toContain(
    '- It removes the generated `getSubscriptionPeriodEnd` from `billing.ts`.',
  );
  expect(body).not.toContain('stripeSubscriptionPeriod.ts');
});

it('returns the rule patch without calling the model when rules cover every finding', async () => {
  const fetch = vi.fn(() => {
    throw new Error('Rules cover every finding; the model must not be called.');
  });
  vi.stubGlobal('fetch', fetch);
  const report = await run(periodRead, true, { apiKey: 'test-key', model: 'test-model' });
  expect(report.patch).toMatchObject({
    status: 'proposed',
    generator: 'deterministic',
    unresolvedFindings: 0,
  });
  expect(fetch).not.toHaveBeenCalled();
});

// Reduced 2025-02-24.acacia → 2025-03-31.basil invoicing contracts for moves without a rule.
function invoicingSchemas(after: boolean): Record<string, unknown> {
  return {
    invoice: {
      type: 'object',
      properties: {
        id: string,
        lines: list('line_item'),
        ...(after
          ? { confirmation_secret: string }
          : { payment_intent: { anyOf: [string, ref('payment_intent')], nullable: true } }),
      },
    },
    payment_intent: { type: 'object', properties: { id: string } },
    line_item: {
      type: 'object',
      properties: {
        id: string,
        amount: integer,
        ...(after ? {} : { type: string, price: { anyOf: [ref('price')], nullable: true } }),
      },
    },
    price: { type: 'object', properties: { id: string, nickname: string } },
  };
}

it('leaves invoicing moves without a behaviour-preserving read unresolved with their reason', () => {
  const content = `${header}export async function lines(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  const line = invoice.lines.data[0];
  return [invoice.payment_intent, line.type, line.price?.nickname, line.amount];
}`;
  const result = analyzeRepository(
    {
      root: '/field-moves',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(invoicingSchemas(false), invoicingSchemas(true), provider.id),
    provider,
    invoicingSchemas(false),
  );
  expect(result.edits).toEqual([]);
  expect(
    result.findings.map((finding) => [finding.expression, finding.confidence, finding.reason]),
  ).toEqual([
    ['.payment_intent', 'confirmed', expect.stringContaining('invoice.confirmation_secret')],
    ['.type', 'confirmed', expect.stringContaining('documents no mapping between the values')],
    ['.price', 'confirmed', expect.stringContaining('holds only the price ID')],
  ]);
  expect(result.findings[0].reason).toMatch(
    /^Removed field read on a statically traced stripe-moves invoice response\. Stripe 2025-03-31\.basil removed invoice\.payment_intent.*add-support-for-multiple-partial-payments-on-invoices$/,
  );
});

// abressiddique/AbresStore-Admin and oMiguelwnl/Borcelle_admin app/api/webhooks/route.ts: an
// awaited field (`await session?.line_items?.data`) is the field itself, and an optional `map`
// runs its callback on the same elements, so both stay traced.
it('traces list elements through an awaited field and an optional map', () => {
  const sessionSchemas = (after: boolean) => ({
    ...invoicingSchemas(after),
    'checkout.session': { type: 'object', properties: { id: string, line_items: list('item') } },
    item: { type: 'object', properties: { id: string, price: ref('price') } },
  });
  const content = `${header}export async function lines(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  const lines = await invoice?.lines?.data;
  const session = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items'] });
  const items = await session?.line_items?.data;
  return [
    lines?.map((line: any) => line.price?.nickname),
    items?.map((item: any) => item.price.id),
  ];
}`;
  const result = analyzeRepository(
    {
      root: '/field-moves',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(sessionSchemas(false), sessionSchemas(true), provider.id),
    provider,
    sessionSchemas(false),
  );
  // The invoice line's removed price is a confirmed read; a Checkout line item keeps its price.
  expect(
    result.findings.map((finding) => [finding.line, finding.expression, finding.confidence]),
  ).toEqual([[9, '.price', 'confirmed']]);
});

const priceReads = `export async function prices(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  const item = await stripe.invoiceItems.retrieve(id);
  return invoice.lines.data.map((line) => [line.price.id, line?.price?.id, item.price?.id]);
}
export async function nicknames(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  const line = invoice.lines.data[0];
  return [line.price?.nickname, line.price?.id.length];
}`;

it('reads invoice line item and invoice item price IDs through the generated helper', async () => {
  const report = await run(priceReads);
  expect(report.patch).toMatchObject({
    status: 'proposed',
    unresolvedFindings: 2,
  });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain(
    '+  return invoice.lines.data.map((line) => [(getInvoicePriceId(line)), (line == null ? undefined : getInvoicePriceId(line)), (getInvoicePriceId(item))]);',
  );
  expect(diff).toContain('+  return [line.price?.nickname, line.price?.id.length];');
  // billing.ts is the only calling file, so the helper goes into it and nothing imports it.
  expect(diff).toContain('+function getInvoicePriceId(line: object): string | undefined {');
  expect(diff).not.toContain('stripeSubscriptionPeriod');
  expect(report.patch).toMatchObject({
    warnings: expect.arrayContaining([expect.stringContaining('pricing.price_details.price')]),
  });
});

it('reads a webhook line item price ID through the helper for either version', async () => {
  const report = await run(`export function priceOf(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice;
    return invoice.lines.data[0].price?.id;
  }
}`);
  expect(report.findings).toMatchObject([
    { confidence: 'confirmed', webhook: { migration: { rule: 'stripe-invoice-price-id-helper' } } },
  ]);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const { getInvoicePriceId } = new Function(
    'module',
    `${subscriptionPeriodHelperModule('cjs', [INVOICE_PRICE_ID_HELPER])}; return module.exports;`,
  )({});
  expect(getInvoicePriceId({ price: { id: 'price_old' } })).toBe('price_old');
  expect(getInvoicePriceId({ price: null })).toBeUndefined();
  const pricing = (price: unknown, type = 'price_details') => ({
    pricing: { type, price_details: { price, product: 'prod_1' } },
  });
  expect(getInvoicePriceId(pricing('price_new'))).toBe('price_new');
  expect(getInvoicePriceId(pricing({ id: 'price_expanded' }))).toBe('price_expanded');
  expect(getInvoicePriceId(pricing('price_new', 'other'))).toBeUndefined();
  expect(getInvoicePriceId({ pricing: null })).toBeUndefined();
});

it('does not move line item prices when the target contract lacks pricing details', async () => {
  const report = await run(priceReads, false);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0 });
});

const shippingReads = `export async function shipping(id: string) {
  const session = await stripe.checkout.sessions.retrieve(id);
  return [session.shipping_details, session.shipping_details?.address, session.shipping_details?.carrier];
}`;

it('reads Checkout Session shipping details through the generated helper', async () => {
  const report = await run(shippingReads);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 1 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain(
    '+  return [(getCheckoutShippingDetails(session)), (getCheckoutShippingDetails(session))?.address, session.shipping_details?.carrier];',
  );
  expect(diff).toContain('+function getCheckoutShippingDetails<T extends object>(session: T)');
  expect(diff).not.toContain('stripeSubscriptionPeriod');
  expect(report.patch).toMatchObject({
    warnings: expect.arrayContaining([
      expect.stringContaining('collected_information.shipping_details'),
    ]),
  });
  const { getCheckoutShippingDetails } = new Function(
    'module',
    `${subscriptionPeriodHelperModule('cjs', [CHECKOUT_SHIPPING_HELPER])}; return module.exports;`,
  )({});
  const address = { address: { city: 'Toronto' }, name: 'Ada' };
  expect(getCheckoutShippingDetails({ shipping_details: address })).toBe(address);
  expect(getCheckoutShippingDetails({ shipping_details: null })).toBeNull();
  expect(getCheckoutShippingDetails({ collected_information: { shipping_details: address } })).toBe(
    address,
  );
  expect(getCheckoutShippingDetails({ collected_information: null })).toBeNull();
});

it('does not move Checkout Session shipping details when the target contract lacks the new location', async () => {
  const report = await run(shippingReads, false);
  expect(report.patch).toMatchObject({ status: 'unsupported', edits: 0 });
});

// Minimal stripe-node types for a strict compile: the old Checkout Session field, or (after the
// upgrade) only its new location.
const stripeTypes = (session: string) => `declare namespace Stripe {
  interface Address { line1: string | null; city: string | null }
  namespace Checkout {
    interface Session { id: string; ${session} }
  }
  interface Event { type: string; data: { object: object } }
}
declare class Stripe {
  constructor(key: string, options: { apiVersion: string });
  webhooks: { constructEvent(body: string, signature: string, secret: string): Stripe.Event };
}
export default Stripe;
`;
const OLD_SESSION = 'shipping_details: { address?: Address; name?: string | null } | null;';
const NEW_SESSION =
  'collected_information: { shipping_details: { address: Address; name: string } | null } | null;';
const compiled = (patched: string, session: string) =>
  strictDiagnostics(
    new Map([
      ['/check/billing.ts', patched],
      ['/check/stripeSubscriptionPeriod.ts', subscriptionPeriodHelperModule('ts', HELPER_NAMES)],
      ['/check/stripe.d.ts', stripeTypes(session)],
    ]),
  );
// The patched billing.ts alone (analyze() applies the helper module's edit too).
const billingOf = (body: string) => {
  const result = analyze(body);
  return {
    result,
    billing: applySourceEdits(
      header + body,
      result.edits.filter((edit) => edit.file === 'billing.ts'),
    ),
  };
};

// Mangu-Commerce/madcaptees api/stripe/webhook.ts (and app/api/webhook/route.ts): the address is
// narrowed by `session.shipping_details?.address`, so a helper call per read did not compile.
it('reads narrowed Checkout shipping details through one local that compiles strictly', () => {
  const { result, billing } = billingOf(`export async function record(
  body: string,
  signature: string,
  orders: { insert(row: object): Promise<unknown> },
) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    await orders.insert({
      stripe_session_id: session.id,
      shipping_address: session.shipping_details?.address
        ? {
            name: session.shipping_details.name ?? '',
            line1: session.shipping_details.address.line1 ?? '',
            city: session.shipping_details.address.city ?? '',
          }
        : null,
    });
  }
}`);
  expect(result.findings).toHaveLength(4);
  expect(
    result.findings.every(
      (finding) =>
        finding.confidence === 'confirmed' &&
        finding.webhook?.migration?.rule === 'stripe-checkout-shipping-details-helper',
    ),
  ).toBe(true);
  expect(billing).toContain(`    const sessionShippingDetails = getCheckoutShippingDetails(session);
    await orders.insert({
      stripe_session_id: session.id,
      shipping_address: sessionShippingDetails?.address
        ? {
            name: sessionShippingDetails.name ?? '',
            line1: sessionShippingDetails.address.line1 ?? '',
            city: sessionShippingDetails.address.city ?? '',`);
  expect(billing.match(/getCheckoutShippingDetails\(session\)/g)).toHaveLength(1);
  // The local compiles against the old and the new stripe-node types; one call per read did not.
  expect(compiled(billing, OLD_SESSION)).toEqual([]);
  expect(compiled(billing, NEW_SESSION)).toEqual([]);
  const perRead = billing
    .replace('    const sessionShippingDetails = getCheckoutShippingDetails(session);\n', '')
    .replaceAll('sessionShippingDetails', '(getCheckoutShippingDetails(session))');
  expect(compiled(perRead, OLD_SESSION)).toContain("Object is possibly 'null'.");
});

// Bizgojo/drivetimetales app/api/webhook/route.ts and eka0789/evofuture
// app/api/webhooks/stripe/route.ts: a truthiness guard narrows invoice.subscription for the next read.
it('reads a truthiness-narrowed invoice.subscription through one local', () => {
  const { result, billing } =
    billingOf(`export async function paid(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      if (!invoice.subscription) break;
      return stripe.subscriptions.retrieve(invoice.subscription as string);
    }
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.subscription) {
        return stripe.subscriptions.retrieve(
          invoice.subscription as string
        );
      }
    }
  }
}`);
  expect(
    result.findings.every(
      (finding) => finding.webhook?.migration?.rule === 'stripe-invoice-subscription-helper',
    ),
  ).toBe(true);
  expect(billing).toContain(`      const invoiceSubscription = getInvoiceSubscription(invoice);
      if (!invoiceSubscription) break;
      return stripe.subscriptions.retrieve(invoiceSubscription as string);`);
  expect(billing).toContain(`      const invoiceSubscription = getInvoiceSubscription(invoice);
      if (invoiceSubscription) {
        return stripe.subscriptions.retrieve(
          invoiceSubscription as string`);
  expect(billing.match(/getInvoiceSubscription\(invoice\)/g)).toHaveLength(2);
});

// ABHINAVJINDAL26/VANTAGE-Golf-Charity-Platform src/app/api/stripe/webhook/route.ts: one payload
// variable for every event; the local goes in the invoice branch, before its guard.
it('declares the local in the block whose test narrows the reads', () => {
  const { billing } = billingOf(`export async function paid(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  const session = event.data.object as any;
  if (event.type === 'checkout.session.completed') {
    if (!session.subscription) return null;
    return session.subscription as string;
  }
  if (event.type === 'invoice.payment_succeeded') {
    if (!session.subscription) {
      return null;
    }
    return stripe.subscriptions.retrieve(session.subscription as string);
  }
}`);
  expect(billing).toContain(`    if (!session.subscription) return null;
    return session.subscription as string;`);
  expect(billing).toContain(`  if (event.type === 'invoice.payment_succeeded') {
    const sessionSubscription = getInvoiceSubscription(session);
    if (!sessionSubscription) {
      return null;
    }
    return stripe.subscriptions.retrieve(sessionSubscription as string);`);
});

// guillermolg00/nextjs-stripe-store src/lib/orders.ts already narrows its own local.
it('keeps one helper call for a single shipping-details read', () => {
  const { billing } = billingOf(`export function order(session: Stripe.Checkout.Session) {
  const shippingDetails = session.shipping_details;
  return shippingDetails?.address
    ? { name: shippingDetails.name ?? '', line1: shippingDetails.address.line1 ?? '' }
    : null;
}`);
  expect(billing).toContain('  const shippingDetails = (getCheckoutShippingDetails(session));\n');
  expect(billing).not.toContain('sessionShippingDetails');
  expect(compiled(billing, OLD_SESSION)).toEqual([]);
});

it.each([
  // abressiddique/AbresStore-Admin app/api/webhooks/route.ts: optional receiver, no test.
  [
    'an optional receiver',
    `export function address(session?: Stripe.Checkout.Session) {
  return { street: session?.shipping_details?.address?.line1, city: session?.shipping_details?.address?.city };
}`,
    2,
  ],
  [
    'a receiver passed to a call between the reads',
    `export async function name(session: Stripe.Checkout.Session, save: (value: object) => Promise<void>) {
  if (session.shipping_details) {
    await save(session);
    return session.shipping_details.name;
  }
}`,
    2,
  ],
  [
    'a let receiver',
    `export function name(input: Stripe.Checkout.Session) {
  let session: Stripe.Checkout.Session = input;
  if (session.shipping_details) return session.shipping_details.name;
}`,
    2,
  ],
  [
    'a dropped field read in the block',
    `export function contact(session: Stripe.Checkout.Session) {
  if (session.shipping_details) return [session.shipping_details.name, session.shipping_details.carrier];
}`,
    2,
  ],
  [
    'an arrow function without a block',
    `export const name = (session: Stripe.Checkout.Session) =>
  session.shipping_details ? session.shipping_details.name : null;`,
    2,
  ],
])('calls the helper per read for %s', (_shape, body, calls) => {
  const { billing } = billingOf(body);
  expect(billing).not.toContain('sessionShippingDetails');
  expect(billing.match(/getCheckoutShippingDetails\(session\)/g)).toHaveLength(calls);
});

// ABHINAVJINDAL26/VANTAGE-Golf-Charity-Platform src/app/api/stripe/webhook/route.ts at fde5a23:
// the period is read through `as any`, the read P2's only correct AI fix made by hand.
it('reads a period through an `as any` cast receiver and keeps the read typed any', async () => {
  const report = await run(`export async function paid(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return {
    status: subscription.status,
    current_period_end: new Date((subscription as any).current_period_end * 1000).toISOString(),
  };
}`);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain(
    '+    current_period_end: new Date((getSubscriptionPeriodEnd(subscription as any) as any) * 1000).toISOString(),',
  );
});

// cyberdreadx/cyberpunk-grok-api api/webhook.ts at b1dc85c: a narrowed webhook subscription read
// through `as any` in a conditional, and through optional chaining.
it('reads webhook periods through cast receivers for either payload version', async () => {
  const report = await run(`export function ends(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object as Stripe.Subscription;
    const cancelAt = subscription.cancel_at
      ? new Date(subscription.cancel_at * 1000).toISOString()
      : (subscription as any).current_period_end
        ? new Date((subscription as any).current_period_end * 1000).toISOString()
        : null;
    return { cancelAt, start: (subscription as Stripe.Subscription)?.current_period_start };
  }
}`);
  const reads = report.findings.filter((finding) => finding.webhook);
  expect(reads).toHaveLength(3);
  expect(
    reads.every(
      (finding) => finding.webhook?.migration?.rule === 'stripe-subscription-periods-helper',
    ),
  ).toBe(true);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('+      : (getSubscriptionPeriodEnd(subscription as any) as any)');
  expect(diff).toContain(
    '+        ? new Date((getSubscriptionPeriodEnd(subscription as any) as any) * 1000).toISOString()',
  );
  expect(diff).toContain(
    '+    return { cancelAt, start: ((subscription as Stripe.Subscription) == null ? undefined : getSubscriptionPeriodStart(subscription as Stripe.Subscription)) };',
  );
});

it('passes a typed cast receiver to the invoice helper without widening it to any', async () => {
  const report = await run(`export async function owner(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  return (invoice as Stripe.Invoice).subscription;
}`);
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  expect(diff).toContain('+  return (getInvoiceSubscription(invoice as Stripe.Invoice));');
});

// Only one parenthesized cast of a plain receiver moves. The double cast is the shape of
// carlonicora/nestjs-neo4jsonapi's stripe-webhook.processor.ts:434.
it.each([
  [
    'a double cast',
    `export async function owner(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  return (invoice as unknown as { subscription: string }).subscription;
}`,
    'getInvoiceSubscription(',
  ],
  [
    'a non-null assertion after a cast',
    `export async function ends(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id);
  return (subscription as any)!.current_period_end;
}`,
    'getSubscriptionPeriodEnd(',
  ],
  [
    'a cast call receiver',
    `export async function ends(id: string) {
  return ((await stripe.subscriptions.retrieve(id)) as any).current_period_end;
}`,
    'getSubscriptionPeriodEnd(',
  ],
  [
    'a typeof-guarded cast read',
    `export async function owner(id: string) {
  const invoice = await stripe.invoices.retrieve(id);
  return typeof (invoice as any).subscription === 'string' ? (invoice as any).subscription : null;
}`,
    'getInvoiceSubscription(',
  ],
])('leaves %s to review', async (_shape, body, helper) => {
  const report = await run(body);
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  expect(added.filter((line) => line.includes(helper))).toEqual([]);
  expect(report.patch).not.toMatchObject({ status: 'proposed', unresolvedFindings: 0 });
});

it('keeps an `as any` receiver typed any under the generic helpers', () => {
  const files = new Map([
    ['/check/helper.ts', subscriptionPeriodHelperModule('ts', HELPER_NAMES)],
    [
      '/check/use.ts',
      `import { getInvoiceSubscription, getCheckoutShippingDetails, getSubscriptionPeriodEnd } from './helper';
declare const invoice: { id: string };
export const owner: string = (getInvoiceSubscription(invoice as any) as any).id;
export const name: string = (getCheckoutShippingDetails(invoice as any) as any).name;
export const ends: string = new Date((getSubscriptionPeriodEnd(invoice as any) as any) * 1000).toISOString();
`,
    ],
  ]);
  expect(strictDiagnostics(files)).toEqual([]);
});

// Chivo1530/CHIVITO-AI-DEV app/api/stripe/webhook/route.js: each event's payload goes straight to
// a private handler function.
const HANDLERS = `export async function POST(body, signature) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionChange(event.data.object);
      break;
    case 'invoice.payment_succeeded':
      await handlePaymentSuccess(event.data.object);
      break;
  }
}

async function handleSubscriptionChange(subscription) {
  return new Date(subscription.current_period_end * 1000);
}

async function handlePaymentSuccess(invoice) {
  const subscriptionId = invoice.subscription;
  return subscriptionId;
}
`;

it('reads payloads passed to private handler functions through the helpers', () => {
  const result = analyze(HANDLERS, 'route.js');
  expect(result.findings).toMatchObject([
    {
      confidence: 'confirmed',
      webhook: {
        migration: { rule: 'stripe-subscription-periods-helper' },
        schema: 'subscription',
        eventTypes: ['customer.subscription.created', 'customer.subscription.updated'],
      },
    },
    {
      confidence: 'confirmed',
      webhook: {
        migration: { rule: 'stripe-invoice-subscription-helper' },
        schema: 'invoice',
        eventTypes: ['invoice.payment_succeeded'],
      },
    },
  ]);
  expect(result.patched).toContain(
    '  return new Date((getSubscriptionPeriodEnd(subscription)) * 1000);',
  );
  expect(result.patched).toContain('  const subscriptionId = (getInvoiceSubscription(invoice));');
});

// createdbymax/Loopletter-Open-source-email-marketing-platform app/api/webhooks/stripe/route.ts:
// the payload is cast to the application's own type, kept in a const and passed on.
it('reads a typeof-narrowed handler parameter through one local', () => {
  const result =
    analyze(`type StripeInvoice = { id: string; subscription?: string | { id: string } | null };

export async function POST(body: string, signature: string) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object as StripeInvoice;
      await handleInvoicePaid(invoice);
      break;
    }
  }
}

async function handleInvoicePaid(invoice: StripeInvoice) {
  let subscriptionId: string | null = null;
  if (typeof invoice.subscription === 'string') {
    subscriptionId = invoice.subscription;
  }
  return subscriptionId;
}`);
  expect(
    result.findings.every(
      (finding) =>
        finding.confidence === 'confirmed' &&
        finding.webhook?.migration?.rule === 'stripe-invoice-subscription-helper',
    ),
  ).toBe(true);
  expect(result.patched).toContain(`  const invoiceSubscription = getInvoiceSubscription(invoice);
  if (typeof invoiceSubscription === 'string') {
    subscriptionId = invoiceSubscription;`);
});

it.each([
  [
    // nishantharkut/Uproot.AI src/app/api/stripe/webhook/route.js: the same handler also takes an
    // SDK response.
    'another call passes an SDK response',
    `async function handlePaymentSuccess(invoice) {
  return invoice.subscription;
}
export async function retry(id) {
  return handlePaymentSuccess(await stripe.invoices.retrieve(id));
}`,
  ],
  [
    'the handler is exported',
    'export async function handlePaymentSuccess(invoice) {\n  return invoice.subscription;\n}',
  ],
  [
    'the handler is passed as a value',
    `async function handlePaymentSuccess(invoice) {
  return invoice.subscription;
}
export const handlers = [handlePaymentSuccess];`,
  ],
  [
    'the handler writes the parameter',
    `async function handlePaymentSuccess(invoice) {
  invoice.subscription = invoice.subscription || null;
  return invoice.subscription;
}`,
  ],
  [
    'a call is outside an event-type branch',
    `async function handlePaymentSuccess(invoice) {
  return invoice.subscription;
}
export function any(body, signature) {
  return handlePaymentSuccess(stripe.webhooks.constructEvent(body, signature, 'whsec').data.object);
}`,
  ],
  [
    'two calls pass different schemas',
    `async function handlePaymentSuccess(invoice) {
  return invoice.subscription;
}
export function both(body, signature) {
  const event = stripe.webhooks.constructEvent(body, signature, 'whsec');
  if (event.type === 'checkout.session.completed') return handlePaymentSuccess(event.data.object);
}`,
  ],
])('leaves a handler parameter to review when %s', (_shape, extra) => {
  const result = analyze(
    HANDLERS.replace(/\nasync function handlePaymentSuccess\(invoice\) \{[^}]*\}\n/, '\n') + extra,
    'route.js',
  );
  const reads = result.findings.filter((finding) => finding.expression === '.subscription');
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((finding) => finding.confidence === 'review' && !finding.webhook)).toBe(true);
  expect(result.patched).not.toContain('getInvoiceSubscription(');
});
