import stripe from './client.ts';
export class MissingHistory extends Error {}
export async function chargeHistory(id: string) {
  const intent = await stripe.paymentIntents.retrieve(id);
  if (!intent.charges) {
    throw new MissingHistory('Missing history');
  }
  return intent.charges.data;
}
