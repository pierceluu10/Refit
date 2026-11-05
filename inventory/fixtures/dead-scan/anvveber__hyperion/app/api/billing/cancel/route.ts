// Excerpt of anvveber/hyperion at 206a9e4c36c7, app/api/billing/cancel/route.ts.
    const stripeSubscription = await cancelStripeSubscription(subscription.stripeSubscriptionId, immediately);

    // Get period end from Stripe subscription items (in newer API versions, it's on items, not subscription)
    const subscriptionItem = stripeSubscription.items?.data?.[0];
    const periodEndTimestamp = subscriptionItem?.current_period_end;
