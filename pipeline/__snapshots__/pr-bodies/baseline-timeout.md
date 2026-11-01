## Usages left for you

**Don't merge until you have migrated or checked each usage Refit left.** 24 usages of the breaking changes (21 confirmed, 3 traced with less certainty) are still unmigrated: no rule changed them. Each is listed under Left Unchanged. Refit could not trace 19 reads of removed field names to a Stripe object, so it left them unchanged; each is listed under Left Unchanged.

## Overview

Stripe API 2026-09-30.endive removes fields this code reads. A deterministic Refit rule migrates 2 of 23 confirmed usages in 1 file.

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `charge.invoice`, `invoice.charge`, `invoice.subscription`, `invoice.subscription_details`, `invoiceitem.price`, and 5 more in Stripe API 2026-09-30.endive.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `server/lib/stripe.js`: Moves the pinned API version from `2024-12-18.acacia` to `2026-09-30.endive`.
- `server/routes/stripe-webhooks.js`: Migrates reads of `subscription.current_period_start`, `subscription.current_period_end` to the documented new locations.
- `server/routes/stripe-subscription-period.js`: Adds the generated helper that reads the removed fields under either API version.
- Review: Uses the item the code already selects for items on different billing periods: `items.data[0]`.

## Code Changes

`server/lib/stripe.js:11` in `getStripe()`

```diff
         try {
             stripe = new Stripe(config.stripeSecretKey, {
-                apiVersion: '2024-12-18.acacia',
+                apiVersion: '2026-09-30.endive',
             });
         } catch (err) {
```

`server/routes/stripe-webhooks.js:6`

```diff
 import logger from '../lib/logger.js';
 import { issueLicenseForCheckout } from '../lib/license-issuer.js';
+import { getSubscriptionPeriodStart, getSubscriptionPeriodEnd } from './stripe-subscription-period.js';
 
 const VALID_TIERS = new Set(['free', 'pro', 'enterprise']);
```

`server/routes/stripe-webhooks.js:248` in `stripeWebhookHandler()`

```diff
                 const rawSubTier = sub.metadata?.tier || (sub.items?.data?.[0]?.price?.metadata?.tier) || 'pro';
                 const tier = await reconcileTierFromPrice(stripe, sub, rawSubTier, null);
-                const periodStart = new Date(sub.current_period_start * 1000).toISOString();
-                const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
+                const periodStart = new Date((getSubscriptionPeriodStart(sub, (items) => items[0])) * 1000).toISOString();
+                const periodEnd = new Date((getSubscriptionPeriodEnd(sub, (items) => items[0])) * 1000).toISOString();
 
                 // Never let a routine subscription update lift a refund/dispute
```

New file `server/routes/stripe-subscription-period.js`; see Files changed.

## Automated Verification Gates

- Evidence Strength: **None.** The checks did not pass, so nothing in this patch is verified.
- Test Suite Output: **Validation did not pass (error).** `npm test` could not finish on the original code (Check exceeded 120 seconds; the container was stopped). Refit did not run the checks on the migrated code.
- Linter & Static Analysis: Not run; Refit rescanned the migrated code and 24 usages of the breaking changes remain, plus 19 untraced reads of removed field names.
- Security Scans: Not run.

## Left Unchanged

Refit traced these usages to Stripe objects but no rule changed them, so the migrated code still uses what the upgrade removes. Migrate each one before merging:

