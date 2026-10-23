# Benchmarks

Every number here comes from real public repositories, frozen before the run that measured them, scanned at a pinned commit, and checked against the providers' real published contracts. No vendor API was called, no scanned repository was contacted, and validation ran each repository's own checks in offline Docker. Detailed method and per-repository results are linked from each section.

**Latest (October 21):** the active-teams set has its first validated fix, published as a draft PR: [refit-dev/Signl#1](https://github.com/refit-dev/Signl/pull/1). A second, [refit-dev/pci-update#1](https://github.com/refit-dev/pci-update/pull/1), passed its checks and is published as a `[Needs review]` draft because one read is untraced. A third, [refit-dev/wedillybird#1](https://github.com/refit-dev/wedillybird/pull/1), passed its 8 Stripe-related unit test files (operator-chosen, since the full suite exceeds the 120-second limit) and is published the same way, with 8 untraced `.description` reads on its own objects. [refit-dev/insightly#1](https://github.com/refit-dev/insightly/pull/1) is published under the #88 waiver and reviewed as incomplete: it fixes the removed subscription and invoice reads but leaves `payment_method_types`, which needs the stripe-node upgrade its `@types/node` 18 blocks. [refit-dev/BrainTrain-#1](https://github.com/refit-dev/BrainTrain-/pull/1) is an untested `[Needs review]` draft under the same waiver: its lockfile lacks integrity hashes, so dependencies were never installed, but the patch is the complete card rule. [refit-dev/ampertalent#1](https://github.com/refit-dev/ampertalent/pull/1) is untested for the same reason (its lockfile and `package.json` disagree) and lists 233 unresolved reads. [refit-dev/niore-platform#1](https://github.com/refit-dev/niore-platform/pull/1) passed `pnpm test` before and after, after [#156](https://github.com/pierceluu10/Refit/pull/156) (owner decision, 2026-10-21) traced its `lazy(() => new Stripe(...))` Proxy clients, so the shared `STRIPE_API_VERSION` could move. With factory tracing, 21 of the 66 active-team repositories are affected, against 11 on October 16; see [the full rescan](#full-rescan-of-the-active-teams-set-october-21).

**Also October 21:** on the 40 affected repositories Refit did not fix, a sandboxed Codex agent (`gpt-5.6-sol`) got 8 patches through Refit's validation; 1 was correct, and 7 silently dropped `payment_method_types`. See [the comparison](#a-coding-agent-on-the-repositories-refit-did-not-fix-october-21).

**October 16 (unreleased):** validated Stripe fixes rose from 53 to **74** on the same 531 repositories after the stripe-node upgrade gained pnpm and Yarn 1, and a new active-teams set (66 repositories) shows that client factories, not fix logic, limit Refit on current code. See [the section below](#stripe-node-upgrade-for-pnpm-and-yarn-and-the-active-teams-set-october-16).

## Summary (Refit 0.38.0)

| Set | Repositories | Affected | Validated fixes | Main stop |
|---|---|---|---|---|
| Stripe, fresh (frozen 2026-10-16) | **381** | 171 (45%) | **5** | 148 send the `payment_method_types` parameter endive removed |
| Stripe, original | 100 | 40 | 4 | 27 send `payment_method_types` |
| Stripe, held out | 50 | 23 | 1 | 18 send `payment_method_types` |
| Shopify, fresh (frozen 2026-10-16) | **200** | 170 with Admin usage | **6** (13 patched) | 44 need an SDK upgrade, 32 use REST |
| Shopify, original | 50 | 46 with Admin usage | 1 | 15 need an SDK upgrade |
| API deadlines, labelled | 100 (32 labelled) | 28 of 32 exposed | n/a | Detection only |
| API deadlines, fresh sets | 581 | 127 exposed | n/a | Detection only |

- **531 Stripe and 250 Shopify repositories in all; 17 validated fixes** (10 Stripe, 7 Shopify). All 17 were reviewed by hand. None was wrong. 2 are partial: one leaves the version for a person to move, and one does not upgrade the package.
- **One owner decision now blocks most Stripe automation.** Of 234 affected Stripe repositories across the three sets, **193 (82%)** send `payment_method_types`, which `2026-09-30.endive` removed from Checkout Session, PaymentIntent and SetupIntent creation. Refit stops for review, as decided on 2026-10-16. A reviewed replacement policy would let Refit continue past this stop for those repositories.
- **Real breakage is common and precise.** 24 of 200 fresh Shopify apps (12%) send a query that fails on every Admin API version Shopify serves today, each at an exact line. 51 of 381 fresh Stripe apps (13%) also send an OpenAI model that OpenAI retires on 2026-10-23.
- **Outcomes are deterministic.** Repeat runs matched 381 of 381 fresh Stripe repositories, 200 of 200 fresh Shopify apps and 150 of 150 earlier Stripe repositories (publication aside). Since the `payment_method_types` stop, no outcome depends on AI sampling.
- **AI was almost never needed:** **$0.02** across every Stripe run in this release. Deterministic rules made every validated fix.

## A coding agent on the repositories Refit did not fix (October 21)

Question: where Refit stopped, does a model-driven agent fix the break instead? The comparison took every affected Stripe repository that Refit did not validate on the October 20 rerun: 21 from the active-teams set, 10 original and 9 held out, 40 in all. On each pinned checkout, OpenAI's Codex CLI (`gpt-5.6-sol`, sandboxed with no network) was told to "upgrade to 2026-09-30.endive". It was given the contract diff Refit computed and the matching Stripe changelog pages. Every patch then went through Refit's own offline validation, with Refit's stripe-node upgrade added and the agent's package-file edits reverted. Every patch that passed was read in full. [Per-repository results and diffs](benchmarks/2026-10-21-agent-comparison-results.json); the harness is [`agent-comparison-cli.ts`](../pipeline/agent-comparison-cli.ts).

The agent is not Claude. The local Claude CLI login was invalid, so the run used the OpenAI key already in `.env`. `--agent claude` reruns it after `claude auth login`.

| Outcome | Repositories |
|---|---|
| Refused at dependency preparation (same gate as Refit; agent not run) | 23 |
| Agent patched, then preparation refused (first pass, before the preflight) | 2 |
| Repository's own checks fail or cannot run unpatched | 5 |
| Regression caught by validation | 2 |
| **Passed validation** | **8** |
| … **correct** | **1** |
| … wrong | 7 |

- **Every wrong patch fails the same way: it deletes `payment_method_types`.** It deleted the parameter in 14 of its 17 patches and replaced it once. `sammorrispb/nextgen-academy` became `allowed_payment_method_types: ['card']`, which is the owner's card rule and the one correct patch. Deleting the parameter typechecks and passes tests, but Stripe then offers dynamic payment methods, so a card-only checkout changes behaviour silently. In `geallenboy/ai-saas-template` it also deleted a computed list the caller chose. Refit stops on exactly this.
- **Apart from that parameter, the agent's edits were right.** In all 7 wrong patches, the response-field moves were correct, as were the pins:
  - `current_period_*` reads moved to the first subscription item;
  - `invoice.subscription` reads moved to `parent.subscription_details`;
  - `shipping_details` reads moved to `collected_information`.

  These went past four of Refit's stops: two type-check regressions (`Kanba-co/kanba`, `iggy-tech/product-hunt-clone-final`), one unresolved `shipping_details` finding (`abressiddique/AbresStore-Admin`) and one validation error (`utsavkrishnatra/pdf_answers`). Deterministic rules for those cases would have produced the same edits without the parameter risk.
- **The environment limits both approaches equally.** 25 of 40 never reached validation because the repository's dependencies cannot be prepared offline (pnpm settings, private registries, size). A model does not change that.
- **Cost: $6.45** for 17 agent runs plus one debug run, under a $20 cap. That is $0.16–1.25 per repository, with a median of 39 s. Refit's AI spend across all 531 repositories was $0.07.
- **Caveats.**
  - The brief gave the contract diff but not the owner's card policy. An agent told the policy might replace the parameter instead of deleting it.
  - Codex could run shell commands offline; dependencies were not installed for it.
  - Generated `stripe-mock` checks were not run for agent patches.
  - Correctness is one reviewer's reading.

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
- **Tracing is the gap.** In 32 repositories Refit found 518 likely Stripe SDK calls and traced none; overall it traced 661 of 1,895 (35%, against 51% on the fresh set). At least 18 of the 32 create the client in a lazy factory, `getStripe()` assigning a module-level `let` on first use, which Refit does not follow. Until it does, "not affected" here means little. (Factory tracing landed on October 17; see [the rescan](#lazy-stripe-clients-on-the-active-teams-set-october-21).)

## Lazy Stripe clients on the active-teams set (October 21)

The October 16 run traced no calls in 32 of the 66 active-team repositories, and at least 18 of them use a lazy `getStripe()` factory. Factory tracing landed on October 17, after that run. To see what was left, the 10 of those 32 with the most likely Stripe calls were rescanned at their frozen commits with `npm run benchmark:coverage`. It reads source only: no install, no Docker, no model call.

| | Traced of 355 likely calls | Repositories at zero |
|---|---|---|
| October 16 run (0.38.0) | 0 | 10 |
| `main` at `b67ff09` | 247 (70%) | 0 |
| Plus dynamically imported factories | **280 (79%)** | 0 |

Most remaining factory misses were a factory loaded with `await import()`, which the analyzer could not follow (`const { getStripe } = await import('@/lib/stripe')`, `(await import('./stripeClient')).getStripeClient()`). Following them added 33 calls in 4 repositories; `joannachen-c/design-meetup-web` went from 15/24 to 24/24. Still untraced: a per-organization cache with expiry (`meetingmindsexperts/ea-sys`, 13 calls), injectable overrides (`options.stripe || getStripe()`), destructured clients and parameters. These are coverage numbers, not fixes: nothing was validated, and the other 56 repositories were not rescanned.

## Full rescan of the active-teams set (October 21)

All 66 active-team repositories were rescanned at their frozen commits from a pinned worktree of `fix/comparison-escape` (`cc426fe`: `main` plus [#151](https://github.com/pierceluu10/Refit/pull/151)), read-only with `npm run benchmark:stripe` and no `--validate`. Every affected repository was then run through the workflow with `--validate` (5 while #151 was unmerged, the other 16 from `main` at `5482423`), in offline Docker (`node:22-alpine`, dependencies installed with lifecycle scripts off, checks with no network).

| Outcome | October 16 | October 21 |
|---|---|---|
| Traced of likely Stripe calls | 661 of 1,895 (35%) | **1,346 of 1,887 (71%)** |
| No mapped Stripe SDK call found | 32 | 4 |
| Not affected | 22 | 40 |
| **Affected** | **11** | **21** |
| … stopped: sends a removed request parameter | | 10 |
| … refused or failed at dependency preparation | | 4 |
| … stopped: committed source over the 50 MiB validation archive | | 2 |
| … checks passed, untraced read left unchanged: `[Needs review]` draft | | 1 |
| … checks did not finish | | 1 |
| … stopped: unparseable source files | | 1 |
| … stopped: helper client needs review | | 1 |
| … **validated** | 0 | **1** |
| Unreadable | 1 | 1 |

- **First fix.** `RISHIE2006/Signl` (Next.js, npm) sends `payment_method_types: ['card']` on Checkout Session creation and pins `2025-03-31.basil`. The deterministic card rule renamed it to `allowed_payment_method_types`, moved the pin to `2026-09-30.endive` and upgraded stripe-node 22.2.2 to 23.0.0: four one-line changes, reviewed by hand ([`fix-reviews.json`](benchmarks/fix-reviews.json)). It is published as a draft PR by Refit Agent on a fork in `refit-dev`; the upstream repository was not touched.
- **Weak checks on that fix.** The benchmark picks `npm test`, but both of Signl's tests import `better-sqlite3`, whose native binding is never built (lifecycle scripts are off and the image has no compiler), so the original code failed. Neither test touches Stripe. The fix was validated with `npm run lint` instead, chosen by the operator, as an approved `.refit.json` check would be. Refit's generated stripe-mock check could not load the route alone (`@clerk/nextjs` fails under plain Node), so no Stripe request was exercised. The PR says both.
- **`payment_method_types` is still the first stop.** 10 affected repositories stop on a removed request parameter. 5 send only `['card']`, but a client's API version cannot be moved: a `lazy()` Proxy wrapper (`Evolvededen/niore-platform`), a client passed to a helper or held in a class field (`kondax-com/Bocker`), a resource cast through `as unknown as` (`brandbite/brandbite`), a spread into request arguments that stripe-node could read as options (`Dvargas005/node-hub`), and a Proxy with `.bind` (`TAIRED1/hackerai`). `JiantaoFu/insightly` sends `['card']` with a movable pin, but stripe-node 23 needs `@types/node >=20` and its lockfile has 18. 3 send card plus other methods (`MeiyuTech/AET-App`, `qesmsep/noir-crm-dashboard`, `User10-stab/meri-beauty`), the listed case covered by the repository opt-in the owner approved on 2026-10-21 ([`STRIPE-PAYMENT-METHOD-TYPES.md`](STRIPE-PAYMENT-METHOD-TYPES.md)). With it, AET-App's two `['card', 'alipay']` calls moved and `tsc` (chosen by the operator; its `npm test` fails 9 tests on the original code) passed before and after: [refit-dev/AET-App#1](https://github.com/refit-dev/AET-App/pull/1), `[Needs review]` for 4 untraced `error.type` reads on `StripeError`. noir-crm still stops: two of its calls send `['us_bank_account']` with no `card`, which the opt-in excludes. meri-beauty still stops: its app calls go through a client whose `checkout.sessions.create` it replaces with a wrapper, which prevents tracing; only two e2e scripts send `['card']`. `Nag-Software/proanbud2` sends `coupon` to `promotionCodes.create`, which has no reviewed replacement.
- **Untraced reads stand behind most of them.** 15 of the 20 unfixed repositories have at least one same-named read Refit could not trace to a Stripe object (from 1 to 502). Under the owner decision of 2026-10-21 these do not block publication: they count as unresolved, so a patch whose checks pass is published only with `--publish-unresolved`, as a `[Needs review]` draft that lists each read as left unchanged. `amahmood-pci/pci-update` is the one such patch: its `tsc` check passed before and after, and its one untraced read is `session.payment_intent` in its webhook, a Checkout Session field endive keeps, so leaving it was right. It is published as [refit-dev/pci-update#1](https://github.com/refit-dev/pci-update/pull/1) and reviewed by hand ([`fix-reviews.json`](benchmarks/fix-reviews.json)).
- **Rerun with `--publish-unresolved`.** The 20 unfixed repositories were rerun with `--validate --publish-unresolved` from `main` plus [#155](https://github.com/pierceluu10/Refit/pull/155) (unmerged). pci-update is the only new patch that passed its checks. `muhallimir/ampertalent` (233 unresolved) and `YosraGhanmi/BrainTrain-` now produce `[Needs review]` artifacts under the #88 dependency waiver, but their checks never ran. BrainTrain-'s patch is the complete card rule (one parameter, the `2026-09-30.endive` pin, stripe-node 22.6.2 to 23.0.0) and is published as an untested draft. ampertalent's was not published: it rewrote `typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id` into separate helper calls, which stripe-node 23's types reject, since TypeScript does not narrow across calls. [#160](https://github.com/pierceluu10/Refit/pull/160) left such narrowed reads for review; [#164](https://github.com/pierceluu10/Refit/pull/164) now reads them through one hoisted `const invoiceSubscription = getInvoiceSubscription(invoice)`, which narrows like the field did. The patched handler type-checks under `--strict` against stripe-node 14.25.0 and 23.0.0, and [refit-dev/ampertalent#1](https://github.com/refit-dev/ampertalent/pull/1) is published as an untested `[Needs review]` draft (233 unresolved reads listed). `JiantaoFu/insightly` now produces a patch, but its own checks fail on the original code.
- **Preparation and size.** `inventashif/hackerai` patches dependencies with pnpm `patchedDependencies`, `Mangu-Commerce/madcaptees` installs non-npmjs tarball URLs and `YosraGhanmi/BrainTrain-` has 279 lockfile entries without integrity: deliberate refusals. `muhallimir/ampertalent`'s `package.json` and lockfile disagree, so `npm ci` fails. `CRONANANI/EzanaFinance3` and `RaulRicco/CashBack` commit more than 50 MiB of source. hackerai's patch generates only with #151, which stops `error instanceof Stripe.errors.StripeError` from marking the client as escaped.
- **The rest.** `beindigital-products/wedillybird`'s `npm test` ended with no exit code on the original code; the check limit is 120 seconds on one CPU, and the suite was still running when it stopped. `Bizgojo/drivetimetales` commits files that do not parse (`lib/belleGenerator.ts` and two scratch `.mjs` files). `EngMajdSayedTaha/reelspy` routes affected calls through a helper whose client needs review.
- **Not affected means no traced read.** The 9 repositories whose version could move and that had no review stop were also run with `--validate`. All 9 stopped as not affected before validation: endive removes fields their code never reads, so Refit proposes nothing.

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

| Refit `0b5480b`, October 20 (validation counts from October 16) | Original 50 | Fresh 200 |
|---|---|---|
| Patched (version pins moved; every document proven on the target) | 1 | **13** |
| … validated in offline Docker | 1 | **6** |
| Already current, or on the newest version the SDK can name | 6 | 1 |
| Stopped: SDK upgrade needed | 15 | 44 |
| Stopped: REST Admin calls | 6 | 32 |
| Stopped: runtime-built, unfollowable or raw GraphQL document | 6 | 32 |
| Stopped: **query already fails on every served version** | 5 | **24** |
| Stopped: dynamic, missing or conflicting pin | 7 | 22 |
| Other (no Admin usage, unparseable document, over scan limits) | 4 | 32 |
| Traced Admin documents | 350 (was 255, then 336) | 644 (was 628) |
| Repeat run at the same commit | 50/50 | 200/200 |

- **Helper tracing** raised traced documents on the original 50 from 255 to 336, and halved unreadable ones (55 → 27), with no outcome changes. It reads default exports, Remix `./shopify.server` imports and helper parameters.
- **Callback and closure tracing** (October 20) follows helpers through callbacks, closure factories, re-exports and constant arrays: unread Admin calls fell from 90 to 76 across both sets, and one more already-broken query was found (`Shop.brand`, a Storefront-only field sent to Admin). The original column's REST and pin rows also include the fresh-set REST fixes made after its first run.
- **REST calls are reported, not migrated** (October 20). Each REST Admin call carries its file, line, method and path or resource operation where the code states them: 114 of the 180 calls across both sets have both, 38 more have one of the two, and the other 28 are client constructions. 9 apps (2 original, 7 fresh) counted as REST only sent raw requests to `/admin/api/<version>/graphql.json`; they now stop as unread GraphQL documents, so the REST rows fell from 8 and 39 to 6 and 32.
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

## Gemini (October 21)

50 repositories frozen by `scripts/ai-sdk-select.mjs --provider gemini` ([list](benchmarks/2026-10-21-gemini-repos.json)): npm packages whose latest manifest declares `@google/genai` (44) or `@google/generative-ai` (6) in `dependencies`. As with the OpenAI and Anthropic sets, GitHub code search was unavailable, so **these are almost all libraries**: provider plugins, agent frameworks, model routers and MCP servers, not applications. Seven are forks or copies of one coding-agent codebase (`earendil-works/pi` and its derivatives). `scripts/gemini-benchmark.mjs` ran `refit deadlines` at each frozen commit, from the working tree at `40a8e2a` with no pipeline changes during the run ([results](benchmarks/2026-10-21-gemini-results.json)). Files were read only; nothing was installed or run, and no Google endpoint was contacted.

| | Result |
|---|---|
| Not scanned (over the 50 MiB or 128-configuration scan limits) | 6 |
| Declare the old `@google/generative-ai` | 6, all scanned |
| Exposed to its end of support (2025-11-30) | **6 of 6**: 7 live manifest lines and 1 in `examples/`, listed as test; all 8 are real declarations on hand review (one is a `devDependencies` entry) |
| Exposed to a Gemini model retirement | none possible: the registry has no Gemini model dates |

**Classification census.** The registry has no Gemini model dates, so each repository was scanned a second time against a throwaway registry that lists every quoted `gemini-*` string in its source under a placeholder date. It measures how the matcher classifies Gemini IDs, not exposure:

| Use | Matches |
|---|---|
| live | 505 in 39 repositories |
| catalog | 779 |
| test | 3,180 |
| check | 180 |
| comment | 152 |
| beyond the 20-per-ID evidence cap, not listed | 1,448 |

Only 74 of the 505 live matches sit in a file that imports either Gemini SDK; libraries keep model IDs in defaults, configuration and provider tables that reach the SDK through their own layers. The first two live matches of each repository (72) were read in context ([review](benchmarks/2026-10-21-gemini-live-review.json)): 5 are not model IDs (a package import, format tags, a gate name, a Chrome built-in model) and matched only because the census lists every `gemini-*` string. Of the other 67, **50 (75%) are live pins**, close to OpenAI's 83% line precision. The 17 others are object-shaped and generated model catalogs (7), test code under paths the rules do not know, `system_test/` and `__testfixtures__/` (4), help or documentation strings (2), a validator, a two-entry list, an `includes()` receiver and a template string in a `.test.ts` file. The last one comes from a classification gap for every provider: only plain string tokens get the test class, so a model in a template string in a test file counts as live. It is reported, not changed, because fixing it lowers live counts for OpenAI and Anthropic too. The review is one reviewer's single AI-assisted pass, not a labelled set.

## PayPal requests (October 21)

`refit paypal` (review only) was run over a frozen set of **22** repositories from a pinned worktree at `1ec93a8` ([list](benchmarks/2026-10-21-paypal-repos.json), [results](benchmarks/2026-10-21-paypal-results.json)). Each repository's npm package declares `@paypal/checkout-server-sdk` or `@paypal/paypal-server-sdk`. npm search found only 22 such repositories, not the 50 the goal asks for, and **the set is libraries and plugins, not applications.**

- **Scan.** 17 were scanned and 5 exceeded the scan limits. 11 scanned repositories make a live PayPal request.
- **Requests.** 90 were reported: 82 `@paypal/paypal-server-sdk` controller calls and 8 raw REST calls. On hand review against each source line, all 90 are real requests with the right method and path. 83 match an operation in PayPal's published OpenAPI documents.
- **Tracing.** A text heuristic counted 116 lines that look like SDK calls; 82 were traced. Of the 34 left, 15 are in the over-limit repositories, 9 are a plugin's own wrapper with SDK-like method names, and 10 are real misses through a controller getter in another file. That is 82 of 92 real call lines in scanned repositories (89%).
- **Old SDK.** No `@paypal/checkout-server-sdk` request was in a scanned repository. Scanning only the PayPal package directory of the 3 over-limit repositories traced all 15 of their call lines, 12 of them old-SDK requests ([supplement](benchmarks/2026-10-21-paypal-subdirectory-results.json)). These are not counted above.

See [PayPal](PAYPAL.md#measured-on-a-frozen-set).

## AI model applications (October 21)

Two sets of real applications were frozen on 2026-10-21 with `scripts/ai-app-select.mjs`: **100** repositories that declare `openai` ([list](benchmarks/2026-10-21-openai-app-repos.json)) and **38** that declare `@anthropic-ai/sdk` ([list](benchmarks/2026-10-21-anthropic-app-repos.json)). The Anthropic set was frozen at 50; on 2026-10-22 we removed 12 copies of leaked proprietary source (one leaked Claude Code tree), and every number in this section and the next was recomputed on the remaining 38 from the committed per-repository results, without rerunning anything. Neither set fell short of its target when frozen. 9 repositories are in both sets. Each file records the queries, the run date, every filter, the sort order, the pool size and, per repository, the pinned commit and why it qualified.

- **Source.** GitHub code search through `gh api`: root `package.json` files split by exclusive size ranges, plus source files that import the SDK split by path. Candidates are ordered by stars within that retrievable pool, not across GitHub, then checked in that order until the target passed. The pool held 8,990 OpenAI and 4,807 Anthropic repositories after deduplication.
- **Filters.** Not a fork or archived; the frozen commit is dated on or after 2025-10-21; the root manifest, or one `apps/*` or `packages/*` manifest, declares the SDK in `dependencies`; the manifest looks like an application; a non-test source file imports the SDK and makes a model call; the tree is inside Refit's scan limits; the name and topics do not look like an SDK, wrapper or framework; the repository is in no other frozen list.
- **Runnable checks.** 95 of the 100 OpenAI and 37 of the 38 Anthropic entries have a `test`, `typecheck` or `build` script (`hasChecks`), so later results can be reported for those alone.
- **No exposure filter.** Selection never looked at which models a repository uses, so the traced and fixed fractions measured on these sets are not biased by it.
- **Reproducibility.** Rerunning the script against the same cache rewrote both files byte for byte before the removal of the copies. It now also rejects them (`leakedSource`), so a rerun picks other repositories in their place. That showed cache replay only: the code-search index moves, so a fresh search is not expected to reproduce the lists, and the frozen files are the record.

The 2026-10-20 npm sets, [OpenAI](benchmarks/2026-10-20-openai-repos.json) and [Anthropic](benchmarks/2026-10-20-anthropic-repos.json), are kept unchanged as library baselines: npm search returns published packages, mostly SDK wrappers, not applications. Tracing and fix numbers for the new sets follow in [Model fixes on the application sets](#model-fixes-on-the-application-sets-october-21).

An independent grep for quoted exact registry model IDs found **4,180** candidate locations in the 138 repositories ([labels](benchmarks/2026-10-21-ai-app-labels.json)): 2,053 in TypeScript, 47 in JavaScript, 1 in Python and the rest in JSON, Markdown, YAML and other files, with 11 in generated files. **297** are live (the ID reaches a request), 293 of them JS/TS. By `via`: 181 `sdk-text`, 58 `sdk-non-text`, 21 `wrapper:*`, 17 `raw-http` and 20 `other`; the current tracers do not follow `wrapper:*`, `raw-http` or `other` (wrapper tracers are deferred). The main non-live reasons are tests (1,797), catalogs (1,489), docs (355) and comparisons (90). The labels come from one AI-assisted reading pass by fresh-context labelling agents, one per batch, not hand labelling; some agents labelled groups of obviously uniform candidates (locale catalogs, test fixtures) by file after spot checks. A seeded random 10% (468 of the 4,679 candidates in all 150 repositories, seed 20261021) was re-read by separate fresh-context agents, one per slice of the sample, that never saw the first labels. 416 of the 468 are in the remaining 138 repositories: `live` agreed on 413 of 416 and `via` on 409 of 416; on the 28 candidates either pass called live, `live` agreed on 25 and `via` on 21. The 7 disagreements among them were adjudicated by reading the code again, and 3 labels changed (the counts above include them). Aliases the registry does not name are out of scope. The tracing measurement on these sets reports JS/TS live pins as the headline, the languages Refit's agents cover, and all live pins as a secondary number.

## Model fixes on the application sets (October 21)

`scripts/ai-model-benchmark.mjs` ran `refit deadlines` and `refit deadlines --propose-model-fixes` at each frozen commit of both application sets, once on `main` (`fb0143a`) and once with the tracing and reporting changes in [the October 22 checkpoint](READINESS.md) merged onto it (`c084880`). Files were read only: nothing was installed, run or validated, and no provider was contacted, so these are proposals, not validated fixes. Results: [Anthropic](benchmarks/2026-10-21-anthropic-app-results.json), [OpenAI](benchmarks/2026-10-21-openai-app-results.json); each file keeps the `main` summary as `baseline`.

| Repositories with a live exposure | Anthropic before | Anthropic after | OpenAI before | OpenAI after |
|---|---|---|---|---|
| Exposed | 16 | 16 | 32 | 32 |
| With a proposed replacement | 2 | 2 | 2 | 2 |
| Stopped for review only | 8 | 11 | 17 | 18 |
| Every live match explained as unresolved | not reported | 3 | not reported | 11 |
| No outcome at all | 6 | 0 | 12 | 0 |
| Scanner error | 0 | 0 | 1 | 1 |

- **Silent repositories.** Before, 6 of 16 exposed Anthropic applications and 12 of 32 OpenAI ones ended with no replacement, no stop and no reason. Now each live match is a replacement, a stop or an `unresolved` entry that says where the model is written (15 Anthropic and 68 OpenAI entries). The OpenAI scanner error is `austineckman/CraftingComputer`, which crashes the scanner process on `main` too, so it has no proposal at all.
- **Replacements did not move.** Since [#147](https://github.com/pierceluu10/Refit/pull/147) added stops on `main`, both sets propose 3 replacements in 2 repositories, before and after. On these sets this change adds stops and explanations and edits nothing new.
- **Copies removed.** The Anthropic set first held 50 applications, 12 of them copies of one leaked Claude Code source tree. We removed the 12 copies of leaked proprietary source on 2026-10-22, and the numbers here were recomputed on the remaining 38. The `c084880` column comes from the committed per-repository results. The `fb0143a` run's rows were not committed, so its Anthropic column gives the counts without the copies that were recorded from that run at the time (16 exposed: 2 with a replacement, 8 stopped and 6 silent).
- **What stops.** Of the 12 distinct Anthropic applications with a stop, 8 send through a custom base URL or another host, 2 load the module that declares the model dynamically, 1 reuses a request object and 1 is a SvelteKit app under a `tsconfig.json` that extends the generated `.svelte-kit/tsconfig.json`, which is not in the checkout. The new stops are 2 custom base URLs (one per set), 1 `fetch` with `anthropic-version` to a non-official host, and the SvelteKit app.
- **No regressions.** No repository lost a replacement or an exposure on either set. Exposures fell only where the deadline scan now lists entries as catalog (`vual/lobe-chat-pro`, and the 12 copies before their removal).

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
node scripts/aws-benchmark.mjs launch --run <id> --total N --shards K --market on-demand -- '<command with {offset} {limit}>'   # see AWS-BENCHMARKS.md
node scripts/paypal-benchmark.mjs --root <dir> --refit <worktree> --list docs/benchmarks/2026-10-21-paypal-repos.json
node scripts/ai-app-select.mjs --provider openai --work <cache> --root <checkouts> --output <openai-list.json>
node scripts/ai-app-select.mjs --provider anthropic --work <cache> --root <checkouts> --output <anthropic-list.json>
```

The two selector commands need a `gh` login. A rerun against the moving code-search index is not expected to match the committed lists; they are the record.
