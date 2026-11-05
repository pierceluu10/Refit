// Excerpt of charliejo11/gridster at e2898209bfe5, worker/routes/stripe-webhook.js.
import { createStripeClient } from "../shared/stripe.js";
// Stripe API versions from 2025-03-31 onward moved these fields:
//   Invoice.subscription        -> Invoice.parent.subscription_details.subscription
//   Subscription.current_period_end -> Subscription.items.data[0].current_period_end
// We don't pin an apiVersion (see shared/stripe.js), so the account's
// current default applies. Read both the old and new shapes so this
// keeps working regardless of which version is active on the account.

function extractId(value) {
  if (!value) {
    return null;
  }

  return typeof value === "string" ? value : value.id ?? null;
}

function extractInvoiceSubscriptionId(invoice) {
  const legacy = extractId(invoice.subscription);

  if (legacy) {
    return legacy;
  }

  return extractId(invoice.parent?.subscription_details?.subscription);
}

function extractCurrentPeriodEnd(subscription) {
  if (subscription.current_period_end) {
    return subscription.current_period_end;
  }

  return subscription.items?.data?.[0]?.current_period_end ?? null;
}
  const rawPeriodEnd = extractCurrentPeriodEnd(subscription);
  const periodEnd = rawPeriodEnd ? new Date(rawPeriodEnd * 1000).toISOString() : null;

  console.log("Subscription current_period_end extraction", {
    subscriptionId: subscription.id,
    topLevelValue: subscription.current_period_end ?? null,
    firstItemValue: subscription.items?.data?.[0]?.current_period_end ?? null,
    resolved: rawPeriodEnd,
    resolvedIso: periodEnd,
  const subscription = await stripe.subscriptions.retrieve(session.subscription);
async function handleInvoicePaid(supabaseAdmin, invoice) {
  const customerId = extractId(invoice.customer);
  const subscriptionId = extractInvoiceSubscriptionId(invoice);

  console.log("invoice.paid fields", {
    invoiceId: invoice.id,
    rawCustomer: invoice.customer,
    rawSubscription: invoice.subscription,
    parentSubscriptionDetails: invoice.parent?.subscription_details ?? null,
    resolvedCustomerId: customerId,
    resolvedSubscriptionId: subscriptionId,
