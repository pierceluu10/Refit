// Excerpt of CaioF/actors-copilot at fd5b8f3eaaad, app/api/webhooks/stripe/route.ts.
import Stripe from 'stripe';
                const subscription = event.data.object as Stripe.Subscription;
                const firstItem = subscription.items.data[0];
                const priceId = firstItem?.price?.id || null;
                const subscriptionWithPeriod = subscription as Stripe.Subscription & { current_period_end?: number };
                const currentPeriodEnd =
                    subscriptionWithPeriod.current_period_end ??
                    firstItem?.current_period_end ??
                    Math.floor(Date.now() / 1000);
