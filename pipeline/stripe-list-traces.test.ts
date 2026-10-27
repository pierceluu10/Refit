import { expect, it } from 'vitest';
import { analyzeRepository, syntaxErrors } from './analyzer.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE, parseProviderAdapter } from './providers.ts';
import { findRemovedProperties } from './specifications.ts';

// List and search methods return `{ object: 'list' | 'search_result', data: [...] }` and
// stripe-node pages them with `for await`, `autoPagingEach` and `autoPagingToArray`
// (docs.stripe.com/api/pagination, /api/pagination/search, /api/pagination/auto). Their items
// trace to the listed object, so the rules migrate removed-field reads on them.
const string = { type: 'string' };
const integer = { type: 'integer' };
const ref = (schema: string) => ({ $ref: `#/components/schemas/${schema}` });
const list = (schema: string) => ({
  type: 'object',
  properties: { has_more: { type: 'boolean' }, data: { type: 'array', items: ref(schema) } },
});
// Reduced Stripe contracts for the 2025-03-31.basil subscription period and invoice moves.
function schemas(after: boolean): Record<string, unknown> {
  return {
    customer: { type: 'object', properties: { id: string, email: string } },
    subscription: {
      type: 'object',
      properties: {
        id: string,
        status: string,
        cancel_at_period_end: { type: 'boolean' },
        metadata: { type: 'object', additionalProperties: string },
        items: list('subscription_item'),
        ...(after ? {} : { current_period_start: integer, current_period_end: integer }),
      },
    },
    subscription_item: {
      type: 'object',
      properties: {
        id: string,
        price: ref('price'),
        ...(after ? { current_period_start: integer, current_period_end: integer } : {}),
      },
    },
    price: { type: 'object', properties: { id: string, unit_amount: integer } },
    invoice: {
      type: 'object',
      properties: {
        id: string,
        lines: list('line_item'),
        ...(after
          ? { parent: { anyOf: [ref('invoice_parent')], nullable: true } }
          : { subscription: { anyOf: [string, ref('subscription')], nullable: true } }),
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
    line_item: {
      type: 'object',
      properties: { id: string, ...(after ? {} : { price: ref('price') }) },
    },
  };
}

const provider = {
  ...STRIPE,
  id: 'stripe-lists',
  operations: [
    { resource: 'customers', method: 'list', schema: 'customer', list: true as const },
    { resource: 'customers', method: 'search', schema: 'customer', list: true as const },
    { resource: 'subscriptions', method: 'list', schema: 'subscription', list: true as const },
    { resource: 'subscriptions', method: 'retrieve', schema: 'subscription' },
    { resource: 'invoices', method: 'list', schema: 'invoice', list: true as const },
    { resource: 'prices', method: 'retrieve', schema: 'price' },
  ],
};
const header = `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' });\n`;

function analyze(body: string, adapter = provider) {
  const content = header + body;
  const result = analyzeRepository(
    {
      root: '/lists',
      files: [{ path: 'billing.ts', content }],
      dependencies: [],
      lockfiles: [],
      warnings: [],
    },
    findRemovedProperties(schemas(false), schemas(true), adapter.id),
    adapter,
    schemas(false),
  );
  const patched = applySourceEdits(
    content,
    result.edits.filter((edit) => edit.file === 'billing.ts'),
  );
  console.log(JSON.stringify(result.findings, null, 2), '\n', patched);
  expect(syntaxErrors('billing.ts', patched)).toEqual([]);
  return { ...result, patched };
}
const reads = (result: ReturnType<typeof analyze>) =>
  result.findings.map((finding) => [finding.expression, finding.confidence, finding.line]);

it('traces a listed subscription in a find callback and migrates its period (shagunmistry/FlowCraft)', () => {
  // src/app/api/subscription/route.ts at ae2e307: a customers.search loop recovers the
  // subscription from subscriptions.list; the same handler selects items.data[0] elsewhere.
  const result = analyze(`export async function GET(email: string, planId: string) {
  const customers = await stripe.customers.search({ query: \`email:'\${email}'\`, limit: 10 })
  for (const customer of customers.data) {
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 10 })
    const recovered = subs.data.find(
      (s) =>
        s.status === 'active' ||
        s.status === 'trialing' ||
        (s.cancel_at_period_end &&
          s.current_period_end * 1000 > Date.now()),
    )
    if (recovered) return recovered.id
  }
  const subscription = await stripe.subscriptions.retrieve(planId)
  const item = subscription.items.data[0]
  return item.price.id
}
`);
  expect(reads(result)).toEqual([['.current_period_end', 'confirmed', 12]]);
  // The handler's own item choice is the rule's plan, as for the retrieved subscription.
  expect(result.patched).toContain(
    '(getSubscriptionPeriodEnd(s, (items) => items[0])) * 1000 > Date.now()',
  );
  expect(result.patched).not.toMatch(/\bs\.current_period_end/);
});

it('traces the first listed subscription and leaves its item price alone (iggy-tech/product-hunt-clone-final)', () => {
  // lib/stripe.ts at 85b3a0f: customers.list by email, then subscriptions.list by customer.
  const result = analyze(`export const getPaymentDetails = async (email: string) => {
  const customers = await stripe.customers.list({
    email: email,
  });
  if (!customers || customers.data.length === 0) {
    throw new Error("Customer not found");
  }
  const customer = customers.data[0];
  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'active',
  });
  if (!subscriptions || subscriptions.data.length === 0) {
    throw new Error("No active subscriptions found for customer");
  }
  const subscription = subscriptions.data[0];
  const nextPaymentDate = new Date(subscription.current_period_end * 1000);
  const priceId = subscription.items.data[0].price.id;
  const price = await stripe.prices.retrieve(priceId);
  return { nextPaymentDate, amount: price.unit_amount };
};
`);
  // `.price` on a subscription item is not the removed line-item price: no finding, no edit.
  expect(reads(result)).toEqual([['.current_period_end', 'confirmed', 19]]);
  expect(result.patched).toContain(
    'new Date((getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000)',
  );
  expect(result.patched).toContain('subscription.items.data[0].price.id');
});

it('traces auto-paginated items, destructured pages and searches', () => {
  const result = analyze(`export async function sweep(customer: string) {
  for await (const invoice of stripe.invoices.list({ customer })) {
    console.log(invoice.subscription);
  }
  await stripe.subscriptions.list({ customer }).autoPagingEach(async (sub) => {
    console.log(sub.current_period_start);
  });
  const all = await stripe.subscriptions.list({ customer }).autoPagingToArray({ limit: 100 });
  const { data: page } = await stripe.subscriptions.list({ customer });
  return [all.map((entry) => entry.status), page.map((entry) => entry.id)];
}
`);
  expect(reads(result)).toEqual([
    ['.subscription', 'confirmed', 5],
    ['.current_period_start', 'confirmed', 8],
  ]);
  expect(result.patched).toContain('console.log((getInvoiceSubscription(invoice)));');
  expect(result.patched).toContain('console.log((getSubscriptionPeriodStart(sub)));');
});

it('never edits the list object itself, an un-awaited page or a synchronous loop over the call', () => {
  const result = analyze(`export async function wrong(customer: string) {
  const subs = await stripe.subscriptions.list({ customer });
  const pending = stripe.subscriptions.list({ customer });
  for (const sub of stripe.subscriptions.list({ customer }) as any) console.log(sub.current_period_end);
  return [subs.current_period_end, pending.data[0].current_period_end];
}
`);
  expect(result.findings.every((finding) => finding.confidence === 'review')).toBe(true);
  expect(result.findings).toHaveLength(3);
  expect(result.edits).toEqual([]);
});

it('keeps list methods untraced in adapters that do not mark them as lists', () => {
  // Older adapters mapped only retrieve-style methods; a list method without `list` is unchanged.
  const unmarked = {
    ...provider,
    operations: provider.operations.filter((operation) => !('list' in operation)),
  };
  const result = analyze(
    `export async function recover(customer: string) {
  const subs = await stripe.subscriptions.list({ customer });
  return subs.data[0].current_period_end;
}
`,
    unmarked,
  );
  expect(reads(result)).toEqual([['.current_period_end', 'review', 5]]);
  expect(result.edits).toEqual([]);
});

it('accepts list: true on adapter operations and rejects any other list value', () => {
  const config = (list: unknown) => ({
    id: 'stripe-config',
    packageName: 'stripe',
    defaultImport: true,
    namedExport: 'Stripe',
    operations: [{ resource: 'subscriptions', method: 'list', schema: 'subscription', list }],
  });
  expect(parseProviderAdapter(config(true)).operations).toEqual([
    { resource: 'subscriptions', method: 'list', schema: 'subscription', list: true },
  ]);
  expect(() => parseProviderAdapter(config(false))).toThrow('optional list: true');
  expect(() => parseProviderAdapter(config('yes'))).toThrow('optional list: true');
});

it('does not confirm a read on a page the code writes to', () => {
  const result = analyze(`export async function overwrite(customer: string, fake: any) {
  const subs = await stripe.subscriptions.list({ customer });
  subs.data[0] = fake;
  return subs.data[0].current_period_end;
}
`);
  expect(reads(result)).toEqual([['.current_period_end', 'review', 6]]);
  expect(result.edits).toEqual([]);
});

// Response reads through array element and copy methods, local helpers, writes and free-form maps.
const traced = (result: ReturnType<typeof analyze>) =>
  result.findings.map((finding) => [
    finding.expression,
    finding.confidence,
    finding.untraced ?? false,
  ]);

it('traces a listed object through at(), find() and a filtered copy', () => {
  for (const pick of [
    'subs.data.at(0)',
    'subs.data.find((s) => s.status === "active")',
    'subs.data.filter((s) => s.status === "active")[0]',
  ])
    expect(
      traced(
        analyze(`export async function end(customer: string) {
  const subs = await stripe.subscriptions.list({ customer })
  const first = ${pick}
  return first?.current_period_end
}
`),
      ),
    ).toEqual([['.current_period_end', 'confirmed', false]]);
});

it('traces what a local helper returns and passes, with review confidence', () => {
  const result = analyze(`async function load(id: string) {
  return stripe.subscriptions.retrieve(id)
}
function end(subscription: { current_period_end: number }) {
  return subscription.current_period_end
}
export async function GET(id: string) {
  const subscription = await load(id)
  return [subscription.current_period_end, end(subscription)]
}
`);
  expect(traced(result)).toEqual([
    ['.current_period_end', 'review', false],
    ['.current_period_end', 'review', false],
  ]);
});

it('counts neither a write to an untraced object nor a metadata value as a read', () => {
  expect(
    traced(
      analyze(`export async function save(id: string, row: { current_period_end?: number }) {
  const subscription = await stripe.subscriptions.retrieve(id)
  row.current_period_end = 0
  return subscription.metadata.current_period_end
}
`),
    ),
  ).toEqual([]);
});

it('keeps confirming a read through a helper parameter typed as the Stripe object', () => {
  const result = analyze(`function end(subscription: Stripe.Subscription) {
  return subscription.current_period_end
}
export async function GET(id: string) {
  return end(await stripe.subscriptions.retrieve(id))
}
`);
  expect(traced(result)).toEqual([['.current_period_end', 'confirmed', false]]);
});
