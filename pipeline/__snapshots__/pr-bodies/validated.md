## Overview

Stripe API 2026-09-30.endive removes request fields this code sends. A deterministic Refit rule migrates 1 confirmed usage in 1 file. Stripe documents the change: [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).

## API Impact & Spec Changes

- Breaking Changes: Removes request field `payment_method_types`; `['card']` moves to `allowed_payment_method_types` under the owner-approved policy.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `lib/stripe.ts`: Sends `allowed_payment_method_types` in place of the removed `payment_method_types`. Moves the pinned API version from `2026-02-25.clover` to `2026-09-30.endive`.
- `package.json`: Upgrades `stripe` from `20.4.1` to `23.0.0`.
- `package-lock.json`: Upgrades `stripe` from `20.4.1` to `23.0.0`.
- Review: `allowed_payment_method_types` filters the payment methods Stripe finds eligible instead of listing them. Before merging, confirm cards stay enabled in the Stripe Dashboard or the payment method configuration this account uses.
- Review: Upgrades `stripe` across major versions, `20.4.1` to `23.0.0`; [its changelog](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md) lists type and behavior changes the checks may not cover.

## Code Changes

`lib/stripe.ts:4`

```diff
 
 export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
-  apiVersion: '2026-02-25.clover',
+  apiVersion: '2026-09-30.endive',
 })
```

`lib/stripe.ts:10` in `createCheckoutSession()`

```diff
   const session = await stripe.checkout.sessions.create({
     mode: 'subscription',
-    payment_method_types: ['card'],
+    allowed_payment_method_types: ['card'],
     customer_email: email,
     line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID!, quantity: 1 }],
```

`package.json:24`

```diff
     "react-dom": "19.2.4",
     "shadcn": "^4.1.0",
-    "stripe": "^20.4.1",
+    "stripe": "^23.0.0",
     "svix": "^1.89.0",
     "tailwind-merge": "^3.5.0",
```

Changes to `package-lock.json` are not shown here; see Files changed.

## Automated Verification Gates

- Evidence Strength: **Type-checked only.** No code ran except the generated stripe-mock checks below.
- Test Suite Output: `npx --no-install tsc --noEmit --pretty false -p .` reported the same 3 existing type errors on the original and migrated code and none new, in offline Docker. Generated stripe-mock checks passed on 1 of 1 exported functions.
- Linter & Static Analysis: TypeScript type check is the test command above; Refit rescanned the migrated code and 0 usages of the breaking changes remain.
- Security Scans: Not run.

## Not Verified

- Refit made no request to Stripe, and `npx --no-install tsc --noEmit --pretty false -p .` runs none of this repository's code; only the generated stripe-mock checks called any of it.
- Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.

## Rollback

- Revert this pull request. It changes 3 files and adds no database migration or environment variable.
- The revert restores the pinned API version `2026-02-25.clover`.
- It also restores `stripe` `20.4.1` in the package manifest and lockfile; reinstall dependencies after reverting.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes against the provider page linked in Overview.
- [ ] Confirm cards stay enabled in the Stripe Dashboard.
- [ ] Run the code this patch changes, or add a test that does: `npx --no-install tsc --noEmit --pretty false -p .` does not run it.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `ed1c44af5cf2`.

<!-- refit-migration:4f4b12cd962c850cb703bda5ca1e11d6156675f5627bde70881d62d08933c217 -->

<!-- refit-evidence "runId": "ed1c44af5cf22850f8cadfe76b5b70f0a9bcd8613f3c9249c7ec6ecf1def8a44", "patchHash": "6a6fe8dc7f79464215be63011ca78d3fd997c22aec07473daa37cd75c814494d", "refit": "<release>" -->
