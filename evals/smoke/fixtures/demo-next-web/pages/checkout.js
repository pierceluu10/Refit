import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_KEY);

export default function Checkout() {
  async function pay() {
    const stripe = await stripePromise;
    await stripe.redirectToCheckout({ sessionId: 'example' });
  }
  return <button onClick={pay}>Pay</button>;
}
