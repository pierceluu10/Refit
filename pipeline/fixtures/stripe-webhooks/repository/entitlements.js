import { stripe } from './client.js';

export class MissingSubscriptionPeriodError extends Error {}

export function handleWebhook(body, signature, secret) {
  const event = stripe.webhooks.constructEvent(body, signature, secret);
  if (event.type !== 'customer.subscription.updated') return { ignored: true };
  const subscription = event.data.object;
  if (
    typeof subscription.current_period_start !== 'number' ||
    typeof subscription.current_period_end !== 'number'
  ) {
    throw new MissingSubscriptionPeriodError('The subscription billing period is missing.');
  }
  return {
    subscription: subscription.id,
    startsAt: subscription.current_period_start,
    endsAt: subscription.current_period_end,
    incomingApiVersion: event.api_version,
  };
}
