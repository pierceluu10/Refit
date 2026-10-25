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
- Test Suite Output: `npx --no-install tsc --noEmit --pretty false -p .` reported the same 1 existing type error on the original and migrated code and none new, in offline Docker. Generated stripe-mock checks did not run.
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
