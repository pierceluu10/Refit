// Excerpt of alanagoyal/branded at cf8f84cc8bfc, lib/billing-state.ts.
import type Stripe from 'stripe';

export const snapshot = (subscriptions: Stripe.Subscription[], now: number) => {
  const entitled = subscriptions.filter(
    (subscription) => subscription.current_period_end * 1000 > now,
  );
  const subscription = entitled[0];
  return {
    current_period_end: subscription?.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
  };
};
