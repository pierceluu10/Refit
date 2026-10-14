import Stripe from 'stripe';

const REQUEST_TIMEOUT_MS = 1000;
const stripe = new Stripe('sk_test_refit_local_fixture', {
  apiVersion: '2022-08-01',
  host: '127.0.0.1',
  port: Number(process.env.REFIT_FIXTURE_PORT),
  protocol: 'http',
  maxNetworkRetries: 0,
  timeout: REQUEST_TIMEOUT_MS,
});

export default stripe;
