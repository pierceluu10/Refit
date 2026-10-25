## Why this needs review

Refit opened this draft for review instead of stopping (owner decision 1). **Don't merge until you have checked each item.**

- Refit asked an AI model for this patch. Checks that pass do not show that it keeps what the code does. **Check:** Read each AI-written line listed under Why this needs review as you would a teammate’s.
  - None: every changed line comes from a Refit rule.
- Webhook payload reads require separate incoming API-version and migration-policy review. **Check:** Set the webhook endpoint API version to `2026-09-30.endive` when you deploy, or confirm it already is.
- Refit cannot trace which API version the code listed here sends, so the patch leaves it unchanged. Refit compared the `2023-10-16` contract with `2026-09-30.endive`; if this code sends another version, what needs migrating can differ. **Check:** Set each version listed here to `2026-09-30.endive` where its value comes from, and check what this code needs for the version it sends now.
  - `convex/stripe.ts:28`
  - `convex/stripe.ts:49`

## Webhook API version not verified

This patch changes webhook handlers. Stripe sends webhooks in the API version set on the webhook endpoint in the Stripe dashboard, which Refit can't see from code. Before merging, check the endpoint's API version in Dashboard > Developers > Webhooks and confirm it matches `2026-09-30.endive`, or update it when you deploy.

- `convex/stripe.ts:81` (`invoice.payment_succeeded`)

## Usages left for you

**Don't merge until you have migrated or checked each usage Refit left.** 1 usage of the breaking changes is still unmigrated: no rule changed it, and the checks passed without it. The locations are in Refit's run report.

## Overview

Stripe API 2026-09-30.endive removes fields this code reads. AI (`gpt-5.4-mini-2026-03-17`), checked by Refit, migrates 3 confirmed usages in 1 file. Stripe documents the change: [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end.md](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end.md), [docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects.md](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects.md).

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `invoice.subscription`, `subscription.current_period_end` in Stripe API 2026-09-30.endive.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `convex/stripe.ts`: Migrates reads of `subscription.current_period_end`, `invoice.subscription` to the documented new locations.
- `convex/stripe-subscription-period.ts`: Adds the generated helper that reads the removed fields under either API version.
- Review: Uses the item the code already selects for items on different billing periods: `items.data[0]`.

## Code Changes

`convex/stripe.ts:9`

```diff
 import { internal } from "./_generated/api";
 import { Id } from "./_generated/dataModel";
+import { getSubscriptionPeriodEnd } from './stripe-subscription-period';
 
 type Metadata = {
```

`convex/stripe.ts:76`

```diff
           userId,
           subscriptionId: subscription.id,
-          endsOn: subscription.current_period_end * 1000,
+          endsOn: (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000,
         });
       }
```

`convex/stripe.ts:87`

```diff
         await ctx.runMutation(internal.users.updateSubscriptionBySubId, {
           subscriptionId: subscription.items.data[0]?.price.id,
-          endsOn: subscription.current_period_end * 1000,
+          endsOn: (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000,
         });
       }
```

New file `convex/stripe-subscription-period.ts`; see Files changed.

## Automated Verification Gates

- Evidence Strength: **Type-checked only.** No code ran.
- Test Suite Output: `npx --no-install tsc --noEmit --pretty false -p .` passed on the original and migrated code in offline Docker. Generated stripe-mock checks did not run.
- Linter & Static Analysis: TypeScript type check is the test command above; Refit rescanned the migrated code and 1 usage of the breaking changes remains.
- Security Scans: Not run.

## Not Verified

- Refit made no request to Stripe, and `npx --no-install tsc --noEmit --pretty false -p .` runs none of this repository's code.
- The AI-written lines are checked only by the commands above; read them as you would a teammate’s.
- Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.
- 1 usage is still unmigrated.

## Rollback

- Revert this pull request. It changes 2 files and adds no database migration or environment variable.
- It removes the generated `convex/stripe-subscription-period.ts`.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes against the provider page linked in Overview.
- [ ] Set the webhook endpoint API version to `2026-09-30.endive` when you deploy, or confirm it already is.
- [ ] Read each AI-written line listed under Why this needs review as you would a teammate’s.
- [ ] Set each version listed here to `2026-09-30.endive` where its value comes from, and check what this code needs for the version it sends now.
- [ ] Migrate the 1 usage Refit left unmigrated.
- [ ] Confirm the selected item is the one whose period this code needs when items bill on different periods (see Key Changes).
- [ ] Run the code this patch changes, or add a test that does: `npx --no-install tsc --noEmit --pretty false -p .` does not run it.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `970d72753414`.

<!-- refit-migration:e91c1ba622cb200e988a6f6ee9290c7d3e95b67c6ae0ff747db45bf9e9234376 -->

<!-- refit-evidence "runId": "970d72753414c1eaff706cb9e9f9eb0da56140a6da68029c303d677a56459003", "patchHash": "d2681f6d5332c6d872edcec520db0a151fb44068935b476125a804be1abab1f9", "refit": "<release>" -->
