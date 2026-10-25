# PR body examples

**Every body below is regenerated from stored results. None was published, and no PR was republished.** Each one is the snapshot `pipeline/pr-body-snapshots.test.ts` checks, written by `createReviewArtifacts()` (or `modelFixBody()` for the model fix) from a stored `report.json`, rendered the way publication renders it: with the waiver `--publish-unresolved` earns, if any. The last three failed validation, so they are rendered as Refit stores them, as a local review artifact. The fixtures under `pipeline/fixtures/pr-bodies/` keep only what the body reads. Check logs and repair attempts are dropped, lockfile hunks are cut to their first lines (the body only names lockfiles), and `patchHash` is recomputed for the cut diff.

## What a reviewer needed and did not get

I read the 13 draft PRs Refit published under refit-dev (Signl, pci-update, podvex, ampertalent, insightly, wedillybird, AET-App, vibe-stack, niore-platform, BrainTrain-, formail-app, onellm-frontend, goal-reminder) and `docs/PR-TEMPLATE.md`, the way a reviewing engineer would.

| Need | Published drafts | Now |
|---|---|---|
| Why: the provider's own page for the change | No draft links a Stripe changelog page; the only link offered is the OpenAPI spec. | Overview links each changelog page the rule or vendor note cites, including Stripe's Endive entry for `payment_method_types`. |
| What changed, per file | 10 of 13 drafts list the lockfile with "Updates Stripe API usage for the new contract." The pinned API version and the SDK upgrade are not stated. | Key Changes states the pinned version move and `stripe` X → Y for the manifest and the lockfile. Code Changes names the lockfile instead of showing it. |
| The exact checks and results | Stated, but nothing says when the command proves little (e.g. `node -e 0`), and a failed validation says only "Validation did not pass (regression)." | Evidence Strength grades what ran: the repository's tests, a type check only, generated stripe-mock checks only, `node -e 0`, or nothing. A failed check is named with its side and exit code, and a type check with the first error the patch introduced. |
| What was not verified | Not stated; a reviewer has to infer it from silence. | A Not Verified section: no request reached the provider, webhook endpoint versions, AI-written lines, SDK-internal requests, and what is still unmigrated. |
| Each untraced site, with file and line | 9 of 13 drafts pack every untraced site into one Review sentence, up to 524 characters on one line. | A Left Unchanged section lists each site on its own line: 25 entries, then "and N more; every location is in report.json." |
| How to roll back | Not stated. | A Rollback section: revert, plus the pinned version, the SDK version and the generated helper the revert restores or removes, and confirmation that Refit changed nothing outside the repository. |
| What to do before merging | Spread across Review lines and waiver sections. | A Reviewer Checklist with one unchecked box per action. |
| A commit that explains itself | Every migration commit reads `fix: migrate affected stripe API usage` and every model fix `fix: replace retiring AI models`, with no body, so `git log` says nothing about the change. | The commit subject is the PR title without `[Needs review]`. The body has the overview, one line per file, the checks, each source URL and the run, wrapped at 72 columns. |
| A body that fits | No budget. The longest draft is 8,468 characters, but nothing bounds a large patch: publication refused a body over 60,000 characters (GitHub's limit is 65,536), so that patch was never published, not shortened. | A target of 16,000 characters. Code Changes shortens first (80 → 40 → 20 → 0 lines), then site lists (25 → 10 → 3 → 0), and the body says what it shortened. Key Changes, Breaking Changes and the review lines never shorten, so a patch with very many of them can still exceed the target; publication refuses a body over 60,000 characters. |

Still missing:

- **Unmigrated usages in stored reports are counted but not located.** Runs since 2026-10-24 store `patch.unresolvedSites`, and the body lists each one under Left Unchanged. The first seven stored reports below predate that, so their bodies still point to Refit's run report; the last three come from a run that stores them.
- **Stored reports from before 2026-10-21 do not count untraced reads as unresolved.** pci-update's stored `unresolvedFindings` is 0, so its regenerated title has no `[Needs review]` and its commit has no review line. A current run counts the read, so the same patch gets both.
- **Breaking Changes can read "Recorded in the technical evidence."** That happens when the report has no change the body can describe; the template keeps the line.

## The ten shapes

| Shape | Stored result | Characters | What it shows |
|---|---|---|---|
| [Validated deterministic patch](#validated-deterministic-patch) | refit-stripe-fresh/run-6d4f38a-b, laxmanclo/multi-agent-kit | 4,181 | The `['card']` rule, the API version pin and the stripe-node upgrade; checks passed. |
| [Needs-review waiver](#needs-review-waiver) | refit-stripe-fresh/run-6d4f38a-c, MeldinRadoncic/TriboAI | 6,472 | Published only with `--publish-unresolved`: the `webhook-api-version` waiver, with 2 webhook reads still unmigrated. |
| [Untraced reads](#untraced-reads) | refit-stripe-active/run-6d4f38a, amahmood-pci/pci-update | 4,358 | One `.payment_intent` read Refit could not trace, left unchanged and listed with file and line. |
| [AI patch](#ai-patch) | refit-stripe-benchmark/run-prs-all, webdevcody/thumbnail-critique | 4,898 | Lines written by `gpt-5.4-mini-2026-03-17` and checked by Refit, with the webhook waiver. |
| [Model fix](#model-fix) | docs/benchmarks/2026-10-21-model-replacement-results.json, RiP3rQ/AI-Butler | 2,018 | **Simulated checks.** The stored validation for this repository is baseline-failed, so Refit never wrote this body. The four replacements are the stored ones; the checks are marked passed to show the body Refit publishes. |
| [Shopify](#shopify) | refit-shopify-benchmark/run-1, samirjabib/shopify-apps-convex-template | 2,770 | Admin API pin moved from 2025-10 to 2026-04; no GraphQL documents in the app's own code. |
| [Multi-integration collection](#multi-integration-collection) | refit-stripe-fresh/run-6d4f38a-c, tmachnacki/podvex | 4,742 | A real Stripe report rendered as the `stripe` integration of a collection. No stored run comes from a real repository with a collection, so the only collection-specific parts are the integration in Related Telemetry and the `refit-integration` marker. |
| [Unmigrated usages](#unmigrated-usages) | refit-bench run 40081277373, Kanba-co/kanba | 7,580 | **Never published: the type check failed.** Three traced usages no rule migrated, each located under Left Unchanged; the type check fails on one of them. |
| [Type errors](#type-errors) | refit-bench run 40081277373, AlefeSk8/Spotify-Clone-Next.js | 7,484 | **Never published: the type check failed.** The first of 4 type errors the patch introduced, and a page for each rule. |
| [Baseline timeout](#baseline-timeout) | refit-bench run 40081277373, brunobola-portfolio/GitHub-Repo-Manager | 9,382 | **Never published: the check timed out on the original code.** 24 usages left, 21 of them confirmed, and 19 untraced reads. |

Every body is under the 16,000-character budget. A separate test adds 400 untraced sites and 120 long changed lines to the multi-integration report; that body cuts Code Changes to 40 lines, lists 25 sites and "and 375 more", and stays under the budget.

## Validated deterministic patch

Regenerated from refit-stripe-fresh/run-6d4f38a-b, laxmanclo/multi-agent-kit. The `['card']` rule, the API version pin and the stripe-node upgrade; checks passed.

`````markdown
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
- Test Suite Output: `npx --no-install tsc --noEmit --pretty false -p .` passed on the original and migrated code in offline Docker. Generated stripe-mock checks passed on 1 of 1 exported functions.
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
`````

## Needs-review waiver

Regenerated from refit-stripe-fresh/run-6d4f38a-c, MeldinRadoncic/TriboAI. Published only with `--publish-unresolved`: the `webhook-api-version` waiver, with 2 webhook reads still unmigrated.

`````markdown
## Webhook API version not verified

This patch changes webhook handlers. Stripe sends webhooks in the API version set on the webhook endpoint in the Stripe dashboard, which Refit can't see from code. Before merging, check the endpoint's API version in Dashboard > Developers > Webhooks and confirm it matches `2026-09-30.endive`, or update it when you deploy.

- `app/api/webhook/route.js:70` (`invoice_payment_succeeded`)

## Usages left for you

**Don't merge until you have migrated or checked each usage Refit left.** 2 usages of the breaking changes are still unmigrated: no rule changed them, and the checks passed without them. The locations are in Refit's run report.

## Overview

Stripe API 2026-09-30.endive removes fields this code reads and removes request fields this code sends. A deterministic Refit rule migrates 3 confirmed usages in 2 files. Stripe documents the change: [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end), [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `invoice.subscription`, `invoiceitem.subscription`, `subscription.current_period_end` in Stripe API 2026-09-30.endive. Removes request field `payment_method_types`; `['card']` moves to `allowed_payment_method_types` under the owner-approved policy.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `app/api/stripe/route.js`: Sends `allowed_payment_method_types` in place of the removed `payment_method_types`.
- `app/api/webhook/route.js`: Migrates reads of `subscription.current_period_end` to the documented new locations.
- `lib/stripe.js`: Moves the pinned API version from `2023-08-16` to `2026-09-30.endive`.
- `app/api/webhook/stripe-subscription-period.js`: Adds the generated helper that reads the removed fields under either API version.
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

- Evidence Strength: **No meaningful check.** `node -e 0` runs no code and no generated check ran, so this shows only that the dependencies install and the patch applies.
- Test Suite Output: `node -e 0` passed on the original and migrated code in offline Docker. Generated stripe-mock checks could not run any of 2 exported functions on their own.
- Linter & Static Analysis: Not run; Refit rescanned the migrated code and 2 usages of the breaking changes remain.
- Security Scans: Not run.

## Not Verified

- Refit made no request to Stripe, and `node -e 0` runs none of this repository's code.
- Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.
- 2 usages are still unmigrated.

## Rollback

- Revert this pull request. It changes 4 files and adds no database migration or environment variable.
- The revert restores the pinned API version `2023-08-16`.
- It removes the generated `app/api/webhook/stripe-subscription-period.js`.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes against the provider page linked in Overview.
- [ ] Set the webhook endpoint API version to `2026-09-30.endive` when you deploy, or confirm it already is.
- [ ] Confirm cards stay enabled in the Stripe Dashboard.
- [ ] Migrate the 2 usages Refit left unmigrated.
- [ ] Confirm the selected item is the one whose period this code needs when items bill on different periods (see Key Changes).
- [ ] Run the code this patch changes, or add a test that does: `node -e 0` does not run it.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `f87feb0a19dc`.

<!-- refit-migration:aea98588f95dd0413a757c65a968a4a9906ef9c188b9e5a75718324e253947d7 -->

<!-- refit-evidence "runId": "f87feb0a19dc400c870378992e9d67bd6597189dd1ee38c4208c878cfbe8a1b1", "patchHash": "c0aebcfdf045c6dab3eae8aa9476d92a5715c8668ae81a5e77515b87dff9dfa2", "refit": "<release>" -->
`````

## Untraced reads

Regenerated from refit-stripe-active/run-6d4f38a, amahmood-pci/pci-update. One `.payment_intent` read Refit could not trace, left unchanged and listed with file and line.

`````markdown
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
`````

## AI patch

Regenerated from refit-stripe-benchmark/run-prs-all, webdevcody/thumbnail-critique. Lines written by `gpt-5.4-mini-2026-03-17` and checked by Refit, with the webhook waiver.

`````markdown
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
- [ ] Migrate the 1 usage Refit left unmigrated.
- [ ] Confirm the selected item is the one whose period this code needs when items bill on different periods (see Key Changes).
- [ ] Run the code this patch changes, or add a test that does: `npx --no-install tsc --noEmit --pretty false -p .` does not run it.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `970d72753414`.

<!-- refit-migration:e91c1ba622cb200e988a6f6ee9290c7d3e95b67c6ae0ff747db45bf9e9234376 -->

<!-- refit-evidence "runId": "970d72753414c1eaff706cb9e9f9eb0da56140a6da68029c303d677a56459003", "patchHash": "d2681f6d5332c6d872edcec520db0a151fb44068935b476125a804be1abab1f9", "refit": "<release>" -->
`````

## Model fix

Regenerated from docs/benchmarks/2026-10-21-model-replacement-results.json, RiP3rQ/AI-Butler. **Simulated checks.** The stored validation for this repository is baseline-failed, so Refit never wrote this body. The four replacements are the stored ones; the checks are marked passed to show the body Refit publishes.

`````markdown
## Retiring AI models

Refit replaced model IDs that their provider retires, using the replacement in its reviewed deadline registry. Requests to a retired model fail.

| Call | Changed at | Model | Retires | Source |
|---|---|---|---|---|
| `lib/openai.ts:41` `chat.completions.create` | `lib/openai.ts:42` | `gpt-3.5-turbo` → `gpt-5.6-terra` | 2026-10-23 | [provider page](https://developers.openai.com/api/docs/deprecations), checked 2026-10-15 |
| `app/api/chat/route.ts:50` `chat.completions.create` | `app/api/chat/route.ts:51` | `gpt-3.5-turbo` → `gpt-5.6-terra` | 2026-10-23 | [provider page](https://developers.openai.com/api/docs/deprecations), checked 2026-10-15 |
| `app/api/journal/completion/route.ts:14` `createChatCompletion` | `app/api/journal/completion/route.ts:15` | `gpt-3.5-turbo` → `gpt-5.6-terra` | 2026-10-23 | [provider page](https://developers.openai.com/api/docs/deprecations), checked 2026-10-15 |
| `app/api/pdfs/message/route.ts:70` `createChatCompletion` | `app/api/pdfs/message/route.ts:71` | `gpt-3.5-turbo` → `gpt-5.6-terra` | 2026-10-23 | [provider page](https://developers.openai.com/api/docs/deprecations), checked 2026-10-15 |

## Checks

Refit ran the repository's approved checks on `4dadd4021c2d` in offline Docker (`node:22-alpine`), before and after this change:

- Baseline `npm run build`: passed
- Patched `npm run build`: passed

## Not Verified

- A passing check is evidence about that command only. The checks ran without network access, so no request reached OpenAI or Anthropic, and they cannot show how the new model answers.
- A replacement model can change answers, cost, rate limits and supported parameters.

## Rollback

Revert this pull request. It changes only the model IDs in the table above: no dependency, configuration or environment variable.

## Reviewer Checklist

- [ ] Try each changed call against the provider and compare its answers.
- [ ] Confirm `npm run build` exercises the changed calls.

Refit opened this as a draft and never merges it.
`````

## Shopify

Regenerated from refit-shopify-benchmark/run-1, samirjabib/shopify-apps-convex-template. Admin API pin moved from 2025-10 to 2026-04; no GraphQL documents in the app's own code.

`````markdown
## Overview

This app pins Shopify Admin API 2025-10. A deterministic Refit rule moves it to 2026-04 after checking every traced GraphQL document against the 2026-04 schema.

## API Impact & Spec Changes

- Breaking Changes: Moves the Admin API version from 2025-10 to 2026-04. Refit found no Admin GraphQL documents in the app's own code; requests the Shopify SDK makes itself (authentication, billing) were not checked.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `.graphqlrc.ts`: Moves the pinned Admin API version to 2026-04.
- `app/shopify.server.ts`: Moves the pinned Admin API version to 2026-04.

## Code Changes

`.graphqlrc.ts:11` in `getConfig()`

```diff
       default: shopifyApiProject({
         apiType: ApiType.Admin,
-        apiVersion: ApiVersion.October25,
+        apiVersion: ApiVersion.April26,
         documents: [
           "./app/**/*.{js,ts,jsx,tsx}",
```

`app/shopify.server.ts:22`

```diff
   apiKey,
   apiSecretKey,
-  apiVersion: ApiVersion.October25,
+  apiVersion: ApiVersion.April26,
   scopes: process.env.SCOPES?.split(","),
   appUrl,
```

`app/shopify.server.ts:72`

```diff
 
 export default shopify;
-export const apiVersion = ApiVersion.October25;
+export const apiVersion = ApiVersion.April26;
 export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
 export const authenticate = shopify.authenticate;
```

## Automated Verification Gates

- Evidence Strength: **The repository's test command.** Refit does not measure whether it reaches the changed lines.
- Test Suite Output: `npm test` passed on the original and migrated code in offline Docker.
- Linter & Static Analysis: Not run; Refit rescanned the migrated code and every runtime Admin API pin is on 2026-04.
- Security Scans: Not run.

## Not Verified

- Refit made no request to Shopify. The checks ran on this repository's code in offline Docker, so they cover only the code paths they exercise.
- Requests the Shopify SDK makes on its own (authentication, billing) were not checked.

## Rollback

- Revert this pull request. It changes 2 files and adds no database migration or environment variable.
- Refit changed nothing outside this repository.

## Reviewer Checklist

- [ ] Read each change under Code Changes.
- [ ] Confirm `npm test` exercises the code this patch changes, or add a test that does.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `a6212c5cfe66`.

<!-- refit-migration:3266b6f195137419294a495bafdb7b5c1eebeddbe4e6bd2719b06af85fd9516d -->

<!-- refit-evidence "runId": "a6212c5cfe6688957be9e54023331415293845ac621c076e06124bb41c65338f", "patchHash": "3bf3707df12a1ff6832ec45c79c28c1b098940a69a940b92d21e6597c5241752", "refit": "<release>" -->
`````

## Multi-integration collection

Regenerated from refit-stripe-fresh/run-6d4f38a-c, tmachnacki/podvex. A real Stripe report rendered as the `stripe` integration of a collection. No stored run comes from a real repository with a collection, so the only collection-specific parts are the integration in Related Telemetry and the `refit-integration` marker.

`````markdown
## Overview

Stripe API 2026-09-30.endive removes fields this code reads. A deterministic Refit rule migrates 1 confirmed usage in 1 file. Stripe documents the change: [docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects).

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `invoice.subscription` in Stripe API 2026-09-30.endive.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `convex/stripe.ts`: Migrates reads of `invoice.subscription` to the documented new locations. Moves the pinned API version from `2024-06-20` to `2026-09-30.endive`.
- `convex/stripe-subscription-period.ts`: Adds the generated helper that reads the removed fields under either API version.
- `package.json`: Upgrades `stripe` from `16.5.0` to `23.0.0`.
- `package-lock.json`: Upgrades `stripe` from `16.5.0` to `23.0.0`.
- Review: Upgrades `stripe` across major versions, `16.5.0` to `23.0.0`; [its changelog](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md) lists type and behavior changes the checks may not cover.

## Code Changes

`convex/stripe.ts:8`

```diff
 import { action, internalAction } from "./_generated/server";
 import { internal } from "./_generated/api";
+import { getInvoiceSubscription } from './stripe-subscription-period';
 
 type Metadata = {
```

`convex/stripe.ts:27`

```diff
       (process.env.NEXT_PUBLIC_URL as string) ?? "http://localhost:3000";
     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
-      apiVersion: "2024-06-20",
+      apiVersion: "2026-09-30.endive",
     });
     const session = await stripe.checkout.sessions.create({
```

`convex/stripe.ts:65`

```diff
       (process.env.NEXT_PUBLIC_URL as string) ?? "http://localhost:3000";
     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
-      apiVersion: "2024-06-20",
+      apiVersion: "2026-09-30.endive",
     });
```

`convex/stripe.ts:81`

```diff
   handler: async (ctx, args) => {
     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
-      apiVersion: "2024-06-20",
+      apiVersion: "2026-09-30.endive",
     });
```

`convex/stripe.ts:118`

```diff
 
         const subscription = await stripe.subscriptions.retrieve(
-          completedEvent.subscription as string,
+          (getInvoiceSubscription(completedEvent)) as string,
         );
```

New file `convex/stripe-subscription-period.ts`; see Files changed.

`package.json:45`

```diff
     "simplex-noise": "^4.0.2",
     "sonner": "^1.5.0",
-    "stripe": "^16.5.0",
+    "stripe": "^23.0.0",
     "svix": "^1.25.0",
     "tailwind-merge": "^2.4.0",
```

Changes to `package-lock.json` are not shown here; see Files changed.

## Automated Verification Gates

- Evidence Strength: **Type-checked only.** No code ran.
- Test Suite Output: `npx --no-install tsc --noEmit --pretty false -p .` passed on the original and migrated code in offline Docker. Generated stripe-mock checks did not run.
- Linter & Static Analysis: TypeScript type check is the test command above; Refit rescanned the migrated code and 0 usages of the breaking changes remain.
- Security Scans: Not run.

## Not Verified

- Refit made no request to Stripe, and `npx --no-install tsc --noEmit --pretty false -p .` runs none of this repository's code.
- Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.

## Rollback

- Revert this pull request. It changes 4 files and adds no database migration or environment variable.
- The revert restores the pinned API version `2024-06-20`.
- It also restores `stripe` `16.5.0` in the package manifest and lockfile; reinstall dependencies after reverting.
- It removes the generated `convex/stripe-subscription-period.ts`.
- Refit changed nothing outside this repository: no Stripe Dashboard, webhook endpoint or account setting.

## Reviewer Checklist

- [ ] Read each change under Code Changes against the provider page linked in Overview.
- [ ] Run the code this patch changes, or add a test that does: `npx --no-install tsc --noEmit --pretty false -p .` does not run it.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `1da7a5d798d9`, integration `stripe`.

<!-- refit-integration:stripe -->

<!-- refit-migration:d632b2df4c8e4e3b8e9cc0c49de4f4c236e785d0df1eee8255c963ff44b5d0df -->

<!-- refit-evidence "runId": "1da7a5d798d9259e7066a90ce774203bf43b5fc9a399d44fd5bb0cc60b8461b5", "patchHash": "c93ce56b8ae769674c9c162fbad43d3d7ebe185300049054e645fe25a946c2b7", "refit": "<release>" -->
`````

## Unmigrated usages

Regenerated from refit-bench run 40081277373 at `56cecbe`, Kanba-co/kanba (MIT). Stored as a local review artifact, the way a benchmark or any failed validation stores it; Refit never publishes it. The `.price` read at line 226 resolves to two removed fields and is one usage.

`````markdown
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

<!-- refit-evidence "runId": "e657899d75bd444af4cc0889f15c63f8cf1a935a0135e4fb7ab945f78035d9b9", "patchHash": "f5e7b6b81d47c27c8ecd4d4ce55fd9dcaf42b712a0adc84985c70c1329464b6b", "refit": "<release>" -->
`````

## Type errors

Regenerated from refit-bench run 40081277373 at `56cecbe`, AlefeSk8/Spotify-Clone-Next.js (MIT). Stored as a local review artifact; Refit never publishes it. The first type error is the upgraded stripe-node types rejecting `subscription_data.trial_from_plan`, which no rule migrates.

`````markdown
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

<!-- refit-evidence "runId": "104527037b7cbe8867b5c1cfec5b5c49d9ffc3dcde8cdfa9ad9fdff1b3853a26", "patchHash": "f4063a1fbb645a1b4632cc0e5f98b4bacf8864ab1372840bd4916224f4a27c1b", "refit": "<release>" -->
`````

## Baseline timeout

Regenerated from refit-bench run 40081277373 at `56cecbe`, brunobola-portfolio/GitHub-Repo-Manager (Apache-2.0). Stored as a local review artifact; Refit never publishes it. `npm test` did not finish on the original code within 120 seconds, so Refit never ran it on the migrated code.

`````markdown
## Usages left for you

**Don't merge until you have migrated or checked each usage Refit left.** 24 usages of the breaking changes (21 confirmed, 3 traced with less certainty) are still unmigrated: no rule changed them. Each is listed under Left Unchanged. Refit could not trace 19 reads of removed field names to a Stripe object, so it left them unchanged; each is listed under Left Unchanged.

## Overview

Stripe API 2026-09-30.endive removes fields this code reads. A deterministic Refit rule migrates 2 of 23 confirmed usages in 1 file. Stripe documents the change: [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).

## API Impact & Spec Changes

- Breaking Changes: Removes response fields `charge.invoice`, `invoice.charge`, `invoice.subscription`, `invoice.subscription_details`, `invoiceitem.price`, and 5 more in Stripe API 2026-09-30.endive.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `server/lib/stripe.js`: Moves the pinned API version from `2024-12-18.acacia` to `2026-09-30.endive`.
- `server/routes/stripe-webhooks.js`: Migrates reads of `subscription.current_period_start`, `subscription.current_period_end` to the documented new locations. Stripe documents it: [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
- `server/routes/stripe-subscription-period.js`: Adds the generated helper that reads the removed fields under either API version. Stripe documents it: [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
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

- [ ] Read each change under Code Changes against the provider page linked in Overview.
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
`````

## Commit messages

Each draft's commit, regenerated from the same stored results (`pipeline/__snapshots__/commit-messages/`). The subject is the PR title without `[Needs review]`, under 70 characters. Lines wrap at 72 columns, except a URL that does not fit on one line. There are no co-author or "Generated with" lines.

### Validated deterministic patch

```text
fix(stripe): move payment_method_types to allowed_payment_method_types

Stripe API 2026-09-30.endive removes request fields this code sends. A
deterministic Refit rule migrates 1 confirmed usage in 1 file.

- lib/stripe.ts: Sends allowed_payment_method_types in place of the
  removed payment_method_types. Moves the pinned API version from
  2026-02-25.clover to 2026-09-30.endive.
- package.json: Upgrades stripe from 20.4.1 to 23.0.0.
- package-lock.json: Upgrades stripe from 20.4.1 to 23.0.0.

Checks: npx --no-install tsc --noEmit --pretty false -p . passed on the
original and migrated code in offline Docker.

Source: https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions

Refit-Run: ed1c44af5cf2
```

### Needs-review waiver

```text
fix(stripe): migrate removed Stripe API fields

Stripe API 2026-09-30.endive removes fields this code reads and removes
request fields this code sends. A deterministic Refit rule migrates 3
confirmed usages in 2 files.

- app/api/stripe/route.js: Sends allowed_payment_method_types in place
  of the removed payment_method_types.
- app/api/webhook/route.js: Migrates reads of
  subscription.current_period_end to the documented new locations.
- lib/stripe.js: Moves the pinned API version from 2023-08-16 to
  2026-09-30.endive.
- app/api/webhook/stripe-subscription-period.js: Adds the generated
  helper that reads the removed fields under either API version.

Checks: node -e 0 passed on the original and migrated code in offline
Docker.

Needs review: the pull request lists what to check before merging.

Source: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
Source: https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions

Refit-Run: f87feb0a19dc
```

### Untraced reads

```text
fix(stripe): migrate removed API fields

Stripe API 2026-09-30.endive removes fields this code reads and removes
request fields this code sends. A deterministic Refit rule migrates 1
confirmed usage in 1 file.

- api/stripe-checkout.js: Sends allowed_payment_method_types in place of
  the removed payment_method_types.
- package.json: Upgrades stripe from 17.7.0 to 23.0.0.
- package-lock.json: Upgrades stripe from 17.7.0 to 23.0.0.

Checks: npx --no-install tsc --noEmit --pretty false -p . passed on the
original and migrated code in offline Docker.

Needs review: the pull request lists what to check before merging.

Source: https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions

Refit-Run: 37a296da57c7
```

### AI patch

```text
fix(stripe): migrate removed Stripe API fields

Stripe API 2026-09-30.endive removes fields this code reads. AI
(gpt-5.4-mini-2026-03-17), checked by Refit, migrates 3 confirmed usages
in 1 file.

- convex/stripe.ts: Migrates reads of subscription.current_period_end,
  invoice.subscription to the documented new locations.
- convex/stripe-subscription-period.ts: Adds the generated helper that
  reads the removed fields under either API version.

Checks: npx --no-install tsc --noEmit --pretty false -p . passed on the
original and migrated code in offline Docker.

Needs review: the pull request lists what to check before merging.

Source: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end.md
Source: https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects.md

Refit-Run: 970d72753414
```

### Model fix (simulated checks)

```text
fix: replace 4 retiring AI models

- lib/openai.ts:42: gpt-3.5-turbo -> gpt-5.6-terra, retires 2026-10-23
- app/api/chat/route.ts:51: gpt-3.5-turbo -> gpt-5.6-terra, retires
  2026-10-23
- app/api/journal/completion/route.ts:15: gpt-3.5-turbo ->
  gpt-5.6-terra, retires 2026-10-23
- app/api/pdfs/message/route.ts:71: gpt-3.5-turbo -> gpt-5.6-terra,
  retires 2026-10-23

Checks: npm run build passed on the original and passed on the patched
code in offline Docker; no request reached the provider.

Source: https://developers.openai.com/api/docs/deprecations
```

### Shopify

```text
fix(shopify): upgrade Admin API to 2026-04

This app pins Shopify Admin API 2025-10. A deterministic Refit rule
moves it to 2026-04 after checking every traced GraphQL document against
the 2026-04 schema.

- .graphqlrc.ts: Moves the pinned Admin API version to 2026-04.
- app/shopify.server.ts: Moves the pinned Admin API version to 2026-04.

Checks: npm test passed on the original and migrated code in offline
Docker.

Refit-Run: a6212c5cfe66
```

### Multi-integration collection

```text
fix(stripe): migrate removed invoice.subscription reads

Stripe API 2026-09-30.endive removes fields this code reads. A
deterministic Refit rule migrates 1 confirmed usage in 1 file.

- convex/stripe.ts: Migrates reads of invoice.subscription to the
  documented new locations. Moves the pinned API version from 2024-06-20
  to 2026-09-30.endive.
- convex/stripe-subscription-period.ts: Adds the generated helper that
  reads the removed fields under either API version.
- package.json: Upgrades stripe from 16.5.0 to 23.0.0.
- package-lock.json: Upgrades stripe from 16.5.0 to 23.0.0.

Checks: npx --no-install tsc --noEmit --pretty false -p . passed on the
original and migrated code in offline Docker.

Source: https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects

Refit-Run: 1da7a5d798d9
Refit-Integration: stripe
```

### Unmigrated usages

```text
fix(stripe): migrate removed Stripe API fields

Stripe API 2026-09-30.endive removes fields this code reads and removes
request fields this code sends. A deterministic Refit rule migrates 3
confirmed usages in 2 files.

- app/api/stripe/checkout/route.ts: Sends allowed_payment_method_types
  in place of the removed payment_method_types. Stripe documents it:
  [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).
- app/api/stripe/webhook/route.ts: Migrates reads of
  invoice.subscription to the documented new locations. Stripe documents
  it:
  [docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects).
- lib/stripe.ts: Moves the pinned API version from 2023-10-16 to
  2026-09-30.endive.
- app/api/stripe/webhook/stripe-subscription-period.ts: Adds the
  generated helper that reads the removed fields under either API
  version. Stripe documents it:
  [docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects).
- package.json: Upgrades stripe from 14.25.0 to 23.0.0.
- package-lock.json: Upgrades stripe from 14.25.0 to 23.0.0.

Checks: Validation did not pass (regression). npx --no-install tsc
--noEmit --pretty false -p . failed on the migrated code with exit code
2. The patch introduced 2 type errors, the first:
“app/api/stripe/webhook/route.ts(227,42): error TS2339: Property
'current\_period\_start' does not exist on type 'Subscription'.”

Needs review: the pull request lists what to check before merging.

Source: https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions
Source: https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects

Refit-Run: e657899d75bd
```

### Type errors

```text
fix(stripe): migrate removed Stripe API fields

Stripe API 2026-09-30.endive removes fields this code reads and removes
request fields this code sends. A deterministic Refit rule migrates 3
confirmed usages in 2 files.

- app/api/create-checkout-session/route.ts: Sends
  allowed_payment_method_types in place of the removed
  payment_method_types. Stripe documents it:
  [docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).
- libs/stripe.ts: Moves the pinned API version from 2022-11-15 to
  2026-09-30.endive.
- libs/supabaseAdmin.ts: Migrates reads of
  subscription.current_period_start, subscription.current_period_end to
  the documented new locations. Stripe documents it:
  [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
- libs/stripe-subscription-period.ts: Adds the generated helper that
  reads the removed fields under either API version. Stripe documents
  it:
  [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
- package.json: Upgrades stripe from 12.9.0 to 23.0.0.
- yarn.lock: Upgrades stripe from 12.9.0 to 23.0.0.

Checks: Validation did not pass (regression). npx --no-install tsc
--noEmit --pretty false -p . failed on the migrated code with exit code
2. The patch introduced 4 type errors, the first:
“app/api/create-checkout-session/route.ts(41,9): error TS2322: Type '\{
trial\_from\_plan: true; metadata: any; \}' is not assignable to type
'SubscriptionData'.”

Needs review: the pull request lists what to check before merging.

Source: https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions
Source: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end

Refit-Run: 104527037b7c
```

### Baseline timeout

```text
fix(stripe): migrate removed Stripe API fields

Stripe API 2026-09-30.endive removes fields this code reads. A
deterministic Refit rule migrates 2 of 23 confirmed usages in 1 file.

- server/lib/stripe.js: Moves the pinned API version from
  2024-12-18.acacia to 2026-09-30.endive.
- server/routes/stripe-webhooks.js: Migrates reads of
  subscription.current_period_start, subscription.current_period_end to
  the documented new locations. Stripe documents it:
  [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).
- server/routes/stripe-subscription-period.js: Adds the generated helper
  that reads the removed fields under either API version. Stripe
  documents it:
  [docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).

Checks: Validation did not pass (error). npm test could not finish on
the original code (Check exceeded 120 seconds; the container was
stopped). Refit did not run the checks on the migrated code.

Needs review: the pull request lists what to check before merging.

Source: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end

Refit-Run: 291e49f1a407
```
