import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import {
  annotateReach,
  CURRENCY_CODE_RULE,
  currencyCodeEdits,
  enumValueEdits,
  REQUEST_OPTIONS_RULE,
  requestOptionEdits,
  responsePropertyOwner,
} from './operation-reach.ts';
import { applySourceEdits } from './patches.ts';
import { validateProviderOperationMappings } from './provider-operations.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { FORMAT_ANNOTATION } from './schema-equivalence.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import type { Removal, Repository } from './types.ts';

// The shape of Stripe's spec3.json for the operations and objects below (stripe/openapi v2026
// tags): Checkout Session creation, its line items, and the error body every operation returns.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const before = {
  openapi: '3.0.0',
  paths: {
    '/v1/checkout/sessions': {
      post: {
        operationId: 'PostCheckoutSessions',
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: { type: 'object', properties: { payment_method_types: {}, ui_mode: {} } },
            },
          },
        },
        responses: {
          '200': { content: { 'application/json': { schema: ref('checkout.session') } } },
          default: { content: { 'application/json': { schema: ref('error') } } },
        },
      },
    },
    '/v1/products': {
      post: {
        operationId: 'PostProducts',
        responses: { '200': { content: { 'application/json': { schema: ref('product') } } } },
      },
    },
    '/v1/prices': {
      get: {
        operationId: 'GetPrices',
        responses: { '200': { content: { 'application/json': { schema: ref('price_list') } } } },
      },
    },
    '/v1/invoices/upcoming': {
      get: {
        operationId: 'GetInvoicesUpcoming',
        responses: { '200': { content: { 'application/json': { schema: ref('product') } } } },
      },
    },
    '/v1/subscriptions/{subscription_exposed_id}': {
      post: {
        operationId: 'PostSubscriptionsSubscriptionExposedId',
        responses: {
          '200': { content: { 'application/json': { schema: ref('subscription') } } },
        },
      },
    },
  },
  components: {
    schemas: {
      'checkout.session': {
        type: 'object',
        properties: {
          id: { type: 'string' },
          url: { type: 'string', nullable: true },
          line_items: {
            type: 'object',
            properties: { data: { type: 'array', items: ref('item') } },
          },
          custom_text: ref('payment_pages_checkout_session_custom_text'),
          total_details: {
            anyOf: [ref('payment_pages_checkout_session_total_details')],
            nullable: true,
          },
        },
      },
      item: { type: 'object', properties: { description: { type: 'string' } } },
      payment_pages_checkout_session_custom_text: {
        type: 'object',
        properties: {
          submit: {
            anyOf: [ref('payment_pages_checkout_session_custom_text_position')],
            nullable: true,
          },
        },
      },
      payment_pages_checkout_session_custom_text_position: {
        type: 'object',
        properties: { message: { type: 'string', maxLength: 500 } },
      },
      payment_pages_checkout_session_total_details: {
        type: 'object',
        properties: { amount_discount: { type: 'integer' } },
      },
      product: { type: 'object', properties: { id: { type: 'string' } } },
      price_list: { type: 'object', properties: { data: { type: 'array' } } },
      subscription: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          items: {
            type: 'object',
            properties: { data: { type: 'array', items: ref('subscription_item') } },
          },
        },
      },
      subscription_item: { type: 'object', properties: { price: { type: 'string' } } },
      error: { type: 'object', properties: { error: ref('api_errors') } },
      api_errors: {
        type: 'object',
        properties: { message: { type: 'string' }, payment_intent: ref('payment_intent') },
      },
      payment_intent: { type: 'object', properties: { amount: { type: 'integer' } } },
    },
  },
};
const provider: ProviderAdapter = {
  ...STRIPE,
  id: 'stripe-full',
  operations: [
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'PostCheckoutSessions',
    },
    { resource: 'products', method: 'create', schema: 'product', operationId: 'PostProducts' },
    { resource: 'prices', method: 'list', schema: 'price_list', operationId: 'GetPrices' },
    {
      resource: 'invoices',
      method: 'retrieveUpcoming',
      schema: 'product',
      operationId: 'GetInvoicesUpcoming',
    },
    {
      resource: 'subscriptions',
      method: 'update',
      schema: 'subscription',
      operationId: 'PostSubscriptionsSubscriptionExposedId',
    },
  ],
};
const CLIENT = "import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.KEY!);\n";

