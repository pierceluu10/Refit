import { expect, it } from 'vitest';
import {
  addedItemChoices,
  addedTypeEscapes,
  changedEventTypes,
  droppedRequestPaths,
  newShapeOnlyReads,
} from './ai-patch-policies.ts';
import { STRIPE } from './providers.ts';
import type { Finding, Removal, Repository, SourceEdit } from './types.ts';

// Snippets come from AI diffs in docs/benchmarks/2026-10-21-agent-comparison-results.json that
// validated and were wrong; each test keeps the code the model changed and the change it made.

const CLIENT = `import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-09-30.endive' });
`;

const repository = (path: string, content: string): Repository => ({
  root: '/repository',
  files: [{ path, content }],
  dependencies: [],
  lockfiles: [],
  warnings: [],
});

// The rules' version of a file, the AI's version, and the files the AI changed.
function versions(path: string, before: string, after: string) {
  return [repository(path, before), repository(path, after), new Set([path])] as const;
}

const replaced = (content: string, original: string, replacement: string) => {
  expect(content).toContain(original);
  return content.replace(original, replacement);
};

const SETUP_INTENT = `${CLIENT}export async function POST(customerId: string) {
  // Create a SetupIntent to save a card
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session', // Allow charging when customer is not present
  });
  return setupIntent.client_secret;
}
`;

it('refuses an AI patch that deletes payment_method_types from a SetupIntent', () => {
  // Bizgojo/drivetimetales: the agent removed the parameter instead of leaving it for review.
  const after = replaced(SETUP_INTENT, "    payment_method_types: ['card'],\n", '');
  const dropped = droppedRequestPaths(
    ...versions('app/api/create-setup-intent/route.ts', SETUP_INTENT, after),
    STRIPE,
  );
  // The dropped value `['card']` is inside the dropped key, so only the key is reported.
  expect(dropped).toEqual([
    {
      call: 'setupIntents.create',
      path: 'payment_method_types',
      line: 7,
      file: 'app/api/create-setup-intent/route.ts',
    },
  ]);
});

it('refuses an AI rename of payment_method_types, which only the reviewed card rule may make', () => {
  const after = replaced(
    SETUP_INTENT,
    "payment_method_types: ['card'],",
    "allowed_payment_method_types: ['card'],",
  );
  const dropped = droppedRequestPaths(
    ...versions('app/api/create-setup-intent/route.ts', SETUP_INTENT, after),
    STRIPE,
  );
  expect(dropped.map((entry) => entry.path)).toEqual(['payment_method_types']);
});

it('refuses an AI patch that changes a literal a request sends, but not its quote style', () => {
  const changed = replaced(SETUP_INTENT, "usage: 'off_session',", "usage: 'on_session',");
  expect(
    droppedRequestPaths(
      ...versions('app/api/create-setup-intent/route.ts', SETUP_INTENT, changed),
      STRIPE,
    ),
  ).toEqual([
    {
      call: 'setupIntents.create',
      path: "usage='off_session'",
      line: 8,
      file: 'app/api/create-setup-intent/route.ts',
    },
  ]);
  const requoted = replaced(SETUP_INTENT, "usage: 'off_session',", 'usage: "off_session",');
  expect(
    droppedRequestPaths(
      ...versions('app/api/create-setup-intent/route.ts', SETUP_INTENT, requoted),
      STRIPE,
    ),
  ).toEqual([]);
});

it("does not charge the rules' own card rename to the AI", () => {
  // The rules' version already carries the reviewed rename; the AI only edits another line.
  const rules = replaced(
    SETUP_INTENT,
    "payment_method_types: ['card'],",
    "allowed_payment_method_types: ['card'],",
  );
  const after = replaced(rules, 'return setupIntent.client_secret;', 'return setupIntent.id;');
  expect(
    droppedRequestPaths(...versions('app/api/create-setup-intent/route.ts', rules, after), STRIPE),
  ).toEqual([]);
});

const SESSION_CONFIG = `${CLIENT}export async function createPayment(customerId: string, priceId: string, paymentMethods: string[]) {
  // 创建一次性付款的checkout session
  const sessionConfig: any = {
    customer: customerId,
    payment_method_types: paymentMethods,
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    mode: 'payment',
  };
  const session = await stripe.checkout.sessions.create(sessionConfig);
  return session.url;
}
`;

