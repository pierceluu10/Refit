## Usages left for you

**Don't merge until you have migrated or checked each usage Refit left.** Refit could not trace 1 read of removed field names to a Stripe object, so it left it unchanged; it is listed under Left Unchanged.

## Overview

Stripe API 2026-09-30.endive removes fields this code reads and removes request fields this code sends. A deterministic Refit rule migrates 3 confirmed usages in 2 files. Stripe documents the change: [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions), [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `invoiceitem.price`, `line_item.price`, `subscription.current_period_end`, `subscription.current_period_start` in Stripe API 2026-09-30.endive. Removes request field `payment_method_types`; `['card']` moves to `allowed_payment_method_types` under the owner-approved policy.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `app/api/create-checkout-session/route.ts`: Sends `allowed_payment_method_types` in place of the removed `payment_method_types`. Stripe documents it: [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).
- `libs/stripe.ts`: Moves the pinned API version from `2022-11-15` to `2026-09-30.endive`.
- `libs/supabaseAdmin.ts`: Migrates reads of `subscription.current_period_start`, `subscription.current_period_end` to the documented new locations. Stripe documents it: [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
- `libs/stripe-subscription-period.ts`: Adds the generated helper that reads the removed fields under either API version. Stripe documents it: [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
- `package.json`: Upgrades `stripe` from `12.9.0` to `23.0.0`.
- `yarn.lock`: Upgrades `stripe` from `12.9.0` to `23.0.0`.
- Review: `allowed_payment_method_types` filters the payment methods Stripe finds eligible instead of listing them. Before merging, confirm cards stay enabled in the Stripe Dashboard or the payment method configuration this account uses.
- Review: Upgrades `stripe` across major versions, `12.9.0` to `23.0.0`; [its changelog](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md) lists type and behavior changes the checks may not cover.
- Review: Uses the item the code already selects for items on different billing periods: `items.data[0]`.

## Code Changes

`app/api/create-checkout-session/route.ts:29` in `POST()`

```diff
 
     const session = await stripe.checkout.sessions.create({
-      payment_method_types: ['card'],
+      allowed_payment_method_types: ['card'],
       billing_address_collection: 'required',
       customer,
```

`libs/stripe.ts:6`

```diff
   process.env.STRIPE_SECRET_KEY ?? '',
   {
-    apiVersion: '2022-11-15',
+    apiVersion: '2026-09-30.endive',
     appInfo: {
       name: 'Spotify Clone NextJS',
```

`libs/supabaseAdmin.ts:9`

```diff
 import { stripe } from './stripe'
 import { toDateTime } from './helpers'
+import { getSubscriptionPeriodStart, getSubscriptionPeriodEnd } from './stripe-subscription-period';
 
 export const supabaseAdmin = createClient<Database>(
```

`libs/supabaseAdmin.ts:163` in `manageSubscriptionStatusChange()`

```diff
         : null,
       current_period_start: toDateTime(
-        subscription.current_period_start
+        (getSubscriptionPeriodStart(subscription, (items) => items[0]))
       ).toISOString(),
       current_period_end: toDateTime(
-        subscription.current_period_end
+        (getSubscriptionPeriodEnd(subscription, (items) => items[0]))
       ).toISOString(),
       created: toDateTime(subscription.created).toISOString(),
```

New file `libs/stripe-subscription-period.ts`; see Files changed.

`package.json:37`

```diff
     "react-icons": "^4.9.0",
     "react-spinners": "^0.13.8",
-    "stripe": "^12.9.0",
+    "stripe": "^23.0.0",
     "tailwind-merge": "^1.13.1",
     "tailwindcss": "3.3.2",
```

Changes to `yarn.lock` are not shown here; see Files changed.

## Automated Verification Gates

- Evidence Strength: **None.** The checks did not pass, so nothing in this patch is verified.
- Test Suite Output: **Validation did not pass (regression).** `npx --no-install tsc --noEmit --pretty false -p .` failed on the migrated code with exit code 2. The patch introduced 4 type errors, the first: “app/api/create-checkout-session/route.ts(41,9): error TS2322: Type '\{ trial\_from\_plan: true; metadata: any; \}' is not assignable to type 'SubscriptionData'.”
- Linter & Static Analysis: TypeScript type check is the test command above; Refit rescanned the migrated code and 0 usages of the breaking changes remain, plus 1 untraced read of removed field names.
- Security Scans: Not run.

## Left Unchanged

Refit could not trace these reads of removed field names to a Stripe object, so it did not change them. Check each one: a read of a Stripe object here breaks after the upgrade.

- `app/api/create-checkout-session/route.ts:12` reads `.price`

## Not Verified

- Refit made no request to Stripe, and the checks did not pass or did not run on this patch.
- Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.
- 1 untraced read was left unchanged; see Left Unchanged.

## Rollback

- Revert this pull request. It changes 6 files and adds no database migration or environment variable.
- The revert restores the pinned API version `2022-11-15`.
- It also restores `stripe` `12.9.0` in the package manifest and lockfile; reinstall dependencies after reverting.
- It removes the generated `libs/stripe-subscription-period.ts`.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes against the provider page linked in Overview.
- [ ] Confirm cards stay enabled in the Stripe Dashboard.
- [ ] Check each read under Left Unchanged.
- [ ] Confirm the selected item is the one whose period this code needs when items bill on different periods (see Key Changes).
- [ ] Fix what `npx --no-install tsc --noEmit --pretty false -p .` reports on the migrated code (see Automated Verification Gates).

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `104527037b7c`.
- Publication: Local review artifact; Refit has not pushed a branch or opened a pull request.

<!-- refit-migration:91de6c8a5d3e9d4e0f9217decb74d26cdea8018b6891bdc781354cf00eb11594 -->

<!-- refit-evidence "runId": "104527037b7cbe8867b5c1cfec5b5c49d9ffc3dcde8cdfa9ad9fdff1b3853a26", "patchHash": "f4063a1fbb645a1b4632cc0e5f98b4bacf8864ab1372840bd4916224f4a27c1b" -->
