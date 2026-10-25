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

// Snippets come from the recorded agent diffs in docs/benchmarks/2026-10-21-agent-comparison-results.json:
// reviewed wrong after validating (drivetimetales, ai-saas-template, AbresStore, Kanba) or labelled
// wrong on October 24 (the rest), and from Refit's own runs. Each test keeps the code the model
// changed and the change it made, unless it says the code is rebuilt.

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

const SESSION_HELPER = `${CLIENT}import { NextResponse } from 'next/server';
import { createOrRetrieveCustomer } from '@/lib/supabase-admin';
import { getURL } from '@/lib/utils';

export async function POST(req: Request) {
  try {
    const customer = await createOrRetrieveCustomer({ uuid, email });
    const sessionParams = getSessionCreateParams(customer);
    const session = await stripe.checkout.sessions.create(sessionParams);
    return NextResponse.json({ sessionId: session.id });
  } catch (error) {
    console.error(error);
    return errorResponse('Unknown');
  }
}

function getSessionCreateParams(
  customer: string,
  priceId: string = process.env.STRIPE_PRICE_ID ?? '',
  mode: 'payment' | 'subscription' = 'subscription'
): Stripe.Checkout.SessionCreateParams {
  const homeUrl = getURL();

  return {
    payment_method_types: ['card'],
    billing_address_collection: 'required',
    customer,
    customer_update: { address: 'auto' },
    line_items: [{ price: priceId, quantity: 1 }],
    mode,
    allow_promotion_codes: true,
    success_url: homeUrl,
    cancel_url: homeUrl
  };
}
`;