function traced(source: string, path = 'app/api/checkout/route.ts') {
  const repository: Repository = {
    root: '/application',
    files: [{ path, content: `${CLIENT}${source}` }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const schemas = before.components.schemas;
  return {
    repository,
    before,
    calls: analyzeRepository(repository, [], provider, schemas).calls,
    mappings: validateProviderOperationMappings(provider, before),
    readFindings: (removals: Removal[]) =>
      analyzeRepository(repository, removals, provider, schemas).findings,
  };
}

function reach(
  source: string,
  changes: Record<string, unknown>[],
  untraced: string[] = [],
  edited: (file: string, offset: number) => boolean = () => false,
  removals: Removal[] = [],
) {
  annotateReach(changes, {
    ...traced(source),
    untracedCalls: () => untraced,
    edited,
    removals,
  });
  return changes.map((change) => [change.reach, change.reachReason]);
}

const checkout = (text: string, id = 'request-property-removed') => ({
  id,
  level: 3,
  operation: 'POST',
  path: '/v1/checkout/sessions',
  text,
});

// Akash4510/ai-companion app/api/stripe/route.ts, shortened.
const AI_COMPANION = `export async function GET() {
  const stripeSession = await stripe.checkout.sessions.create({
    success_url: settingsUrl,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price_data: { currency: 'INR', unit_amount: 500 * 100 }, quantity: 1 }],
  });
  return new Response(JSON.stringify({ url: stripeSession.url }));
}`;

it('blocks a removed request property only where a traced call sends it', () => {
  expect(
    reach(AI_COMPANION, [checkout('removed the request property `payment_method_types`')]),
  ).toEqual([
    [
      'reached',
      'The `checkout.sessions.create` call in app/api/checkout/route.ts sends `payment_method_types`.',
    ],
  ]);
  expect(
    reach(AI_COMPANION, [
      checkout('removed the request property `line_items/items/dynamic_tax_rates`'),
    ]),
  ).toEqual([
    [
      'unused',
      'No traced `checkout.sessions.create` call sends `line_items/items/dynamic_tax_rates`.',
    ],
  ]);
});

it('passes a removed request property a kept rule edit rewrites at every traced call', () => {
  const removed = checkout('removed the request property `payment_method_types`');
  const source = `${CLIENT}${AI_COMPANION}`;
  const name = source.indexOf('payment_method_types');
  // The card rule's edit replaces the property name (analyzer.ts).
  const cardEdit = (file: string, offset: number) =>
    file === 'app/api/checkout/route.ts' && offset >= name && offset < name + 20;
  expect(reach(AI_COMPANION, [{ ...removed }], [], cardEdit)).toEqual([
    [
      'handled',
      'A kept rule edit rewrites `payment_method_types` in every traced `checkout.sessions.create` call that sends it, first in app/api/checkout/route.ts.',
    ],
  ]);
  // A second call the edit does not cover still reaches it.
  const second = `${AI_COMPANION}\nexport const again = () => stripe.checkout.sessions.create({ payment_method_types: ['card', 'link'] });`;
  expect(reach(second, [{ ...removed }], [], cardEdit)[0][0]).toBe('reached');
});

// efegorkemumit/udemy-clone-nextjs14 app/api/courses/[courseId]/checkout/route.ts, shortened: the
// line items are a local constant the call names once.
it('reads a request body through a local constant used once, and stops when it is reused', () => {
  const udemy = `export async function POST() {
  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    { quantity: 1, price_data: { currency: 'TRY', product_data: { name: course.title } } },
  ];
  const session = await stripe.checkout.sessions.create({ customer, line_items, mode: 'payment' });
  return session.url;
}`;
  const dynamic = checkout('removed the request property `line_items/items/dynamic_tax_rates`');
  expect(reach(udemy, [{ ...dynamic }])[0][0]).toBe('unused');
  expect(
    reach(udemy.replace("mode: 'payment' });", "mode: 'payment' });\n  line_items.push(extra);"), [
      { ...dynamic },
    ]),
  ).toEqual([
    [
      'unknown',
      'The `checkout.sessions.create` call in app/api/checkout/route.ts builds its request where Refit cannot read whether it sends `line_items/items/dynamic_tax_rates`.',
    ],
  ]);
  expect(
    reach('export const go = (params) => stripe.checkout.sessions.create({ ...params });', [
      checkout('removed the request property `payment_method_types`'),
    ])[0][0],
  ).toBe('unknown');
});

// Addisu87/digital-marketplace trpc/payment-router.ts, shortened: line items pushed one by one.
it('reads items pushed into a request list, and stops when the list escapes', () => {
  const marketplace = `export async function POST() {
  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  filteredProducts.forEach((product) => {
    line_items.push({ price: product.priceId!, quantity: 1 });
  });
  line_items.push({ price: 'price_fee', quantity: 1, adjustable_quantity: { enabled: false } });
  const session = await stripe.checkout.sessions.create({ mode: 'payment', line_items });
  return session.url;
}`;
  const dynamic = checkout('removed the request property `line_items/items/dynamic_tax_rates`');
  expect(reach(marketplace, [{ ...dynamic }])[0][0]).toBe('unused');
  expect(
    reach(
      marketplace.replace(
        'quantity: 1 });\n  });',
        'quantity: 1, dynamic_tax_rates: [rate] });\n  });',
      ),
      [{ ...dynamic }],
    )[0][0],
  ).toBe('reached');
  // A helper that is handed the list may add anything to it.
  expect(
    reach(marketplace.replace('  const session', '  addTaxes(line_items);\n  const session'), [
      { ...dynamic },
    ])[0][0],
  ).toBe('unknown');
});

// AlefeSk8/Spotify-Clone-Next.js libs/supabaseAdmin.ts, on Checkout: a typed request object that
// gains a property under a condition.
it('reads properties assigned to a request object, and stops on a computed key', () => {
  const spotify = `export const createOrRetrieve = async ({ email, uuid }: { email: string; uuid: string }) => {
  const sessionData: { metadata: { supabaseUUID: string }; customer_email?: string } = {
    metadata: { supabaseUUID: uuid },
  };
  if (email) sessionData.customer_email = email;
  console.log('creating', sessionData);
  const session = await stripe.checkout.sessions.create(sessionData);
  return session.id;
};`;
  const removed = checkout('removed the request property `payment_method_types`');
  expect(reach(spotify, [{ ...removed }])[0][0]).toBe('unused');
  expect(
    reach(
      spotify.replace('if (email)', "sessionData.payment_method_types = ['card'];\n  if (email)"),
      [{ ...removed }],
    )[0][0],
  ).toBe('reached');
  expect(
    reach(spotify.replace('sessionData.customer_email = email', 'sessionData[field] = email'), [
      { ...removed },
    ])[0][0],
  ).toBe('unknown');
});

it('stops where a request object may change out of sight', () => {
  const removed = checkout('removed the request property `payment_method_types`');
  const go = (lines: string) =>
    `${lines}\nexport async function go() {\n  return stripe.checkout.sessions.create(params);\n}`;
  // Exported: another module may assign to it.
  expect(reach(go("export const params = { mode: 'payment' };"), [{ ...removed }])[0][0]).toBe(
    'unknown',
  );
  // Aliased, returned, or shadowed by a parameter of the same name.
  for (const lines of [
    "const params = { mode: 'payment' };\nconst alias = params;",
    "const params = { mode: 'payment' };\nexport const read = () => params;",
    "const params = { mode: 'payment' };\nexport const other = (params) => params.mode;",
  ])
    expect(reach(go(lines), [{ ...removed }])[0][0]).toBe('unknown');
  expect(reach(go("const params = { mode: 'payment' };"), [{ ...removed }])[0][0]).toBe('unused');
});

// Bizgojo/drivetimetales app/api/checkout/route.ts, on Checkout: optional properties spread in.
it('reads both sides of a conditional spread', () => {
  const spread = (extra: string) => `export async function POST() {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    ...(customerName ? { ${extra} } : {}),
    ...(trial && { subscription_data: { trial_period_days: 7 } }),
  });
  return session.url;
}`;
  const removed = checkout('removed the request property `payment_method_types`');
  expect(reach(spread('customer_email: email'), [{ ...removed }])[0][0]).toBe('unused');
  expect(reach(spread("payment_method_types: ['card']"), [{ ...removed }])[0][0]).toBe('reached');
  expect(
    reach(spread('customer_email: email').replace('(trial &&', '(options ??'), [
      { ...removed },
    ])[0][0],
  ).toBe('unknown');
});

// Amarnath0077/industrialstore-main api/create-checkout-session.js, shortened: line items built by
// a `.map` callback and a local helper.
it('reads line items a map callback or a local function returns', () => {
  const store = `function successUrl(origin) {
  return origin + '/success';
}
export default async function handler(req, res) {
  const lineItems = req.body.items.map((item) => {
    const productData = { name: item.name || 'Product' };
    if (item.img) productData.images = [item.img];
    return {
      price_data: { currency: 'usd', product_data: productData, unit_amount: item.price },
      quantity: Math.max(1, Number(item.quantity) || 1),
    };
  });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: lineItems,
    success_url: successUrl(req.headers.origin),
  });
  res.json({ url: session.url });
}`;
  expect(
    reach(store, [
      checkout('removed the request property `line_items/items/dynamic_tax_rates`'),
      checkout(
        'the `line_items/items/price_data/currency` request property `format` changed from `none` to `currency`',
        'request-property-type-changed',
      ),
    ]).map(([value]) => value),
  ).toEqual(['unused', 'compatible']);
  // A currency the callback reads from its item still blocks.
  expect(
    reach(store.replace("currency: 'usd'", 'currency: item.currency'), [
      checkout(
        'the `line_items/items/price_data/currency` request property `format` changed from `none` to `currency`',
        'request-property-type-changed',
      ),
    ])[0][0],
  ).toBe('reached');
});

// Chivo1530/CHIVITO-AI-DEV lib/stripe.js: Subscription updates have their own `items` property.
it("reads an object's own items property as a property", () => {
  const change = {
    id: 'request-property-type-changed',
    level: 3,
    operation: 'POST',
    path: '/v1/subscriptions/{subscription_exposed_id}',
    text: 'the `items/items/price_data/currency` request property `format` changed from `none` to `currency`',
  };
  const update = (body: string) =>
    `export const cancel = (id) => stripe.subscriptions.update(id, ${body});`;
  expect(reach(update('{ cancel_at_period_end: true }'), [{ ...change }])[0][0]).toBe('unused');
  expect(
    reach(update("{ items: [{ price_data: { currency: 'usd', product: 'prod_1' } }] }"), [
      { ...change },
    ])[0][0],
  ).toBe('compatible');
  expect(
    reach(update("{ items: [{ price_data: { currency: 'USD', product: 'prod_1' } }] }"), [
      { ...change },
    ])[0][0],
  ).toBe('reached');
});

it('blocks a removed enum value only when the call may send that value', () => {
  const removed = checkout(
    'removed the enum value `hosted` of the request property `ui_mode`',
    'request-property-enum-value-removed',
  );
  const call = (value: string) =>
    `export const go = () => stripe.checkout.sessions.create({ mode: 'payment', ui_mode: ${value} });`;
  expect(reach(call("'embedded'"), [{ ...removed }])[0][0]).toBe('unused');
  expect(reach(call("'hosted'"), [{ ...removed }])[0][0]).toBe('reached');
  expect(reach(call('mode'), [{ ...removed }])[0][0]).toBe('unknown');
});

it('blocks a newly required nested property only for calls that send its parent', () => {
  const required = {
    id: 'new-required-request-property',
    level: 3,
    operation: 'POST',
    path: '/v1/subscriptions/{subscription_exposed_id}',
    text: 'added the new required request property `billing_cycle_anchor/type`',
  };
  expect(
    reach(
      'export const go = (id) => stripe.subscriptions.update(id, { cancel_at_period_end: true });',
      [{ ...required }],
    )[0][0],
  ).toBe('unused');
  expect(
    reach(
      'export const go = (id) => stripe.subscriptions.update(id, { billing_cycle_anchor: { month: 1 } });',
      [{ ...required }],
    )[0][0],
  ).toBe('reached');
});

it('treats an operation an untraced call may request as unknown', () => {
  expect(
    reach(
      AI_COMPANION,
      [checkout('removed the request property `line_items/items/dynamic_tax_rates`')],
      ['payments.checkout.sessions.create'],
    ),
  ).toEqual([
    [
      'unknown',
      'The untraced call `payments.checkout.sessions.create` may request `checkout.sessions.create` with `line_items/items/dynamic_tax_rates`.',
    ],
  ]);
});

it('names the Stripe object that owns a changed response property', () => {
  const owner = (text: string, path = '/v1/checkout/sessions') =>
    responsePropertyOwner({ operation: 'POST', path, text }, before);
  expect(
    owner(
      'the response property `line_items/data/items/description` became nullable for the status `200`',
    ),
  ).toEqual({
    schema: 'item',
    property: 'description',
    links: [{ schema: 'checkout.session', property: 'line_items' }],
  });
  // A subscription's own `items` property is a list object, not an array's items.
  expect(
    owner(
      'removed the required property `items/data/items/price` from the response with the `200` status',
      '/v1/subscriptions/{subscription_exposed_id}',
    ),
  ).toMatchObject({ schema: 'subscription_item', property: 'price' });
  expect(
    owner(
      "the `custom_text/submit/anyOf[subschema #1: PaymentPagesCheckoutSessionCustomTextPosition]/message` response property's maxLength was increased from `500` to `1200` for the response status `200`",
    ),
  ).toEqual({
    schema: 'payment_pages_checkout_session_custom_text_position',
    property: 'message',
    links: [
      { schema: 'checkout.session', property: 'custom_text' },
      { schema: 'payment_pages_checkout_session_custom_text', property: 'submit' },
    ],
  });
  // A nullable field whose path names no anyOf member reads its only object member.
  expect(
    owner(
      'removed the required property `total_details/amount_discount` from the response with the `200` status',
    ),
  ).toEqual({
    schema: 'payment_pages_checkout_session_total_details',
    property: 'amount_discount',
    links: [{ schema: 'checkout.session', property: 'total_details' }],
  });
  // stripe-node unwraps the error body's `error` into the thrown error: only `payment_intent` links.
  expect(
    owner(
      'the response property `error/payment_intent/amount` became optional for the status `default`',
    ),
  ).toEqual({
    schema: 'payment_intent',
    property: 'amount',
    links: [{ schema: 'api_errors', property: 'payment_intent' }],
  });
  // `line_items` is an inline list object: nothing names it, so reads cannot be traced against it.
  expect(
    owner('the response property `line_items/data` became optional for the status `200`'),
  ).toBeUndefined();
  expect(
    owner('the response property `missing` became optional for the status `200`'),
  ).toBeUndefined();
});

it('blocks a response change where code reads the property, traced or by the same name', () => {
  const optional = (path: string) => ({
    id: 'response-property-became-optional',
    level: 2,
    operation: 'POST',
    path: '/v1/checkout/sessions',
    text: `the response property \`${path}\` became optional for the status \`default\``,
  });
  expect(reach(AI_COMPANION, [optional('error/payment_intent/amount')])).toEqual([
    [
      'unused',
      'No code reads `api_errors.payment_intent`, the only way to `payment_intent.amount` in this response.',
    ],
  ]);
  // A same-named read elsewhere cannot reach the error's PaymentIntent if nothing reads the link.
  const reads = `${AI_COMPANION}\nexport const total = (order) => order.amount;`;
  expect(reach(reads, [optional('error/payment_intent/amount')])[0]).toEqual([
    'unused',
    'No code reads `api_errors.payment_intent`, the only way to `payment_intent.amount` in this response.',
  ]);
  // A caught error's PaymentIntent is untraced: reading it and an `amount` keeps the change unknown.
  const caught = `${reads}\nexport const failed = (error) => total(error.raw.payment_intent);`;
  expect(reach(caught, [optional('error/payment_intent/amount')])[0]).toEqual([
    'unknown',
    'app/api/checkout/route.ts:12 reads `amount` on an object Refit cannot trace.',
  ]);
  // Checkout line items are read only through `line_items`: sending them in a request does not.
  const description = {
    ...optional('line_items/data/items/description'),
    text: 'the response property `line_items/data/items/description` became nullable for the status `200`',
  };
  const labels = `${AI_COMPANION}\nexport const label = (feature) => feature.description;`;
  expect(reach(labels, [{ ...description }])).toEqual([
    [
      'unused',
      'No code reads `checkout.session.line_items`, the only way to `item.description` in this response.',
    ],
  ]);
  const listed = `${labels}\nexport const items = (session) => session.line_items.data.map(label);`;
  expect(reach(listed, [{ ...description }])[0][0]).toBe('unknown');
  const expanded = `export async function GET() {
  const session = await stripe.checkout.sessions.create({ mode: 'payment', expand: ['line_items'] });
  return session.line_items.data[0].description.trim();
}`;
  expect(reach(expanded, [{ ...description }])[0]).toEqual([
    'reached',
    'app/api/checkout/route.ts:5 reads `item.description`.',
  ]);
  expect(
    reach(AI_COMPANION, [
      {
        id: 'response-property-max-length-increased',
        level: 2,
        operation: 'POST',
        path: '/v1/checkout/sessions',
        text: "the `custom_text/submit/anyOf[subschema #1: X]/message` response property's maxLength was increased from `500` to `1200` for the response status `200`",
      },
    ]),
  ).toEqual([['compatible', 'A response string may now be longer; reading it is unaffected.']]);
});

// Kanba-co/kanba app/api/stripe/webhook/route.ts, shortened: a period read on an untraced object.
it('leaves a response removal Refit already analyzes to that analysis', () => {
  const removed = {
    id: 'response-required-property-removed',
    level: 3,
    operation: 'POST',
    path: '/v1/checkout/sessions',
    text: 'removed the required property `total_details/amount_discount` from the response with the `200` status',
  };
  const source = `${AI_COMPANION}\nexport const discount = (session) => session.total_details.amount_discount;`;
  const covered: Removal = {
    id: 'subscription-period',
    schema: 'payment_pages_checkout_session_total_details',
    property: 'amount_discount',
    pointer:
      '/components/schemas/payment_pages_checkout_session_total_details/properties/amount_discount',
  };
  expect(reach(source, [{ ...removed }], [], () => false, [covered])).toEqual([
    [
      'handled',
      "Refit's removed-field analysis covers `payment_pages_checkout_session_total_details.amount_discount`; its findings decide this removal.",
    ],
  ]);
  expect(reach(source, [{ ...removed }])[0][0]).toBe('unknown');
  // Only removals: the same property becoming nullable is still read for reach.
  expect(
    reach(
      source,
      [
        {
          ...removed,
          id: 'response-property-became-nullable',
          text: 'the response property `total_details/amount_discount` became nullable for the status `200`',
        },
      ],
      [],
      () => false,
      [covered],
    )[0][0],
  ).toBe('unknown');
});

it('keeps blocking changes Refit has no reach rule for', () => {
  expect(
    reach(AI_COMPANION, [
      {
        id: 'response-success-status-removed',
        level: 3,
        operation: 'POST',
        path: '/v1/checkout/sessions',
        text: 'removed the success response with the status `200`',
      },
      checkout('deleted the `query` request parameter `expand`', 'request-parameter-removed'),
    ]),
  ).toEqual([
    ['unknown', 'The changed response property is not a property of a named Stripe object.'],
    [
      'unknown',
      'Refit cannot read the request property in "deleted the `query` request parameter `expand`".',
    ],
  ]);
});

it('reads the changed request property, not the attribute oasdiff names after it', () => {
  const anyOf = checkout(
    'removed `subschema #2` from the `ui_mode` request property `anyOf` list',
    'request-property-any-of-removed',
  );
  const call = `export const go = () => stripe.checkout.sessions.create({ mode: 'payment', ui_mode: 'hosted' });`;
  expect(reach(call, [anyOf])).toEqual([
    [
      'reached',
      'The `checkout.sessions.create` call in app/api/checkout/route.ts sends `ui_mode`.',
    ],
  ]);
});

// The `currency` format is a lowercase three-letter ISO code (https://docs.stripe.com/currencies).
it('passes the new currency format only where every sent currency is a lowercase ISO code', () => {
  const format = () =>
    checkout(
      'the `line_items/items/price_data/currency` request property `format` changed from `none` to `currency`',
      'request-property-type-changed',
    );
  // IncomeStreamSurfer/free-site-example convex/stripe.ts, shortened.
  const freeSite = `export const pay = () => stripe.checkout.sessions.create({
  line_items: [{ price_data: { currency: "usd", product_data: { name: "Unlimited Use Plan" }, unit_amount: 1999 }, quantity: 1 }],
  mode: "payment",
});`;
  // heyitsadityaa/ticketr actions/createStripeCheckoutSession.ts, shortened.
  const ticketr = `export const buy = () => stripe.checkout.sessions.create({
  line_items: [{ price_data: { currency: "gbp", product_data: { name: "Ticket" }, unit_amount: 100 }, quantity: 1 }],
  mode: "payment",
});`;
  for (const source of [freeSite, ticketr])
    expect(reach(source, [format()])[0]).toEqual(['compatible', expect.any(String)]);
  expect(reach(AI_COMPANION, [format()])).toEqual([
    [
      'reached',
      'The `checkout.sessions.create` call in app/api/checkout/route.ts sends `line_items/items/price_data/currency` as `INR`; the target contract gives it the `currency` format, a lowercase three-letter ISO code (https://docs.stripe.com/currencies).',
    ],
  ]);
  const computed = `export const go = (currency: string) => stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{ price_data: { currency, unit_amount: 100 }, quantity: 1 }],
});`;
  expect(reach(computed, [format()])[0][0]).not.toBe('compatible');
});

const currencyFormat = (property: string, path = '/v1/checkout/sessions') => ({
  id: 'request-property-type-changed',
  level: 3,
  operation: 'POST',
  path,
  text: `the \`${property}\` request property \`format\` changed from \`none\` to \`currency\``,
});
const LINE_ITEM_CURRENCY = 'line_items/items/price_data/currency';

// As run.ts does it: the currency rule's edits are kept, and reach reads them.
function lowercased(
  source: string,
  change: Record<string, unknown> = currencyFormat(LINE_ITEM_CURRENCY),
  path?: string,
) {
  const context = traced(source, path);
  const edits = currencyCodeEdits([change], context);
  annotateReach([change], {
    ...context,
    untracedCalls: () => [],
    removals: [],
    edited: (file, offset) =>
      edits.some((edit) => edit.file === file && edit.start <= offset && offset < edit.end),
  });
  const content = context.repository.files[0].content;
  return {
    edits,
    content,
    patched: applySourceEdits(content, edits),
    reach: [change.reach, change.reachReason],
  };
}

// Hombre2014/Genius app/api/stripe/route.ts at 375bbe7, shortened.
const GENIUS = `export async function GET() {
  const stripeSession = await stripe.checkout.sessions.create({
    success_url: settingsUrl,
    mode: 'subscription',
    line_items: [
      {
        price_data: {
          currency: 'USD',
          product_data: { name: 'My AI Tools Pro' },
          unit_amount: 2000,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      },
    ],
  });
  return new NextResponse(JSON.stringify({ url: stripeSession.url }));
}`;
// psykat1116/Planit actions/StripeRedirect/index.ts at 0cbae47, shortened.
const PLANIT = `const handler = async () => {
  const stripeSession = await stripe.checkout.sessions.create({
    success_url: settingsURL,
    mode: "subscription",
    line_items: [
      {
        price_data: {
          currency: "INR",
          product_data: { name: "Planit Pro" },
          unit_amount: 9900,
          recurring: { interval: "month" },
        },
        quantity: 1,
      },
    ],
  });
  return stripeSession.url || "";
};`;
// sudeepmahato16/airbnb-clone services/reservation.ts at fe8a793, shortened; the file uses CRLF.
const AIRBNB = [
  'export const reserve = async (listing, totalPrice) => {',
  '  const product = await stripe.products.create({',
  '    name: "Listing",',
  '    images: [listing.imageSrc],',
  '    default_price_data: {',
  '      currency: "USD",',
  '      unit_amount: totalPrice * 100',
  '    }',
  '  })',
  '  return product.default_price;',
  '}',
].join('\r\n');

// https://docs.stripe.com/currencies: "Make sure to use all lowercase letters when entering the
// three-letter ISO code in any payment request."
it.each([
  [
    'Genius',
    GENIUS,
    currencyFormat(LINE_ITEM_CURRENCY),
    "'USD'",
    "'usd'",
    'checkout.sessions.create',
  ],
  [
    'Planit',
    PLANIT,
    currencyFormat(LINE_ITEM_CURRENCY),
    '"INR"',
    '"inr"',
    'checkout.sessions.create',
  ],
  [
    'airbnb-clone',
    AIRBNB,
    currencyFormat('default_price_data/currency', '/v1/products'),
    '"USD"',
    '"usd"',
    'products.create',
  ],
])(
  'lowercases the uppercase currency literal %s writes in its request, which handles the change',
  (_name, source, change, literal, replacement, operation) => {
    const { edits, content, patched, reach } = lowercased(source, change);
    const start = content.indexOf(literal);
    expect(edits).toEqual([
      {
        file: 'app/api/checkout/route.ts',
        start,
        end: start + literal.length,
        replacement,
        changeId: CURRENCY_CODE_RULE,
        rule: CURRENCY_CODE_RULE,
      },
    ]);
    // Only the literal changes, quote style and line endings included.
    expect(patched).toBe(content.replace(literal, replacement));
    expect(reach).toEqual([
      'handled',
      `A kept rule edit rewrites \`${String(change.text).match(/`([^`]+)`/)![1]}\` in every traced \`${operation}\` call that sends it, first in app/api/checkout/route.ts.`,
    ]);
  },
);

it('leaves a currency constant, a lowercase code and test files unedited', () => {
  // A constant may also be displayed, so it stays for review even though Refit can read it.
  const constant = lowercased(
    GENIUS.replace(
      '  const stripeSession',
      "  const CURRENCY = 'USD';\n  const stripeSession",
    ).replace("currency: 'USD'", 'currency: CURRENCY'),
  );
  expect(constant.edits).toEqual([]);
  expect(constant.reach).toEqual([
    'reached',
    'The `checkout.sessions.create` call in app/api/checkout/route.ts sends `line_items/items/price_data/currency` as `USD`; the target contract gives it the `currency` format, a lowercase three-letter ISO code (https://docs.stripe.com/currencies).',
  ]);
  const lowercase = lowercased(GENIUS.replace("'USD'", "'usd'"));
  expect(lowercase.edits).toEqual([]);
  expect(lowercase.reach[0]).toBe('compatible');
  const test = lowercased(GENIUS, undefined, 'app/api/stripe/route.test.ts');
  expect(test.edits).toEqual([]);
  expect(test.reach[0]).toBe('unused');
  // A literal outside the call's own argument, even in a local constant used once, and a
  // computed code stay reached.
  const outside = lowercased(`export async function POST() {
  const line_items = [{ quantity: 1, price_data: { currency: 'TRY', unit_amount: 100 } }];
  const session = await stripe.checkout.sessions.create({ line_items, mode: 'payment' });
  return session.url;
}`);
  expect(outside.edits).toEqual([]);
  expect(outside.reach[0]).toBe('reached');
  const computed = lowercased(GENIUS.replace("'USD'", '`${region}D`'));
  expect(computed.edits).toEqual([]);
  expect(computed.reach[0]).toBe('reached');
});

// D4: compareOpenApi lists a format-only `currency` change as compatible (schema-equivalence.ts).
it('keeps a format-only currency change compatible unless a traced call visibly sends a code Stripe rejects', () => {
  const equivalent = (change: Record<string, unknown> = currencyFormat(LINE_ITEM_CURRENCY)) => ({
    ...change,
    equivalence: FORMAT_ANNOTATION,
    reach: 'compatible',
    reachReason: 'format',
  });
  // A computed code, an unreadable body and an untraced call no longer stop.
  const computed = `export const go = (currency: string) => stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{ price_data: { currency, unit_amount: 100 }, quantity: 1 }],
});`;
  expect(reach(computed, [equivalent()])).toEqual([['compatible', 'format']]);
  expect(
    reach('export const go = (body: any) => stripe.checkout.sessions.create(body);', [
      equivalent(),
    ]),
  ).toEqual([['compatible', 'format']]);
  expect(reach(computed, [equivalent()], ['stripe.checkout.sessions.create'])).toEqual([
    ['compatible', 'format'],
  ]);
  // An uppercase code Refit can read still stops, and the currency rule still handles a literal
  // written in the call.
  const constant = lowercased(
    GENIUS.replace(
      '  const stripeSession',
      "  const CURRENCY = 'USD';\n  const stripeSession",
    ).replace("currency: 'USD'", 'currency: CURRENCY'),
    equivalent(),
  );
  expect(constant.reach[0]).toBe('reached');
  expect(constant.reach[1]).toContain('as `USD`');
  const literal = lowercased(GENIUS, equivalent());
  expect(literal.edits).toHaveLength(1);
  expect(literal.reach[0]).toBe('handled');
  // So does an uppercase literal in a query parameter, which the rule does not edit.
  const listed = {
    id: 'request-parameter-type-changed',
    level: 3,
    operation: 'GET',
    path: '/v1/prices',
    text: 'for the `query` request parameter `currency`, the `format` was changed from `none` to `currency`',
  };
  expect(
    reach("export const list = () => stripe.prices.list({ currency: 'EUR' });", [
      equivalent(listed),
    ])[0][0],
  ).toBe('reached');
  expect(
    reach("export const list = () => stripe.prices.list({ currency: 'eur' });", [
      equivalent(listed),
    ])[0][0],
  ).toBe('compatible');
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Shaped like Stripe's dahlia and endive Checkout Session create bodies, where endive gives
// `line_items[].price_data.currency` the `currency` format.
const checkoutContract = (version: string, currency: Record<string, unknown>) => ({
  openapi: '3.0.0',
  info: { title: 'Stripe API', version },
  paths: {
    '/v1/checkout/sessions': {
      post: {
        operationId: 'PostCheckoutSessions',
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  mode: { type: 'string' },
                  line_items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        price_data: {
                          type: 'object',
                          properties: { currency, unit_amount: { type: 'integer' } },
                        },
                        quantity: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Session',
            content: { 'application/json': { schema: ref('checkout.session') } },
          },
        },
      },
    },
  },
  components: {
    schemas: { 'checkout.session': { type: 'object', properties: { id: { type: 'string' } } } },
  },
});

it.skipIf(!process.env.REFIT_OASDIFF)(
  'proposes the lowercased currency with the endive pin and says why in the draft',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-currency-codes-'));
    roots.push(root);
    const files = {
      'package.json': JSON.stringify({ dependencies: { stripe: '22.6.2' } }),
      // psykat1116/Planit's call, in JavaScript so no stripe-node upgrade is looked up.
      'redirect.js': `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-08-26.dahlia' });
export const redirect = () => stripe.checkout.sessions.create({ mode: "subscription", line_items: [{ price_data: { currency: "INR", unit_amount: 9900 }, quantity: 1 }] });
`,
      'before.json': JSON.stringify(checkoutContract('2026-08-26.dahlia', { type: 'string' })),
      'after.json': JSON.stringify(
        checkoutContract('2026-09-30.endive', { type: 'string', format: 'currency' }),
      ),
      'provider.json': JSON.stringify({
        id: 'stripe-checkout',
        packageName: 'stripe',
        defaultImport: true,
        namedExport: 'Stripe',
        constructorCalls: true,
        apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
        operations: [
          {
            resource: 'checkout.sessions',
            method: 'create',
            schema: 'checkout.session',
            operationId: 'PostCheckoutSessions',
          },
        ],
      }),
    };
    for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
    const report = await runPipeline({
      repository: root,
      before: join(root, 'before.json'),
      after: join(root, 'after.json'),
      providerConfig: join(root, 'provider.json'),
      apiVersion: '2026-08-26.dahlia',
      fullDiff: true,
      proposePatch: true,
    });
    expect(report.specificationDiff.changes).toContainEqual(
      expect.objectContaining({
        text: 'the `line_items/items/price_data/currency` request property `format` changed from `none` to `currency`',
        reach: 'handled',
      }),
    );
    expect(report.operationImpacts).toEqual([]);
    if (!('diff' in report.patch)) throw new Error('Expected a patch');
    expect(report.patch).toMatchObject({
      status: 'proposed',
      summary: 'Lowercase uppercase currency codes and update the pinned Stripe API version.',
      sources: [{ url: 'https://docs.stripe.com/currencies', files: ['redirect.js'] }],
      warnings: expect.arrayContaining([expect.stringContaining('Uppercase currency codes')]),
    });
    expect(report.patch.diff).toContain(
      '+export const redirect = () => stripe.checkout.sessions.create({ mode: "subscription", line_items: [{ price_data: { currency: "inr", unit_amount: 9900 }, quantity: 1 }] });',
    );
    expect(report.patch.diff).toContain(
      "+const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2026-09-30.endive' });",
    );
    const check = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
    const artifacts = createReviewArtifacts({
      ...report,
      publicationFiles: [{ path: 'redirect.js', mode: '100644', content: 'export {};' }],
      patch: { ...report.patch, validation: 'passed' },
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
        patchHash: digest(report.patch.diff),
        baseline: check,
        patched: check,
        limits: {
          timeoutMs: 120_000,
          outputBytes: 1024 * 1024,
          network: 'none',
          workspace: '512m' as const,
          memory: '1g' as const,
        },
        publishable: true,
        attempts: [],
        repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
        reason: 'Synthetic check results for artifact formatting tests.',
      },
    });
    const body = artifacts.files['pull-request.md'];
    expect(artifacts.manifest.title).toBe('fix(stripe): lowercase currency codes');
    expect(body).toContain(
      'expects lowercase currency codes where this code sends uppercase ones. A deterministic Refit rule migrates 1 confirmed usage in 1 file',
    );
    expect(body).toContain('[docs.stripe.com/currencies](https://docs.stripe.com/currencies)');
    expect(body).toContain(
      '- `redirect.js`: Sends the currency `inr` in lowercase, as the new `currency` format requires. Stripe documents it: [docs.stripe.com/currencies](https://docs.stripe.com/currencies). Moves the pinned API version',
    );
  },
);

