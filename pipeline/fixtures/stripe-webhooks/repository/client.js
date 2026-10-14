import Stripe from 'stripe';

export const stripe = new Stripe('local-webhook-fixture', {
  apiVersion: '2025-02-24.acacia',
});