- `server/routes/stripe-webhooks.js:29` reads `.price` (`invoiceitem.price` or `line_item.price`)
- `server/routes/stripe-webhooks.js:316` reads `.charge` (`invoice.charge`)
- `server/routes/stripe-webhooks.js:340` reads `.invoice` (`charge.invoice`)
- `server/routes/stripe-webhooks.js:341` reads `.invoice` (`charge.invoice`)
- `server/routes/stripe-webhooks.js:342` reads `.invoice` (`charge.invoice`)
- `server/routes/stripe-webhooks.js:343` reads `.invoice` (`charge.invoice`)
- `server/routes/stripe-webhooks.js:382` reads `.charge` (`invoice.charge`)
- `server/routes/stripe-webhooks.js:383` reads `.invoice` (`charge.invoice`)
- `server/routes/stripe-webhooks.js:384` reads `.invoice` (`charge.invoice`)
- `server/routes/stripe-webhooks.js:385` reads `.invoice` (`charge.invoice`)
- `server/routes/stripe-webhooks.js:386` reads `.invoice` (`charge.invoice`)
- `server/routes/stripe-webhooks.js:410` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:414` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:421` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:427` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:436` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:449` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:453` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:459` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:467` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:488` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:495` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:507` reads `.subscription` (`invoice.subscription`)
- `server/routes/stripe-webhooks.js:516` reads `.subscription` (`invoice.subscription`)

Refit could not trace these reads of removed field names to a Stripe object, so it did not change them. Check each one: a read of a Stripe object here breaks after the upgrade.

- `server/routes/billing.js:107` reads `.unit_amount`
- `server/routes/billing.js:110` reads `.unit_amount`
- `server/routes/stripe-webhooks.js:30` reads `.price`
- `server/routes/stripe-webhooks.js:31` reads `.price`
- `server/routes/stripe-webhooks.js:62` reads `.subscription`
- `server/routes/stripe-webhooks.js:63` reads `.subscription`
- `server/routes/stripe-webhooks.js:63` reads `.subscription_details`
- `server/routes/stripe-webhooks.js:64` reads `.subscription`
- `server/routes/stripe-webhooks.js:68` reads `.current_period_start`
- `server/routes/stripe-webhooks.js:69` reads `.current_period_end`
- `server/routes/stripe-webhooks.js:344` reads `.subscription`
- `server/routes/stripe-webhooks.js:387` reads `.subscription`
- `server/__tests__/stripe-webhooks.test.js:201` reads `.subscription`
- `server/__tests__/stripe-webhooks.test.js:208` reads `.subscription`
- `server/__tests__/stripe-webhooks.test.js:215` reads `.current_period_start`
- `server/__tests__/stripe-webhooks.test.js:216` reads `.current_period_end`
- `server/__tests__/stripe-webhooks.test.js:223` reads `.current_period_start`
- `server/__tests__/stripe-webhooks.test.js:224` reads `.current_period_end`
- `server/__tests__/stripe-webhooks.test.js:227` reads `.subscription`

## Not Verified

- Refit made no request to Stripe, and the checks did not pass or did not run on this patch.
- Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.
- 19 untraced reads were left unchanged; see Left Unchanged.
- 24 usages are still unmigrated.

## Rollback

- Revert this pull request. It changes 3 files and adds no database migration or environment variable.
- The revert restores the pinned API version `2024-12-18.acacia`.
- It removes the generated `server/routes/stripe-subscription-period.js`.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes.
- [ ] Set each webhook endpoint's API version to `2026-09-30.endive` when you deploy. The generated helpers read the old and the new payload, so the handlers work before and after.
- [ ] Check each read under Left Unchanged.
- [ ] Migrate the 24 usages Refit left unmigrated (see Left Unchanged).
- [ ] Confirm the selected item is the one whose period this code needs when items bill on different periods (see Key Changes).
- [ ] Make `npm test` pass on the original code, or configure a check that does, then run Refit again.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `291e49f1a407`.
- Publication: Local review artifact; Refit has not pushed a branch or opened a pull request.

<!-- refit-migration:32d47a7c6f3cb0d1455052a6fd328229c4709357a9fb58d2a75f7bf4400a6cd3 -->

<!-- refit-evidence "runId": "291e49f1a4074cce80ccf73c1f552adba76a69296c48331e5d738769a7ee4b8b", "patchHash": "dd2d0482f3343a111c85bfeabf25e41d3631ed4976bf71f9fef8d9e766e79d3a", "refit": "<release>" -->
