import Stripe from 'stripe';

const REQUEST_TIMEOUT_MS = 1000;
export const stripe = new Stripe('sk_test_refit_local_fixture', {
  host: '127.0.0.1',
  port: Number(process.env.REFIT_FIXTURE_PORT),
  protocol: 'http',
  maxNetworkRetries: 0,
  timeout: REQUEST_TIMEOUT_MS,
});