it('refuses an AI patch that deletes a parameter from a body declared before the call', () => {
  // geallenboy/ai-saas-template: the body is a `const` passed to the call by name.
  const [before, after, files] = versions(
    'src/server/routers/payments.ts',
    SESSION_CONFIG,
    replaced(SESSION_CONFIG, '    payment_method_types: paymentMethods,\n', ''),
  );
  expect(droppedRequestPaths(before, after, files, STRIPE)).toEqual([
    {
      call: 'checkout.sessions.create',
      path: 'payment_method_types',
      line: 7,
      file: 'src/server/routers/payments.ts',
    },
  ]);
  // The `any` on the body was there before the AI edit, so it is not a new type escape.
  expect(addedTypeEscapes(before, after, files)).toEqual([]);
});

const SUBSCRIPTION = `${CLIENT}export async function createSubscription(customerId: string, priceId: string, trialDays: number) {
  return stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    trial_period_days: trialDays,
    payment_behavior: 'default_incomplete',
    expand: ['latest_invoice.payment_intent'],
  })
}
`;

it('refuses an AI patch that replaces an expand path', () => {
  // Sanjdcool/ApanStack-Newsletter: the agent swapped the removed path for a new one.
  const after = replaced(
    SUBSCRIPTION,
    "expand: ['latest_invoice.payment_intent'],",
    "expand: ['latest_invoice.confirmation_secret'],",
  );
  expect(droppedRequestPaths(...versions('lib/stripe.ts', SUBSCRIPTION, after), STRIPE)).toEqual([
    {
      call: 'subscriptions.create',
      path: "expand[]='latest_invoice.payment_intent'",
      line: 9,
      file: 'lib/stripe.ts',
    },
  ]);
});

it('accepts an AI patch that reorders, reformats or adds to what a request sends', () => {
  const after = replaced(
    SUBSCRIPTION,
    `    customer: customerId,
    items: [{ price: priceId }],`,
    `    items: [
      { price: priceId },
    ],
    customer: customerId,
    metadata: { source: 'newsletter' },`,
  );
  expect(droppedRequestPaths(...versions('lib/stripe.ts', SUBSCRIPTION, after), STRIPE)).toEqual(
    [],
  );
});

it('refuses an AI patch that drops a spread or a later argument of a request', () => {
  const before = `${CLIENT}export async function refund(charge: string, extra: object, key: string) {
  return stripe.refunds.create({ charge, ...extra }, { idempotencyKey: key });
}
`;
  const after = replaced(before, '{ charge, ...extra }, { idempotencyKey: key }', '{ charge }');
  expect(
    droppedRequestPaths(...versions('refund.ts', before, after), STRIPE).map((entry) => entry.path),
  ).toEqual(['...extra', 'argument 2']);
});

const COUPON = `import Stripe from 'stripe'

export function getSubscriptionCoupon(subscription: Stripe.Subscription): Stripe.Coupon | null {
  const coupon = subscription.discount?.coupon
  return coupon ?? null
}
`;

it('refuses an AI patch that reads a removed field through as unknown as', () => {
  // kondax-com/Bocker: the agent cast the subscription to a hand-written shape.
  const after = replaced(
    COUPON,
    '  const coupon = subscription.discount?.coupon\n  return coupon ?? null',
    `  const discounts = (subscription as unknown as { discounts?: unknown[] | null }).discounts ?? []
  for (const discount of discounts) {
    if (!discount || typeof discount === 'string') continue
    return (discount as { coupon?: Stripe.Coupon }).coupon ?? null
  }
  return null`,
  );
  expect(addedTypeEscapes(...versions('lib/coupon.ts', COUPON, after))).toEqual([
    { construct: 'as unknown as', line: 4, file: 'lib/coupon.ts' },
  ]);
});

