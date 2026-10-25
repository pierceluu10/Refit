## Usages left for you

**Don't merge until you have migrated or checked each usage Refit left.** Refit could not trace 1 read of removed field names to a Stripe object, so it left it unchanged; it is listed under Left Unchanged.

## Overview

Stripe API 2026-09-30.endive removes fields this code reads and removes request fields this code sends. A deterministic Refit rule migrates 1 confirmed usage in 1 file. Stripe documents the change: [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `invoice.payment_intent` in Stripe API 2026-09-30.endive. Removes request field `payment_method_types`; `['card']` moves to `allowed_payment_method_types` under the owner-approved policy.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `api/stripe-checkout.js`: Sends `allowed_payment_method_types` in place of the removed `payment_method_types`.
- `package.json`: Upgrades `stripe` from `17.7.0` to `23.0.0`.
- `package-lock.json`: Upgrades `stripe` from `17.7.0` to `23.0.0`.
- Review: `allowed_payment_method_types` filters the payment methods Stripe finds eligible instead of listing them. Before merging, confirm cards stay enabled in the Stripe Dashboard or the payment method configuration this account uses.
- Review: Upgrades `stripe` across major versions, `17.7.0` to `23.0.0`; [its changelog](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md) lists type and behavior changes the checks may not cover.

## Code Changes

`api/stripe-checkout.js:107` in `handler()`

```diff
     const session = await stripe.checkout.sessions.create({
       mode: 'payment',
-      payment_method_types: ['card'],
+      allowed_payment_method_types: ['card'],
       line_items,
       success_url: `${origin}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
```

`package.json:14`

```diff
     "@supabase/supabase-js": "^2.112.2",
     "@tailwindcss/vite": "^4.1.14",
-    "stripe": "^17.6.0",
+    "stripe": "^23.0.0",
     "vite": "^6.2.3"
   },
```

Changes to `package-lock.json` are not shown here; see Files changed.

## Automated Verification Gates

- Evidence Strength: **Type-checked only.** No code ran.
- Test Suite Output: `npx --no-install tsc --noEmit --pretty false -p .` passed on the original and migrated code in offline Docker. Generated stripe-mock checks could not run any of 1 exported functions on their own.
- Linter & Static Analysis: TypeScript type check is the test command above; Refit rescanned the migrated code and 0 usages of the breaking changes remain, plus 1 untraced read of removed field names.
- Security Scans: Not run.

## Left Unchanged

Refit could not trace these reads of removed field names to a Stripe object, so it did not change them. Check each one: a read of a Stripe object here breaks after the upgrade.

- `api/stripe-webhook.js:99` reads `.payment_intent`

## Not Verified

- Refit made no request to Stripe, and `npx --no-install tsc --noEmit --pretty false -p .` runs none of this repository's code.
- 1 untraced read was left unchanged; see Left Unchanged.

## Rollback

- Revert this pull request. It changes 3 files and adds no database migration or environment variable.
- It also restores `stripe` `17.7.0` in the package manifest and lockfile; reinstall dependencies after reverting.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes against the provider page linked in Overview.
- [ ] Confirm cards stay enabled in the Stripe Dashboard.
- [ ] Check each read under Left Unchanged.
- [ ] Run the code this patch changes, or add a test that does: `npx --no-install tsc --noEmit --pretty false -p .` does not run it.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `37a296da57c7`.

<!-- refit-migration:aabfa8f9a90c7ce80c7f3787a77119436b808cfa921bcc94ab365f7c9bd63bf4 -->

<!-- refit-evidence "runId": "37a296da57c79eded74f51772163b097add6b545c999464f9f909277f1c0d75c", "patchHash": "f9d1d43746404aeb0285a8245dee0b7dd69bb6400ad5e1ff6691ad8d5173c3cb", "refit": "<release>" -->