it('refuses an AI patch that deletes a parameter from a body a helper function returns', () => {
  // brendansudol/punchlines-ai: the body comes from a function in the same file.
  const path = 'app/api/create-checkout-session/route.ts';
  const dropped = [
    { call: 'checkout.sessions.create', path: 'payment_method_types', line: 27, file: path },
  ];
  const deleted = replaced(SESSION_HELPER, "    payment_method_types: ['card'],\n", '');
  expect(droppedRequestPaths(...versions(path, SESSION_HELPER, deleted), STRIPE)).toEqual(dropped);
  // The same body passed to the call without a variable.
  const inline = (content: string) =>
    replaced(
      content,
      'const sessionParams = getSessionCreateParams(customer);\n    const session = await stripe.checkout.sessions.create(sessionParams);',
      'const session = await stripe.checkout.sessions.create(getSessionCreateParams(customer));',
    );
  expect(
    droppedRequestPaths(...versions(path, inline(SESSION_HELPER), inline(deleted)), STRIPE),
  ).toEqual(dropped.map((entry) => ({ ...entry, line: entry.line - 1 })));
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

const SUBSCRIPTION_WEBHOOK = `${CLIENT}import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(req: Request) {
  const body = await req.text();
  const signature = req.headers.get("Stripe-Signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Guard: both signature and secret must be present
  if (!signature || !webhookSecret) {
    console.warn("Webhook: missing signature or secret");
    return new NextResponse("Missing webhook credentials", { status: 400 });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (error) {
    // Log internally but return generic message to client
    console.error("Webhook signature verification failed:", error);
    return new NextResponse("Webhook signature verification failed", { status: 400 });
  }

  const session = event.data.object as any;

  if (event.type === "checkout.session.completed") {
    // Guard: session.subscription can be null for one-time payments
    if (!session.subscription) {
      console.log("checkout.session.completed: no subscription (one-time payment), skipping.");
      return new NextResponse(null, { status: 200 });
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
      const userId = session.metadata?.userId;
      const charityId = session.metadata?.charityId;
      const charityPct = parseInt(session.metadata?.charityPct || "10", 10);

      if (userId) {
        const { error } = await supabase
          .from("profiles")
          .update({
            stripe_subscription_id: subscription.id,
            stripe_customer_id: subscription.customer as string,
            sub_status: subscription.status,
            current_period_end: new Date((subscription as any).current_period_end * 1000).toISOString(),
            charity_name: charityId,
            charity_pct: charityPct,
          })
          .eq("id", userId);

        if (error) console.error("Error updating profile in webhook:", error);
      }
    } catch (err) {
      console.error("checkout.session.completed handler error:", err);
    }
  }

  if (event.type === "invoice.payment_succeeded") {
    // Guard: subscription might be null for one-time invoices
    if (!session.subscription) {
      console.log("invoice.payment_succeeded: no subscription, skipping.");
      return new NextResponse(null, { status: 200 });
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
      await supabase
        .from("profiles")
        .update({
          sub_status: subscription.status,
          current_period_end: new Date((subscription as any).current_period_end * 1000).toISOString(),
        })
        .eq("stripe_subscription_id", subscription.id);
    } catch (err) {
      console.error("invoice.payment_succeeded handler error:", err);
    }
  }

  return new NextResponse(null, { status: 200 });
}
`;

it('accepts the AI fix that routed period reads through the version-tolerant helper', () => {
  // ABHINAVJINDAL26/VANTAGE-Golf-Charity-Platform, October 22: a Refit AI patch reviewed as correct.
  // Its diff was not kept; docs/AI-PATCH-RELIABILITY.md records its two edits, rebuilt here: both
  // reads go through the generated helper, with no item choice.
  const path = 'src/app/api/stripe/webhook/route.ts';
  const read = '(subscription as any).current_period_end';
  expect(SUBSCRIPTION_WEBHOOK.split(read)).toHaveLength(3);
  const fixed = SUBSCRIPTION_WEBHOOK.replaceAll(read, 'getSubscriptionPeriodEnd(subscription)');
  const inputs = versions(path, SUBSCRIPTION_WEBHOOK, fixed);
  expect(changedEventTypes(...inputs)).toEqual([]);
  expect(addedItemChoices(...inputs)).toEqual([]);
  expect(droppedRequestPaths(...inputs, STRIPE)).toEqual([]);
  expect(addedTypeEscapes(...inputs)).toEqual([]);
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

// Rebuilt: kondax-com/Bocker's agent wrote getSubscriptionCoupon in a new file, which Refit's AI
// path cannot create, so the code before its change is reconstructed.
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
  // A choice already in the rules' code is not the AI's; only added choices count.
  const unrelated = replaced(indexed, 'const customerId', 'const customer');
  expect(addedItemChoices(...versions('server.ts', indexed, unrelated))).toEqual([]);
  const second = replaced(
    indexed,
    '  return row;',
    '  return { ...row, start: subscription.items.data[0].current_period_start };',
  );
  expect(addedItemChoices(...versions('server.ts', indexed, second))).toEqual(['server.ts']);
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

it.each([
  [
    'a variable holding the list',
    '(() => { const items = subscription.items.data; return new Date(items[0].current_period_end * 1000) })()',
  ],
  [
    'destructured items',
    '(() => { const { items } = subscription; return new Date(items.data[0].current_period_end * 1000) })()',
  ],
  [
    'destructured data',
    '(() => { const { data } = subscription.items; return new Date(data[0].current_period_end * 1000) })()',
  ],
  [
    'a variable holding the item, then destructuring',
    '(() => { const item = subscription.items.data[0]; const { current_period_end } = item; return new Date(current_period_end * 1000) })()',
  ],
  ['a string key', "new Date(subscription.items.data[0]['current_period_end'] * 1000)"],
  [
    'Reflect.get',
    "new Date(Number(Reflect.get(subscription.items.data[0], 'current_period_end')) * 1000)",
  ],
])('refuses an item choice through %s', (_form, period) => {
  const after = replaced(
    PERIOD_WEBHOOK,
    'new Date(subscription.current_period_end * 1000)',
    period,
  );
  expect(addedItemChoices(...versions('server.ts', PERIOD_WEBHOOK, after))).toEqual(['server.ts']);
});

it('refuses replacing a reviewed item selector with an item the AI picks', () => {
  const read = 'new Date(subscription.current_period_end * 1000)';
  const selected = replaced(
    PERIOD_WEBHOOK,
    read,
    'new Date(getSubscriptionPeriodEnd(subscription, selectPlanItem) * 1000)',
  );
  const picked = replaced(
    PERIOD_WEBHOOK,
    read,
    'new Date(subscription.items.data[0].current_period_end * 1000)',
  );
  expect(addedItemChoices(...versions('server.ts', selected, picked))).toEqual(['server.ts']);
});

it('refuses an AI patch that sets a request parameter to undefined, void 0 or null', () => {
  const path = 'app/api/create-setup-intent/route.ts';
  for (const value of ['undefined', 'void 0', 'null']) {
    const after = replaced(SETUP_INTENT, 'customer: customerId,', `customer: ${value},`);
    expect(
      droppedRequestPaths(...versions(path, SETUP_INTENT, after), STRIPE).map(
        (entry) => entry.path,
      ),
    ).toEqual(['customer']);
  }
  // A key that overrides a spread with undefined unsets what the spread sent.
  const spread = `${CLIENT}export async function POST(base: Stripe.SetupIntentCreateParams) {
  return stripe.setupIntents.create({ ...base, usage: 'off_session' });
}
`;
  const unset = replaced(
    spread,
    "usage: 'off_session'",
    "usage: 'off_session', customer: undefined",
  );
  expect(
    droppedRequestPaths(...versions(path, spread, unset), STRIPE).map((entry) => entry.path),
  ).toEqual(['customer=unset']);
});

// geallenboy/ai-saas-template src/lib/stripe.ts: keys the body gets after its declaration.
const SESSION_BUILDER = `${CLIENT}export async function createCheckoutSession(params: {
  priceId: string
  customerId?: string
  customerEmail?: string
  successUrl: string
  cancelUrl: string
  metadata?: Record<string, string>
  mode?: 'payment' | 'subscription'
}): Promise<Stripe.Checkout.Session> {
  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: params.mode || 'subscription',
      line_items: [
        {
          price: params.priceId,
          quantity: 1,
        },
      ],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata: params.metadata,
      billing_address_collection: 'auto',
    }

    if (params.customerId) {
      sessionParams.customer = params.customerId
    } else if (params.customerEmail) {
      sessionParams.customer_email = params.customerEmail
    }

    if (params.mode === 'subscription') {
      sessionParams.subscription_data = {
        metadata: params.metadata,
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams)
    return session
  } catch (error) {
    throw error
  }
}
`;

it('refuses an AI patch that deletes a key assigned to a request body after its declaration', () => {
  const after = replaced(
    SESSION_BUILDER,
    `    if (params.mode === 'subscription') {
      sessionParams.subscription_data = {
        metadata: params.metadata,
      }
    }
`,
    '',
  );
  expect(
    droppedRequestPaths(...versions('src/lib/stripe.ts', SESSION_BUILDER, after), STRIPE),
  ).toEqual([
    {
      call: 'checkout.sessions.create',
      path: 'subscription_data',
      line: 34,
      file: 'src/lib/stripe.ts',
    },
  ]);
});

// beindigital-products/wedillybird lib/payments/drivers/stripe.ts: two bodies named `params`.
const TWO_BODIES = `${CLIENT}export async function createCoupon(input: CouponInput) {
  const params: Stripe.CouponCreateParams = {
    name: clampCouponName(input.name),
    duration: input.duration,
    ...(input.percentOff != null ? { percent_off: input.percentOff } : {}),
  };
  const coupon = await stripe.coupons.create(params);
  return mapCoupon(coupon);
}

export async function createPromotionCode(input: PromotionCodeInput) {
  const params: Stripe.PromotionCodeCreateParams = {
    promotion: { type: 'coupon', coupon: input.couponId },
    ...(input.code ? { code: input.code } : {}),
  };
  const pc = await stripe.promotionCodes.create(params);
  return mapPromotionCode(pc);
}
`;

it('follows each request body to the declaration in its own scope', () => {
  const after = replaced(TWO_BODIES, '    name: clampCouponName(input.name),\n', '');
  expect(
    droppedRequestPaths(...versions('lib/payments/drivers/stripe.ts', TWO_BODIES, after), STRIPE),
  ).toEqual([
    { call: 'coupons.create', path: 'name', line: 5, file: 'lib/payments/drivers/stripe.ts' },
  ]);
});

it('follows a spread of a body declared in the file, and ignores reflowing a spread', () => {
  const before = `${CLIENT}const base = { payment_method_types: ['card'], mode: 'payment' as const };
export async function POST(customer: string, coupon?: string) {
  return stripe.checkout.sessions.create({
    ...base,
    customer,
    ...(coupon ? { discounts: [{ coupon }] } : {}),
  });
}
`;
  const dropped = replaced(before, "payment_method_types: ['card'], ", '');
  expect(
    droppedRequestPaths(...versions('checkout.ts', before, dropped), STRIPE).map(
      (entry) => entry.path,
    ),
  ).toEqual(['payment_method_types']);
  const reflowed = replaced(
    before,
    '    ...(coupon ? { discounts: [{ coupon }] } : {}),',
    `    ...(coupon
      ? { discounts: [{ coupon }] }
      : {}),`,
  );
  expect(droppedRequestPaths(...versions('checkout.ts', before, reflowed), STRIPE)).toEqual([]);
});

it('refuses an added as never cast', () => {
  const after = replaced(
    COUPON,
    '  const coupon = subscription.discount?.coupon',
    '  const coupon = (subscription as never as { discount?: Stripe.Discount }).discount?.coupon',
  );
  expect(
    addedTypeEscapes(...versions('lib/coupon.ts', COUPON, after)).map((entry) => entry.construct),
  ).toEqual(['as never']);
});

it('refuses a new-shape read when the edit calls a helper for another field or object', () => {
  // A generated helper is an old-shape read only of its own field, from the payload itself.
  const otherObject = shippingEdit(`    const shippingAddress = {
      street: (getCheckoutShippingDetails(retrieved) ?? session?.collected_information?.shipping_details)?.address?.line1,
      city: session?.collected_information?.shipping_details?.address?.city,
    }`);
  const otherField = shippingEdit(`    const renews = getSubscriptionPeriodEnd(session);
    const shippingAddress = {
      street: session?.collected_information?.shipping_details?.address?.line1,
      city: session?.collected_information?.shipping_details?.address?.city,
    }`);
  for (const edit of [otherObject, otherField])
    expect(newShapeOnly(edit).map((read) => read.line)).toEqual([6, 7]);
});

it('refuses an edit where one read keeps the old shape and another reads only the new one', () => {
  const reads = newShapeOnly(
    shippingEdit(`    const shippingAddress = {
      street: (Reflect.get(session, 'shipping_details') ?? session?.collected_information?.shipping_details)?.address?.line1,
      city: session?.collected_information?.shipping_details?.address?.city,
    }`),
  );
  expect(reads.map((read) => read.line)).toEqual([6, 7]);
});

// Mangu-Commerce/madcaptees api/stripe/webhook.ts in re-probe 40078712515: the shipping-details
// rule calls the helper once per read, so TypeScript cannot narrow it and repair asks the model.
const HELPER_READS = `import Stripe from 'stripe';
import { getCheckoutShippingDetails } from '../../stripeSubscriptionPeriod';

export async function record(session: Stripe.Checkout.Session, existing: unknown) {
  if (!existing) {
    const email = session.customer_details?.email || session.customer_email || 'unknown@checkout.stripe';
    await supabase.from('orders').insert({
      stripe_session_id: session.id,
      email,
      shipping_address: (getCheckoutShippingDetails(session))?.address
        ? {
            name: (getCheckoutShippingDetails(session)).name ?? '',
            line1: (getCheckoutShippingDetails(session)).address.line1 ?? '',
            city: (getCheckoutShippingDetails(session)).address.city ?? '',
            country: (getCheckoutShippingDetails(session)).address.country ?? 'US',
          }
        : null,
    });
  }
}
`;

function insertEdit(replacement: string): SourceEdit {
  const start = HELPER_READS.indexOf('    await supabase');
  const end = HELPER_READS.indexOf('    });\n') + '    });'.length;
  expect(start).toBeGreaterThan(0);
  return { file: 'api/stripe/webhook.ts', start, end, replacement, changeId: SHIPPING.id };
}

const helperReads = (edit: SourceEdit) =>
  newShapeOnlyReads(repository('api/stripe/webhook.ts', HELPER_READS), [edit], [], [SHIPPING]);

it('accepts a repair that calls the shipping helper once and narrows its result', () => {
  expect(
    helperReads(
      insertEdit(`    const shipping = getCheckoutShippingDetails(session);
    await supabase.from('orders').insert({
      stripe_session_id: session.id,
      email,
      shipping_address: shipping?.address
        ? {
            name: shipping.name ?? '',
            line1: shipping.address.line1 ?? '',
            city: shipping.address.city ?? '',
            country: shipping.address.country ?? 'US',
          }
        : null,
    });`),
    ),
  ).toEqual([]);
});

it("refuses a repair that rewrites the rules' version-tolerant helper to the new shape only", () => {
  // The helper calls are not findings, so only the edited code's dual reads show the change.
  const reads = helperReads(
    insertEdit(`    const shipping = session.collected_information?.shipping_details;
    await supabase.from('orders').insert({
      stripe_session_id: session.id,
      email,
      shipping_address: shipping?.address
        ? {
            name: shipping.name ?? '',
            line1: shipping.address.line1 ?? '',
            city: shipping.address.city ?? '',
            country: shipping.address.country ?? 'US',
          }
        : null,
    });`),
  );
  expect(reads).toEqual(
    [10, 12, 13, 14, 15].map((line) => ({
      file: 'api/stripe/webhook.ts',
      line,
      schema: 'checkout.session',
      property: 'shipping_details',
    })),
  );
});
