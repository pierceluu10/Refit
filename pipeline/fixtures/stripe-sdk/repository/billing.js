import { stripe } from './client.js';

export async function chargeHistory(paymentIntentId) {
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  return intent.charges.data;
}