it('names the owner of a property called items that is not an array', () => {
  const document = {
    paths: {
      '/v1/subscriptions': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { data: { type: 'array', items: ref('subscription') } },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        subscription: {
          type: 'object',
          properties: {
            items: {
              type: 'object',
              properties: { data: { type: 'array', items: ref('subscription_item') } },
            },
          },
        },
        subscription_item: { type: 'object', properties: { price: ref('price') } },
        price: {
          type: 'object',
          properties: { product: { anyOf: [{ type: 'string' }, ref('product')] } },
        },
        product: { type: 'object', properties: { features: { type: 'array' } } },
      },
    },
  };
  expect(
    responsePropertyOwner(
      {
        operation: 'GET',
        path: '/v1/subscriptions',
        text: 'removed the required property `data/items/items/data/items/price/product/anyOf[subschema #2: Product]/features` from the response with the `200` status',
      },
      document,
    ),
  ).toMatchObject({ schema: 'product', property: 'features' });
});

describe('a removed operation', () => {
  const removed = () => ({
    id: 'api-path-removed-without-deprecation',
    level: 3,
    operation: 'GET',
    path: '/v1/invoices/upcoming',
    text: 'api path removed without deprecation',
  });
  const UPCOMING =
    'export const preview = (customer, subscription) => stripe.invoices.retrieveUpcoming({ customer, subscription });';
  const source = `${CLIENT}${UPCOMING}`;
  const name = source.indexOf('retrieveUpcoming');
  // The createPreview rule replaces the method name (stripe-invoice-preview.ts).
  const previewEdit = (file: string, offset: number) =>
    file === 'app/api/checkout/route.ts' && offset >= name && offset < name + 16;

  it('passes when no traced call requests it', () => {
    expect(reach(AI_COMPANION, [removed()])).toEqual([
      ['unused', 'No traced call requests the removed `invoices.retrieveUpcoming`.'],
    ]);
  });

  it('is reached by a traced call and handled where a kept edit replaces every call', () => {
    expect(reach(UPCOMING, [removed()])).toEqual([
      ['reached', 'app/api/checkout/route.ts:3 calls the removed `invoices.retrieveUpcoming`.'],
    ]);
    expect(reach(UPCOMING, [removed()], [], previewEdit)).toEqual([
      [
        'handled',
        'A kept rule edit replaces every traced `invoices.retrieveUpcoming` call, first in app/api/checkout/route.ts:3.',
      ],
    ]);
    // A second call the edit does not cover still reaches it.
    const second = `${UPCOMING}\nexport const again = () => stripe.invoices.retrieveUpcoming({ customer: 'cus_1' });`;
    expect(reach(second, [removed()], [], previewEdit)[0][0]).toBe('reached');
  });

  it('stays unknown where an untraced call or a raw request may name it', () => {
    expect(reach(AI_COMPANION, [removed()], ['billing.stripe.invoices.retrieveUpcoming'])).toEqual([
      [
        'unknown',
        'The untraced call `billing.stripe.invoices.retrieveUpcoming` may request the removed `invoices.retrieveUpcoming`.',
      ],
    ]);
    const raw = `${AI_COMPANION}\nexport const upcoming = () => fetch('https://api.stripe.com/v1/invoices/upcoming?customer=' + id);`;
    expect(reach(raw, [removed()])).toEqual([
      [
        'unknown',
        'app/api/checkout/route.ts writes the removed path `/v1/invoices/upcoming`, which Refit cannot trace.',
      ],
    ]);
  });
});

