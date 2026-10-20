# Benchmarks

Every number here comes from real public repositories, frozen before the run that measured them, scanned at a pinned commit, and checked against the providers' real published contracts. No vendor API was called, no scanned repository was contacted, and validation ran each repository's own checks in offline Docker. Detailed method and per-repository results are linked from each section.

**Latest (October 16, unreleased):** validated Stripe fixes rose from 53 to **74** on the same 531 repositories after the stripe-node upgrade gained pnpm and Yarn 1, and a new active-teams set (66 repositories) shows that client factories, not fix logic, limit Refit on current code. See [the section below](#stripe-node-upgrade-for-pnpm-and-yarn-and-the-active-teams-set-october-16).

## Summary (Refit 0.38.0)

| Set | Repositories | Affected | Validated fixes | Main stop |
|---|---|---|---|---|
| Stripe, fresh (frozen 2026-10-16) | **381** | 171 (45%) | **5** | 148 send the `payment_method_types` parameter endive removed |
| Stripe, original | 100 | 40 | 4 | 27 send `payment_method_types` |
| Stripe, held out | 50 | 23 | 1 | 18 send `payment_method_types` |
| Shopify, fresh (frozen 2026-10-16) | **200** | 170 with Admin usage | **6** (13 patched) | 44 need an SDK upgrade, 39 use REST |
| Shopify, original | 50 | 46 with Admin usage | 1 | 15 need an SDK upgrade |
| API deadlines, labelled | 100 (32 labelled) | 28 of 32 exposed | n/a | Detection only |
| API deadlines, fresh sets | 581 | 127 exposed | n/a | Detection only |

- **531 Stripe and 250 Shopify repositories in all; 17 validated fixes** (10 Stripe, 7 Shopify). All 17 were reviewed by hand. None was wrong. 2 are partial: one leaves the version for a person to move, and one does not upgrade the package.
- **One owner decision now blocks most Stripe automation.** Of 234 affected Stripe repositories across the three sets, **193 (82%)** send `payment_method_types`, which `2026-09-30.endive` removed from Checkout Session, PaymentIntent and SetupIntent creation. Refit stops for review, as decided on 2026-10-16. A reviewed replacement policy would let Refit continue past this stop for those repositories.
- **Real breakage is common and precise.** 23 of 200 fresh Shopify apps (12%) send a query that fails on every Admin API version Shopify serves today, each at an exact line. 51 of 381 fresh Stripe apps (13%) also send an OpenAI model that OpenAI retires on 2026-10-23.
- **Outcomes are deterministic.** Repeat runs matched 381 of 381 fresh Stripe repositories, 200 of 200 fresh Shopify apps and 150 of 150 earlier Stripe repositories (publication aside). Since the `payment_method_types` stop, no outcome depends on AI sampling.
- **AI was almost never needed:** **$0.02** across every Stripe run in this release. Deterministic rules made every validated fix.

## stripe-node upgrade for pnpm and Yarn, and the active-teams set (October 16)

No owner decision changed. The stripe-node upgrade now covers root pnpm v9 and Yarn 1 projects and npm lockfiles in any standard formatting, and the benchmark validates Yarn roots ([checkpoint](READINESS.md), [dependency guide](DEPENDENCIES.md#stripe-node-upgrade-in-a-patch)). The same 531 repositories were rerun from pinned worktrees at `7238e46`; Yarn repositories were rerun at `fecd935`, which only lets the harness validate them. Per-repository outcomes: [fresh](benchmarks/2026-10-16-stripe-fixrate-fresh-results.json), [original](benchmarks/2026-10-16-stripe-fixrate-original-results.json), [held out](benchmarks/2026-10-16-stripe-fixrate-heldout-results.json).

| | Original 100 | Held-out 50 | Fresh 381 | All 531 |
|---|---|---|---|---|
| Affected | 40 | 23 | 171 | 234 |
| Validated before (`6d02116`) | 11 | 7 | 35 | 53 |
| **Validated now** | **13** | **9** | **52** | **74** |
| Stopped: `payment_method_types` outside the card rule | 11 | 8 | 63 | 82 |
| Refused at validation preparation | 7 | 2 | 29 | 38 |
| Regression caught by validation | 3 | 1 | 8 | 12 |
| Other stops (declared types, invalid source, no checks, AI declined, failing baseline) | 6 | 3 | 19 | 28 |

- **71 of the 74 are deterministic; three are AI repairs, each read in full.** `akn3107/whatsapp-store-creator` and `brendansudol/punchlines-ai` are correct. In punchlines-ai the period helper takes `(items) => items[0]` from the deterministic rule, because the same function already stores `subscription.items.data[0].price.id`. `ABHINAVJINDAL26/VANTAGE-Golf-Charity-Platform` also wraps a Checkout Session's `subscription`, which Stripe kept, in the Invoice helper; that returns the same value, but the edit is unnecessary. A model edit that adds its own item choice now stops for review (`e47b8ab`); none of these three did.
- **The new upgrades were checked against the package managers, not only against `tsc`.** pnpm re-resolved 30 of 32 upgraded lockfiles byte for byte (the other two carry drift already in the repository); Yarn 1 accepted 12 of 13 with `--frozen-lockfile` (the thirteenth was already stale). Every validated fix also installed its patched lockfile frozen in offline Docker.
- **Every regression is the same template.** All 12 are forks of one Supabase subscription starter whose `libs/supabaseAdmin.ts` assigns stripe-node 23's widened enums (`Price.Type`, `Interval`, now with `OtherString`) to narrow database types. No rule casts them.
- **Yarn 1 needs room.** Four Yarn repositories ran out of the 2 GiB preparation workspace because Yarn 1 downloads every platform's optional binaries. Under the operator's `REFIT_VALIDATION_WORKSPACE=4g` profile, 3 of the 4 validate, each upgrading stripe-node to 23.0.0 in `yarn.lock`, and the fourth passes its checks with findings still unresolved ([results](benchmarks/2026-10-16-stripe-fixrate-yarn-4g-results.json)). These are not counted above.
- **AI spend for every run in this section: $0.07.**

### Active teams (frozen October 16)

The fresh set skews toward old, idle code: 38% pin a 2022–2023 API version, and the median repository has 3 stars. [`2026-10-16-stripe-active-repos.json`](benchmarks/2026-10-16-stripe-active-repos.json) was selected and committed before any run by [`stripe-active-select.mjs`](../scripts/stripe-active-select.mjs), which records every exclusion:

- **Search.** The fresh set's 13 code searches, minus the 531 repositories used before: 6,512 repositories.
- **Criteria.** Not archived or a fork; under 50 MB; a default-branch commit in the 90 days before 2026-10-16 by at least two human authors (bots excluded); a GitHub Actions workflow; `stripe` in the root `package.json`; exactly one root lockfile. 72 qualified; 3,996 had no commit in 90 days and 799 had one human author.
- **Kept.** 66 after dropping repositories already on endive (3), with no derivable API version (2) or that could not be cloned (1). 14 are owned by organisations. 46 of 66 pin a 2025–2026 API version.

| Outcome | Repositories |
|---|---|
| No mapped Stripe SDK call found | 32 |
| Not affected | 22 |
| **Affected** | **11** |
| … stopped: `payment_method_types` outside the card rule | 6 |
| … refused at validation preparation (registry URL, lockfile, size) | 3 |
| … stopped: unparseable source files | 2 |
| … validated | 0 |
| Over scan limits | 1 |

- **Active code breaks less.** 17% are affected, against 45% of the fresh set, because recent pins are closer to the target. The breaking reads are the same ones: `subscription.current_period_end` (5), `invoice.subscription` (4), `subscription.current_period_start` (3).
- **Tracing is the gap.** In 32 repositories Refit found 518 likely Stripe SDK calls and traced none; overall it traced 661 of 1,895 (35%, against 51% on the fresh set). At least 18 of the 32 create the client in a lazy factory, `getStripe()` assigning a module-level `let` on first use, which Refit does not follow. Until it does, "not affected" here means little.

## After the card-only `payment_method_types` policy (October 16)

The owner approved one replacement: an exact `payment_method_types: ['card']` becomes `allowed_payment_method_types: ['card']`, together with the endive pin and the stripe-node upgrade ([policy and results](STRIPE-PAYMENT-METHOD-TYPES.md)). Every other value still stops.

On rerun, validated Stripe fixes rose from **10 to 53** on the same 531 repositories:

- original 100: 4 → 11;
- held-out 50: 1 → 7;
- fresh 381: 5 → 35. `YunmeiYe/nextjs-ai-platform` counts as validated: it hit a dependency-cache lock held by a concurrent run of the same repositories, and validated when rerun alone at `6d02116`, the same commit as the other 380 fresh results.

All 43 card-rule fixes were checked against their diffs. 40 passed `tsc` with no new errors, and 3 are covered only by generated `stripe-mock` checks. 10 patches regressed on other stripe-node 23 type errors; validation caught them, and none was proposed. No other outcome changed. The tables below predate the policy.

## Stripe

### Fresh 381 (October 16)

[`2026-10-16-stripe-fresh-repos.json`](benchmarks/2026-10-16-stripe-fresh-repos.json) was frozen before any run; per-repository outcomes are in [`2026-10-16-stripe-fresh-results.json`](benchmarks/2026-10-16-stripe-fresh-results.json).

- **Search.** 13 GitHub code searches for stripe-node usage in TypeScript and JavaScript: constructors, imports, checkout, subscriptions, webhooks and invoices. They returned 6,363 repositories.
- **Criteria.** After excluding the 150 used before, 3,034 met the [Stripe benchmark](STRIPE-BENCHMARK.md) criteria: not archived, under 50 MB, pushed since 2024, and `stripe` in the root `package.json`.
- **Selection.** The 400 most starred were cloned. 17 run an API version with no published spec (stripe-node below 10, or a 2020 pin), and 2 are already on the target. **All 381 others are kept.**
- **API versions.** 266 come from a literal `apiVersion` and 115 from the locked SDK release. They span 30 API versions, from `2022-08-01` to `2026-08-26.dahlia`. The target is `2026-09-30.endive`.
- **Contracts.** Each version's spec is pinned by `stripe/openapi` tag. Seven new tags were taken from each stripe-node release's `OPENAPI_VERSION`, and each spec's `info.version` was verified.

The run used the full pipeline: deterministic rules, AI patches on `gpt-5.6-luna` behind a fresh $5 ledger, and offline Docker validation with generated `stripe-mock` checks. The final run used pinned worktrees at `6733a99`, split across three processes. An earlier run at `61670ab` gave the same outcome for 381 of 381 repositories.

| Outcome | Repositories |
|---|---|
| Not affected: no confirmed break on a traced call | 129 |
| No mapped Stripe method, or no Stripe SDK call found | 77 |
| Repository exceeds scan limits | 4 |
| **Affected** | **171** |
| … stopped: sends the removed `payment_method_types` request parameter | **148** |
| … stopped: declared Stripe types without traced provenance, or a conflicting SDK pin | 5 |
| … stopped: an invalid source file (a stray brace, an unescaped quote, an unterminated literal; each checked by hand) | 4 |
| … repository refused for validation (tracked `node_modules`, a lockfile over 20,000 records) | 3 |
| … AI evidence over the 64 KiB limit, or AI declined | 3 |
| … proposed, no preparable checks | 2 |
| … validation regression: an AI patch introduced type errors; caught, not proposed | 1 |
| … **validated** | **5** |

- **Confirmed breaking reads:** 514 in 171 repositories. The most common are `subscription.current_period_end` (91 repositories), `invoice.subscription` (71) and `subscription.current_period_start` (22). Refit traced 2,165 of 4,216 likely Stripe SDK calls (51%).
- **Validated fixes.** All 5 are deterministic and were reviewed by hand ([`fix-reviews.json`](benchmarks/fix-reviews.json)). Each is published as a draft PR by Refit Agent on a fork in `refit-dev`; upstream repositories were not touched: [goal-reminder#1](https://github.com/refit-dev/goal-reminder/pull/1), [formail-app#1](https://github.com/refit-dev/formail-app/pull/1), [podvex#1](https://github.com/refit-dev/podvex/pull/1), [onellm-frontend#1](https://github.com/refit-dev/onellm-frontend/pull/1) and [vibe-stack#1](https://github.com/refit-dev/vibe-stack/pull/1).
  - **Correct:** `cdinnison/goal-reminder`, `seangray-dev/formail-app` and `tmachnacki/podvex`. Each moves the reads, bumps every pin and upgrades stripe-node to 23.0.0. In the Convex apps, only the invoice branch's `.subscription` read moves; the Checkout Session branch, whose field Stripe kept, is left alone.
  - **Correct-partial:** `vinroger/onellm-frontend` has no literal pin, so the version stays with the account. `profullstack/vibe-stack` uses pnpm, which the SDK upgrade did not support then; it now validates with the upgrade.
- **The run found two Refit bugs, both fixed with tests.**
  - Three repositories commit Supabase's generated `types_db.ts` as UTF-16, the way PowerShell writes it. TypeScript reads such files, but Refit treated them as binary and stopped the whole repository. Refit now decodes UTF-16 files that start with a byte-order mark and refuses to edit them. Those three now stop on `payment_method_types` instead.
  - Imports like `./stripe.server`, the Remix convention, were not resolved, because `.server` looked like a file extension.
- **Production mode** (the full oasdiff contract diff) completed for 300 of 300. In the first run, 47 timed out under CPU load: four benchmark processes ran at a load average near 11, and one timeout was reused for every repository on the same API version. On a normal load, the same comparisons finish in 2–4 seconds. The benchmark no longer reuses a timeout, and the 30-second limit is unchanged, as the [plan](STRIPE-PLAN.md) records.

### Original 100 and held-out 50 at the final commit

Both sets were rerun at `5f94ab4`.

| | Original 100 | Held-out 50 |
|---|---|---|
| Affected | 40 | 23 |
| Validated | 4 | 1 |
| Stopped: `payment_method_types` | 27 | 18 |
| Same outcome as the previous run (`e4692cc`) | 100/100 | 50/50 |

The 5 validated fixes are the 5 published, hand-reviewed drafts in the [Stripe benchmark](STRIPE-BENCHMARK.md#published-drafts-and-hand-review). Earlier history (labels, recall and precision, the self-maintaining pipeline, the held-out AI run) is there too.

## Shopify

Shopify Admin GraphQL migrations are deterministic, and no AI is used. Details are in the [Shopify benchmark](SHOPIFY-BENCHMARK.md).

| | Original 50 | Fresh 200 |
|---|---|---|
| Patched (version pins moved; every document proven on the target) | 1 | **13** |
| … validated in offline Docker | 1 | **6** |
| Already current, or on the newest version the SDK can name | 6 | 1 |
| Stopped: SDK upgrade needed | 15 | 44 |
| Stopped: REST Admin calls | 7 | 39 |
| Stopped: runtime-built document | 6 | 26 |
| Stopped: **query already fails on every served version** | 5 | **23** |
| Stopped: dynamic, missing or conflicting pin | 6 | 22 |
| Other (no Admin usage, unparseable document, over scan limits) | 4 | 32 |
| Traced Admin documents | 336 (was 255) | 628 |
| Repeat run at the same commit | 50/50 | 200/200 |

- **Helper tracing** raised traced documents on the original 50 from 255 to 336, and halved unreadable ones (55 → 27), with no outcome changes. It reads default exports, Remix `./shopify.server` imports and helper parameters.
- **The fresh set found four bugs, each fixed with a test.** Three let REST calls through, so a REST app's version was moved: template URLs, `createAdminRestApiClient`, and REST resource classes. The fourth refused npm `{ "packages": [...] }` workspaces. The REST fixes stopped 3 wrongly patched apps, none of which had validated.
- **The broken queries are real.** All 23 were rechecked with graphql-js against the served schema. 11 are the old Remix template's `productVariantUpdate(input: ProductVariantInput)`.
- **Most apps are limited by their SDK.** `ApiVersion.October26` needs `@shopify/shopify-api` 14, and app frameworks pin older releases. That SDK upgrade is a major-version change, so Refit stops rather than performing it.

## API deadlines

The hand-labelled [deadline benchmark](DEADLINE-BENCHMARK.md) covers 100 repositories, 32 labelled line by line. Refit flags 28 of 28 exposed repositories at 28/28 repository precision, with 83% OpenAI line precision from live-only evidence.

`refit deadlines` was also run, unlabelled, over both fresh sets ([results](benchmarks/2026-10-16-deadline-fresh-results.json)):

| | Fresh Shopify 200 | Fresh Stripe 381 |
|---|---|---|
| Live exposure to a registry deadline | 62 (31%) | 65 (17%) |
| Past due | 22 | 9 |
| Due within 7 days | 29 (Shopify `2025-10`, due today) | 51 (OpenAI 2026-10-23 retirements) |
| Most common | `shopify-admin-2025-10` (29), `-2025-07` (15) | `gpt-3.5-turbo` (35), `gpt-4` (15) |

These counts are a lower bound for Shopify: the registry starts at `2025-04`, and many apps pin older versions.

## Meta Graph API requests (October 20)

`refit meta-graph` was run over the 33 Meta repositories of the deadline benchmark, and each of the 162 requests it reports in live code was read in context ([labels](benchmarks/2026-10-20-meta-graph-call-labels.json), [results](benchmarks/2026-10-20-meta-graph-call-results.json)). All 162 are real Graph API requests or endpoints, and no reported version, path, edge, field, metric or method disagrees with the code. The version was read for 157 (the other 5 are unversioned), the path and edge for 158, and `fields` for 113. A request was found at 62 of the 63 live Graph pins labelled in the deadline benchmark; the miss is a browser `FB.init`. Labels are one reviewer's single pass. See [Meta Graph API](META-GRAPH.md#measured-on-the-deadline-benchmark).

Review-only version moves to v25.0 on the same 33 repositories ([results](benchmarks/2026-10-20-meta-graph-move-results.json)): 0 proposed with the committed change list, because every changelog is unread; in a hypothetical run with every changelog marked reviewed and empty, 100 of the 131 live pins would move, each a one-line edit of the version text only.

## Speed and cost

| Measure | Result |
|---|---|
| Stripe benchmark, per repository (4 scans: coverage, shipped adapter, full adapter, full diff) | median **4 s**, p90 17 s, max 324 s |
| Shopify benchmark, scanning 200 apps | **134 s** of CPU, 0.7 s per app |
| `refit deadlines`, per repository | **0.4–0.5 s** (581 repositories in 259 s) |
| `refit run` with Docker validation, cold dependency cache | 46 s (`x-money-shopify`, `tsc`) |
| Same run, warm dependency cache | **22 s**: preparation reuses the archive keyed by lockfile hash |
| AI spend, every Stripe run in this release (531 repositories, fresh ledger) | **$0.02** |
| AI spend per call | $0.002–0.006 on `gpt-5.6-luna` |

- **Scanning time grows with repository size, not Stripe usage.** In `hackerai-tech/hackerai` (1,605 files), 88% of the time is TypeScript symbol resolution across files. Restricting analysis to files import-connected to SDK usage saved under 30%, because a Next.js app's files nearly all import one another. That change was not kept, since every repository-wide safety check would need re-proving.
- **The Stripe benchmark scans serially in one process.** `--concurrency` only overlaps validation, so large lists are split with `--offset` and `--limit` across processes. Three processes cut the 381-repository run from about 90 minutes to 22.
- **AI costs almost nothing because the gates stop before AI.** Of the 234 affected Stripe repositories, 193 stop on the removed request parameter before any model is asked. Most of the rest are fixed deterministically.

## What these benchmarks do not show

- **Validation is evidence about the checks that ran.** Most validated fixes are checked by `tsc` with no new errors; only some repositories have tests. Generated `stripe-mock` checks found no runnable entry point in these handlers, so runtime behavior was exercised only where the repository's own tests do it.
- **Fresh sets are unlabelled.** "Not affected" means no confirmed break on a traced call, not proof of no impact. Recall was measured only on the labelled 30 of the original 100 (95%).
- **Repositories are public and mostly small.** Large monorepos hit scan limits (10,000 files, 50 MiB) and are refused.
- **The Shopify target is the newest version the locked SDK can name,** not always `2026-10`.

## Reproduce

```sh
node scripts/stripe-benchmark-setup.mjs --root <dir> --list docs/benchmarks/2026-10-16-stripe-fresh-repos.json
node scripts/shopify-benchmark-setup.mjs --root <dir> --list docs/benchmarks/2026-10-16-shopify-fresh-repos.json
git worktree add --detach <worktree> <commit>    # always run from a pinned checkout
OPENAI_MODEL=gpt-5.6-luna npm run benchmark:stripe -- --root <dir> --output <run> --env .env --ai --validate [--offset N --limit N]
npm run benchmark:shopify -- --root <dir> --list <list> --output <run> --validate
node scripts/stripe-benchmark-compare.mjs <run-a>/results.json <run-b>/results.json
```
