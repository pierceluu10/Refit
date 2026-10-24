# Reviewing Refit's fixes by hand

Passing checks show the migrated code still typechecks or passes its tests. They don't show the fix is right. Most benchmark repositories have no tests, so every published draft gets a human review, recorded in [`benchmarks/fix-reviews.json`](benchmarks/fix-reviews.json). The benchmark report counts verdicts, not only passing checks.

## Checklist

Answer each for the draft PR, with a one-line note:

1. **Right replacement:** the new code reads what Stripe's changelog names as the replacement for each removed field.
2. **Both versions:** the code still works for events and responses rendered in the old API version.
3. **Nothing unrelated:** no change outside the removed-field reads, imports, the generated helper and the version pin.
4. **Please-check items:** each listed read is either a real gap or correctly left alone; note false alarms.
5. **Upgrade complete:** the `apiVersion` pin and `stripe` package are moved to the target version, or the PR says they are not.
6. **Would merge:** a maintainer could merge it as is.

## Verdicts

- `correct`: 1 to 4 and 6 hold.
- `correct-partial`: the changed code is right, but something needed for the upgrade is missing (usually 5).
- `wrong`: any changed line reads the wrong field, breaks old-version handling, or changes unrelated behavior.
- `unsure`: the reviewer cannot tell without running the application; say what would settle it.

A `wrong` verdict is a Refit bug: add a test case that reproduces it.

## Every validated fix in the October 24 baseline

The latest full baseline, refit-bench run 40117208880 at Refit `604cb81` (all four tuned sets, 589 of 597 rows; 8 repositories missing from two failed shards), validates 54 fixes in benchmark mode. Production mode validates none: every row stops `needs-review` on full-diff contract changes. All 54 diffs were read in full, lockfiles included, by applying the artifact's `migration.patch` to a shallow clone at the pinned commit. 44 had no review; the other 10 were read again because their diffs grew (the card rule and the larger generated helper).

| Verdict         | Reviews |
| --------------- | ------- |
| correct         | 54      |
| correct-partial | 0       |
| wrong           | 0       |
| unsure          | 0       |

What the 54 diffs contain:

- **Card rule, case A.** 44 diffs rename `payment_method_types: ['card']` to `allowed_payment_method_types` (42 on Checkout Sessions, one each on a PaymentIntent and a SetupIntent), in the same patch that moves the version to endive. Six repositories set no `apiVersion`, so the stripe-node upgrade moves it.
- **Webhook and response reads.** 29 diffs read `subscription.current_period_*` and `invoice.subscription` through the generated helper, which returns the old field when present. Every `invoice.subscription` rewrite is inside an invoice event branch, and the Checkout Session's own `subscription` is left alone. No read is rewritten to the new shape only.
- **Type restore.** Three diffs add type-only `Extract<>` narrowings after the stripe-node 23 upgrade. Runtime values do not change.
- **Version moves.** Every Node client's `apiVersion` literal moves to `2026-09-30.endive`, and `stripe` moves to 23.0.0. Lockfiles change only the stripe entries, plus `qs` in one pnpm lockfile, which stripe 23 no longer depends on. One repository keeps its Deno `supabase/functions` clients at basil; they send no removed parameter.

Limits:

- `main` has moved since `604cb81`, for example with #280's local-body card renames. Read the new or changed diffs again once a baseline exists on the final `main`.
- Untouched reads of fields that were already removed at a repository's old pin, in Joseyosei/Share-The-Link, Honey-Bagel/Milanote-Clone, nicuk/docsflow and papay0/Ideate.build, were already broken before Refit ran. The patch leaves them alone and they are noted in each review.
- The artifact's `migration.patch` replaces whole files. Applied, it produces only the changes listed here.