describe('a documented enum successor', () => {
  const move = {
    rule: 'stripe-checkout-ui-mode-embedded',
    family: 'request-enum-value' as const,
    operations: ['PostCheckoutSessions'],
    parameter: 'ui_mode',
    value: 'embedded',
    replacement: 'embedded_page',
    source:
      'https://docs.stripe.com/changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes',
    warning: 'Sends embedded_page.',
  };
  const removed = () =>
    checkout(
      'removed the enum value `embedded` of the request property `ui_mode`',
      'request-property-enum-value-removed',
    );
  const run = (source: string, path?: string) => {
    const context = traced(source, path);
    const edits = enumValueEdits([removed()], context, [move]);
    const change: Record<string, unknown> = removed();
    annotateReach([change], {
      ...context,
      untracedCalls: () => [],
      edited: (file, offset) =>
        edits.some((edit) => edit.file === file && edit.start <= offset && offset < edit.end),
      removals: [],
    });
    const file = context.repository.files[0];
    return {
      edits,
      patched: applySourceEdits(file.content, edits),
      reach: [change.reach, change.reachReason],
    };
  };

  it('replaces the literal the call sends and passes the change', () => {
    const embedded = run(
      'export const go = () => stripe.checkout.sessions.create({ mode: "payment", ui_mode: "embedded" });',
    );
    expect(embedded.patched).toContain('ui_mode: "embedded_page"');
    expect(embedded.reach).toEqual([
      'handled',
      'A kept rule edit rewrites `ui_mode` in every traced `checkout.sessions.create` call that sends it, first in app/api/checkout/route.ts.',
    ]);
    // Both sides of a conditional written in the call.
    const conditional = run(
      "export const go = (inline) => stripe.checkout.sessions.create({ ui_mode: inline ? 'embedded' : 'hosted' });",
    );
    expect(conditional.patched).toContain("ui_mode: inline ? 'embedded_page' : 'hosted'");
    expect(conditional.reach[0]).toBe('handled');
  });

  it('leaves constants, other rules and test files for review', () => {
    const constant = run(
      "const MODE = 'embedded';\nexport const go = () => stripe.checkout.sessions.create({ ui_mode: MODE });",
    );
    expect(constant.edits).toEqual([]);
    expect(constant.reach[0]).toBe('reached');
    const computed = run(
      'export const go = (mode) => stripe.checkout.sessions.create({ ui_mode: mode });',
    );
    expect(computed.edits).toEqual([]);
    expect(computed.reach[0]).toBe('unknown');
    // No rule for this value: nothing is edited.
    const other = enumValueEdits(
      [
        checkout(
          'removed the enum value `hosted` of the request property `ui_mode`',
          'request-property-enum-value-removed',
        ),
      ],
      traced("export const go = () => stripe.checkout.sessions.create({ ui_mode: 'hosted' });"),
      [move],
    );
    expect(other).toEqual([]);
    const test = run(
      "export const go = () => stripe.checkout.sessions.create({ ui_mode: 'embedded' });",
      'app/api/checkout/route.test.ts',
    );
    expect(test.edits).toEqual([]);
  });
});

