## Usages left for you

**Don't merge until you have migrated or checked each usage Refit left.** 3 usages of the breaking changes (none confirmed; Refit traced them with less certainty) are still unmigrated: no rule changed them. Each is listed under Left Unchanged.

## Overview

Stripe API 2026-09-30.endive removes fields this code reads and removes request fields this code sends. A deterministic Refit rule migrates 3 confirmed usages in 2 files. Stripe documents the change: [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions), [docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects).

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `invoice.subscription`, `invoiceitem.price`, `line_item.price`, `subscription.current_period_end`, `subscription.current_period_start` in Stripe API 2026-09-30.endive. Removes request field `payment_method_types`; `['card']` moves to `allowed_payment_method_types` under the owner-approved policy.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `app/api/stripe/checkout/route.ts`: Sends `allowed_payment_method_types` in place of the removed `payment_method_types`. Stripe documents it: [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).
- `app/api/stripe/webhook/route.ts`: Migrates reads of `invoice.subscription` to the documented new locations. Stripe documents it: [docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects).
- `lib/stripe.ts`: Moves the pinned API version from `2023-10-16` to `2026-09-30.endive`.
- `app/api/stripe/webhook/stripe-subscription-period.ts`: Adds the generated helper that reads the removed fields under either API version. Stripe documents it: [docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects).
- `package.json`: Upgrades `stripe` from `14.25.0` to `23.0.0`.
- `package-lock.json`: Upgrades `stripe` from `14.25.0` to `23.0.0`.
- Review: `allowed_payment_method_types` filters the payment methods Stripe finds eligible instead of listing them. Before merging, confirm cards stay enabled in the Stripe Dashboard or the payment method configuration this account uses.
- Review: Upgrades `stripe` across major versions, `14.25.0` to `23.0.0`; [its changelog](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md) lists type and behavior changes the checks may not cover.

## Code Changes

`app/api/stripe/checkout/route.ts:172` in `POST()`

```diff
     const session = await stripe.checkout.sessions.create({
       customer: customerId,
-      payment_method_types: ['card'],
+      allowed_payment_method_types: ['card'],
       allow_promotion_codes: true,
       line_items: [
```

`app/api/stripe/webhook/route.ts:5`

```diff
 import { createClient } from '@supabase/supabase-js';
 import Stripe from 'stripe';
+import { getInvoiceSubscription } from './stripe-subscription-period';
 
 // Create a Supabase client with service role for server-side operations
```

`app/api/stripe/webhook/route.ts:163` in `handleInvoicePaymentSucceeded()`

```diff
   console.log(`✅ Invoice payment succeeded: ${invoice.id}`);
   
-  if (invoice.subscription) {
+  if ((getInvoiceSubscription(invoice))) {
     const customerId = invoice.customer as string;
     await syncCustomerFromStripe(customerId);
```

`app/api/stripe/webhook/route.ts:172` in `handleInvoicePaymentFailed()`

```diff
   console.log(`❌ Invoice payment failed: ${invoice.id}`);
   
-  if (invoice.subscription) {
+  if ((getInvoiceSubscription(invoice))) {
     const customerId = invoice.customer as string;
     await syncCustomerFromStripe(customerId);
```

`lib/stripe.ts:4`

```diff
 
 export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
-  apiVersion: '2023-10-16',
+  apiVersion: '2026-09-30.endive',
   typescript: true,
 });
```

New file `app/api/stripe/webhook/stripe-subscription-period.ts`; see Files changed.

`package.json:81`

```diff
     "recharts": "^2.15.4",
     "sonner": "^1.7.4",
-    "stripe": "^14.15.0",
+    "stripe": "^23.0.0",
     "tailwind-merge": "^2.5.2",
     "tailwindcss": "3.3.3",
```

Changes to `package-lock.json` are not shown here; see Files changed.

## Automated Verification Gates

- Evidence Strength: **None.** The checks did not pass, so nothing in this patch is verified.
- Test Suite Output: **Validation did not pass (regression).** `npx --no-install tsc --noEmit --pretty false -p .` failed on the migrated code with exit code 2. The patch introduced 2 type errors, the first: “app/api/stripe/webhook/route.ts(227,42): error TS2339: Property 'current\_period\_start' does not exist on type 'Subscription'.”
- Linter & Static Analysis: TypeScript type check is the test command above; Refit rescanned the migrated code and 3 usages of the breaking changes remain.
- Security Scans: Not run.

## Left Unchanged

Refit traced these usages to Stripe objects but no rule changed them, so the migrated code still uses what the upgrade removes. Migrate each one before merging:

- `app/api/stripe/webhook/route.ts:226` reads `.price` (`invoiceitem.price` or `line_item.price`)
- `app/api/stripe/webhook/route.ts:227` reads `.current_period_start` (`subscription.current_period_start`)
- `app/api/stripe/webhook/route.ts:228` reads `.current_period_end` (`subscription.current_period_end`)

## Not Verified

- Refit made no request to Stripe, and the checks did not pass or did not run on this patch.
- Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.
- 3 usages are still unmigrated.

## Rollback

- Revert this pull request. It changes 6 files and adds no database migration or environment variable.
- The revert restores the pinned API version `2023-10-16`.
- It also restores `stripe` `14.25.0` in the package manifest and lockfile; reinstall dependencies after reverting.
- It removes the generated `app/api/stripe/webhook/stripe-subscription-period.ts`.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes against the provider page linked in Overview.
- [ ] Confirm cards stay enabled in the Stripe Dashboard.
- [ ] Migrate the 3 usages Refit left unmigrated (see Left Unchanged).
- [ ] Fix what `npx --no-install tsc --noEmit --pretty false -p .` reports on the migrated code (see Automated Verification Gates).

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `e657899d75bd`.
- Publication: Local review artifact; Refit has not pushed a branch or opened a pull request.

<!-- refit-migration:3dd7b2df0020f2414ace0f8f56181e93996b3a2f5b8ca7f8063f50ec33fbac44 -->

<!-- refit-evidence "runId": "e657899d75bd444af4cc0889f15c63f8cf1a935a0135e4fb7ab945f78035d9b9", "patchHash": "f5e7b6b81d47c27c8ecd4d4ce55fd9dcaf42b712a0adc84985c70c1329464b6b" -->
