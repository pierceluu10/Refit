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
2. **Generated Stripe checks for repositories without tests,** which is 83 of the 100. Run the migrated code paths against Stripe responses for the old and new API versions. Option to research first: Stripe's official `stripe-mock` server, and whether it can serve specific historical versions. **Researched October 15:** it can, through its `-spec` and `-fixtures` flags and each `stripe/openapi` release's files. [Generated checks](GENERATED-CHECKS.md) now run simple exported functions against versioned stripe-mock inside the offline sandbox (0.29.0).
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

## Self-maintaining pipeline (October 15, 2026)

The goal of this round was a pipeline that catches as many real Stripe breaks as possible, fixes them automatically and can run unattended in worker mode. Results are in [STRIPE-BENCHMARK.md](STRIPE-BENCHMARK.md#self-maintaining-pipeline-before-and-after).

1. **Escapes no longer downgrade reads.** Traced SDK responses, webhook payloads and values with a proven `Stripe.*` type stay confirmed when they are passed into functions, returned, stored or aliased. Only direct mutations downgrade a read: property assignment, `delete`, `++`/`--`, mutating array methods, `Object.assign`-style statics, a method called on the binding itself, rebinding a client, or method replacement through a re-exported module namespace. The repository-wide alias doubt for imports that may resolve to unscanned declaration files no longer applies to reads. Declared Stripe types confirm and no longer block automation unless the value is mutated. Edits for request renames, endpoint replacements and the price-ID webhook rule keep the earlier, stricter escape analysis.
2. **Response enum additions no longer block Stripe full-diff gating.** Stripe can add values to open response enums without a version change ([API versioning: enums](https://docs.stripe.com/api/versioning#enums)). A new value blocks only when the code switches over that field or checks it with `never`. Real 2023 → 2026 pairs produce about 100,000 `oasdiff` entries (85 MB), so the raw output limit is now 256 MiB, and informational entries are dropped from the stored report. Production mode now completes on real Stripe specifications.
3. **Field moves and one-patch upgrades.** Pierce's price-ID webhook rule (`stripe-subscription-periods.ts`) is unchanged. The same file now also moves `subscription.current_period_start/end` reads on **SDK responses** to the subscription items (earliest start, latest end). It runs only when the target contract defines the item periods. `invoice.subscription` is covered by Pierce's [configured nested moves](PROPERTY-MOVES.md) (0.23.0), so this branch does not add a second rule for it. Patches that use a rule or AI also bump the repository's literal Stripe `apiVersion`. With `--ai-patch`, rule edits are deterministic, and the model receives only the confirmed findings no rule covers. The matching Stripe changelog pages are pinned in [`benchmarks/stripe-changelog/`](benchmarks/stripe-changelog/) (URL, raw Markdown, SHA-256) and attached with `refit run --documentation-snapshot`.

### Open decisions

1. **Six labels look wrong.** Six reads labelled `stripe-unaffected` are `session.subscription` inside `if (event.type === 'invoice.payment_succeeded')`, where `session` is `event.data.object as Stripe.Checkout.Session`. At runtime the object is an Invoice, and `invoice.subscription` was removed in basil, so these are real breaks. The label oracle followed the cast. They are scored as false positives below; relabelling them as `breaking` raises confirmed precision on the labelled set from 86% to 100%. Decide whether to relabel, and have a human confirm.
2. **The webhook gate is repository-wide.** *Decided (option b PR): unmigrated webhook reads no longer block patch generation or validation when other confirmed work exists. They stay unresolved, and publication still refuses them.* Previously, any webhook finding blocked every patch in the repository; on the benchmark that held back 19 of the 38 period rewrites (9 repositories).
3. **Webhook payloads without a price policy.** *Decided (option b PR): implemented as the version-tolerant read in [subscription periods](STRIPE-SUBSCRIPTION-PERIODS.md#without-a-price-policy), using `Reflect.get` instead of a cast. Needs Pierce's sign-off.* Before, only the price-ID policy could migrate webhook period reads. A policy-free option is a dual-shape read that uses the subscription-level field when present (old endpoint version) and the widest item period otherwise. TypeScript needs a cast for that, because the new SDK types no longer declare the old field. This changes Pierce's design, so it needs his agreement.
4. **Typed values and unsigned payloads now confirm.** A `JSON.parse` body cast to `Stripe.Subscription` confirms through its declared type and carries no webhook evidence, so the incoming-version gate does not apply to it. The deterministic rules still skip typed values, but AI patches can edit them.
5. **Worker mode is not unattended yet.** Production mode now completes, but a 2023 → 2026 Stripe upgrade still has 1,300 to 3,800 blocking level-2/3 changes per repository. Most are response-side: removed properties the code never reads, `any-of` additions for expandable fields, became-nullable or optional, `max-length-unset`. Every called operation gets an operation impact, which blocks AI. A proposed policy: response-side changes block only when the analyzer sees a read of that property. That needs property-path mapping for non-removal changes. A narrower, provable step is proposed separately: a removed response property that lies inside an expandable field's expanded object cannot appear unless a request expands that field. It stops blocking when no literal `expand` names the field and no other `expand` mention exists. In the local basil lab this removes 47 of the 54 blocking changes on the called operations. The 7 that remain are direct removals the code never reads (`invoice.paid`, `line_item.tax_rates`, …), which still need the read-based policy above.
6. **Closed enums.** Stripe's spec doesn't mark which enums are open. Response enum additions are treated as non-blocking unless the code switches over the field. A closed enum that gains a value in a new version, on a field the code compares with `===` but never switches over, is not flagged.
7. **The `stripe` package is not upgraded.** This blocks every benchmark patch from building. Bumping only the `apiVersion` literal breaks TypeScript builds on older stripe-node versions: their `apiVersion` type is a literal of their own version, and their `SubscriptionItem` lacks the period fields. This is verified against stripe@12.9.0 and stripe@16.12.0 types, and all six proposed benchmark patches are affected. Upgrading the package needs network access to regenerate the lockfile inside the patch flow.
8. **Widest item period.** Without a price policy, the SDK-response rule uses the earliest item start and the latest item end. This equals the old value when all items share one period. Whether that is the right entitlement for subscriptions with mixed item periods is an application decision.
9. **AI budget.** `~/.refit/ai-budget/budget.json` records a $1 limit ($0.76 spent) while `.env` sets `REFIT_AI_BUDGET_USD=3`. Refit refuses to spend while they disagree, so the AI part of the benchmark could not run. Raising the limit means resetting or migrating that ledger, which is the owner's call.
10. **Sandbox limits stop validation.** Of the three affected repositories with runnable checks, none reached them. `alanagoyal/branded` exceeds the 512 MB `/workspace` tmpfs while installing dependencies. `odota/core` has lockfile entries without registry integrity. `pretzelai/stripe-no-webhooks` tests with `bun`. Raising the tmpfs size or adding images is a sandbox-security decision.