describe('request options passed as params (stripe-node 22)', () => {
  const moved = (source: string, path?: string) => {
    const context = traced(source, path);
    const edits = requestOptionEdits(context);
    return {
      edits,
      patched: applySourceEdits(context.repository.files[0].content, edits).slice(CLIENT.length),
    };
  };

  it('moves an options-only last argument after an explicit undefined', () => {
    const { edits, patched } = moved(`export const go = (id: string, account: string) =>
  stripe.subscriptions.update(id, { stripeAccount: account, idempotencyKey: 'k' });
export const make = (stripeAccount: string) => stripe.checkout.sessions.create({ stripeAccount });`);
    expect(edits.map((edit) => edit.rule)).toEqual([REQUEST_OPTIONS_RULE, REQUEST_OPTIONS_RULE]);
    expect(patched).toBe(`export const go = (id: string, account: string) =>
  stripe.subscriptions.update(id, undefined, { stripeAccount: account, idempotencyKey: 'k' });
export const make = (stripeAccount: string) => stripe.checkout.sessions.create(undefined, { stripeAccount });`);
  });

  it('leaves params, mixed keys, spreads, explicit options and test files alone', () => {
    const source = `export const a = (id: string) => stripe.subscriptions.update(id, { metadata: {} });
export const b = (id: string, account: string) =>
  stripe.subscriptions.update(id, { stripeAccount: account, metadata: {} });
export const c = (id: string, options: object) => stripe.subscriptions.update(id, { ...options });
export const d = (id: string, account: string) =>
  stripe.subscriptions.update(id, {}, { stripeAccount: account });
export const e = () => stripe.checkout.sessions.create({});`;
    expect(moved(source).edits).toEqual([]);
    expect(
      moved(
        `export const t = (s: string) => stripe.checkout.sessions.create({ stripeAccount: s });`,
        'app/checkout.test.ts',
      ).edits,
    ).toEqual([]);
  });
});
