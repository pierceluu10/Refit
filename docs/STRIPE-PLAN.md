# Plan: make Refit excellent at maintaining Stripe integrations

Refit's initial target is Stripe integrations in TypeScript/JavaScript GitHub repositories, migrated from versioned Stripe OpenAPI specifications into validated draft pull requests. The [real-repository benchmark](STRIPE-BENCHMARK.md) shows where that stands today. On 100 real Stripe repositories upgrading to the latest API version:
- Refit confirms **0** affected repositories;
- it proposes **0** fixes;
- it opens **0** validated draft PRs.

That's although at least **31** of them read a field (`subscription.current_period_end`) that Stripe removed. This plan closes that gap and defines what "excellent" means in numbers.

## Definition of done

Measured on the frozen 100-repository benchmark (`docs/benchmarks/2026-10-14-stripe-repos.json`), plus a hand-labelled ground truth (phase 0):

| Measure | Today | Target |
|---|---|---|
| Repositories scanned without a crash | 97 | **100** |
| Likely Stripe calls traced | 23% | **≥ 90%** |
| Production mode (full contract diff) completes on real Stripe specs | 0 / 54 | **100%** |
| **Recall:** labelled breaking reads that Refit confirms | 0% | **≥ 90%** |
| **Precision:** confirmed reads that are truly Stripe objects | n/a | **≥ 98%** |
| Confirmed findings that receive a proposal (rule or AI) | n/a | **≥ 90%** |
| Invented migrations reaching a PR (AI evals and guard) | 7/63 tuning, 2/42 held-out | **0** |
| Affected repositories that end in a **validated** draft PR | 0 | **≥ 70% of those with runnable checks** |
| Repositories where any validation is possible | 10 | **≥ 60** (generated Stripe checks) |

Each phase below names the measure it moves. The benchmark is rerun after every phase.

## Phase 0: ground truth (do first)

Without a labelled answer key, "excellent" can't be proven.
- Hand-label **30 of the 100 repositories:** every read of a field that changes between the repository's API version and the target, marked *real Stripe object* or *not Stripe*, plus the correct migration for the top changes.
- Store the labels next to the pinned list. The benchmark then reports **recall and precision**, not just counts.
- Freeze the set. Don't tune scanner heuristics against a hidden 20-repository held-out subset.

## Phase 1: unblock the pipeline

*Moves: crashes, production mode, adapter coverage.*

1. **Skip unparseable files instead of failing the scan** (3 repositories), and report the skipped files.
2. **Make the full contract diff work on real Stripe specs:** before running `oasdiff`, prune both specs to the schemas and operations the repository's adapter uses, so 8–11 MB becomes kilobytes. Then investigate the "could not compare" pairs. Keep the 30s limit, which should be enough after pruning.
3. **Ship a full built-in Stripe adapter.** Generate it per API version from `x-stripeOperations` in Stripe's `spec3.sdk.json` (the benchmark's `pipeline/stripe-benchmark.ts` already does this), so `customers`, `subscriptions`, `invoices`, `checkout.sessions` and so on are mapped, not just `paymentIntents`. Select per repository from its called methods to respect the 100-operation limit, or lift the limit for generated built-ins.

## Phase 2: see Stripe objects where apps actually use them

*Moves: tracing, recall, precision. This overlaps Pierce's scanner work, so split it with him.*

1. **TypeScript `Stripe.*` types:** treat values annotated or asserted as `Stripe.Subscription`, `Stripe.Invoice` and so on (`const s: Stripe.Subscription`, `event.data.object as Stripe.Subscription`, typed parameters) as that object. Map class names to schemas with `x-stripeResource.class_name`. This is the biggest single lever, because typed objects are how Stripe data flows through real apps.
2. **Webhook events:** trace `stripe.webhooks.constructEvent(...)` → `event`, narrow `event.data.object` by `event.type` (`switch`/`if` on `'customer.subscription.updated'` and similar) to the event's object type. 74 of 100 repositories have webhook handlers.
3. **Objects passed between functions:** follow Stripe objects into same-repository functions through typed parameters, instead of stopping at the first call or alias.
4. **Path aliases and remaining client patterns:** `@/lib/stripe`, class fields, factories, from the [SDK coverage benchmark](SDK-COVERAGE.md).
5. **Cut noise:** report a read only when the receiver resolves to a Stripe object. For example, a `.type` in a UI hook is never reported because Stripe removed `line_item.type`.

## Phase 3: fix the real Stripe changes correctly

*Moves: proposals, correctness.*

1. **Model "moved" fields, not just removed ones.** Most basil-era breaks are relocations. `subscription.current_period_end` moved to subscription items, and `invoice.subscription` moved under the invoice's parent details. Treat these as moves to a new path, not deletions with nothing to replace them.
2. **A curated rule catalog** for the most frequent real changes in the benchmark:
   - `current_period_*`
   - `invoice.subscription`
   - `invoice.payment_intent`
   - `line_item.price` / `invoiceitem.price`
   - `line_item.type`
   - `product.features`

   Each rule is deterministic, sourced from Stripe's changelog with links in the PR, and has its own tests.
3. **AI for the long tail,** given Stripe's changelog pages as vendor notes (`documentationSources`). The guard rules and PR evidence apply as they do today.
4. **Upgrade as one PR:** bump the literal `apiVersion` (and the `stripe` package when needed) in the same draft PR as the code changes. That's the change a Stripe developer actually wants to review.

## Phase 4: prove each PR works

*Moves: validation coverage, validated PRs.*

1. **pnpm and yarn dependency preparation,** plus workspace packages. Today it's npm-only: 26 pnpm and 5 yarn repositories in the benchmark.
2. **Generated Stripe checks for repositories without tests,** which is 83 of the 100. Run the migrated code paths against Stripe responses for the old and new API versions. Option to research first: Stripe's official `stripe-mock` server, and whether it can serve specific historical versions.
3. **Real-change evaluation cases:** small apps reproducing the benchmark's real patterns (a webhook handler reading `current_period_end`, a typed helper receiving `Stripe.Invoice`, …), scored by execution like the existing AI evals, with a held-out half.

## Phase 5: real draft PRs end to end

- Fork a handful of benchmark repositories to our own account and let Refit open real draft PRs there, without bothering their maintainers. Check the PR text, diff and validation evidence as a reviewer would.
- Run the background worker (`watch`/`serve`) against them, to prove production mode end to end.

## Order and ownership

| Phase | Depends on | Suggested owner |
|---|---|---|
| 0 Ground truth | — | Otabek |
| 1.1–1.2 Crash skipping, diff pruning | — | Otabek |
| 1.3 Full built-in adapter | — | Otabek |
| 2 Tracing (types, webhooks, aliases) | Coordination with Pierce's scanner work | Pierce, with Otabek on webhooks |
| 3 Rules, AI notes, one-PR upgrades | 1, 2 | Otabek |
| 4 Validation | 1 | Either |
| 5 Real draft PRs | 1–4 | Either |

After each phase, rerun `npm run benchmark:stripe` and update the table at the top of [STRIPE-BENCHMARK.md](STRIPE-BENCHMARK.md).