it('refuses added any types and comments that turn checks off', () => {
  const after = replaced(
    COUPON,
    '  const coupon = subscription.discount?.coupon',
    `  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coupon = (subscription as any).discount?.coupon
  // @ts-expect-error discount was removed
  const legacy = subscription.discount`,
  );
  expect(
    addedTypeEscapes(...versions('lib/coupon.ts', COUPON, after)).map((entry) => entry.construct),
  ).toEqual(['any', 'eslint-disable', '@ts-expect-error']);
});

const PERIOD_WEBHOOK = `${CLIENT}export async function handle(subscriptionId: string) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = subscription.customer;
  const row = {
    stripe_customer_id: customerId,
    stripe_price_id: subscription.items.data[0].price.id,
    stripe_current_period_end: new Date(subscription.current_period_end * 1000),
  };
  return row;
}
`;

it('refuses an item choice made through a variable declared in a separate edit', () => {
  // JiantaoFu/insightly: the model stored items.data[0] and read the period from it lines later.
  const aliased = replaced(
    PERIOD_WEBHOOK,
    '  const customerId = subscription.customer;\n',
    '  const customerId = subscription.customer;\n  const subscriptionItem = subscription.items.data[0];\n',
  );
  const after = replaced(
    aliased,
    'new Date(subscription.current_period_end * 1000)',
    'new Date(subscriptionItem.current_period_end * 1000)',
  );
  expect(addedItemChoices(...versions('server.ts', PERIOD_WEBHOOK, after))).toEqual(['server.ts']);
});

it('refuses item choices by destructuring and by a non-null element', () => {
  // kondax-com/Bocker wrote `updatedSubscription.items.data[0]!.current_period_start`.
  const indexed = replaced(
    PERIOD_WEBHOOK,
    'new Date(subscription.current_period_end * 1000)',
    'new Date(subscription.items.data[0]!.current_period_end * 1000)',
  );
  const destructured = replaced(
    PERIOD_WEBHOOK,
    'new Date(subscription.current_period_end * 1000)',
    '(() => { const { current_period_end } = subscription.items.data[0]; return new Date(current_period_end * 1000) })()',
  );
  const bound = replaced(
    PERIOD_WEBHOOK,
    'new Date(subscription.current_period_end * 1000)',
    '(() => { const [item] = subscription.items.data; return new Date(item.current_period_end * 1000) })()',
  );
  for (const after of [indexed, destructured, bound])
    expect(addedItemChoices(...versions('server.ts', PERIOD_WEBHOOK, after))).toEqual([
      'server.ts',
    ]);
  // The price read from the first item was in the code before; only new choices count.
  expect(addedItemChoices(...versions('server.ts', PERIOD_WEBHOOK, PERIOD_WEBHOOK))).toEqual([]);
});

it('keeps refusing changed webhook event types', () => {
  const before = `export function created(event: { type: string }) {
  switch (event.type) {
    case 'customer.subscription-created':
      return true;
  }
  return event.type === 'invoice.paid';
}
`;
  const after = replaced(
    before,
    "'customer.subscription-created'",
    "'customer.subscription.created'",
  );
  expect(changedEventTypes(...versions('events.ts', before, after))).toEqual([
    'customer.subscription-created',
  ]);
});

const ORDER_WEBHOOK = `import Stripe from 'stripe';
export const POST = async (event: Stripe.Event) => {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const shippingAddress = {
      street: session?.shipping_details?.address?.line1,
      city: session?.shipping_details?.address?.city,
    }
    return shippingAddress;
  }
}
`;

const SHIPPING: Removal = {
  id: 'stripe:checkout.session:shipping_details',
  schema: 'checkout.session',
  property: 'shipping_details',
  pointer: '/components/schemas/checkout.session/properties/shipping_details',
};

// Webhook findings on each `shipping_details` read, as the analyzer reports them.
function shippingFindings(content: string): Finding[] {
  const lines = content.split('\n');
  return lines.flatMap((text, index) => {
    const column = text.indexOf('shipping_details');
    return column < 0
      ? []
      : [
          {
            file: 'app/api/webhooks/route.ts',
            line: index + 1,
            column: column + 1,
            changeId: SHIPPING.id,
            expression: 'session.shipping_details',
            confidence: 'confirmed' as const,
            reason: 'Reads a removed field from a webhook payload.',
            webhook: {
              eventTypes: ['checkout.session.completed'],
              schema: 'checkout.session',
              origin: { file: 'app/api/webhooks/route.ts', line: 3, column: 7 },
              apiVersion: 'unverified' as const,
            },
          },
        ];
  });
}

