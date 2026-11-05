// Excerpt of pretzelai/lumen at c689c56b3241, api/src/routes/stripe.ts.
import Stripe from 'stripe';

export const check = async (data) => {
  const stripeClient = new Stripe(data.secretKey, {
    apiVersion: '2025-02-24.acacia',
  });
  await stripeClient.accounts.retrieve();
};
