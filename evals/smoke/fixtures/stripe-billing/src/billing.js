import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

export async function chargeCustomer(customerId, amount) {
  const intent = await stripe.paymentIntents.create({
    customer: customerId,
    amount,
    currency: 'usd',
    payment_method_types: ['card'],
  });
  return intent.id;
}
