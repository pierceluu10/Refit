## Webhook API version not verified

This patch changes webhook handlers. Stripe sends webhooks in the API version set on the webhook endpoint in the Stripe dashboard, which Refit can't see from code. Before merging, check the endpoint's API version in Dashboard > Developers > Webhooks and confirm it matches `2026-09-30.endive`, or update it when you deploy.

- `app/api/webhook/route.js:70` (`invoice_payment_succeeded`)

## Overview

Stripe API 2026-09-30.endive removes fields this code reads and removes request fields this code sends. A deterministic Refit rule migrates 3 confirmed usages in 2 files so the code keeps working after the upgrade. Stripe documents the change: [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end), [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `invoice.subscription`, `invoiceitem.subscription`, `subscription.current_period_end` in Stripe API 2026-09-30.endive. Removes request field `payment_method_types`; `['card']` moves to `allowed_payment_method_types` under the owner-approved policy.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `app/api/stripe/route.js`: Sends `allowed_payment_method_types` in place of the removed `payment_method_types`.
- `app/api/webhook/route.js`: Migrates reads of `subscription.current_period_end` to the documented new locations.
- `lib/stripe.js`: Moves the pinned API version from `2023-08-16` to `2026-09-30.endive`.
- `app/api/webhook/stripe-subscription-period.js`: Adds the generated helper that reads the removed fields under either API version.
- Review: **2 confirmed usages of the breaking changes are still unmigrated.** The checks passed without them; migrate them before merging, using the locations in Refit's run report.
- Review: `allowed_payment_method_types` filters the payment methods Stripe finds eligible instead of listing them. Before merging, confirm cards stay enabled in the Stripe Dashboard or the payment method configuration this account uses.
- Review: Uses the item the code already selects for items on different billing periods: `items.data[0]`.

## Code Changes

`app/api/stripe/route.js:42` in `GET()`

```diff
     const stripeSession = await stripe.checkout.sessions.create({
       mode: "subscription",
-      payment_method_types: ["card"],
+      allowed_payment_method_types: ["card"],
       billing_address_collection: "auto",
       line_items: [
```

`app/api/webhook/route.js:7`

```diff
 
 import { stripe } from "@/lib/stripe";
+import { getSubscriptionPeriodEnd } from './stripe-subscription-period.js';
```

`app/api/webhook/route.js:59` in `POST()`

```diff
     const stripeSubscriptionId = subscription.id;
     const stripePriceId = subscription.items.data[0].price.id;
-    const stripeCurrentPeriodEnd = new Date(subscription.current_period_end * 1000)
+    const stripeCurrentPeriodEnd = new Date((getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000)
 
         // Add the user subscription to the database
```

`app/api/webhook/route.js:76` in `POST()`

```diff
             
 
-            await tribodb.query(`UPDATE usersubscription SET stripePriceId = $1, stripeCurrentPeriodEnd = $2 WHERE stripeSubscriptionId = $3`, [subscription.items.data[0].price.id, new Date(subscription.current_period_end * 1000), subscription.id]);
+            await tribodb.query(`UPDATE usersubscription SET stripePriceId = $1, stripeCurrentPeriodEnd = $2 WHERE stripeSubscriptionId = $3`, [subscription.items.data[0].price.id, new Date((getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000), subscription.id]);
             console.log("INVOICE PAYMENT SUCCEEDED: ", event.data.object.customer_details.email);
```

`lib/stripe.js:14`

```diff
 
 export const stripe = new Stripe(stripeSecretKey, {
-    apiVersion: '2023-08-16'
+    apiVersion: '2026-09-30.endive'
 });
```

New file `app/api/webhook/stripe-subscription-period.js`; see Files changed.

## Automated Verification Gates

- Test Suite Output: `node -e 0` passed on the original and migrated code in offline Docker. Generated stripe-mock checks could not run any of 2 exported functions on their own.
- Linter & Static Analysis: Not run; Refit rescanned the migrated code and 2 confirmed usages of the breaking changes remain.
- Security Scans: Not run.

## Not Verified

- Refit made no request to Stripe. The checks ran on this repository's code in offline Docker, so they cover only the code paths they exercise.
- Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.
- 2 confirmed usages are still unmigrated.

## Rollback

- Revert this pull request. It changes 4 files and adds no database migration or environment variable.
- The revert restores the pinned API version `2023-08-16`.
- It removes the generated `app/api/webhook/stripe-subscription-period.js`.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes against the provider page linked in Overview.
- [ ] Set the webhook endpoint API version to `2026-09-30.endive` when you deploy, or confirm it already is.
- [ ] Confirm cards stay enabled in the Stripe Dashboard.
- [ ] Migrate the 2 confirmed usages Refit left unmigrated.
- [ ] Confirm `node -e 0` exercises the code this patch changes, or add a test that does.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `f87feb0a19dc`.

<!-- refit-migration:aea98588f95dd0413a757c65a968a4a9906ef9c188b9e5a75718324e253947d7 -->

<!-- refit-evidence "runId": "f87feb0a19dc400c870378992e9d67bd6597189dd1ee38c4208c878cfbe8a1b1", "patchHash": "c0aebcfdf045c6dab3eae8aa9476d92a5715c8668ae81a5e77515b87dff9dfa2" -->
