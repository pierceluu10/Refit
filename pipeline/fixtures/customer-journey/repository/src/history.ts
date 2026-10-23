import { stripe } from './stripe.ts';

export async function chargeHistory(id: string) {
  const intent = await stripe.paymentIntents.retrieve(id);
  return intent.charges.data;
}