// One AI edit replacing the shipping address block of ORDER_WEBHOOK.
function shippingEdit(replacement: string): SourceEdit {
  const original = `    const shippingAddress = {
      street: session?.shipping_details?.address?.line1,
      city: session?.shipping_details?.address?.city,
    }`;
  const start = ORDER_WEBHOOK.indexOf(original);
  expect(start).toBeGreaterThan(0);
  return {
    file: 'app/api/webhooks/route.ts',
    start,
    end: start + original.length,
    replacement,
    changeId: SHIPPING.id,
  };
}

const newShapeOnly = (edit: SourceEdit, content = ORDER_WEBHOOK) =>
  newShapeOnlyReads(
    repository('app/api/webhooks/route.ts', content),
    [edit],
    shippingFindings(content),
    [SHIPPING],
  );

it('refuses an AI patch that reads a webhook payload only in the new shape', () => {
  // abressiddique/AbresStore-Admin: the agent moved every read to collected_information.
  const reads = newShapeOnly(
    shippingEdit(`    const shippingAddress = {
      street: session?.collected_information?.shipping_details?.address?.line1,
      city: session?.collected_information?.shipping_details?.address?.city,
    }`),
  );
  expect(reads).toEqual([
    {
      file: 'app/api/webhooks/route.ts',
      line: 6,
      schema: 'checkout.session',
      property: 'shipping_details',
    },
    {
      file: 'app/api/webhooks/route.ts',
      line: 7,
      schema: 'checkout.session',
      property: 'shipping_details',
    },
  ]);
});

it('accepts webhook reads that keep the old shape', () => {
  const reflected = shippingEdit(`    const shipping = (Reflect.get(session, 'shipping_details') ??
      session?.collected_information?.shipping_details) as Stripe.Checkout.Session.CollectedInformation.ShippingDetails | null | undefined;
    const shippingAddress = {
      street: shipping?.address?.line1,
      city: shipping?.address?.city,
    }`);
  const aliased = shippingEdit(`    const payload = session;
    const shipping = payload['shipping_details'] ?? payload.collected_information?.shipping_details;
    const shippingAddress = {
      street: shipping?.address?.line1,
      city: shipping?.address?.city,
    }`);
  const helper = shippingEdit(`    const shipping = getCheckoutShippingDetails(session);
    const shippingAddress = {
      street: shipping?.address?.line1,
      city: shipping?.address?.city,
    }`);
  for (const edit of [reflected, aliased, helper]) expect(newShapeOnly(edit)).toEqual([]);
});

it('refuses an old-shape read of a different object than the payload', () => {
  const edit =
    shippingEdit(`    const retrieved = await stripe.checkout.sessions.retrieve(session.id);
    const shipping = Reflect.get(retrieved, 'shipping_details') ?? session.collected_information?.shipping_details;
    const shippingAddress = {
      street: shipping?.address?.line1,
      city: shipping?.address?.city,
    }`);
  expect(newShapeOnly(edit)).toHaveLength(2);
});

it('checks a destructured webhook read against its initializer', () => {
  const content = replaced(
    ORDER_WEBHOOK,
    `    const shippingAddress = {
      street: session?.shipping_details?.address?.line1,
      city: session?.shipping_details?.address?.city,
    }`,
    `    const { shipping_details } = session;`,
  );
  const original = '    const { shipping_details } = session;';
  const start = content.indexOf(original);
  const edit = (replacement: string): SourceEdit => ({
    file: 'app/api/webhooks/route.ts',
    start,
    end: start + original.length,
    replacement,
    changeId: SHIPPING.id,
  });
  expect(
    newShapeOnly(
      edit('    const { shipping_details } = session.collected_information ?? {};'),
      content,
    ),
  ).toHaveLength(1);
  expect(
    newShapeOnly(
      edit(
        '    const shipping_details = Reflect.get(session, "shipping_details") ?? session.collected_information?.shipping_details;',
      ),
      content,
    ),
  ).toEqual([]);
});
