import { expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { annotateReach, responsePropertyOwner } from './operation-reach.ts';
import { validateProviderOperationMappings } from './provider-operations.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
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
      subscription: { type: 'object', properties: { status: { type: 'string' } } },
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
    {
      resource: 'subscriptions',
      method: 'update',
      schema: 'subscription',
      operationId: 'PostSubscriptionsSubscriptionExposedId',
    },
  ],
};
const CLIENT = "import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.KEY!);\n";

function reach(
  source: string,
  changes: Record<string, unknown>[],
  untraced: string[] = [],
  edited: (file: string, offset: number) => boolean = () => false,
  removals: Removal[] = [],
) {
  const repository: Repository = {
    root: '/application',
    files: [{ path: 'app/api/checkout/route.ts', content: `${CLIENT}${source}` }],
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
  const schemas = before.components.schemas;
  const analysis = analyzeRepository(repository, [], provider, schemas);
  annotateReach(changes, {
    repository,
    before,
    calls: analysis.calls,
    mappings: validateProviderOperationMappings(provider, before),
    untracedCalls: () => untraced,
    readFindings: (removals) => analyzeRepository(repository, removals, provider, schemas).findings,
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
  ).toEqual({ schema: 'item', property: 'description' });
  expect(
    owner(
      "the `custom_text/submit/anyOf[subschema #1: PaymentPagesCheckoutSessionCustomTextPosition]/message` response property's maxLength was increased from `500` to `1200` for the response status `200`",
    ),
  ).toEqual({ schema: 'payment_pages_checkout_session_custom_text_position', property: 'message' });
  // A nullable field whose path names no anyOf member reads its only object member.
  expect(
    owner(
      'removed the required property `total_details/amount_discount` from the response with the `200` status',
    ),
  ).toEqual({
    schema: 'payment_pages_checkout_session_total_details',
    property: 'amount_discount',
  });
  expect(
    owner(
      'the response property `error/payment_intent/amount` became optional for the status `default`',
    ),
  ).toEqual({ schema: 'payment_intent', property: 'amount' });
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
    ['unused', 'No code reads `payment_intent.amount`.'],
  ]);
  const reads = `${AI_COMPANION}\nexport const total = (order) => order.amount;`;
  expect(reach(reads, [optional('error/payment_intent/amount')])[0]).toEqual([
    'unknown',
    'app/api/checkout/route.ts:12 reads `amount` on an object Refit cannot trace.',
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
  const source = `${AI_COMPANION}\nexport const discount = (totals) => totals.amount_discount;`;
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
