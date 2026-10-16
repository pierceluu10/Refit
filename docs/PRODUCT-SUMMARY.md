# Refit: what works end to end

_As of October 16, 2026 (Refit 0.38.0). Every number below comes from runs recorded in [Benchmarks](BENCHMARKS.md), [the Stripe benchmark](STRIPE-BENCHMARK.md), [the Shopify benchmark](SHOPIFY-BENCHMARK.md) and [readiness checkpoints](READINESS.md)._

Refit is Dependabot for API changes. When a provider ships a new API version, Refit reads the old and new API contracts and finds the exact lines in a customer's code that break. It writes the migration, runs the repository's own checks in an offline sandbox, and opens a draft pull request for a human to review. It never merges.

## The pipeline, as it runs today

1. **Detect.** `refit agents` finds which provider SDKs a repository uses, from package manifests, lockfiles and raw API hostnames. It suggests only the provider agents Refit has, and a pull request that adds a new SDK gets one suggestion comment. Nothing activates without explicit approval.
2. **Diff the contracts.** Refit diffs the provider's published OpenAPI documents for the repository's pinned version and the target version: removed response fields, moved fields, and removed request parameters.
3. **Trace the code.** A TypeScript-AST scanner follows SDK clients through imports, aliases, helpers and callbacks to the exact reads and requests the change breaks.
4. **Fix.** Reviewed deterministic rules handle known migrations. AI (`gpt-5.6-luna`) is used only where no rule applies, behind a budget ledger, a substitution guard and one bounded repair. Anything ambiguous stops for review.
5. **Validate.** Refit installs locked dependencies in Docker and runs the repository's tests or typecheck, plus generated checks against a local Stripe mock. Validation runs with no network access, before and after the patch.
6. **Publish.** A draft PR from the Refit Agent GitHub App shows the changed code, the evidence and anything left to check.

## Measured on 781 real open-source apps

Stripe target: `2026-09-30.endive`. Three frozen Stripe sets: the original 100, 50 held out from tuning, and 381 fresh repositories frozen on October 16. Two frozen Shopify sets: 50 and 200 fresh apps.

| | Stripe (531) | Shopify (250) |
|---|---|---|
| Repositories with confirmed breaking usage (Stripe) or Admin API usage (Shopify) | **234** | 216 |
| Validated fixes | **10** (5 published as draft PRs) | **7** |
| Hand-reviewed: correct / correct-partial / wrong | 8 / 2 / 0 | 7 / 0 / 0 |
| Apps whose queries already fail on every version the provider serves | n/a | **28** |
| Same outcome on a repeat run | 531 of 531 | 250 of 250 |
| AI spend for every run in 0.38.0 | **$0.02** (cap $5) | $0 (no AI) |
| Live vendor API calls | 0 | 0 |

Each published PR moves the removed `subscription.current_period_end` and `invoice.subscription` reads to their new locations. A generated helper keeps old-version webhook payloads working. Each PR also bumps the `apiVersion` pin and upgrades `stripe` from 14–15 to 23. [Example draft PR](https://github.com/refit-dev/full-stack-starter-kit/pull/1).

## Why the evidence gates matter: one Stripe change, three ways to get it wrong

Stripe endive removed `payment_method_types` from Checkout Sessions, PaymentIntents and SetupIntents. **193 of the 234 affected apps (82%) send it.**

- **Before Refit checked request parameters**, 4 of its 5 failed validations were this change. The upgraded SDK types rejected the parameter.
- **The AI "fixed" it 4 times out of 4** by renaming it to `allowed_payment_method_types`. The typecheck passed, but the contract defines that field as a filter on dynamically eligible methods, not the same static list. Those PRs would have looked green and changed checkout behavior.
- **One deterministic fix looked validated** because the old SDK types still accepted the parameter. The new API version would have rejected the request at runtime.

Refit now catches the removed parameter statically and stops before any patch or AI request (148 fresh, 18 held-out and 27 original repositories). It never ships a plausible guess. Choosing a replacement is a product decision, so it goes to a human.

## What it does not do yet

- **Two providers are end to end.** Stripe, and Shopify Admin GraphQL. OpenAI has a preview adapter. On 200 fresh Shopify apps, Refit patched 13 (6 validated) and stopped the rest with exact reasons: 44 need an SDK upgrade, 39 use REST, 26 build queries at runtime, and 23 have queries that already fail on every version Shopify serves. Most Shopify apps are limited by their framework's SDK, whose major upgrade Refit does not automate.
- **Deadline tracking alerts but does not migrate on its own.** `refit deadlines` matches pinned versions and models against 47 reviewed sunset entries (Shopify, Meta Graph API, OpenAI), and `refit serve --deadline-alerts` opens one GitHub issue per repository and deadline. It found Graph API v18.0 calls in `thematters/matters-server` and a model 7 days from shutdown in `embedelite/chat`. No live issue has been opened yet; the App first needs the Issues permission.
- **Validation is bounded.** Passing checks show the code still typechecks or passes its tests, not that every runtime path works. The 5 published apps have no tests, so evidence is `tsc` plus hand review; generated mock checks could not reach their Convex handlers.
- **Coverage gaps are explicit.** Repositories without an npm, pnpm or Yarn lockfile, dependency installs over 1 GiB, and failing baseline tests are refused rather than guessed at.
- **Hosting is not chosen.** Refit runs today as a CLI plus a self-hosted GitHub App worker (`refit serve`). Hosting and billing are not decided.

Engineering: 1,330 tests passing (78 more gated on Docker and real SDKs), with conventional commits, CI on Node 22 and 24, and versioned pre-releases.
