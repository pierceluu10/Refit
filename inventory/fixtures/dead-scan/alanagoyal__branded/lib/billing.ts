// Excerpt of alanagoyal/branded at cf8f84cc8bfc, lib/billing.ts.
import Stripe from 'stripe';

export const stripeClient = () => new Stripe(process.env.STRIPE_SECRET_KEY!);
