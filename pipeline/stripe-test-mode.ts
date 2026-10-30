import { providerKeys, type SandboxAdapter, type ProviderCall } from './provider-sandbox.ts';
import { PipelineInputError } from './types.ts';

// Stripe's test mode as the provider sandbox's first adapter. Facts are from Stripe's docs, read
// 2026-10-28: keys https://docs.stripe.com/keys.md, rate limits https://docs.stripe.com/rate-limits.md
// (25 requests per second in a sandbox, 429 with Stripe-Rate-Limited-Reason, retry with exponential
// backoff and jitter), versioning https://docs.stripe.com/api/versioning.md (Stripe-Version per
// request, else the account default), metadata https://docs.stripe.com/api/metadata.md, and the
// delete, cancel and expire endpoints listed in docs/STRIPE-TEST-MODE.md.

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Create operations (no path parameter) whose form body takes `metadata`, from the side's contract.
function taggable(contract: unknown) {
  const paths = (contract as { paths?: Record<string, Record<string, unknown>> } | null)?.paths;
  return Object.entries(paths ?? {})
    .filter(([path, operations]) => {
      if (path.includes('{')) return false;
      const post = operations.post as
        | { requestBody?: { content?: Record<string, { schema?: { properties?: object } }> } }
        | undefined;
      const properties =
        post?.requestBody?.content?.['application/x-www-form-urlencoded']?.schema?.properties;
      return Boolean(properties && 'metadata' in properties);
    })
    .map(([path]) => `^POST ${escape(path)}$`);
}

// Identifiers written as string literals in the code under test.
const LITERAL = /(['"`])((?:cus|prod|price)_[A-Za-z0-9]{6,})\1/g;
// Account-specific objects Refit does not recreate: their state lives in the customer's account.
const OTHER =
  /(['"`])((?:acct|sub|si|in|ii|pi|seti|cs|src|card|ba|txn|ch|re|dp|promo|plink|bpc|txr|cbtxn|pm)_[A-Za-z0-9]{6,})\1/g;
// Stripe's own test objects work in every test account.
const TEST_OBJECT = /^(?:pm_card_|tok_|card_bypassPending)/;

function standIns(sources: readonly { path: string; content: string }[]) {
  const wanted = new Map<string, { id: string; kind: string }>();
  const unreproducible = new Set<string>();
  for (const source of sources) {
    for (const match of source.content.matchAll(LITERAL))
      wanted.set(match[2], { id: match[2], kind: match[2].slice(0, match[2].indexOf('_')) });
    for (const match of source.content.matchAll(OTHER))
      if (!TEST_OBJECT.test(match[2])) unreproducible.add(`${match[2]} (${source.path})`);
  }
  return { wanted: [...wanted.values()], unreproducible: [...unreproducible] };
}

const CLEANUP: Record<string, (id: string) => ProviderCall> = {
  customer: (id) => ({ method: 'DELETE', path: `/v1/customers/${id}` }),
  coupon: (id) => ({ method: 'DELETE', path: `/v1/coupons/${id}` }),
  // A product with prices cannot be deleted, so it is archived instead.
  product: (id) => ({ method: 'POST', path: `/v1/products/${id}`, form: { active: 'false' } }),
  price: (id) => ({ method: 'POST', path: `/v1/prices/${id}`, form: { active: 'false' } }),
  promotion_code: (id) => ({
    method: 'POST',
    path: `/v1/promotion_codes/${id}`,
    form: { active: 'false' },
  }),
  payment_link: (id) => ({
    method: 'POST',
    path: `/v1/payment_links/${id}`,
    form: { active: 'false' },
  }),
  'checkout.session': (id) => ({ method: 'POST', path: `/v1/checkout/sessions/${id}/expire` }),
  payment_intent: (id) => ({ method: 'POST', path: `/v1/payment_intents/${id}/cancel` }),
  setup_intent: (id) => ({ method: 'POST', path: `/v1/setup_intents/${id}/cancel` }),
  subscription: (id) => ({ method: 'DELETE', path: `/v1/subscriptions/${id}` }),
  invoice: (id) => ({ method: 'DELETE', path: `/v1/invoices/${id}` }),
  webhook_endpoint: (id) => ({ method: 'DELETE', path: `/v1/webhook_endpoints/${id}` }),
};

export const STRIPE_TEST_MODE: SandboxAdapter = {
  name: 'Stripe',
  hosts: ['api.stripe.com'],
  keyVariable: 'STRIPE_TEST_KEY',
  testKey: /^(?:sk|rk)_test_[A-Za-z0-9]{8,}$/,
  secret: /\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}/g,
  authorization: 'Bearer {key}',
  versionHeader: 'Stripe-Version',
  rateLimit: { status: 429, retries: 5, backoffMs: 500 },
  tagField: 'metadata[refit_run]',
  taggable,
  standIns,
  async createStandIn(wanted, call, sources) {
    const product = async () =>
      String(
        (
          await call({
            method: 'POST',
            path: '/v1/products',
            form: { name: `Refit stand-in for ${wanted.id}` },
            tag: true,
          })
        ).id,
      );
    if (wanted.kind === 'cus') {
      const customer = await call({
        method: 'POST',
        path: '/v1/customers',
        form: { name: `Refit stand-in for ${wanted.id}` },
        tag: true,
      });
      return { id: String(customer.id), assumption: 'a customer with no payment method' };
    }
    if (wanted.kind === 'prod') return { id: await product(), assumption: 'an active product' };
    // A price used for subscriptions must be recurring; nothing else in the code says which.
    const recurring = sources.some((source) =>
      /['"`]subscription['"`]|recurring/.test(source.content),
    );
    const price = await call({
      method: 'POST',
      path: '/v1/prices',
      form: {
        currency: 'usd',
        unit_amount: '1000',
        product: await product(),
        ...(recurring ? { 'recurring[interval]': 'month' } : {}),
      },
      tag: true,
    });
    return {
      id: String(price.id),
      assumption: recurring ? 'a monthly USD 10.00 recurring price' : 'a one-time USD 10.00 price',
    };
  },
  cleanup: (object) => CLEANUP[object.object]?.(object.id),
  operation: (method, path) =>
    `${method} ${path
      .split('/')
      .map((part) => (/^[a-z]+_[A-Za-z0-9_]+$/.test(part) && /\d/.test(part) ? '{id}' : part))
      .join('/')}`,
};

// --stripe-test-mode on `refit run` and the Stripe benchmark: the keys come from STRIPE_TEST_KEY
// only, and are refused unless every one is a test key. It runs the behaviour tests the model writes.
export function stripeTestMode(enabled: boolean | undefined, behaviourTests: boolean | undefined) {
  if (!enabled) return undefined;
  if (!behaviourTests)
    throw new PipelineInputError(
      '--stripe-test-mode runs behaviour tests, so it needs --write-behaviour-tests (--behaviour-tests in the benchmark).',
    );
  return { adapter: STRIPE_TEST_MODE, keys: providerKeys(STRIPE_TEST_MODE, process.env) };
}
