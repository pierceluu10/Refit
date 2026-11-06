// Illustrative fixture code.
import { loadStripe } from '@stripe/stripe-js';

export default async function Checkout() {
  const stripe = await loadStripe(process.env.NEXT_PUBLIC_STRIPE_KEY ?? '');
  return stripe;
}
