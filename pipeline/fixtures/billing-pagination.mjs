import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DECLINED_ATTEMPTS = 102;
const PAYMENT_AMOUNT = 2000;
const REFUND_AMOUNT = 500;
const mode = process.argv[2] ?? 'after';
assert.ok(mode === 'before' || mode === 'after', 'Contract must be before or after.');
const load = (path) => import(pathToFileURL(resolve(path)).href);
const Stripe = createRequire(resolve('package.json'))('stripe');
const { startSimulator } = await load('simulator/server.ts');
const server = await startSimulator(mode);
process.env.BILLING_MODE = 'simulator';
process.env.STRIPE_SIMULATOR_MODE = mode;
process.env.STRIPE_SIMULATOR_URL = server.url;
try {
  const { createCustomer } = await load('src/billing/customers.ts');
  const { createPayment, retryPayment } = await load('src/billing/payments.ts');
  const { getChargeHistory } = await load('src/billing/history.ts');
  const { createRefund } = await load('src/billing/refunds.ts');
  const { stripe } = await load('src/stripe.ts');
  const customer = await createCustomer('pagination@example.com', 'Pagination');
  let id;
  try {
    await createPayment(customer.id, PAYMENT_AMOUNT, 'pm_card_chargeDeclined');
    assert.fail('Declined card unexpectedly succeeded.');
  } catch (error) {
    assert.ok(error instanceof Stripe.errors.StripeCardError);
    id = error.payment_intent.id;
  }
  for (let index = 1; index < DECLINED_ATTEMPTS; index++) {
    await assert.rejects(retryPayment(id, 'pm_card_chargeDeclined'), Stripe.errors.StripeCardError);
  }
  await retryPayment(id, 'pm_card_visa');
  await createRefund(id, REFUND_AMOUNT);
  const history = await getChargeHistory(id);
  assert.equal(
    history.length,
    DECLINED_ATTEMPTS + 1,
    'History must retrieve every page, not only the default 10 charges.',
  );
  assert.equal(new Set(history.map((charge) => charge.id)).size, history.length);
  assert.equal(history[0].status, 'succeeded');
  assert.equal(history[0].amount_refunded, REFUND_AMOUNT);
  assert.ok(history.every((charge) => charge.payment_intent === id));
  assert.ok(history.slice(1).every((charge) => charge.status === 'failed'));
  const pending = await stripe.paymentIntents.create({
    customer: customer.id,
    amount: PAYMENT_AMOUNT,
    currency: 'usd',
    payment_method_types: ['card'],
  });
  assert.deepEqual(
    await getChargeHistory(pending.id),
    [],
    'An existing intent with no attempts must retain its empty history.',
  );
  console.log(
    'Multi-page history passed: ' + history.length + ' attempts; empty history preserved.',
  );
} finally {
  await server.close();
}
