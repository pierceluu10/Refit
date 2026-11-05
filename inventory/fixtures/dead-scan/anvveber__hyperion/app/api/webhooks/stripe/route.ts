// Excerpt of anvveber/hyperion at 206a9e4c36c7, app/api/webhooks/stripe/route.ts.
import Stripe from 'stripe';
async function updateLocalSubscription(userId: string, stripeSubscription: Stripe.Subscription) {
  const subscriptionItem = stripeSubscription.items.data[0];
  const subscriptionData = stripeSubscription as unknown as Record<string, unknown>;
  const currentPeriodStart = subscriptionData.current_period_start as number | undefined;
  const currentPeriodEnd = subscriptionData.current_period_end as number | undefined;
  const cancelAtPeriodEnd = subscriptionData.cancel_at_period_end as boolean | undefined;
  const invoiceData = invoice as unknown as Record<string, unknown>;
  const paymentIntent = invoiceData.payment_intent as string | null;
