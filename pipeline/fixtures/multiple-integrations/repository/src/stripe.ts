import Stripe from 'stripe';
import { port, REQUEST_TIMEOUT_MS } from './simulator.ts';

const OFFLINE_KEY = 'sk_test_refit_multiple_integrations';
const API_VERSION = '2022-08-01';

export const stripe = new Stripe(OFFLINE_KEY, {
  apiVersion: API_VERSION,
  host: '127.0.0.1',
  port,
  protocol: 'http',
  timeout: REQUEST_TIMEOUT_MS,
  telemetry: false,
  maxNetworkRetries: 0,
});
