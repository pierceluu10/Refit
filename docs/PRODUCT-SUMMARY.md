# Refit: what works end to end

_As of October 16, 2026 (Refit 0.35.0). Every number below comes from runs recorded in [the Stripe benchmark](STRIPE-BENCHMARK.md) and [readiness checkpoints](READINESS.md)._

Refit is Dependabot for API changes. When a provider ships a new API version, Refit reads the old and new API contracts and finds the exact lines in a customer's code that break. It writes the migration, runs the repository's own checks in an offline sandbox, and opens a draft pull request for a human to review. It never merges.

## The pipeline, as it runs today

1. **Detect.** `refit agents` finds which provider SDKs a repository uses, from package manifests, lockfiles and raw API hostnames. It suggests only the provider agents Refit has, and a pull request that adds a new SDK gets one suggestion comment. Nothing activates without explicit approval.
2. **Diff the contracts.** Refit diffs the provider's published OpenAPI documents for the repository's pinned version and the target version: removed response fields, moved fields, and removed request parameters.
3. **Trace the code.** A TypeScript-AST scanner follows SDK clients through imports, aliases, helpers and callbacks to the exact reads and requests the change breaks.
4. **Fix.** Reviewed deterministic rules handle known migrations. AI (`gpt-5.6-luna`) is used only where no rule applies, behind a budget ledger, a substitution guard and one bounded repair. Anything ambiguous stops for review.
5. **Validate.** Refit installs locked dependencies in Docker and runs the repository's tests or typecheck, plus generated checks against a local Stripe mock. Validation runs with no network access, before and after the patch.
6. **Publish.** A draft PR from the Refit Agent GitHub App shows the changed code, the evidence and anything left to check.

## Measured on 150 real open-source Stripe apps

Target: Stripe `2026-09-30.endive`. The 100 original repositories plus 50 frozen held-out repositories never used for tuning.

| | |
|---|---|
| Stripe SDK calls found / traced to a client | 1,877 / 722 |
| Repositories with confirmed breaking usage | **63 of 150** (225 confirmed usages) |
| Validated fixes published as draft PRs (forks in `refit-dev`) | **5** |
| Hand-reviewed correct (checklist: right replacement, old payloads still work, nothing unrelated, upgrade complete) | **5 of 5** |
| Same outcome on a repeat run, held-out set | **50 of 50** |
| AI spend for 4 held-out runs and the 100-repository run | **$0.059** (cap $5) |
| Live vendor API calls | 0 |

Each published PR moves the removed `subscription.current_period_end` and `invoice.subscription` reads to their new locations. A generated helper keeps old-version webhook payloads working. Each PR also bumps the `apiVersion` pin and upgrades `stripe` from 14–15 to 23. [Example draft PR](https://github.com/refit-dev/full-stack-starter-kit/pull/1).

## Why the evidence gates matter: one Stripe change, three ways to get it wrong

Stripe endive removed `payment_method_types` from Checkout Sessions, PaymentIntents and SetupIntents. **48 of the 63 affected apps send it.**

- **Before Refit checked request parameters**, 4 of its 5 failed validations were this change. The upgraded SDK types rejected the parameter.
- **The AI "fixed" it 4 times out of 4** by renaming it to `allowed_payment_method_types`. The typecheck passed, but the contract defines that field as a filter on dynamically eligible methods, not the same static list. Those PRs would have looked green and changed checkout behavior.
- **One deterministic fix looked validated** because the old SDK types still accepted the parameter. The new API version would have rejected the request at runtime.

Refit now catches the removed parameter statically and stops before any patch or AI request (16 held-out and 25 original repositories). It never ships a plausible guess. Choosing a replacement is a product decision, so it goes to a human.

## What it does not do yet

- **One provider is complete.** Stripe is end to end. OpenAI has a preview adapter. Shopify (a built-in adapter, contract-checked rules and a real-app benchmark) and API deadline tracking (sunset dates and alerts) are in progress; neither has merged yet.
- **Validation is bounded.** Passing checks show the code still typechecks or passes its tests, not that every runtime path works. The 5 published apps have no tests, so evidence is `tsc` plus hand review; generated mock checks could not reach their Convex handlers.
- **Coverage gaps are explicit.** Repositories without an npm, pnpm or Yarn lockfile, dependency installs over 1 GiB, and failing baseline tests are refused rather than guessed at.
- **Hosting is not chosen.** Refit runs today as a CLI plus a self-hosted GitHub App worker (`refit serve`). Hosting and billing are not decided.

Engineering: 1,295 tests passing (78 more gated on Docker and real SDKs), with conventional commits, CI on Node 22 and 24, and versioned pre-releases.
