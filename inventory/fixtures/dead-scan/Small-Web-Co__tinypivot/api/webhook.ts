// Excerpt of Small-Web-Co/tinypivot at 69caa7e03901, api/webhook.ts.
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
});

export const handle = (event: Stripe.Event) => {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    return session.customer_details?.email;
  }
};
