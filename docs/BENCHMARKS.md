# Benchmarks

Every number here comes from real public repositories, frozen before the run that measured them, scanned at a pinned commit, and checked against the providers' real published contracts. No vendor API was called, no scanned repository was contacted, and validation ran each repository's own checks in offline Docker. Detailed method and per-repository results are linked from each section.

**Latest (October 21):** the active-teams set has its first validated fix, published as a draft PR: [refit-dev/Signl#1](https://github.com/refit-dev/Signl/pull/1). A second, [refit-dev/pci-update#1](https://github.com/refit-dev/pci-update/pull/1), passed its checks and is published as a `[Needs review]` draft because one read is untraced. A third, [refit-dev/wedillybird#1](https://github.com/refit-dev/wedillybird/pull/1), passed its 8 Stripe-related unit test files (operator-chosen, since the full suite exceeds the 120-second limit) and is published the same way, with 8 untraced `.description` reads on its own objects. [refit-dev/insightly#1](https://github.com/refit-dev/insightly/pull/1) is published under the #88 waiver and reviewed as incomplete: it fixes the removed subscription and invoice reads but leaves `payment_method_types`, which needs the stripe-node upgrade its `@types/node` 18 blocks. [refit-dev/BrainTrain-#1](https://github.com/refit-dev/BrainTrain-/pull/1) is an untested `[Needs review]` draft under the same waiver: its lockfile lacks integrity hashes, so dependencies were never installed, but the patch is the complete card rule. [refit-dev/ampertalent#1](https://github.com/refit-dev/ampertalent/pull/1) is untested for the same reason (its lockfile and `package.json` disagree) and lists 233 unresolved reads. [refit-dev/niore-platform#1](https://github.com/refit-dev/niore-platform/pull/1) passed `pnpm test` before and after, after [#156](https://github.com/pierceluu10/Refit/pull/156) (owner decision, 2026-10-21) traced its `lazy(() => new Stripe(...))` Proxy clients, so the shared `STRIPE_API_VERSION` could move. With factory tracing, 21 of the 66 active-team repositories are affected, against 11 on October 16; see [the full rescan](#full-rescan-of-the-active-teams-set-october-21).

**Also October 21:** on the 40 affected repositories Refit did not fix, a sandboxed Codex agent (`gpt-5.6-sol`) got 8 patches through Refit's validation; 1 was correct, and 7 silently dropped `payment_method_types`. See [the comparison](#a-coding-agent-on-the-repositories-refit-did-not-fix-october-21).

**October 16 (unreleased):** validated Stripe fixes rose from 53 to **74** on the same 531 repositories after the stripe-node upgrade gained pnpm and Yarn 1, and a new active-teams set (66 repositories) shows that client factories, not fix logic, limit Refit on current code. See [the section below](#stripe-node-upgrade-for-pnpm-and-yarn-and-the-active-teams-set-october-16).

## Summary (Refit 0.38.0)

| Set                                | Repositories      | Affected             | Validated fixes    | Main stop                                                    |
| ---------------------------------- | ----------------- | -------------------- | ------------------ | ------------------------------------------------------------ |
| Stripe, fresh (frozen 2026-10-16)  | **381**           | 171 (45%)            | **5**              | 148 send the `payment_method_types` parameter endive removed |
| Stripe, original                   | 100               | 40                   | 4                  | 27 send `payment_method_types`                               |
| Stripe, held out                   | 50                | 23                   | 1                  | 18 send `payment_method_types`                               |
| Shopify, fresh (frozen 2026-10-16) | **200**           | 170 with Admin usage | **6** (13 patched) | 44 need an SDK upgrade, 32 use REST                          |
| Shopify, original                  | 50                | 46 with Admin usage  | 1                  | 15 need an SDK upgrade                                       |
| API deadlines, labelled            | 100 (32 labelled) | 28 of 32 exposed     | n/a                | Detection only                                               |
| API deadlines, fresh sets          | 581               | 127 exposed          | n/a                | Detection only                                               |

- **531 Stripe and 250 Shopify repositories in all; 17 validated fixes** (10 Stripe, 7 Shopify). All 17 were reviewed by hand. None was wrong. 2 are partial: one leaves the version for a person to move, and one does not upgrade the package.
- **One owner decision now blocks most Stripe automation.** Of 234 affected Stripe repositories across the three sets, **193 (82%)** send `payment_method_types`, which `2026-09-30.endive` removed from Checkout Session, PaymentIntent and SetupIntent creation. Refit stops for review, as decided on 2026-10-16. A reviewed replacement policy would let Refit continue past this stop for those repositories.
- **Real breakage is common and precise.** 24 of 200 fresh Shopify apps (12%) send a query that fails on every Admin API version Shopify serves today, each at an exact line. 51 of 381 fresh Stripe apps (13%) also send an OpenAI model that OpenAI retires on 2026-10-23.
- **Outcomes are deterministic.** Repeat runs matched 381 of 381 fresh Stripe repositories, 200 of 200 fresh Shopify apps and 150 of 150 earlier Stripe repositories (publication aside). Since the `payment_method_types` stop, no outcome depends on AI sampling.
- **AI was almost never needed:** **$0.02** across every Stripe run in this release. Deterministic rules made every validated fix.

## Refit builds the environment from the repository's own install (October 28)

PR #364, under the founder decision of 2026-10-28 ([customer environment](CUSTOMER-ENVIRONMENT.md)). The runs were on refit-bench, no AI, `subsets/l2-push-249.json`, offset 0, size 25, count 249, compared with `scripts/stripe-benchmark-compare.mjs`.

- **Before:** main `89f1c0ed59809eedfd247526f7f1a770af7447d6`, run 40624045392.
- **After:** `6d6ecd9130ccf3de6ddd74875fae0751a099235e`, run 40639926011.

All 12 jobs passed in both runs, and both runs report 249 repositories. **Outcome changes: 0.** The same outcome holds for 249 of 249 repositories.

The build sandbox ran on the 15 rows where Refit's own preparation refused for a reason it may fall back on. All 15 installs failed, so nothing was newly validated and no `migration.patch` needed a label in `docs/benchmarks/fix-reviews.json`. These rows stay untested, as before. Their causes, read from the results and reproduced locally for three of them:

- **Install scripts that download from hosts no committed file names, so the proxy refused them:** Prisma (`binaries.prisma.sh`) in TN0123/Schematic and yuens1002/artisan-roast, and the Supabase CLI (`release-assets.githubusercontent.com`) in cesarolvr/journeylog-app.
- **A native build with no Python in the image:** `better-sqlite3` in inventashif/hackerai.
- **A lockfile Refit's default pnpm 10 refuses, with no `packageManager` pin:** Miguel07Alm/text2question, an `ERR_PNPM_INVALID_DEPENDENCY_NAME` alias `react@latest`.
- **The other 10** (pnpm and Yarn rows, and one `npm ci` from a Dockerfile): the benchmark's stored message had been filled by proxy-agent warnings before the error. After the measured commit, `installFailure` puts the error lines first. That change touches messages only, not outcomes.

Allowing well-known binary download hosts, or a native toolchain in the build image, would widen what the sandbox runs, so it needs an owner decision.

## Holdout sets

`subsets/holdout-100.json` (100 repositories) and `subsets/holdout-30b.json` (30) are the Stripe agent's measurement-only sets, frozen on October 28. `heldout-30` has been run many times since October 24, so it may already be tuned to; these two are repositories nobody working on Refit has seen.

**Rules (integrity).**

- Never open, clone, trace or debug a holdout repository, its row, its logs or its diff to design or check a fix. Diagnose on `l2-push-249` or `dev-30` only.
- Run them only at milestones: a release, or a claim about the agent's validated rate. Record each run here with its run id, commit and command, as for any set, and report the whole set's numbers, not a slice.
- Never add, drop or replace a repository after a run. A repository that later fails to clone stays in the denominator as a failure. To refresh, freeze a new set with a new seed.
- Held-out repositories may be named only in their own lists, in `docs/benchmarks/holdout-selection/` and in milestone results under `docs/benchmarks/holdout-results/`. `pipeline/holdout-integrity.test.ts` fails `npm test` if any other tracked file names one, shipped source in `src/`, `pipeline/`, `bin/` and `scripts/` included (owner decision D5). It also checks that both lists are disjoint from each other and from every other list in `docs/benchmarks/subsets/` and `docs/benchmarks/*-repos.json`, and that every entry has a full 40-character commit and an API version older than the target with a pinned spec.

**How they were selected.** `scripts/stripe-holdout-select.mjs` draws from the same population as every tuned Stripe set, and so from the same population as `heldout-30` and `l2-push-249`. Those two come from `push-279-affected.json`, which keeps the affected rows of the four tuned sets, which come from the fresh set's 13 GitHub code searches for stripe-node use. The script:

1. reruns those 13 searches (`holdout-selection/search.json`: 6,700 repositories on October 28);
2. drops every `owner/name` that any tracked Refit file mentions at `efcb91ed`: every frozen list and subset, every result, review and note (523 of the 6,700);
3. keeps the fresh set's filters: not archived or a fork, under 50 MB, pushed since 2024-01-01, and `stripe` declared in the root `package.json` (2,830 eligible; 1,585 do not declare `stripe` at the root, 1,032 are over 50 MB, 730 were not pushed since 2024);
4. orders those by SHA-256 of the seed `refit-holdout-2026-10-28`, a newline and the lower-cased name (`holdout-selection/candidates.json`). The seed was fixed before any candidate was seen;
5. walks that order in batches of at most 50 shallow clones at the default-branch HEAD. Each clone is read only for its API version and its Stripe use, then deleted (`holdout-selection/checks.json`). A repository is kept when an application file (not a test, spec, fixture or mock) imports `stripe` and constructs a client, and its API version has a pinned spec in `data/stripe-openapi-versions.json` and is older than `2026-09-30.endive`. The API version is read as for the fresh set: the oldest literal `apiVersion` pin, else the locked stripe-node release. The first 150 in seeded order were checked: 130 kept, 9 with no readable API version, 8 with no Stripe client in application code, 3 on a version without a pinned spec, and none failed to clone;
6. fills `holdout-100` with the first 100 kept, in seeded order, and `holdout-30b` with the next 30.

Each entry is pinned to the full commit that was checked. Rerun it with `node scripts/stripe-holdout-select.mjs --work <dir> --names-at efcb91ed`. GitHub's search index moves, so the committed inputs are the record. `candidates.json` holds the 2,830 eligible repositories in seeded order, so the order can be recomputed from the seed without GitHub (`seededOrder` in the script, tested in `pipeline/stripe-holdout-select.test.ts`).

**What they hold.**

|                                                     | holdout-100         | holdout-30b        | heldout-30     |
| --------------------------------------------------- | ------------------- | ------------------ | -------------- |
| API version from 2022                               | 6                   | 4                  | 1              |
| from 2023                                           | 19                  | 11                 | 9              |
| from 2024                                           | 33                  | 8                  | 12             |
| from 2025                                           | 26                  | 6                  | 7              |
| from 2026                                           | 16                  | 1                  | 1              |
| Most common version                                 | 2023-10-16 (16)     | 2023-10-16 (9)     | 2023-10-16 (7) |
| Version from an `apiVersion` pin / from stripe-node | 61 / 39             | 23 / 7             |                |
| npm / pnpm / Yarn / several lockfiles / none        | 79 / 10 / 0 / 5 / 6 | 22 / 3 / 3 / 1 / 1 |                |
| Median stars                                        | 0                   | 0                  | 5              |

holdout-100 spans 25 API versions, from 2022-11-15 to 2026-08-26.dahlia; holdout-30b spans 15, from 2022-08-01 to 2026-04-22.dahlia. They have fewer stars than `heldout-30`, because the earlier sets took the most-starred repositories from the same searches and these are a random draw from what was left.

**One difference from `heldout-30`.** `heldout-30` keeps only rows a refit-bench run had already found `affected`. These sets are frozen before any Refit run, as the original, held-out 50 and fresh sets were, so some rows will be unaffected; in the fresh set it was 55%. Report a milestone as validated over affected rows, as `heldout-30` is, and give the affected count and the whole set's outcomes beside it. Never filter the list itself.

**Run them** (at a milestone only, no AI unless the milestone authorizes it). `benchmark.yml` checks out Refit at `commit` with `sparse-checkout: docs/benchmarks` and reads `docs/benchmarks/$LIST`, so a list committed in Refit needs no copy in refit-bench; the commit must contain it.

```sh
gh workflow run benchmark.yml -R refit-dev/refit-bench \
  -f commit=$(git rev-parse HEAD) \
  -f list=subsets/holdout-100.json -f offset=0 -f size=10 -f count=100
gh workflow run benchmark.yml -R refit-dev/refit-bench \
  -f commit=$(git rev-parse HEAD) \
  -f list=subsets/holdout-30b.json -f offset=0 -f size=3 -f count=30
```

No run has been dispatched yet.

## Preparation fallbacks (October 29)

#399 adds general fallbacks for four dependency-preparation stops: pnpm 7's lockfile 5.4, code-host archive dependencies, Yarn 1 records without integrity, and Yarn's cache running out of the workspace ([Preparation failures](PREPARATION-FAILURES.md#preparation-fallbacks-october-28)). Runs are refit-bench `benchmark.yml` with `-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249`, no flags and no AI, compared with `node scripts/stripe-benchmark-compare.mjs --details` and `scripts/validation-funnel.mjs`.

| Run                | Commit     | Preparation refused | Validated (funnel) |
| ------------------ | ---------- | ------------------: | -----------------: |
| 40812216438 (main) | `6161f020` |                  28 |                185 |
| 40812228030 (#399) | `8de26a7b` |                  26 |            **186** |

- 246 of 249 rows are identical in every compared field. `Librum-Reader/Librum-Website` moves from a preparation stop to validated, after its one version-only `yarn.lock` record is completed from the registry. Its patch is the same as before. It was read in full and labelled `correct-partial`: stripe stays at ^13 and two `invoice.payment_intent` reads are left, as the draft says. No patch is labelled `wrong`.
- Stops named more precisely, not outcome changes: taxonomy (pnpm 7) and link-flame (GitHub archive) now pass every input check and stop at install on `--engine-strict` Node engine ranges. onix gets past Yarn's ENOSPC and stops on the 2 GiB archive limit. Four rows (artisan-roast, Schematic, Uproot.AI, slackify) are named `git-dependency`.
- Noise: `SimplerDevelopment/SimplerDevelopment` hit the 45-minute job limit with every stage slower than the before run, including the scans before preparation. `kondax-com/Bocker`'s baseline failed in the after run only, as it did once in lane A's run.

## Conflicting lockfiles chosen by rule (October 28)

`feat/conflicting-lockfiles` (built on lane A's `feat/lockfile-resolution`) installs one of several committed lockfiles by rule and upgrades stripe in the chosen one when the others cannot follow ([Preparation failures](PREPARATION-FAILURES.md#conflicting-lockfiles-one-chosen-by-rule-october-28)). Every run is refit-bench `benchmark.yml`, no AI, compared with `node scripts/stripe-benchmark-compare.mjs <before>/results.json <after>/results.json --details`.

| Run                               | Commit     | Inputs                                                                                     | Validated |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------ | --------- |
| 40624045392 (main)                | `89f1c0ed` | `-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249`                     | 84        |
| 40626067947 (lane A)              | `622951a0` | the same, `-f flags=--resolve-lockfiles`                                                   | 90        |
| 40634781011 (this change)         | `17b831d8` | the same, `-f flags=--resolve-lockfiles`                                                   | **96**    |
| 40634774301 (subset, this change) | `17b831d8` | `-f list=subsets/l3-conflicting-lockfiles.json -f offset=0 -f size=4 -f count=7`, the flag | 3 of 7    |

- Against lane A, 6 repositories move from needs-review to validated and none is lost: the three conflicting-lockfile rows of the subset (Quill, avikalp987/quill, tldr-app), `omar99elnemr/Docubot` and `saidMounaim/tick-event` (their one in-sync lockfile now takes the stripe upgrade), and `r0ld3x/DocTalk`, which commits no lockfile and validates because its install was not killed this time (Docker SIGKILL in both earlier runs). The six patches are read and labelled `correct` in `docs/benchmarks/fix-reviews.json`; the subset's three are byte-identical to a local offline Docker run.
- Not outcome changes: `LucasKlemke/doctor-reborn` now upgrades stripe and its own `@ts-expect-error` becomes unused, so its patch fails tsc and is not published (before, the pin moved on stripe 18 and passed); `passion-27/QuotesAI` now has the upgrade in its patch and still stops on its `link:` dependency; `vignesh-gupta/digibee-marketplace` (one `yarn.lock`, a byte-identical patch) timed out installing the candidate after 300 seconds; rerun locally in offline Docker at `17b831d8`, the same patch passes its type check (grade C).
- heldout-30, run only after the above: 40624360669 (main `89f1c0ed`, 10 validated) → 40682647162 (`ce5755ac`, `-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30 -f flags=--resolve-lockfiles`, **12**), none lost, 27 of 30 rows identical. `ItusiAI/Open-Magiviz` and `VishalRaut2106/HackMate_AI` install `package-lock.json` because their workflows install with npm and validate (labelled `correct`); `DarkInventor/QuotesAI` gains the stripe upgrade and still stops on its `link:` dependency. Nothing was tuned on this set.
- Run-to-run noise in lockfile-less repositories, which this change does not touch: `Alfredoeb9/ele` and `minhthuong031103/RealEstateBrokerageMarket` lost their installs to SIGKILL on main and lane A and ran here, and `kondax-com/Bocker`'s baseline failed only in lane A's run.

## AI repair where policy used to stop (October 28)

Founder decision of 2026-10-28 ([AI repair](AI-REPAIR.md), agent Q). Subset `subsets/repair-policy.json`: 12 rows of past l2-push-249 AI runs (40624062726, 40624045392) whose repair stopped `review-required`, whose patch broke the build on rejected properties, call signatures or removed operations, or whose assessment the webhook or removed-parameter policy blocked, plus 2 controls. heldout-30 had no such row and stays held out. All runs: `benchmark.yml` at `--ref feat/stripe-test-mode-key`, `-f list=subsets/repair-policy.json -f offset=0 -f size=2 -f count=12 -f ai=true -f "flags=--resolve-lockfiles --webhook-checks --behaviour-tests --stripe-test-mode"`.

- Before: 40758613932 (`96102693` = `bench/all-feats-2026-10-28` `bf81624d` plus the subset, `ai_budget=3`), AI spend $0.28.
- After: 40764807844 (`1ed2b674`, `ai_budget=5`), AI spend $0.66. Earlier after runs on this branch: 40752646000 (`ac2a33d2`, $0.42) and 40759647632 (`2aa46eec`, $0.58; twitter-like hit an npm `ECONNRESET`).

|                                                                 | Before | After                                 |
| --------------------------------------------------------------- | -----: | ------------------------------------- |
| Patches that break the build (`regression`)                     |      4 | 3                                     |
| Repairs requested                                               |      3 | 6                                     |
| Repairs accepted                                                |      0 | 1 (dubbl-org/dubbl, `[Needs review]`) |
| Assessments blocked (assessment not requested by the benchmark) |      6 | 2 (contract review)                   |
| Validated                                                       |      3 | 3                                     |

- dubbl-org/dubbl: `review-required` with 0 repair requests (the upgraded types reject `stripeAccount`) to an AI repair that passes the type check (grade C). It moves `{ stripeAccount }` into the request-options argument of six retrieve calls; reviewed `correct` in `docs/benchmarks/fix-reviews.json`. It ships `[Needs review]` with "What the AI changed and why", never validated.
- ReeceHarding/firebase-next.js-boilerplate: the `retrieveUpcoming` contract review stopped it before any model call; now 3 repairs run and the checks still fail (`retrieveUpcoming` untouched), so it stays a regression and is not published. One of its AI edits is wrong (`accounts.retrieve({})`), reviewed `wrong`; the checks caught it.
- Unchanged: LouisMbc/twitter-like (the rule-lines guard, agent S), Panda2Chan/ai-asmr (repeated proposal on a second API-version pin, agent P), kondax-com/Bocker (its own flaky tests fail the baseline), and the 7 rows that already passed.

## A coding agent on the repositories Refit did not fix (October 21)

Question: where Refit stopped, does a model-driven agent fix the break instead? The comparison took every affected Stripe repository that Refit did not validate on the October 20 rerun: 21 from the active-teams set, 10 original and 9 held out, 40 in all. On each pinned checkout, OpenAI's Codex CLI (`gpt-5.6-sol`, sandboxed with no network) was told to "upgrade to 2026-09-30.endive". It was given the contract diff Refit computed and the matching Stripe changelog pages. Every patch then went through Refit's own offline validation, with Refit's stripe-node upgrade added and the agent's package-file edits reverted. Every patch that passed was read in full. [Per-repository results and diffs](benchmarks/2026-10-21-agent-comparison-results.json); the harness is [`agent-comparison-cli.ts`](../pipeline/agent-comparison-cli.ts).

The agent is not Claude. The local Claude CLI login was invalid, so the run used the OpenAI key already in `.env`. `--agent claude` reruns it after `claude auth login`.

| Outcome                                                                    | Repositories |
| -------------------------------------------------------------------------- | ------------ |
| Refused at dependency preparation (same gate as Refit; agent not run)      | 23           |
| Agent patched, then preparation refused (first pass, before the preflight) | 2            |
| Repository's own checks fail or cannot run unpatched                       | 5            |
| Regression caught by validation                                            | 2            |
| **Passed validation**                                                      | **8**        |
| … **correct**                                                              | **1**        |
| … wrong                                                                    | 7            |

- **Every wrong patch fails the same way: it deletes `payment_method_types`.** It deleted the parameter in 14 of its 17 patches and replaced it once. `sammorrispb/nextgen-academy` became `allowed_payment_method_types: ['card']`, which is the owner's card rule and the one correct patch. Deleting the parameter typechecks and passes tests, but Stripe then offers dynamic payment methods, so a card-only checkout changes behaviour silently. In `geallenboy/ai-saas-template` it also deleted a computed list the caller chose. Refit stops on exactly this.
- **Apart from that parameter, the agent's edits were right.** In all 7 wrong patches, the response-field moves were correct, as were the pins:
  - `current_period_*` reads moved to the first subscription item;
  - `invoice.subscription` reads moved to `parent.subscription_details`;
  - `shipping_details` reads moved to `collected_information`.

  These went past four of Refit's stops: two type-check regressions (`Kanba-co/kanba`, `iggy-tech/product-hunt-clone-final`), one unresolved `shipping_details` finding (`abressiddique/AbresStore-Admin`) and one validation error (`utsavkrishnatra/pdf_answers`). Deterministic rules for those cases would have produced the same edits without the parameter risk.

- **The environment limits both approaches equally.** 25 of 40 never reached validation because the repository's dependencies cannot be prepared offline (pnpm settings, private registries, size). A model does not change that.
- **Cost: $6.45** for 17 agent runs plus one debug run, under a $20 cap. That is $0.16–1.25 per repository, with a median of 37 s. Refit's AI spend across all 531 repositories was $0.07.
- **Caveats.**
  - The brief gave the contract diff but not the owner's card policy. An agent told the policy might replace the parameter instead of deleting it.
  - Codex could run shell commands offline; dependencies were not installed for it.
  - Generated `stripe-mock` checks were not run for agent patches.
  - Correctness is one reviewer's reading.

## stripe-node upgrade for pnpm and Yarn, and the active-teams set (October 16)

No owner decision changed. The stripe-node upgrade now covers root pnpm v9 and Yarn 1 projects and npm lockfiles in any standard formatting, and the benchmark validates Yarn roots ([checkpoint](READINESS.md), [dependency guide](DEPENDENCIES.md#stripe-node-upgrade-in-a-patch)). The same 531 repositories were rerun from pinned worktrees at `7238e46`; Yarn repositories were rerun at `fecd935`, which only lets the harness validate them. Per-repository outcomes: [fresh](benchmarks/2026-10-16-stripe-fixrate-fresh-results.json), [original](benchmarks/2026-10-16-stripe-fixrate-original-results.json), [held out](benchmarks/2026-10-16-stripe-fixrate-heldout-results.json).

|                                                                                        | Original 100 | Held-out 50 | Fresh 381 | All 531 |
| -------------------------------------------------------------------------------------- | ------------ | ----------- | --------- | ------- |
| Affected                                                                               | 40           | 23          | 171       | 234     |
| Validated before (`6d02116`)                                                           | 11           | 7           | 35        | 53      |
| **Validated now**                                                                      | **13**       | **9**       | **52**    | **74**  |
| Stopped: `payment_method_types` outside the card rule                                  | 11           | 8           | 63        | 82      |
| Refused at validation preparation                                                      | 7            | 2           | 29        | 38      |
| Regression caught by validation                                                        | 3            | 1           | 8         | 12      |
| Other stops (declared types, invalid source, no checks, AI declined, failing baseline) | 6            | 3           | 19        | 28      |

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

| Outcome                                                            | Repositories |
| ------------------------------------------------------------------ | ------------ |
| No mapped Stripe SDK call found                                    | 32           |
| Not affected                                                       | 22           |
| **Affected**                                                       | **11**       |
| … stopped: `payment_method_types` outside the card rule            | 6            |
| … refused at validation preparation (registry URL, lockfile, size) | 3            |
| … stopped: unparseable source files                                | 2            |
| … validated                                                        | 0            |
| Over scan limits                                                   | 1            |

- **Active code breaks less.** 17% are affected, against 45% of the fresh set, because recent pins are closer to the target. The breaking reads are the same ones: `subscription.current_period_end` (5), `invoice.subscription` (4), `subscription.current_period_start` (3).
- **Tracing is the gap.** In 32 repositories Refit found 518 likely Stripe SDK calls and traced none; overall it traced 661 of 1,895 (35%, against 51% on the fresh set). At least 18 of the 32 create the client in a lazy factory, `getStripe()` assigning a module-level `let` on first use, which Refit does not follow. Until it does, "not affected" here means little. (Factory tracing landed on October 17; see [the rescan](#lazy-stripe-clients-on-the-active-teams-set-october-21).)

## Lazy Stripe clients on the active-teams set (October 21)

The October 16 run traced no calls in 32 of the 66 active-team repositories, and at least 18 of them use a lazy `getStripe()` factory. Factory tracing landed on October 17, after that run. To see what was left, the 10 of those 32 with the most likely Stripe calls were rescanned at their frozen commits with `npm run benchmark:coverage`. It reads source only: no install, no Docker, no model call.

|                                     | Traced of 355 likely calls | Repositories at zero |
| ----------------------------------- | -------------------------- | -------------------- |
| October 16 run (0.38.0)             | 0                          | 10                   |
| `main` at `b67ff09`                 | 247 (70%)                  | 0                    |
| Plus dynamically imported factories | **280 (79%)**              | 0                    |

Most remaining factory misses were a factory loaded with `await import()`, which the analyzer could not follow (`const { getStripe } = await import('@/lib/stripe')`, `(await import('./stripeClient')).getStripeClient()`). Following them added 33 calls in 4 repositories; `joannachen-c/design-meetup-web` went from 15/24 to 24/24. Still untraced: a per-organization cache with expiry (`meetingmindsexperts/ea-sys`, 13 calls), injectable overrides (`options.stripe || getStripe()`), destructured clients and parameters. These are coverage numbers, not fixes: nothing was validated, and the other 56 repositories were not rescanned.

## Full rescan of the active-teams set (October 21)

All 66 active-team repositories were rescanned at their frozen commits from a pinned worktree of `fix/comparison-escape` (`cc426fe`: `main` plus [#151](https://github.com/pierceluu10/Refit/pull/151)), read-only with `npm run benchmark:stripe` and no `--validate`. Every affected repository was then run through the workflow with `--validate` (5 while #151 was unmerged, the other 16 from `main` at `5482423`), in offline Docker (`node:22-alpine`, dependencies installed with lifecycle scripts off, checks with no network).

| Outcome                                                               | October 16         | October 21               |
| --------------------------------------------------------------------- | ------------------ | ------------------------ |
| Traced of likely Stripe calls                                         | 661 of 1,895 (35%) | **1,346 of 1,887 (71%)** |
| No mapped Stripe SDK call found                                       | 32                 | 4                        |
| Not affected                                                          | 22                 | 40                       |
| **Affected**                                                          | **11**             | **21**                   |
| … stopped: sends a removed request parameter                          |                    | 10                       |
| … refused or failed at dependency preparation                         |                    | 4                        |
| … stopped: committed source over the 50 MiB validation archive        |                    | 2                        |
| … checks passed, untraced read left unchanged: `[Needs review]` draft |                    | 1                        |
| … checks did not finish                                               |                    | 1                        |
| … stopped: unparseable source files                                   |                    | 1                        |
| … stopped: helper client needs review                                 |                    | 1                        |
| … **validated**                                                       | 0                  | **1**                    |
| Unreadable                                                            | 1                  | 1                        |

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

## Stripe test mode (October 28)

Behaviour tests against Stripe test mode ([Stripe test mode](STRIPE-TEST-MODE.md)) on refit-dev/refit-bench, with the `STRIPE_TEST_KEY` repository secret and the workflow from refit-bench branch `feat/stripe-test-mode`, which passes that secret only when `flags` holds `--stripe-test-mode`:

```bash
gh workflow run benchmark.yml -R refit-dev/refit-bench --ref feat/stripe-test-mode -f commit=<sha> -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249 -f ai=true -f ai_budget=200 -f flags="--behaviour-tests --stripe-test-mode"
```

Results: pending; compared with 40624062726 (main `89f1c0ed`, AI) by `scripts/stripe-benchmark-compare.mjs`, then heldout-30 against 40624075884.

## Stripe

### Fresh 381 (October 16)

[`2026-10-16-stripe-fresh-repos.json`](benchmarks/2026-10-16-stripe-fresh-repos.json) was frozen before any run; per-repository outcomes are in [`2026-10-16-stripe-fresh-results.json`](benchmarks/2026-10-16-stripe-fresh-results.json).

- **Search.** 13 GitHub code searches for stripe-node usage in TypeScript and JavaScript: constructors, imports, checkout, subscriptions, webhooks and invoices. They returned 6,363 repositories.
- **Criteria.** After excluding the 150 used before, 3,034 met the [Stripe benchmark](STRIPE-BENCHMARK.md) criteria: not archived, under 50 MB, pushed since 2024, and `stripe` in the root `package.json`.
- **Selection.** The 400 most starred were cloned. 17 run an API version with no published spec (stripe-node below 10, or a 2020 pin), and 2 are already on the target. **All 381 others are kept.**
- **API versions.** 266 come from a literal `apiVersion` and 115 from the locked SDK release. They span 30 API versions, from `2022-08-01` to `2026-08-26.dahlia`. The target is `2026-09-30.endive`.
- **Contracts.** Each version's spec is pinned by `stripe/openapi` tag. Seven new tags were taken from each stripe-node release's `OPENAPI_VERSION`, and each spec's `info.version` was verified.

The run used the full pipeline: deterministic rules, AI patches on `gpt-5.6-luna` behind a fresh $5 ledger, and offline Docker validation with generated `stripe-mock` checks. The final run used pinned worktrees at `6733a99`, split across three processes. An earlier run at `61670ab` gave the same outcome for 381 of 381 repositories.

| Outcome                                                                                                              | Repositories |
| -------------------------------------------------------------------------------------------------------------------- | ------------ |
| Not affected: no confirmed break on a traced call                                                                    | 129          |
| No mapped Stripe method, or no Stripe SDK call found                                                                 | 77           |
| Repository exceeds scan limits                                                                                       | 4            |
| **Affected**                                                                                                         | **171**      |
| … stopped: sends the removed `payment_method_types` request parameter                                                | **148**      |
| … stopped: declared Stripe types without traced provenance, or a conflicting SDK pin                                 | 5            |
| … stopped: an invalid source file (a stray brace, an unescaped quote, an unterminated literal; each checked by hand) | 4            |
| … repository refused for validation (tracked `node_modules`, a lockfile over 20,000 records)                         | 3            |
| … AI evidence over the 64 KiB limit, or AI declined                                                                  | 3            |
| … proposed, no preparable checks                                                                                     | 2            |
| … validation regression: an AI patch introduced type errors; caught, not proposed                                    | 1            |
| … **validated**                                                                                                      | **5**        |

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

|                                              | Original 100 | Held-out 50 |
| -------------------------------------------- | ------------ | ----------- |
| Affected                                     | 40           | 23          |
| Validated                                    | 4            | 1           |
| Stopped: `payment_method_types`              | 27           | 18          |
| Same outcome as the previous run (`e4692cc`) | 100/100      | 50/50       |

The 5 validated fixes are the 5 published, hand-reviewed drafts in the [Stripe benchmark](STRIPE-BENCHMARK.md#published-drafts-and-hand-review). Earlier history (labels, recall and precision, the self-maintaining pipeline, the held-out AI run) is there too.

## Shopify

Shopify Admin GraphQL migrations are deterministic, and no AI is used. Details are in the [Shopify benchmark](SHOPIFY-BENCHMARK.md).

| Refit `0b5480b`, October 20 (validation counts from October 16)   | Original 50             | Fresh 200     |
| ----------------------------------------------------------------- | ----------------------- | ------------- |
| Patched (version pins moved; every document proven on the target) | 1                       | **13**        |
| … validated in offline Docker                                     | 1                       | **6**         |
| Already current, or on the newest version the SDK can name        | 6                       | 1             |
| Stopped: SDK upgrade needed                                       | 15                      | 44            |
| Stopped: REST Admin calls                                         | 6                       | 32            |
| Stopped: runtime-built, unfollowable or raw GraphQL document      | 6                       | 32            |
| Stopped: **query already fails on every served version**          | 5                       | **24**        |
| Stopped: dynamic, missing or conflicting pin                      | 7                       | 22            |
| Other (no Admin usage, unparseable document, over scan limits)    | 4                       | 32            |
| Traced Admin documents                                            | 350 (was 255, then 336) | 644 (was 628) |
| Repeat run at the same commit                                     | 50/50                   | 200/200       |

- **Helper tracing** raised traced documents on the original 50 from 255 to 336, and halved unreadable ones (55 → 27), with no outcome changes. It reads default exports, Remix `./shopify.server` imports and helper parameters.
- **Callback and closure tracing** (October 20) follows helpers through callbacks, closure factories, re-exports and constant arrays: unread Admin calls fell from 90 to 76 across both sets, and one more already-broken query was found (`Shop.brand`, a Storefront-only field sent to Admin). The original column's REST and pin rows also include the fresh-set REST fixes made after its first run.
- **REST calls are reported, not migrated** (October 20). Each REST Admin call carries its file, line, method and path or resource operation where the code states them: 114 of the 180 calls across both sets have both, 38 more have one of the two, and the other 28 are client constructions. 9 apps (2 original, 7 fresh) counted as REST only sent raw requests to `/admin/api/<version>/graphql.json`; they now stop as unread GraphQL documents, so the REST rows fell from 8 and 39 to 6 and 32.
- **The fresh set found four bugs, each fixed with a test.** Three let REST calls through, so a REST app's version was moved: template URLs, `createAdminRestApiClient`, and REST resource classes. The fourth refused npm `{ "packages": [...] }` workspaces. The REST fixes stopped 3 wrongly patched apps, none of which had validated.
- **The broken queries are real.** All 23 were rechecked with graphql-js against the served schema. 11 are the old Remix template's `productVariantUpdate(input: ProductVariantInput)`.
- **Most apps are limited by their SDK.** `ApiVersion.October26` needs `@shopify/shopify-api` 14, and app frameworks pin older releases. That SDK upgrade is a major-version change, so Refit stops rather than performing it.

### Shopify SDK path, round 3 (SH12, 2026-10-30)

dev-60 plus the 250 practice repositories (practice-50 and fresh-200), refit-bench `shopify.yml` on `shopify-ai`, size 1, `--sdk-upgrade`. Before: 40950547981, 40950561596, 40953254697 (`c3304055`, docs-only behind the base; AI was requested but the OpenAI credit was exhausted, so no AI call ran).

| Run                                                              | Commit     | Validated rows | Distinct repos | Needs review | Stopped |
| ---------------------------------------------------------------- | ---------- | -------------: | -------------: | -----------: | ------: |
| Before                                                           | `c3304055` |             10 |              7 |           31 |     220 |
| No AI: 40971544558, 40971547445, 40971550694                     | `788cdaf9` |             19 |             13 |           65 |     157 |
| No AI: 40973528148, 40973530890, 40973533416                     | `396c5b1e` |             30 |             21 |           65 |     157 |
| Claude Sonnet 5.5, $15.34: 40979832096, 40984651472, 40982838222 | `df398702` |             26 |             19 |           71 |     157 |

- Rows count every list a repository is in; one fresh-200 row of the `396c5b1e` run did not come back (309 rows).
- At `396c5b1e`, nothing validated before is lost, and 14 repositories are newly validated (2 grade A, 12 grade C). Every diff was read and labelled `correct` in `fix-reviews.json`.
  - 12 move the SDK with the version (remix 3 to 5, React Router 1 to 2).
  - 2 pin the dated version string on the locked `@shopify/shopify-api` 11.
- jgasimli04/marketoracle validated before on a fallback version. At `788cdaf9` its upgrade failed its type check on an aliased `AppProvider` and was not published; `396c5b1e` fixed that.
- Of the 91 rows whose first stop was the SDK upgrade, the next stops at `396c5b1e` are:
  - validated: 13
  - needs review: 24
  - GraphQL documents already failing on 2026-01 (SH11): 14
  - unreadable documents (SH13): 12
  - the SDK still: 15. These are lockfiles that preparation refuses, remix 2 or `@shopify/shopify-api` older than 8, no readable locked release, and REST apps the string pin does not cover.
  - REST (SH14): 9
  - regressions, never published: 2
  - an error and an unrun patch: 2
- The AI run validates fewer rows, and not because of the patches. Its development-store run failed on stand-in Function IDs, a store locale, rate limits and app ownership, on the before version (2026-01) as well, and that set five rows that pass every check to grade D (danyn/shopify-app-rr, cornerstone-report/x-money-shopify, ersinkoc/CouponEngine, mssalemi/b-is-for-bundles, Stephnn0/shipping-discounts-shopify-app). Two rows validate only with AI (IliasHad/shopify-app-template-remix-cloudflare-workers, SankaiAI/iHeard.ai).

<<<<<<< HEAD
### Development-store environment (2026-10-30, fix/shopify-store-proof)

refit-bench `shopify.yml` on `shopify-ai`, `--sdk-upgrade`. Before is main `57ce145f`; after is `915fd860` (store-environment checks and rate-limit retries in `pipeline/shopify-live-proof.ts`).

| Set                  | Runs (before → after)     | AI                              | Validated | Needs review | Live proof passed |
| -------------------- | ------------------------- | ------------------------------- | --------- | ------------ | ----------------- |
| dev-60 (size 1)      | 41132449226 → 41133273810 | no                              | 10 → 10   | 24 → 24      | 1 → 1             |
| dev-60 (size 1)      | 41132846019 → 41133282871 | Claude Sonnet 5.5, $10 cap each | 10 → 10   | 24 → 24      | 1 → 1             |
| practice 50 (size 5) | 41132451966 → 41133277344 | no                              | 7 → 7     | 15 → 15      | 0 → 0             |
| fresh 200 (size 5)   | 41132455018 → 41133280282 | no                              | 17 → 17   | 57 → 57      | 5 → 5             |

- Every row has the same status, grade and live-proof status before and after. No row is newly validated, so `docs/benchmarks/fix-reviews.json` gains no entry.
- The five rows SH12 round 3 graded D on store failures already validate on main, because #435 records those failures as not run: danyn/shopify-app-rr, cornerstone-report/x-money-shopify, mssalemi/b-is-for-bundles and Stephnn0/shipping-discounts-shopify-app at C, ersinkoc/CouponEngine at B.
- The AI pair does not exercise the change. The $10 cap splits into about $0.17 per shard; scan-time requests used it, 9 rows per run stopped with `AI budget exhausted`, and no row reached the live-case writer (`aiCostUsd` 0 on every patched row). mssalemi/b-is-for-bundles, for example, records `no value for required variable $functionId`. Measuring the function and locale checks needs an AI run that reaches case writing.
=======
### Shopify SDK and preparation stops (2026-10-30)

dev-60, practice-50 and fresh-200 on refit-bench `shopify.yml` (`shopify-ai`), `--sdk-upgrade`, no AI. Admin schemas were read on 2026-10-30.

| Run                                           | Commit     | dev-60 validated | practice-50 validated | fresh-200 validated | Needs review (all) | Stopped (all) |
| --------------------------------------------- | ---------- | ---------------: | --------------------: | ------------------: | -----------------: | ------------: |
| Before: 41132449226, 41132451966, 41132455018 | `57ce145f` |               10 |                     7 |                  17 |                 96 |           170 |
| 41134862193, 41134865076, 41134868010         | `a744b0b2` |               10 |                     9 |                  20 |                 94 |           167 |
| After: 41140411942, 41140424261, 41140435896  | `08f5df4e` |                4 |                     4 |                  13 |                 92 |           188 |

- **Gained, 6 repositories (6 rows), every diff read and labelled `correct`:**
  - alexCevi/shopify-metaform-os (practice), Shabir300/QRCode-generator-react-router-app-v7-shopify and safwanadnan/shopiflare (fresh). These are npm projects with `workspaces: ["extensions/*"]` that lockfile resolution refused, and now resolve with their committed workspace manifests.
  - Shopify/shopify-app-template-remix, shopsavvy/shopify-shopsavvy and lukeclifton/shopify-app-template-remix-cloudflare (fresh), which needed two more fixes:
    - lockfile resolution now accepts an `.npmrc` line that names `https://registry.npmjs.org` itself (the template's `@shopify:registry=…`);
    - the late-pin pass of lockfile resolution now moves its cutoff to a dependency a late pin needs that was published after it. `@shopify/shopify-app-remix` 5.0.1 was published 24 seconds before the `@shopify/shopify-api` 14.0.1 it requires (registry times, read 2026-10-30).
- **Lost, 13 repositories (19 rows): a wrong upgrade that main counted as validated.** Each crossed `@shopify/shopify-app-session-storage-prisma` 8 (from 5.x or 6.x to 10.0.1) with a Prisma `Session` model that lacks `refreshToken` and `refreshTokenExpires`.
  - Session storage 8.0.0 to 10.0.1 sends both fields on every store, as `null` when absent. Prisma rejects an argument the model does not declare (`Unknown argument \`refreshToken\``, checked locally with Prisma 6.19.3), so the upgraded app cannot store a session. The type check cannot see this, which is how it graded C.
  - The upgrade now stops there (`sessionModelStop`), and these repositories fall back to the dated `'2026-10'` string pin on their locked SDK, `[Needs review]` at grade D.
  - The 13 are labelled `wrong` in `fix-reviews.json`; 11 of them had earlier `correct` labels. ratul-pointerflow/wishlist and markusvoigt/market_discount_full_app validated at `a744b0b2` for the same reason and are labelled `wrong` too.
  - Twenty more rows that the upgrade would have patched with the same defect now stop instead.
- gruntlord5/cloudflare-react-router7-shopify-d1 (dev and practice) no longer stops on React Router's `unstable_newEmbeddedAuthStrategy` flag, which no release reads, but now stops on its Bun lockfile, with no code change. hak193/i-devr-code now prepares and passes on both sides, and stays `[Needs review]` for its submodules.
- Shopify/subscriptions-reference-app's Admin URL `LATEST_API_VERSION` pin applies at `a744b0b2`. At `08f5df4e` the upgrade stops on its Session model.
>>>>>>> origin/main

### Shopify dev and blind sets

Frozen on 2026-10-29 by `scripts/shopify-select.mjs`; nothing has been run on them. The exact criteria and command are in each list's `criteria`, and the search results, per-repository pre-scan counts and totals are in `docs/benchmarks/shopify-selection/`.

- `subsets/shopify-blind-100.json` (100) is measurement only. Nobody opens, traces or debugs its repositories, and it runs once, in the final combined Shopify benchmark. `pipeline/shopify-sets-integrity.test.ts` fails if a tracked file outside the list and the selection inputs names one of them, or if any other benchmark list does.
- `subsets/shopify-dev-60.json` (60) is the development set. Agents may open and debug it.

How the blind set was chosen:

- **Search.** GitHub code search for the three Shopify app SDKs in `package.json`, `api_version` in `shopify.app.toml`, and `/admin/api/20` URLs in TypeScript and JavaScript. This found 6,467 repositories; 519 were dropped because any file under `docs/benchmarks` already names them.
- **Activity filters.**
  - Kept repositories that are not archived or forks and are under 512 MB.
  - Each has a default-branch commit within 90 days, at least 2 human authors in that window, a GitHub Actions workflow, and a root `package.json` and lockfile.
  - 169 passed.
- **Offline pre-scan.**
  - Each repository was scanned at its commit with Refit's Shopify scan and its GraphQL documents were checked against 2026-10. Nothing was installed or run.
  - A repository is affected when its oldest pin is unsupported or retiring soonest (2026-01), when it calls the REST Admin API, or when a document fails on 2026-10 or already fails.
  - 84 of the 169 were affected.
- **Loosening.**
  - 84 is short of 100, so per the founder (2026-10-29) the activity window widened to 180 days. 16 of the first 27 newly eligible repositories, in seeded order, filled the set. The 1-author stage was not needed.
  - Each loosened repository records it in `loosened`, and the list's top-level `loosened` counts them. CI, lockfile, Shopify-usage and affected checks were never loosened.
- **Categories** of the 100: unsupported version 79, retiring soonest 4, REST Admin calls 64, failing documents 10, product model 0.

The dev set comes from the 250 already-open 2026-10-16 lists, because the search alone could not fill both sets. They were pre-scanned the same way at their frozen commits, with a root lockfile required and no activity filters: 145 were affected, and the first 60 in seeded order form the set. Each entry names its `source` list, and it shares no repository with the blind set.

Run the dev set on GitHub Actions with `-f list=subsets/shopify-dev-60.json` ([GitHub benchmarks](GITHUB-BENCHMARKS.md#shopify)).

#### Proof gate (2026-10-29, feat/shopify-proof-gate)

`shopify.yml` on dev-60 with `-f flags=--sdk-upgrade`, size 1, no AI, current schemas (2026-01 `b0e01280b220`, 2026-04 `70db95021c1f`, 2026-07 `9cf7ccbb5b38`, 2026-10 `9af82bcd6c84`): 40939897777 (before, `1712c55f`) and 40942668604 (after, `33beeb94`). Validated 0 → 3, all grade C, each hand-checked `correct` in `docs/benchmarks/fix-reviews.json`: sabbir-noyon/wishkit-app-shopify and lnmjkessel-code/v13 (a `.graphqlrc.ts` pin left to the schema proof; lnmjkessel commits no generated types, so codegen no longer counts as stale) and jgasimli04/marketoracle (no Admin request). 9 patched rows stay `[Needs review]`: 4 at grade D whose changed files no check covers (LazerTechnologies, newideasacct-lab/ai-peacemaker and Rakesh161rausahn change JavaScript tsc does not check; brunaszarin/spotlight-manager runs only tests, which reach nothing changed), 4 at grade D whose baseline check fails (TS18003, TS2688 or failing tests), and dcam9586/scout-source2, now grade C, keeps its `submodules` gate. Priyadharshini29-M/Combo-page-app errors as before; no other row changed.

The 250 practice repositories (`2026-10-16-shopify-repos.json` and `2026-10-16-shopify-fresh-repos.json`, size 5, same flags and schemas): 40943642717 and 40943654787 (before, `1712c55f`), 40942682023 and 40942694636 (after, `33beeb94`). Validated 4 → 8, none lost: the three dev-60 rows above (they come from these lists) and Akmal1255553/startup1 (grade B; its tests reach `app/shopify.server.ts`), reviewed `correct`. dcam9586/scout-source2 moves from D to C and keeps its `submodules` gate; no other row changed. The one dependency-preparation stop, aargonlab/Self-Service-Returns, declared `"workspaces": []`, which npm leaves out of the root lockfile record; `dc552d8a` accepts it as `npm ci` does, and 40945140339 prepares it and passes its tests on both sides, still grade D because no test reaches `app/shopify.server.ts`.

#### Dev set with and without AI (2026-10-29)

refit-bench `shopify.yml` on branch `shopify-ai`, commit `8bc3d97f`, `--sdk-upgrade`, `size=1`, schemas read 2026-10-29 (2026-04 and 2026-07 differ from the frozen hashes), the development store set in both runs. Without AI: run 40942065975. With AI (`ai=true`, `ai_budget=300`, gpt-6.1-sol): run 40942081474.

|                                                                                  | No AI  | AI     |
| -------------------------------------------------------------------------------- | ------ | ------ |
| Validated                                                                        | 0      | 0      |
| Needs review                                                                     | 12     | 12     |
| Error (`Combo-page-app`: the proposal changes the verified version declarations) | 1      | 1      |
| Stopped at scan                                                                  | 47     | 47     |
| Grade A / D among the 12                                                         | 0 / 12 | 1 / 11 |

- One row changes: jadenScali/Aeo-Optimizer moves from grade D to A. The model wrote the variable inputs the live proof lacked, and all 7 operations ran on the development store at both versions. It stays `[Needs review]` because its own tests fail on the original code. Its patch is deterministic and identical in both runs.
- 32 scan-time AI requests cost $0.43; the AI child runs spent more on assessments and live cases (recorded per row as `workflow.aiCostUsd`).
  - Document rewrites: 8 requests, 3 kept, none shipped (those repositories stop on REST calls or SDK limits). The sanjeev744/smart-bundle rewrite was kept only by adding a selection under `@skip(if: true)`. The gate now refuses that.
  - Reconstructions: 14 requests, 2 kept, both hand-checked correct (alistairmartin/honey-birdette-checkout-amd, whose `GROUPS` holds only the CUSTOMER `size_preference` group). The other 12 were declined correctly: queries from CLI flags, request bodies or caller parameters. That repository still stops on its other unreadable calls and its SDK.
  - REST mappings: 10 requests. One proposal was kept but did not produce what the code reads, so it was not used.
- No patch reached AI repair. Every patched row's baseline failed or its checks passed, so no build break was left to repair.

#### Versioned REST contract (2026-10-29, feat/shopify-rest-contract)

refit-bench `shopify.yml` on branch `shopify-ai`, `--sdk-upgrade`, `size=1`, schemas read 2026-10-29 (2026-01 `b0e01280b220`, 2026-04 `70db95021c1f`, 2026-07 `9cf7ccbb5b38`, 2026-10 `9af82bcd6c84`). Before is `31532666` (bench/iter1-shopify-meta with #424 and #425 merged); after is `c3304055`.

| Set                                               | Runs (before → after)     | AI              | Validated | Needs review | Rows stopped on REST |
| ------------------------------------------------- | ------------------------- | --------------- | --------- | ------------ | -------------------- |
| dev-60                                            | 40950502043 → 40950547981 | yes, budget 300 | 3 → 3     | 12 → 13      | 14 → 12              |
| practice 50 (`2026-10-16-shopify-repos.json`)     | 40950519023 → 40950561596 | yes, budget 300 | 1 → 1     | 10 → 10      | 8 → 7                |
| fresh 200 (`2026-10-16-shopify-fresh-repos.json`) | 40953240143 → 40953254697 | no              | 6 → 6     | 43 → 44      | 44 → 32              |

- The fresh-200 AI pair (40950533927 → 40950575885) is not comparable: the OpenAI account ran out of credit during the after run, and 36 rows ended with `HTTP 429 (credit_balance_exhausted)`. In that run danyn/shopify-app-rr showed as validated only because its live proof, which failed before, did not run; it is not a new validation. The pair was rerun without AI.
- 13 of the 52 rows on the 250 practice repositories that stopped on REST no longer do (dev-60 is drawn from them). None validates yet, because each meets another gate: `LATEST_API_VERSION` that only an SDK upgrade moves (Ascensyo/addlee-now, NINE15Team/Finally-Back-In-Stock, Stephnn0/remix-youtube-tutorial), an SDK upgrade the lockfile cannot take (AB-Insightful/ab-insightful, atsuki-sakai/shopify-point-app, sourav-backend-dev/crypto-shopify-app), a document that already fails on 2026-01 (dza59/remix-chat-tutorial), an unresolved `this.apiVersion` (shoptether/shoptether) or no pin (kevinjmosley93/the-best-shopify-theme-toolkit).
- arslanramay/shopify-custom-app-boilerplate moves from the REST stop to a patch (SDK 11.0.0 to 14.0.1, three proven count calls) that is untested, because it has no checks. Priyadharshini29-M/Combo-page-app moves from an error to `[Needs review]` at grade D: its proven `products.json` call is no longer rewritten, so the rewrite no longer conflicts with the version edits.
- No row is newly validated, so `docs/benchmarks/fix-reviews.json` gains no entry. Offline, the contract proves 66 of 181 REST calls on the 250 repositories, and every REST call in 16 of the 55 that use REST.

#### Retired-version migrations (2026-10-29, feat/shopify-migrations)

refit-bench `shopify.yml` on branch `shopify-ai`, `--sdk-upgrade`, `size=1`, no AI, same schemas as above. Both sides include the lockless-validation fix to the harness (`b75dd0d9`): before is `4e2db08f` (`1de287fe` plus that fix), after is `b75dd0d9`.

| Set                                               | Runs (before → after)     | Validated | Needs review | Rows stopped on "already fails" |
| ------------------------------------------------- | ------------------------- | --------- | ------------ | ------------------------------- |
| dev-60                                            | 40987872842 → 40982064263 | 3 → 3     | 10 → 10      | 5 → 2                           |
| practice 50 (`2026-10-16-shopify-repos.json`)     | 40981299500 → 40982073035 | 1 → 1     | 5 → 5        | 5 → 4                           |
| fresh 200 (`2026-10-16-shopify-fresh-repos.json`) | 40981309100 → 40982087176 | 6 → 6     | 25 → 28      | 24 → 13                         |

- Of the 33 target rows (29 repositories; 4 appear in two sets), 15 now pass the "already fails" stop. 12 stop on the SDK: `ApiVersion.October26` needs `@shopify/shopify-api` 14, and those rows use `LATEST_API_VERSION`, an enum the locked SDK lacks, or a lockfile that nests the SDK (SH12's lane). 3 become `[Needs review]` drafts at grade D with the schema proof holding: benzookapi/shopify-gcp-demo, lukeclifton/shopify-app-template-remix-cloudflare and ratul-pointerflow/wishlist. They commit no lockfile, so dependency preparation refuses them. The store run needs a case for the template's other mutation (`populateProduct`), which only the AI case writer provides. benzookapi's patch was read: it matches Shopify's own template change, with `variant` kept as an object.
- 18 still stop on "already fails". Each sends a field no rule covers: `Shop` policy fields, `Order.financialStatus` and `fulfillmentStatus`, `Customer.ordersCount`, `ProductVariant` weight fields, `AppPlanV2` spreads, `Shop.primaryLocale`, `metafieldDelete`, `inventoryAdjustQuantity`, `discountsAllocatorFunctionRegister`, `webPixels`, `cartCreate` (a Storefront mutation sent to Admin), and others. Shopify no longer publishes quotable Markdown pages for these changes, so they need AI repair.
- No row is newly validated, so `docs/benchmarks/fix-reviews.json` gains no entry.
- The harness fix: the Shopify benchmark skipped validation for repositories that commit no lockfile. They now run with npm, as Stripe's benchmark has since #338.
- **AI runs with Claude are not comparable yet.** The pairs used `claude-sonnet-5-5` with budget 300 (before `dde26f87` = #431 plus the harness and variant fixes, after `ed026a00` = this branch merged with #431): dev-60 40988042473 → 40988067551, practice 50 40988051253 → 40988076014, fresh 200 40988059842 → 40988084253. Validated went 3 → 3, 1 → 1 and 5 → 6. Up to 34 rows per run ended with `Anthropic token counting failed with HTTP 400 (invalid_request_error)`. The requests are byte-identical at both commits (checked by recording them offline), and a rerun of the before commit (40990579751) fails on 12 dev-60 rows the same way, so the failure is on the Anthropic account, not in either commit. The fresh-200 +1 (cornerstone-report/x-money-shopify, grade D to C) is an artifact: its live-case writer hit the 400, so the store run that failed before did not run.
- The development-store case for the bulk update was refused in a first AI run (40982706076): the variant it updates comes from the product the case created, but only the product's own ID counted as created. A created product's own variants now count (`3b31fd95`); other nested IDs still do not.

#### REST residue (2026-10-29, feat/shopify-rest-residue, SH14)

Same workflow and flags, no AI (the OpenAI credit is exhausted). Before is `1de287fe` (bench/iter1-shopify-meta); after is `a9752609`: saved records, unused REST client providers, const bodies, `text()`, the `errors` envelope and scoped client declarations ([Shopify REST](SHOPIFY-REST.md#what-a-proof-needs)).

| Set                                               | Runs (before → after)     | Validated | Needs review | Rows stopped on REST |
| ------------------------------------------------- | ------------------------- | --------- | ------------ | -------------------- |
| dev-60                                            | 40966783635 → 40966793498 | 3 → 3     | 10 → 10      | 12 → 9               |
| practice 50 (`2026-10-16-shopify-repos.json`)     | 40966803463 → 40966812848 | 1 → 1     | 3 → 3        | 7 → 5                |
| fresh 200 (`2026-10-16-shopify-fresh-repos.json`) | 40966822386 → 40966831940 | 6 → 6     | 18 → 20      | 32 → 24              |

- 11 distinct rows leave the REST stop (dev-60 is drawn from the other two sets). Their next stop:
  - SDK and version gates: `LATEST_API_VERSION` that only an SDK upgrade moves (tungbinzzz/instagram-app-shopify, chandandadhekar/ListAI-V2, michaelwang11394/sales-associate), an SDK upgrade that stops (Liroo/emilievizcano.com), a version read from `SHOPIFY_API_VERSION` (CABlank/referrd-react-app-shopify) or no pin (german-zarate/shopify-node-express-mongodb-app);
  - a GraphQL document that already fails on 2026-01: hasan-araav/shopify-order-sync.
- Three rows now get a patch, each a version move only: antho8101/RefSpring moves seven REST URL versions and passes its type check on both sides at grade D (`[Needs review]`); snoryder8019/rw_socket moves one `apiVersion` and its own tests already fail before the patch; Santho-sh/shopify-product-bundler-app moves `ApiVersion.January23` and has no checks. The findings were read; the diffs themselves were not downloaded.
- No row is newly validated, so `docs/benchmarks/fix-reviews.json` gains no entry. Offline, the contract now proves 108 of 181 REST calls on the 250 repositories (67 before). 10 of the 31 rows whose first stop was REST have every REST call proven.
- The REST stops that remain are real: the Checkout resource; parameters (`phone`, `customer_id`) and fields (Product `type` and `image`, a misspelled Variant field) the contract does not list; DraftOrder `use_customer_default_address`, which shopify.dev shows only in examples, not in its Properties; a delete response used; `createAdminRestApiClient` clients; and a NestJS `useFactory` provider.

#### Document tracing and REST detection (2026-10-30, fix/shopify-tracing-rest)

refit-bench `shopify.yml` on branch `shopify-ai`, `--sdk-upgrade`, no AI, schemas read 2026-10-30 (2026-01 `76bdd5e5583c`, 2026-04 `a8b5a7a55eae`, 2026-07 `90cc3c6275fa`, 2026-10 `3ef749850e5d`) on both sides. Before is main `57ce145f`; after is `8b0928c1`.

| Set                                               | Runs (before → after)     | Validated | Needs review | Unreadable calls | Rows stopped first on unreadable | Rows stopped first on REST |
| ------------------------------------------------- | ------------------------- | --------- | ------------ | ---------------- | -------------------------------- | -------------------------- |
| dev-60                                            | 41132449226 → 41137277696 | 10 → 10   | 24 → 24      | 9 → 9            | 5 → 5                            | 8 → 8                      |
| practice 50 (`2026-10-16-shopify-repos.json`)     | 41132451966 → 41137288908 | 7 → 7     | 15 → 15      | 7 → 11           | 3 → 2                            | 3 → 3                      |
| fresh 200 (`2026-10-16-shopify-fresh-repos.json`) | 41132455018 → 41137299973 | 17 → 17   | 57 → 57      | 40 → 35          | 12 → 10                          | 21 → 24                    |

- Tracing follows Admin clients returned from factories (to every call), clients passed into repository functions directly or as a destructured member, object members copied with spread or passed to a repository function, and loaded namespaces (`const mod = await import(…)`). Rapid-CRM and shxhid-dev clear every unreadable call; Yespo-CDP/yespo-shopify reads 13 more documents and now stops on one that already fails on 2026-01 (its 5 remaining unreadable calls build aliases at runtime).
- REST detection widened, so more rows stop, by design: a base URL ending at its version (`https://${shop}/admin/api/2024-01`, path joined elsewhere) and REST paths after a substituted version (`/admin/api/${VERSION}/shop.json`) were invisible before, so a version move could leave or move them unproven. alucardislit-coder/shopify-stripe-backend, CABlank/referrd-react-app-shopify and luffytaroZ/Tracker (previously "no Admin usage") now stop on them, and 7 other already-stopped rows list more REST calls.
- An intermediate commit (`36443a25`, runs 41135575190, 41135586901, 41135598187) patched shxhid-dev/shxhid-chat-agent. The diff was read and labelled `wrong` in `fix-reviews.json`: it moved a version constant that also sets the app's Storefront API URL and an unlisted REST URL. `8b0928c1` stops a version a Storefront URL shares, so the row now stops with that reason.
- No row is newly validated or patched at `8b0928c1`, and nothing validated before is lost.
- What still stops:
  - Unreadable documents (runtime by design): CLI, MCP and GraphiQL pass-through (Nuraveda, psydao, alistairmartin, ArseniyX's model-built queries), aliases and argument lists built from runtime IDs (flwrdev, Yespo, BillyND, lisandrophan), `Effect.fn` and `Object.assign` wrappers (mw10013, drizzle-team), class-method senders (carlosrebelo14-ai, madeburo), exported functions nothing calls (rrichie551), library exports (yan-ad), and a client threaded through callback return values (aura-historia).
  - REST: fields and parameters the contract does not list (SGFGOV, iamgenesistech, mdrahbar21, samikaran, mwakidenis), responses returned whole to callers or a frontend (Greenstand), delete responses used (Stephnn0), a spread of runtime paging options (Shopify/editions-dev-2k-variants), `createAdminRestApiClient` clients (CJBiohacker, jamalsoueidan, Jessdanie94), URL constants sent twice with different methods (JehielL) or through wrappers (amm10090, evigauge), REST client providers (NguyenThoNgocIT, raj84908), base URLs whose path is joined elsewhere, and a test file that only asserts URLs while the adapter's own base URL has no trailing slash (mikelaurenzo7-collab). None has a deterministic GraphQL equivalent that this branch could add without guessing.

## API deadlines

The hand-labelled [deadline benchmark](DEADLINE-BENCHMARK.md) covers 100 repositories, 32 labelled line by line. Refit flags 28 of 28 exposed repositories at 28/28 repository precision, with 83% OpenAI line precision from live-only evidence.

`refit deadlines` was also run, unlabelled, over both fresh sets ([results](benchmarks/2026-10-16-deadline-fresh-results.json)):

|                                      | Fresh Shopify 200                                                                              | Fresh Stripe 381                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| Live exposure to a registry deadline | 62 (31%)                                                                                       | 65 (17%)                           |
| Past due                             | 22                                                                                             | 9                                  |
| Due within 7 days                    | 34: 29 on Shopify `2025-10` (due today) and 5 more on OpenAI 2026-10-23 retirements (6 in all) | 51 (OpenAI 2026-10-23 retirements) |
| Most common                          | `shopify-admin-2025-10` (29), `-2025-07` (15)                                                  | `gpt-3.5-turbo` (35), `gpt-4` (15) |

These counts are a lower bound for Shopify: the registry starts at `2025-04`, and many apps pin older versions.

## Meta Graph tracing on meta-dev-60 (October 29)

refit-bench `meta.yml` on `subsets/meta-dev-60.json` (size 1, all 60 rows, target v26.0, no AI) compared affb6e8a (run 40955599826) with feat/meta-tracing-ai 59965322 (run 40963544288). The change: URL objects with `searchParams`, conditional URLs, same-file URL builders, fetch wrappers that spread options, injected fetch parameters, and `encodeURIComponent(id)` as a node.

|                                         | affb6e8a  | 59965322       |
| --------------------------------------- | --------- | -------------- |
| Validated                               | 3         | 5              |
| Needs review (patch)                    | 12        | 12             |
| No patch                                | 45        | 43             |
| Grades                                  | C 11, D 4 | B 1, C 12, D 4 |
| Repositories with unknown-request stops | 47        | 46             |
| unversioned / version-holder            | 22 / 13   | 22 / 13        |
| AI spend                                | $0        | $0             |

- FreeForCharity/FFC-IN-FFC_Single_Page_Template (B) and tareksalammohamed/socialpilot (C) moved from no patch to validated. Both diffs were read and labelled `correct` in `benchmarks/fix-reviews.json`.
- Totex-Motors/Totexgest hit the 30-minute validation timeout in 40963544288. Alone in 40970287411 (same commit), it is needs-review / D in 666 s, as on the base (unresolved 30 → 28).
- 9 newly moved pins across 5 repositories were read in context offline.
- Nothing validated before was lost.
- The AI reconstruction path (`pipeline/meta-graph-ai.ts`) is not measured. Probe run 40963591790 still got HTTP 429 `credit_balance_exhausted` from OpenAI.

### With AI on Claude (October 30)

refit-bench `meta.yml` (branch `feat/anthropic-provider`, refit-dev/refit-bench#15) ran on `subsets/meta-dev-60.json` at 24832a69 (feat/meta-tracing-ai, which includes feat/anthropic-backend), with size 1, $300 cap, provider `anthropic` and `claude-sonnet-5-5`:

- 40987935081: with AI;
- 40987943348: the no-AI control at the same commit.

24832a69 also scopes parameter changes to their edge or path, as field changes already were. That fix stops a WhatsApp `/messages` request that sends `type` from matching a v26.0 change on the Ad Account `adcreatives` edge.

|                                         | affb6e8a, no AI | 24832a69, no AI | 24832a69, AI                          |
| --------------------------------------- | --------------- | --------------- | ------------------------------------- |
| Validated                               | 3               | 6               | 9                                     |
| Needs review (patch)                    | 12              | 11              | 12                                    |
| No patch                                | 45              | 43              | 39                                    |
| Grades                                  | C 11, D 4       | B 1, C 12, D 4  | C 17, D 4                             |
| Repositories with unknown-request stops | 47              | 46              | 24                                    |
| unversioned / version-holder            | 22 / 13         | 22 / 13         | 20 / 15                               |
| listed-change / separate-changelog      | 41 / 32         | 41 / 32         | 48 / 35                               |
| AI spend                                | $0              | $0              | $20.03 (scan $12.18, refit run $7.85) |

AI reconstruction:

- 295 sites were sent to the model and 220 were kept.
- The 75 refused were declined by the model or failed Refit's checks: a different traced path, a version not written on the named line, or a name not in the code.
- Each benchmark row reconstructs twice, once in its scan and once in its child `refit run`. Within one `refit run` the model is asked once: validation reuses the workflow scan's reconstructions.
- Requests AI made readable expose real blockers: listed-change and separate-changelog stops rise.

Newly validated, each read against the source and labelled in `benchmarks/fix-reviews.json`:

- With AI:
  - CassieMarie0728/jekyll-forge: nested-ternary OAuth token URLs;
  - dvygolov/AdReplica: an OG scrape helper that returns a `new URL` with conditional `searchParams`;
  - Shamrock2245/shamrock-bail-portal-site: Apps Script `UrlFetchApp` posts.
  - All three are `correct`.
- Without AI, from the parameter scoping: mkyousafali/Aqura, `correct-partial`. Its upload-session create moves; the upload step stays on v22.0.
- Already validated, with a different AI diff: ogSulem/pulse (the config table's token URL) and FreeForCharity (its pagination script too, so grade C instead of B). Both `correct`.

Nothing validated in the no-AI control is lost with AI. No wrong fix. In the AI run, Totex-Motors/Totexgest, AtonIA00/aton-member-dashboard and jaguar999paw-droid/lavira-media-engine end needs-review, held by real or caution stops.

The merged summaries of these runs print "AI spend: $0": rows recorded spend only per stage (`ai.scan`, `ai.run`), and the merge sums `ai.costUsd`. The row total is now written.

## Meta Graph changelog coverage on meta-dev-60 (October 29)

`feat/meta-changelogs`: WhatsApp and Messenger requests are matched against their mined changelogs instead of stopping every move, and a listed change stops a move only where it can reach the code (see [Meta Graph API](META-GRAPH.md#propose-version-moves-review-only)). refit-bench `meta.yml`, `subsets/meta-dev-60.json`, `size=1`, no AI (AI spend $0):

|                                                                     | Before: 40955443390 (`affb6e8a`) | After: 40970560104 (`3f3937dc`) |
| ------------------------------------------------------------------- | -------------------------------: | ------------------------------: |
| Validated                                                           |                                3 |                               6 |
| Needs review                                                        |                               11 |                              19 |
| Missing manifest                                                    |                                1 |                               0 |
| Rows with a patch                                                   |                               15 |                              25 |
| Stop kind `separate-changelog` (repositories)                       |                               32 |                               0 |
| Stop kind `listed-change`                                           |                               41 |                              32 |
| `unknown-request` / `unversioned` / `version-holder` / `tests-only` |                 47 / 22 / 13 / 7 |                47 / 22 / 13 / 7 |

- Newly validated: ingridandrade-ctrl/arthea, symbiosika/symbiosika-framework, mkyousafali/Aqura. All three diffs are reviewed `correct` in `docs/benchmarks/fix-reviews.json`; none was validated before was lost.
- An intermediate run (40963951479, `43dff33f`) lost framerslab/agentos and ogSulem/pulse: the v12.0 Custom Labels `name` change had no edge, so routing in-effect changes to the out-of-cycle list matched every `fields=name` request. It is now scoped to `custom_labels`, and no dev-60 repository gets an in-effect out-of-cycle hit.
- What still holds `listed-change`: node-wide placeholder removals (`/{commerce-order-id}`, custom audiences, Instagram v1.0 nodes) on requests to a single opaque node, the v22.0 Instagram v1.0 `comments` edge, `GET /?ids=` (v26.0, a real break), and explicitly requested fields a crossed version changes.

## Meta Graph API requests (October 20)

`refit meta-graph` was run over the 33 Meta repositories of the deadline benchmark, and each of the 162 requests it reports in live code was read in context ([labels](benchmarks/2026-10-20-meta-graph-call-labels.json), [results](benchmarks/2026-10-20-meta-graph-call-results.json)). All 162 are real Graph API requests or endpoints, and no reported version, path, edge, field, metric or method disagrees with the code. The version was read for 157 (the other 5 are unversioned), the path for 158, the edge for 116, and `fields` for 113. A request was found at 62 of the 63 live Graph pins labelled in the deadline benchmark; the miss is a browser `FB.init`. Labels are one reviewer's single pass. See [Meta Graph API](META-GRAPH.md#measured-on-the-deadline-benchmark).

Review-only version moves to v25.0 on the same 33 repositories ([results](benchmarks/2026-10-20-meta-graph-move-results.json)): 0 proposed with the committed change list, because every changelog is unread; in a hypothetical run with every changelog marked reviewed and empty, 100 of the 131 live pins would move, each a one-line edit of the version text only.

## Gemini (October 21)

50 repositories frozen by `scripts/ai-sdk-select.mjs --provider gemini` ([list](benchmarks/2026-10-21-gemini-repos.json)): npm packages whose latest manifest declares `@google/genai` (44) or `@google/generative-ai` (6) in `dependencies`. As with the OpenAI and Anthropic sets, GitHub code search was unavailable, so **these are almost all libraries**: provider plugins, agent frameworks, model routers and MCP servers, not applications. Seven are forks or copies of one coding-agent codebase (`earendil-works/pi` and its derivatives). `scripts/gemini-benchmark.mjs` ran `refit deadlines` at each frozen commit, from the working tree at `40a8e2a` with no pipeline changes during the run ([results](benchmarks/2026-10-21-gemini-results.json)). Files were read only; nothing was installed or run, and no Google endpoint was contacted.

|                                                                | Result                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not scanned (over the 50 MiB or 128-configuration scan limits) | 6                                                                                                                                                     |
| Declare the old `@google/generative-ai`                        | 6, all scanned                                                                                                                                        |
| Exposed to its end of support (2025-11-30)                     | **6 of 6**: 7 live manifest lines and 1 in `examples/`, listed as test; all 8 are real declarations on hand review (one is a `devDependencies` entry) |
| Exposed to a Gemini model retirement                           | none possible: the registry has no Gemini model dates                                                                                                 |

**Classification census.** The registry has no Gemini model dates, so each repository was scanned a second time against a throwaway registry that lists every quoted `gemini-*` string in its source under a placeholder date. It measures how the matcher classifies Gemini IDs, not exposure:

| Use                                           | Matches                |
| --------------------------------------------- | ---------------------- |
| live                                          | 505 in 39 repositories |
| catalog                                       | 779                    |
| test                                          | 3,180                  |
| check                                         | 180                    |
| comment                                       | 152                    |
| beyond the 20-per-ID evidence cap, not listed | 1,448                  |

Only 74 of the 505 live matches sit in a file that imports either Gemini SDK; libraries keep model IDs in defaults, configuration and provider tables that reach the SDK through their own layers. The first two live matches of each repository (72) were read in context ([review](benchmarks/2026-10-21-gemini-live-review.json)): 5 are not model IDs (a package import, format tags, a gate name, a Chrome built-in model) and matched only because the census lists every `gemini-*` string. Of the other 67, **50 (75%) are live pins**, close to OpenAI's 83% line precision. The 17 others are object-shaped and generated model catalogs (7), test code under paths the rules do not know, `system_test/` and `__testfixtures__/` (4), help or documentation strings (2), a validator, a two-entry list, an `includes()` receiver and a template string in a `.test.ts` file. The last one comes from a classification gap for every provider: only plain string tokens get the test class, so a model in a template string in a test file counts as live. It is reported, not changed, because fixing it lowers live counts for OpenAI and Anthropic too. The review is one reviewer's single AI-assisted pass, not a labelled set.

## PayPal requests (October 21)

`refit paypal` (review only) was run over the **22** repositories the frozen set then held, from a pinned worktree at `1ec93a8` ([list](benchmarks/2026-10-21-paypal-repos.json), [results](benchmarks/2026-10-21-paypal-results.json)). Each repository's npm package declares `@paypal/checkout-server-sdk` or `@paypal/paypal-server-sdk`. npm search found only 22 such repositories, not the 50 the goal asks for, and **those 22 are libraries and plugins, not applications.**

- **Scan.** 17 were scanned and 5 exceeded the scan limits. 11 scanned repositories make a live PayPal request.
- **Requests.** 90 were reported: 82 `@paypal/paypal-server-sdk` controller calls and 8 raw REST calls. On hand review against each source line, all 90 are real requests with the right method and path. 83 match an operation in PayPal's published OpenAPI documents.
- **Tracing.** A text heuristic counted 116 lines that look like SDK calls; 82 were traced. Of the 34 left, 15 are in the over-limit repositories, 9 are a plugin's own wrapper with SDK-like method names, and 10 are real misses through a controller getter in another file. That is 82 of 92 real call lines in scanned repositories (89%).
- **Old SDK.** No `@paypal/checkout-server-sdk` request was in a scanned repository. Scanning only the PayPal package directory of the 3 over-limit repositories traced all 15 of their call lines, 12 of them old-SDK requests ([supplement](benchmarks/2026-10-21-paypal-subdirectory-results.json)). These are not counted above.
- **Extended set (October 22).** GitHub code search added 20 repositories, mostly applications, so the list now holds 42. A second pass over all 42 at `662bc90` ([results](benchmarks/2026-10-22-paypal-results.json)) scanned 36; 6 exceeded the scan limits. 23 make a live PayPal request, with 135 live requests: 89 `@paypal/paypal-server-sdk` controller calls, 41 raw REST calls and 5 `@paypal/checkout-server-sdk` requests. 114 match a published operation. The 20 added repositories were hand-labelled before the run ([labels](benchmarks/2026-10-22-paypal-labels.json)): 56 requests in 15 of them. The scan reported 43 live requests there and matched 42 labels (recall 75%); the one unmatched report is a base URL constant. The 22 first repositories are not labelled. See [PayPal progress](PAYPAL-PROGRESS.md#benchmark).

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

| Repositories with a live exposure        | Anthropic before | Anthropic after | OpenAI before | OpenAI after |
| ---------------------------------------- | ---------------- | --------------- | ------------- | ------------ |
| Exposed                                  | 16               | 16              | 32            | 32           |
| With a proposed replacement              | 2                | 2               | 2             | 2            |
| Stopped for review only                  | 8                | 11              | 17            | 18           |
| Every live match explained as unresolved | not reported     | 3               | not reported  | 11           |
| No outcome at all                        | 6                | 0               | 12            | 0            |
| Scanner error                            | 0                | 0               | 1             | 1            |

- **Silent repositories.** Before, 6 of 16 exposed Anthropic applications and 12 of 32 OpenAI ones ended with no replacement, no stop and no reason. Now each live match is a replacement, a stop or an `unresolved` entry that says where the model is written (15 Anthropic and 68 OpenAI entries). The OpenAI scanner error is `austineckman/CraftingComputer`, which crashes the scanner process on `main` too, so it has no proposal at all.
- **Replacements did not move.** Since [#147](https://github.com/pierceluu10/Refit/pull/147) added stops on `main`, both sets propose 3 replacements in 2 repositories, before and after. On these sets this change adds stops and explanations and edits nothing new.
- **Copies removed.** The Anthropic set first held 50 applications, 12 of them copies of one leaked Claude Code source tree. We removed the 12 copies of leaked proprietary source on 2026-10-22, and the numbers here were recomputed on the remaining 38. The `c084880` column comes from the committed per-repository results. The `fb0143a` run's rows were not committed, so its Anthropic column gives the counts without the copies that were recorded from that run at the time (16 exposed: 2 with a replacement, 8 stopped and 6 silent).
- **What stops.** Of the 12 distinct Anthropic applications with a stop, 8 send through a custom base URL or another host, 2 load the module that declares the model dynamically, 1 reuses a request object and 1 is a SvelteKit app under a `tsconfig.json` that extends the generated `.svelte-kit/tsconfig.json`, which is not in the checkout. The new stops are 2 custom base URLs (one per set), 1 `fetch` with `anthropic-version` to a non-official host, and the SvelteKit app.
- **No regressions.** No repository lost a replacement or an exposure on either set. Exposures fell only where the deadline scan now lists entries as catalog (`vual/lobe-chat-pro`, and the 12 copies before their removal).

## Speed and cost

| Measure                                                                                        | Result                                                          |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Stripe benchmark, per repository (4 scans: coverage, shipped adapter, full adapter, full diff) | median **4 s**, p90 17 s, max 324 s                             |
| Shopify benchmark, scanning 200 apps                                                           | **134 s** of CPU, 0.7 s per app                                 |
| `refit deadlines`, per repository                                                              | **0.4–0.5 s** (581 repositories in 259 s)                       |
| `refit run` with Docker validation, cold dependency cache                                      | 46 s (`x-money-shopify`, `tsc`)                                 |
| Same run, warm dependency cache                                                                | **22 s**: preparation reuses the archive keyed by lockfile hash |
| AI spend, every Stripe run in this release (531 repositories, fresh ledger)                    | **$0.02**                                                       |
| AI spend per call                                                                              | $0.002–0.006 on `gpt-5.6-luna`                                  |

- **Scanning time grows with repository size, not Stripe usage.** In `hackerai-tech/hackerai` (1,605 files), 88% of the time is TypeScript symbol resolution across files. Restricting analysis to files import-connected to SDK usage saved under 30%, because a Next.js app's files nearly all import one another. That change was not kept, since every repository-wide safety check would need re-proving.
- **The Stripe benchmark scans serially in one process.** `--concurrency` only overlaps validation, so large lists are split with `--offset` and `--limit` across processes. Three processes cut the 381-repository run from about 90 minutes to 22.
- **AI costs almost nothing because the gates stop before AI.** Of the 234 affected Stripe repositories, 193 stop on the removed request parameter before any model is asked. Most of the rest are fixed deterministically.

## Test paths widened (October 22)

- **Rule.** The shared `TEST_PATH` and the Go and Python tracers' test paths now also treat end-to-end and system test directories as tests, by whole directory segment: `system_test(s)/`, `integration_test(s)/`, `acceptance_test(s)/`, `functional_test(s)/`, `smoke_test(s)/`, `e2e_test(s)/` (with `_`, `-` or nothing before `test`) and `tests-e2e/`. Test files keep the `test` use, as before, so owner decision 22 (docs, examples, fixtures and build output still count) is unchanged. `playwright/` and a bare `integration/` were left out: on the frozen sets both name application code in some repositories (`src/targets/playwright/`, `src/integrations/shopify.js`).
- **Gemini.** `scripts/gemini-benchmark.mjs` ran once from main `3182b66` and once with the widened paths ([recount](benchmarks/2026-10-22-test-paths-recount.json)). Live-class precision went from 34/59 (57.6%) to 34/50 (68.0%); recall stayed 34/39 (87.2%). 9 matches changed use, all `system_test/` lines in `googleapis/nodejs-vertexai` labelled not sent, so repositories with a Gemini exposure went from 27 to 26. Live matches went from 439 to 430. No labelled sent pin was lost.
- **Other sets.** A listing of every frozen repository's files at its recorded commit found the newly matched directories only in test harnesses (for example `integration-tests/`, `e2e-tests/`, `system-test/`), and no labelled live site in any benchmark sits in one. The one recorded live site that moves is a v2 client in `jagregory/cognito-local`'s `integration-tests/aws-sdk/setup.ts`, an unlabelled Vitest harness ([Cloud SDK](CLOUD-SDK-EOL.md)). Sets whose results keep only aggregates (API hosts, the fresh deadline sets) have no frozen repository with such a directory, so they are unchanged.

## Stripe list and search traces (October 25)

refit-bench run [40175558373](https://github.com/refit-dev/refit-bench/actions/runs/40175558373) ran `feat/stripe-list-traces` at `b07ce5baa5041a68550ea79c34ceb9417c8cc90c` on `subsets/push-279-affected.json` with no AI (`gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=b07ce5baa5041a68550ea79c34ceb9417c8cc90c -f list=subsets/push-279-affected.json -f offset=0 -f size=2 -f count=279`). All 279 rows came back. Compared with main run 40167312081 at `efb3ddae`, its base, by `scripts/stripe-benchmark-compare.mjs`, 276 keep their outcome and 3 change, all for the better:

| Repository                         | main             | list traces | Why                                                                                                                                                               |
| ---------------------------------- | ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kanba-co/kanba                     | regression       | validated   | `subscriptions.list` results' `current_period_start` and `current_period_end` are now migrated; on main the stripe-node upgrade left them as two new `tsc` errors |
| iggy-tech/product-hunt-clone-final | regression       | validated   | the same for `current_period_end` in `lib/stripe.ts`                                                                                                              |
| jeanchrinot/shipaisaas-starter     | `[Needs review]` | validated   | `price.unit_amount` and `product.name` on `prices.list` and `products.list` pages are now traced to objects that keep those fields, so they no longer need review |

Confirmed findings went from 1,011 to 1,032 and validated repositories from 75 to 78; repositories whose checks failed on the patch went from 12 to 10. Unresolved findings went from 2,208 to 2,289, mostly `--full-diff` contract changes on the newly mapped list operations (for example 1 to 6 in `samarbadriddin0v/notion-clone`), which still need review and do not change an outcome. The workflow diff in the results is cut at 8,000 characters, so the edits were checked by a local rescan of 14 repositories that call list methods, from pinned worktrees of `efb3ddae` and `b07ce5ba` with FlowCraft's `2023-10-16` and endive contracts: 17 new read edits in Kanba-co/kanba, cyberdreadx/cyberpunk-grok-api, habibjutt/nextjs_boilerplate, iggy-tech/product-hunt-clone-final, odota/core, qesmsep/noir-crm-dashboard and shagunmistry/FlowCraft, each reviewed, none wrong. Not measured: AI patches, publication and the hosted worker.

## Signed webhook events of both API versions (October 28)

`--webhook-checks` sends signed Stripe events of both API versions to the Next.js route handlers a patch can affect, offline in the behaviour-test sandbox ([signed webhook events](GENERATED-CHECKS.md#signed-webhook-events-opt-in)). A handler file it covers counts for grade C only (founder decision, Otabek, 2026-10-28). The incoming-version gate is unchanged.

| Set (no AI)                       | Before: main `89f1c0ed` | After: `9f8936a7`, `--webhook-checks` |
| --------------------------------- | ----------------------: | ------------------------------------: |
| l2-push-249: production validated |                      84 |                                    84 |
| l2-push-249: grade changes        |                         |                                     0 |
| heldout-30: production validated  |                      10 |                                    10 |
| heldout-30: grade changes         |                         |                                     0 |

- **Runs.** Before: l2-push-249 [40624045392](https://github.com/refit-dev/refit-bench/actions/runs/40624045392) (the brief's 40624345477 was cancelled in the queue; this run is the same main commit), heldout-30 [40624360669](https://github.com/refit-dev/refit-bench/actions/runs/40624360669). After, at `9f8936a7` with `-f flags=--webhook-checks`: l2-push-249 [40639445000](https://github.com/refit-dev/refit-bench/actions/runs/40639445000) (`-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249`), heldout-30 [40700945574](https://github.com/refit-dev/refit-bench/actions/runs/40700945574) (`-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30`). Compared with `scripts/stripe-benchmark-compare.mjs`: 0 outcome changes on either set. Again at `09029e5f`, after the cross-mock boolean fix below: heldout-30 [40703117794](https://github.com/refit-dev/refit-bench/actions/runs/40703117794) (0 outcome, grade or patch changes; inboxradarai's event now passes) and l2-push-249 [40703112108](https://github.com/refit-dev/refit-bench/actions/runs/40703112108), whose shards 3 and 9 were cancelled with every other queued refit-bench run at 17:11Z: its 236 rows have 0 outcome, grade or patch changes against main (81 validated of those rows before and after). None of the 13 missing rows had an unresolved event at `9f8936a7`, and the fix can only turn an unresolved event into a passed one, so their `9f8936a7` results stand.
- **No grade rises.** The check covered handler files on 55 l2-push-249 rows and 8 heldout-30 rows, but every one was already type-checked (grade C, or B from tests), and signed events never give more than C. Where they could matter, the D rows, 53 l2-push-249 rows and 7 heldout-30 rows could not prepare their dependencies, so the handler cannot load.
- **Nothing lost, no new review labels.** No patch validates newly, so `docs/benchmarks/fix-reviews.json` is unchanged. The one patch that differs on l2-push-249, kondax-com/Bocker, follows its own flaky baseline: its tests failed on the original code in 40553722899, 40638303426, 40638306398 and this run, and passed only in 40624045392. Neither run validates it.
- **Unresolved events, all on rows already `[Needs review]`.** createdbymax/Loopletter-Open-source-email-marketing-platform reads `invoice.payment_intent` on `invoice.paid`, which the new version drops (the patch leaves it). 4NDR3S-01/TuSuerteEC fetches `PaymentIntent.invoice`, which the new version drops. raumildhandhukia/inboxradarai's `cancel_at_period_end` and Loopletter's `billing_thresholds` came from a subscription each side retrieved from its own version's mock, not from the patch; booleans no longer differ across sides since `09029e5f`, and `billing_thresholds` (null against an object) still does.
- **What stays out of reach.** On l2-push-249: 98 rows have no handler the patch affects that the harness can call (Pages Router, Express and Convex handlers, secrets from a validated `env` object), 53 cannot prepare dependencies, and 9 fail their patched checks before the signed events run. 0 regressions on either set.
- **Not measured:** AI patches, publication and the hosted worker.

## Request data flow in reach (October 27)

Production mode stops on a request contract change whenever Refit cannot read whether a traced call sends the changed property. On main, most of those calls build their request in ordinary code: an object that gains properties after it is created, line items pushed one by one or returned by a `.map` callback, conditional spreads, local helper functions. `feat/type-aware-reach` follows that data flow in `pipeline/operation-reach.ts`, and still stops wherever the object is passed to another function, aliased, returned, exported or written through a computed key. It also reads a Subscription update's own `items` property as a property: main read it as an array marker, so `subscriptions.update(id, { cancel_at_period_end: true })` was unreadable.

| Set (no AI, default flags)        | Before: main `d25413d9` | After: `0724f1ba` |
| --------------------------------- | ----------------------: | ----------------: |
| l2-push-249: production validated |                      73 |                80 |
| l2-push-249: contract-change stop |                      74 |                56 |
| heldout-30: production validated  |                      10 |                10 |

- **Runs.** l2-push-249: before [40432255476](https://github.com/refit-dev/refit-bench/actions/runs/40432255476), after [40448715209](https://github.com/refit-dev/refit-bench/actions/runs/40448715209) (`gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=0724f1baa7394ad766bb6d1308fba36ce14717ab -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249`). heldout-30: before [40447588227](https://github.com/refit-dev/refit-bench/actions/runs/40447588227), after [40448718890](https://github.com/refit-dev/refit-bench/actions/runs/40448718890) (`-f list=subsets/heldout-30.json -f size=3 -f count=30`). All rows came back in all four runs.
- **7 repositories newly validate, none lost.** el-noir/Tempify, abressiddique/AbresStore-Admin, cdinnison/goal-reminder, oMiguelwnl/Borcelle_admin, emman-tt/tilios-backend, Chris-26-dev/ecommerce and Mangu-Commerce/madcaptees. Each call site was read at its pinned commit to confirm it sends none of the changed properties, and each `migration.patch` was applied to a clone and read in full: 7 `correct` in [fix-reviews.json](benchmarks/fix-reviews.json). The patches come from existing rules only (card rule, version pin, stripe-node upgrade, currency code, generated read helpers).
- **What still stops.** On l2-push-249 the unreadable-request stop fell from 35 to 4 of the rows whose only blocker is contract changes. Those rows now stop on changes the code really sends (15), reads of a changed response field on an object Refit cannot trace (13) and other reach reasons (7). Most of the 56 rows with a contract-change stop also have another blocker: removed request parameters, kept or untraced API versions, webhook versions.
- **heldout-30.** Its one row with an unreadable request now reads it, but still stops on a change the code sends, so no outcome changes.
- **Not measured:** AI patches, publication and the hosted worker.

## Type oracle (October 27)

`feat/stripe-type-oracle` runs the repository's type check once more on the original code with the target stripe-node installed, and records the errors that upgrade introduces as `validation.typeOracle` ([architecture](ARCHITECTURE.md#type-oracle)). It is evidence only: it can move a contract change from `unknown` to `reached`, and it is the type condition the AI patch gate uses, but it never clears a stop by itself.

| Set (default flags)                      | Before | After: `e8f52e9` |
| ---------------------------------------- | -----: | ---------------: |
| l2-push-249: production validated, no AI |     80 |               80 |
| l2-push-249: production validated, AI    |     80 |               80 |
| heldout-30: production validated, no AI  |     10 |               10 |
| heldout-30: production validated, AI     |     10 |               10 |

- **Runs.** Before: l2-push-249 no AI [40448715209](https://github.com/refit-dev/refit-bench/actions/runs/40448715209), AI [40470122759](https://github.com/refit-dev/refit-bench/actions/runs/40470122759) with its failed shard rerun as [40544895386](https://github.com/refit-dev/refit-bench/actions/runs/40544895386); heldout-30 no AI [40448718890](https://github.com/refit-dev/refit-bench/actions/runs/40448718890), AI [40470125581](https://github.com/refit-dev/refit-bench/actions/runs/40470125581). After, at `e8f52e9b`: l2-push-249 no AI [40545715035](https://github.com/refit-dev/refit-bench/actions/runs/40545715035), AI [40545759381](https://github.com/refit-dev/refit-bench/actions/runs/40545759381); heldout-30 no AI [40545721985](https://github.com/refit-dev/refit-bench/actions/runs/40545721985), AI [40545751982](https://github.com/refit-dev/refit-bench/actions/runs/40545751982). AI runs used `-f ai=true` with a $200 budget on l2-push-249 and $30 on heldout-30.
- **No outcome changed.** `node scripts/stripe-benchmark-compare.mjs` finds every compared field identical on 249 of 249 rows without AI and on 30 of 30 heldout rows in both modes. With AI, kondax-com/Bocker failed its baseline check in the after run, so no patch was checked there; it stops `needs-review` in both runs. No patch was newly published, so there was nothing new to review.
- **Where the oracle ran.** On l2-push-249 it compared type errors on 146 rows; the other 103 do not upgrade stripe-node with prepared dependencies of their own or have no type check. The patched code had no new type errors on 134 of the 146. It moved 5 changes to `reached` on 4 rows, all of which already stopped for other reasons.
- **Not measured:** publication and the hosted worker.

## Validated means the draft is not [Needs review] (October 27)

A run without publication ended `validated` whenever every gate passed, even when its own draft was titled `[Needs review]`: a kept untyped request property such as `trial_from_plan`, a grade-D patch only Refit's generated checks reached, or advisory type errors in JavaScript. `fix/needs-review-outcome` ends those runs `needs-review`, so the benchmark counts only drafts that would publish as validated.

| Set (default flags)                      | Before: main `836df9fa` | After: `63646f2a` |
| ---------------------------------------- | ----------------------: | ----------------: |
| l2-push-249: production validated, no AI |                      80 |                80 |
| l2-push-249: production validated, AI    |                      80 |                80 |
| heldout-30: production validated, no AI  |                      10 |                 9 |
| heldout-30: production validated, AI     |                      10 |                 9 |

- **Runs.** Before: the type oracle runs above (main's code, outcome for outcome). After, at `63646f2a`: l2-push-249 no AI [40591181316](https://github.com/refit-dev/refit-bench/actions/runs/40591181316), AI [40591190068](https://github.com/refit-dev/refit-bench/actions/runs/40591190068); heldout-30 no AI [40591185819](https://github.com/refit-dev/refit-bench/actions/runs/40591185819), AI [40591194943](https://github.com/refit-dev/refit-bench/actions/runs/40591194943).
- **1 row changed.** KPZ231/what-now-chaos is graded D (no test reaches `src/app/api/checkout/route.js`; only the generated stripe-mock check ran it), so its draft was already `[Needs review]`; it now ends `needs-review`. Every other row is identical, except that with AI kondax-com/Bocker's patch failed its checks after it failed its baseline in the before run; it stops `needs-review` in both.
- **Why it matters for the lanes.** On l2-push-249 the spec-noise filter frees 4 rows whose draft keeps `trial_from_plan` (kpirabaharan/Spotify-Clone, adityayaduvanshi/Full-Stack-Music-Web-App, afdon/music-app, AlefeSk8/Spotify-Clone-Next.js); they now count as `needs-review`, not validated.

## AI patches on stops under D2, D2a and D2b (October 27)

`feat/ai-patch-on-stops` applies the owner's D2 gate to the coverage AI attempt: an AI patch publishes as a validated draft only when the new stripe-node is installed, the type oracle shows zero new errors, the repository's own tests pass offline (or, under D2a, a passing type check covers type-visible changes on the files it checked, labelled "validated by type check, no tests"), and the diff touches only traced Stripe sites. Under D2b an AI "no change needed" answer clears an untraced read only where the type oracle passed and the read's receiver is an object the application writes itself (`PLANS.find(…).price`), never on the AI's word alone.

| Set (default flags)                   | Before: main | After: `93e73d7c` |
| ------------------------------------- | -----------: | ----------------: |
| l2-push-249: production validated, AI |           80 |                84 |
| heldout-30: production validated, AI  |            9 |                10 |

- **Runs.** Before: l2-push-249 [40470122759](https://github.com/refit-dev/refit-bench/actions/runs/40470122759) with its failed shard rerun as [40544895386](https://github.com/refit-dev/refit-bench/actions/runs/40544895386), heldout-30 [40470125581](https://github.com/refit-dev/refit-bench/actions/runs/40470125581). After, at `93e73d7c`: l2-push-249 [40552354557](https://github.com/refit-dev/refit-bench/actions/runs/40552354557), heldout-30 [40552360621](https://github.com/refit-dev/refit-bench/actions/runs/40552360621). Both sets ran with `-f ai=true`, a $200 budget on l2-push-249 and $30 on heldout-30. Counts apply the needs-review fix above: KPZ231/what-now-chaos (grade D) is not counted in any heldout-30 run. Without AI the lane changes nothing: runs 40545177251 and 40545182208 match main outcome for outcome.
- **5 repositories newly validate, none lost.** CiphersLab/SaaSPilot, palashb01/DocuChat, JensenMPillay/pdfai and abhirupkumar/docwhisperer on l2-push-249, raumildhandhukia/inboxradarai on heldout-30. In each, the AI answered no change needed for untraced `.price` reads that read the application's plan configuration, the type oracle passed, and D2b cleared them; the patch itself is the rules' patch. Each `migration.patch` was applied to a clone and read in full: 4 `correct` and 1 `correct-partial` in [fix-reviews.json](benchmarks/fix-reviews.json). pdfai is partial because its webhook reads `session.subscription` for invoice events through a value cast to `Stripe.Checkout.Session`, which Refit's declared-type trace does not flag.
- **What still stops.** D2b cleared reads on 7 l2-push-249 rows; 3 still stop on contract changes or submodules. No AI patch passed the D2 gate: the one kept AI patch changed code outside the traced sites and the type oracle did not pass for it, so it stays `[Needs review]`. CRONANANI/EzanaFinance3 hit the 20-minute runner limit in the after run (`needs-review` before). AI spend was $1.01 on l2-push-249 (main: $0.66) and $0.13 on heldout-30 (main: $0.03).
- **Not measured:** publication and the hosted worker.

## Structurally equivalent schema changes (October 27)

Owner decision D4: a schema change that leaves the structure the same is not breaking, for any OpenAPI provider. `feat/spec-noise-filter` (`pipeline/schema-equivalence.ts`, [schema equivalence](SCHEMA-EQUIVALENCE.md)) marks such oasdiff changes compatible: a renamed subschema with the same shape, and format-only annotations. On Stripe's 2023-10-16 and endive specifications the two suspects are both of that kind: the `address` request property's subschema title `optional_fields_address` becomes `optional_fields_customer_address` with an identical object, and request `currency` properties gain `format: currency` with the same description.

| Set (no AI, default flags)        | Before: main | After: `3b5cb244` |
| --------------------------------- | -----------: | ----------------: |
| l2-push-249: production validated |           80 |                84 |
| l2-push-249: contract-change stop |           97 |                86 |
| heldout-30: production validated  |            9 |                10 |

- **Runs.** Before: l2-push-249 [40448715209](https://github.com/refit-dev/refit-bench/actions/runs/40448715209), heldout-30 [40448718890](https://github.com/refit-dev/refit-bench/actions/runs/40448718890). After, at `3b5cb244`: l2-push-249 [40552957597](https://github.com/refit-dev/refit-bench/actions/runs/40552957597), heldout-30 [40552966689](https://github.com/refit-dev/refit-bench/actions/runs/40552966689). Counts apply the needs-review fix above.
- **Stops cleared.** On l2-push-249 the contract diffs lose 191 entries: 24 `address` subschema renames and 167 `currency` format annotations. On heldout-30 they lose 17. No patch diff changed.
- **5 repositories newly validate, none lost.** siavashsk/spotify-clone, psykat1116/Spotify, Emmah-oo/spotify-clone and Neddie28/Spotify-Clone on l2-push-249, nishchay-veer/tunehub-next on heldout-30: each stopped only on the `address` change that `customers.update` sends from `billing_details`. Each `migration.patch` was applied to a clone and read in full: 5 `correct` in [fix-reviews.json](benchmarks/fix-reviews.json).
- **4 rows freed but not counted.** kpirabaharan/Spotify-Clone, adityayaduvanshi/Full-Stack-Music-Web-App, afdon/music-app and AlefeSk8/Spotify-Clone-Next.js ended `validated` in the run, but their drafts keep `subscription_data.trial_from_plan` and are `[Needs review]`; reviewed again as `unsure`, as on October 24, until a test-mode Checkout Session settles it.
- **What still stops.** 86 l2-push-249 rows keep a contract-change stop, most beside another blocker (removed request parameters, kept or untraced API versions, webhook versions). Addisu87/digital-marketplace failed dependency preparation on a registry 502 in the after run (`needs-review` before and after).
- **Not measured:** AI patches, publication and the hosted worker.

## Response reads through copies, helpers and nested owners (October 27)

`feat/response-read-tracing` traces a response object through `at()`, `find()` and copies made with `filter()` or `slice()`, through a private helper's return value and through the parameters every call of it passes the same object, and reads a Subscription's `items` list as subscription items, so a change nested under them (`items/data/items/price/product`) has a named owner. A write to an untraced object and a value of a free-form map such as `metadata` no longer count as reads. Reads through a helper keep review confidence, except through a parameter whose declared type already names the Stripe object.

| Set (no AI, default flags)        | Before: main `6c6ff6a9` | After: `d5b75c9f` |
| --------------------------------- | ----------------------: | ----------------: |
| l2-push-249: production validated |                      84 |                86 |
| heldout-30: production validated  |                      10 |                10 |

- **Runs.** Before, main at `6c6ff6a9` (after the spec-noise and API-version merges): l2-push-249 [40621425780](https://github.com/refit-dev/refit-bench/actions/runs/40621425780), heldout-30 [40621428835](https://github.com/refit-dev/refit-bench/actions/runs/40621428835). After, at `d5b75c9f`: l2-push-249 [40619980162](https://github.com/refit-dev/refit-bench/actions/runs/40619980162), heldout-30 [40619983267](https://github.com/refit-dev/refit-bench/actions/runs/40619983267). `d5b75c9f` branches from `d9217cac`, before the API-version merge, so the rows whose only difference is an `api-version-untraced` or `webhook-api-version` stop (compasstio-ai, build-it, branded, mern-vsms, RealEstateBrokerageMarket) come from that merge, not this branch. heldout-30 matches main on 30 of 30 rows.
- **Two regressions found and fixed.** The first heldout-30 run at `78e0c291` ([40554003990](https://github.com/refit-dev/refit-bench/actions/runs/40554003990)) moved VishalRaut2106/HackMate_AI's two `invoice.subscription` reads from confirmed to review: the helper parameter rule also covered `invoice: Stripe.Invoice`. `17e30256` keeps a declared Stripe type on its declared-type trace. The local suite then showed reads through a transparent wrapper and a helper with a declared Stripe return type downgraded to review (`nested-sdk.test.ts`, `stripe-types.test.ts`); `d5b75c9f` keeps those confirmed. Each has a test.
- **2 repositories newly validate, none lost.** samarbadriddin0v/notion-clone and shagunmistry/FlowCraft stopped only on 14 removals of Product `features` nested under subscription items in customer responses, which the code never reads. Each `migration.patch` was applied to a clone and read in full: 2 `correct` in [fix-reviews.json](benchmarks/fix-reviews.json). Their results at `d5b75c9f` match `17e30256` in every compared field, diff included.
- **What still stops.** Chivo1530/CHIVITO-AI-DEV loses its contract-change stop and gr8monk3ys/link-flame its source-evidence stop, but both keep a dependency-preparation stop. aresjinwoo94-cpu/EliteVault gains 2 confirmed period reads in `scripts/sync-stripe-plan.mjs`, on a client already pinned at basil, so the patch correctly leaves them; its draft stays `[Needs review]`. kondax-com/Bocker's baseline tests failed in this run (and in the preparation run) and passed on main with the same dependency archive: a flaky test in the repository, `[Needs review]` either way.
- **Not measured:** AI patches, publication and the hosted worker.

## API versions untraced only where the client escapes (October 27)

An `apiVersion` pin was `api-version-untraced` whenever its client could escape anywhere Refit cannot see. `feat/api-version-tracing` narrows that doubt to clients that really reach unseen code: a client passed to an opaque helper, an unsafe class binding, a webhook event Refit cannot trace, or an alias in a file whose resolution is ambiguous. A client handed to an exported local helper whose parameter Refit reads (`listCharges(client: Stripe)`) keeps its pin traced; a rest parameter or `eval` still makes it unknown.

| Set (no AI, default flags)                 | Before: main | After: `ae6127f7` |
| ------------------------------------------ | -----------: | ----------------: |
| l2-push-249: production validated          |           80 |                80 |
| l2-push-249: rows with an untraced version |           19 |                16 |
| heldout-30: production validated           |            9 |                 9 |

- **Runs.** Before: l2-push-249 [40448715209](https://github.com/refit-dev/refit-bench/actions/runs/40448715209), heldout-30 [40448718890](https://github.com/refit-dev/refit-bench/actions/runs/40448718890). After, at `ae6127f7`: l2-push-249 [40553722899](https://github.com/refit-dev/refit-bench/actions/runs/40553722899), heldout-30 [40553727358](https://github.com/refit-dev/refit-bench/actions/runs/40553727358). Counts apply the needs-review fix above.
- **3 rows lose the untraced-version stop, none validates.** Yosef-Ali/compasstio-ai, doganarif/build-it and alanagoyal/branded keep other blockers (contract changes, a removed request parameter, a kept API version). Only branded's patch changes: it now also upgrades stripe-node, read in full and reviewed `correct` for its two period reads; its draft stays `[Needs review]`.
- **What still stops.** 16 l2-push-249 rows keep an untraced version, from clients passed to helpers Refit cannot read, class bindings, or ambiguous aliases. Webhook endpoint versions are unchanged by this lane, and failed pin-move errors on `api-version-kept` drafts are still not recorded.
- **Not measured:** AI patches, publication and the hosted worker.

## Documented-replacement rules (October 28)

`feat/stripe-generated-rules` (#357) adds a reach rule for removed API operations, walks oasdiff `items` segments as array members where the schema is an array (so `Subscription.items` reads as a property), and adds the `request-enum-value` rule family with dahlia's three Checkout `ui_mode` successors ([rules](MINED-RULES.md#documented-replacement-rules-2026-10-28)).

| Set (no AI, default flags)                    | Before: main `89f1c0ed` | After: `a4438b81` |
| --------------------------------------------- | ----------------------: | ----------------: |
| l2-push-249: production validated             |                      84 |                86 |
| l2-push-249: rows with a contract-change stop |                      86 |                83 |

- **Runs.** `gh workflow run benchmark.yml --repo refit-dev/refit-bench -f commit=<sha> -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249`. Before: [40688452206](https://github.com/refit-dev/refit-bench/actions/runs/40688452206) at main `89f1c0ed`; the brief's before run 40624345477 was cancelled with 108 of 249 rows, so it was run again. After: [40637566055](https://github.com/refit-dev/refit-bench/actions/runs/40637566055) at `a4438b810c3f9930f997c77fc1d44273a70a17df`. Compared with `scripts/stripe-benchmark-compare.mjs`: 247 of 249 outcomes identical, 245 identical in every compared field.
- **2 repositories newly validate, none lost.** samarbadriddin0v/notion-clone and shagunmistry/FlowCraft stopped only on `removed the required property …/items/data/items/price/product/anyOf[…: Product]/features`, which the old path walk could not attribute to a Stripe object. It is now `Product.features`, which neither repository reads. Both `migration.patch` files are byte-identical to the before run's, were applied to a clone and read in full: 2 `correct` in [fix-reviews.json](benchmarks/fix-reviews.json). FlowCraft's checks did not run in the before run (dependency preparation) and passed in the after run; that difference is run noise.
- **Stops cleared but not counted.** `GET /v1/invoices/upcoming` blocks 6 rows instead of 20; each of the 6 has an untraced Stripe call that may request it, so it stays `unknown`. Product.features blocks 0 rows instead of 5. Chivo1530/CHIVITO-AI-DEV loses its contract-change stop and keeps its dependency-preparation stop. Strata-Labs/BitScript's checks ran in the before run and not in the after run (dependency preparation, run noise; the same patch).
- **The `ui_mode` rules edited nothing.** All 5 rows that send `ui_mode` build the request with spreads, through an untraced client or in a body Refit cannot read, so each stays a stop, as designed. The rules have 0 wrong patches on this set, and no row exercised them; they are covered by tests only.
- **heldout-30 not run.** Run [40727895025](https://github.com/refit-dev/refit-bench/actions/runs/40727895025) was cancelled on the founder's instruction (2026-10-28) to stop every heldout-30 and l2-push-249 run.
- **Not measured:** AI patches, publication and the hosted worker.

## Lockfile resolution and types-only peers (October 28)

Founders' decisions of 2026-10-27: a networked lockfile-resolution step may run before, and separate from, the offline validation, and a types-only peer (`@types/*` devDependency) may be raised together with stripe-node. `feat/lockfile-resolution` (`pipeline/lockfile-resolution.ts`, [details](DEPENDENCIES.md#lockfile-resolution-for-validation)) resolves a `package-lock.json` for a root npm project refused as `no-lockfile`, `lockfile-out-of-sync` or `lockfile-integrity`, as of its last commit date, with scripts off, no repository `.npmrc` and the registry pinned to registry.npmjs.org. Every resolved package then passes the existing checks and installs frozen offline. The resolved lockfile is not part of the pull request, and the draft says the checks ran against it and as of which date. It is on by default (`REFIT_LOCKFILE_RESOLUTION=off` turns it off); the benchmark's `--resolve-lockfiles` sets it explicitly.

| Set (no AI)                       | Before: main | After |
| --------------------------------- | -----------: | ----: |
| l4-lockfile-resolution (40 rows)  |              |       |
| — production validated            |            0 |     8 |
| — checks passed                   |            1 |    18 |
| — refused for a lockfile reason   |           38 |    14 |
| l2-push-249: production validated |           84 |    92 |
| l2-push-249: checks passed        |          161 |   178 |
| heldout-30: production validated  |           10 |    10 |
| heldout-30: checks passed         |           19 |    19 |

- **Subset.** `docs/benchmarks/subsets/l4-lockfile-resolution.json`, chosen by rule: every repository of `subsets/push-279-affected.json` whose row in run 40591181316 (l2-push-249) or 40591185819 (heldout-30), both at main `63646f2a`, names a `no-lockfile`, `lockfile-out-of-sync` or `lockfile-integrity` refusal or a stripe-node upgrade refused with "upgrade it first".
- **Runs.** Before: subset [40626037555](https://github.com/refit-dev/refit-bench/actions/runs/40626037555) (`cdff5f05` = main `89f1c0ed` + the subset), l2-push-249 [40624045392](https://github.com/refit-dev/refit-bench/actions/runs/40624045392) and heldout-30 [40624360669](https://github.com/refit-dev/refit-bench/actions/runs/40624360669) (main `89f1c0ed`). After, at `45601b1b`: subset [40734300846](https://github.com/refit-dev/refit-bench/actions/runs/40734300846) and heldout-30 [40734329431](https://github.com/refit-dev/refit-bench/actions/runs/40734329431). l2-push-249 after is [40677583831](https://github.com/refit-dev/refit-bench/actions/runs/40677583831) at `6c7bdc4c`: the founder cancelled the l2-push-249 rerun at `45601b1b` (40734315567) and paused further runs. The two commits between them only keep the committed lockfile's root names in a re-resolved lockfile and name the raised peer in the draft; on the subset and heldout-30, `6c7bdc4c` (40677546968, 40677593801) and `45601b1b` have the same outcome in every row, and every `migration.patch` is byte-identical except lamp-bot's lockfile name.
- **Commands.** `gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=<sha> -f list=subsets/l4-lockfile-resolution.json -f offset=0 -f size=2 -f count=40` (resolution is on by default since `9543185f`), the same with `-f list=subsets/l2-push-249.json -f size=25 -f count=249` and `-f list=subsets/heldout-30.json -f size=3 -f count=30`. Compared with `scripts/stripe-benchmark-compare.mjs`.
- **Nothing lost.** No row validated or passing its checks on main stops doing so on any set.
- **17 rows newly pass their checks, 8 newly validate.** Every `migration.patch` was read in full, lockfile hunks checked for scope: 11 `correct` and 6 `correct-partial` (3 kept their API version after the endive pin failed the type check; ele's multi-period subscription case and 10 unmigrated usages; minhthuong's webhook version; Chivo's advisory JavaScript error) in [fix-reviews.json](benchmarks/fix-reviews.json). None is wrong.
- **Types-only peer.** liamstamper/lamp-bot was refused because stripe 23.0.0 declares `@types/node >=20` as an optional peer and it pins 18.11.18. It now raises `@types/node` to 20.0.0 with stripe, its lockfile changes only stripe, `@types/node`, `undici-types` and the four packages stripe 23 no longer reaches, `tsc -p .` shows no new errors, and it validates at C.
- **What still stops (subset).** No lockfile for a project whose package.json npm cannot resolve as of its commit date: UNC-GDSC/Micro-SaaS-Starter-Kit (E404), RicardoGEsteves/next-digital-marketplace and baifan1366/project-management-system (ERESOLVE). Workspaces (Traviseric/arxmint), pnpm (Suhaib3100/online-compiler, nishantharkut/Uproot.AI), `EBADENGINE` (thematters/matters-server, MikPoik/next13-ai-companion) and 7 projects that also commit a binary `bun.lockb` (Rohit19060/stripe_hono, mageshyt/Nextjs-saas-starter, rishabhsingroha/MusicListeningPlatform, LDAWoo/webprodigies-plura, blefnk/all-in-one-nextjs-template, duggal1/flux-io, michaelshimeles/goshenpay-backend). Four rows now reach their checks and fail them on the original code; helloworld9912/Stripe-Account-Migration's patch fails its checks and is not published.
- **Not measured.** `9fe02248`, after the measured commit, resolves lockfiles for npm projects that also commit `bun.lockb`, which reaches the 7 rows above; it has unit tests only, and the benchmark rerun waits for the founder. AI patches, publication and the hosted worker were not measured.

## Preparation inputs npm and pnpm accept (October 28)

`feat/preparation-failures` accepts what npm and pnpm themselves accept in four lockfile and workspace shapes from the l2-push-249 triage ([preparation failures](PREPARATION-FAILURES.md#preparation-coverage-triage-2026-10-27)): an integrity that lists `sha1` beside a stronger hash, a lockfile record outside every `node_modules` directory, workspace negations after every positive pattern, and a pnpm workspace `bin` no importer links to.

| Set (no AI, default flags)                          | Before: main `6c6ff6a9` | After: `b884fe3e` |
| --------------------------------------------------- | ----------------------: | ----------------: |
| l2-push-249: production validated                   |                      84 |                84 |
| l2-push-249: rows stopped on dependency preparation |                      53 |                51 |
| heldout-30: production validated                    |                      10 |                10 |

- **Runs.** Before, main at `6c6ff6a9`: l2-push-249 [40621425780](https://github.com/refit-dev/refit-bench/actions/runs/40621425780), heldout-30 [40621428835](https://github.com/refit-dev/refit-bench/actions/runs/40621428835). After, at `b884fe3e` (this branch with `6c6ff6a9` merged): l2-push-249 [40621391261](https://github.com/refit-dev/refit-bench/actions/runs/40621391261), heldout-30 [40621394549](https://github.com/refit-dev/refit-bench/actions/runs/40621394549).
- **2 rows now prepare, none validates.** Shobhnik13/SynthAI passes both checks and keeps other stops; tomsoderlund/login-as-a-service's baseline fails. Small-Web-Co/tinypivot and inventashif/hackerai pass the fixed checks and stop on real lockfile drift and a Node 24 engine requirement. No patch newly validates.
- **Not measured:** AI patches, publication and the hosted worker.

## Dependency blocker census and the committed-source limit (October 27)

A census of every blocker on every row of main `89f1c0ed`, and the committed-source limit raised to 512 MiB under `4g` and 256 MiB under `2g` (founders' decision, 2026-10-27). The table and how to read it are in [Dependency blockers](DEPENDENCY-BLOCKERS.md); the per-row census is `benchmarks/2026-10-27-blocker-census.json`.

| Set                                | Run                                                                              | Commit          | Validated |
| ---------------------------------- | -------------------------------------------------------------------------------- | --------------- | --------: |
| l2-push-249, no AI                 | [40624045392](https://github.com/refit-dev/refit-bench/actions/runs/40624045392) | main `89f1c0ed` |        84 |
| l2-push-249, AI ($200 cap)         | [40624062726](https://github.com/refit-dev/refit-bench/actions/runs/40624062726) | main `89f1c0ed` |        88 |
| heldout-30, no AI                  | [40624069371](https://github.com/refit-dev/refit-bench/actions/runs/40624069371) | main `89f1c0ed` |        10 |
| heldout-30, AI ($30 cap)           | [40624075884](https://github.com/refit-dev/refit-bench/actions/runs/40624075884) | main `89f1c0ed` |        11 |
| l2-push-249, no AI, after          | [40625964049](https://github.com/refit-dev/refit-bench/actions/runs/40625964049) | `2d6f499c`      |        84 |
| heldout-30, no AI, after           | [40625971542](https://github.com/refit-dev/refit-bench/actions/runs/40625971542) | `2d6f499c`      |        10 |
| source-limit-50 (16), `2g`, before | [40625949948](https://github.com/refit-dev/refit-bench/actions/runs/40625949948) | `fffa3ad5`      |         0 |
| source-limit-50 (16), `2g`, after  | [40625956831](https://github.com/refit-dev/refit-bench/actions/runs/40625956831) | `2d6f499c`      |         1 |

- **Commands.** `gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=<full sha> -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249` (and `-f ai=true -f ai_budget=200`); heldout-30 with `-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30` (and `-f ai=true -f ai_budget=30`); the subset with `-f list=subsets/source-limit-50.json -f offset=0 -f size=2 -f count=16 -f flags="--validation-workspace 2g"`. The census: `node scripts/validation-funnel.mjs <merged>/results.json --all-blockers --artifacts <download dir> --json`; comparisons with `scripts/stripe-benchmark-compare.mjs`.
- **Baseline ids.** The l2-push-249 no-AI baseline is [40624045392](https://github.com/refit-dev/refit-bench/actions/runs/40624045392), an identical run at the same commit: the one this lane dispatched (40624056119) was cancelled with other duplicates to clear the queue.
- **`4g`: no change.** 0 outcome changes on 249 and 30 rows. Every heldout-30 patch is byte-identical, and 233 of 234 l2-push-249 patches; kondax-com/Bocker's own tests are flaky (a regression in [40624045392](https://github.com/refit-dev/refit-bench/actions/runs/40624045392), a baseline failure in [40624062726](https://github.com/refit-dev/refit-bench/actions/runs/40624062726) at the same commit), and its patch differs only in where the period helper is written. At `4g` the old 256 MiB limit stopped none of the 597 tuned repositories (the largest tree is 155.5 MiB).
- **`2g`: 8 rows pass the source check.** Before, 8 of the 16 rows over 50 MiB were refused with the 50 MiB message; after, none. Shefaul-22/AgriFlow validates (C). mouhamedanflosse/digitalHome and shivamm-55/HippoSphere (C) and CRONANANI/EzanaFinance3 (D) pass their checks and stay `[Needs review]`. Traviseric/arxmint and Eziox-Development/eziox-web stop at lockfile integrity and lockfile drift, RaulRicco/CashBack's preparation fails, and SimplerDevelopment/SimplerDevelopment writes no manifest, as at `4g`. The four passing patches were read in full: AgriFlow, digitalHome and HippoSphere `correct`, EzanaFinance3 `unsure` (untraced reads in files the patch does not touch), in `benchmarks/fix-reviews.json`.
- **Not repeated:** the AI runs after the change. The limit is checked before any patch is validated and stops nothing at `4g`, so the AI budget was kept.
- **Not measured:** host memory while buffering a source tree near 512 MiB on the Fly worker, publication and the night set.

## `payment_method_types` on its own API-version path (October 28)

`claude/refit-payment-method-types-9b09ad` keeps the `allowed_payment_method_types` rename wherever the renamed call's own path is proven: its own request sends no version override (or a literal the patch moves), and every constructor of its client, through `const` aliases, pins a literal the patch moves or omits `apiVersion` and moves with the stripe-node upgrade. Before, any one untraced client or request anywhere in the repository dropped every rename. The founders' decision of 2026-10-27 and what still stops are in [STRIPE-PAYMENT-METHOD-TYPES.md](STRIPE-PAYMENT-METHOD-TYPES.md#founders-decision-2026-10-27-the-renames-own-api-version-path).

| Set (no AI, default flags)          | Before: main `89f1c0ed` | After: `7af4994d` |
| ----------------------------------- | ----------------------: | ----------------: |
| l2-push-249: production validated   |                      84 |                84 |
| l2-push-249: rows with a rename     |                     162 |               167 |
| l2-push-249: renamed call sites     |                     204 |               220 |
| heldout-30: production validated    |                      10 |                10 |
| heldout-30: rows with a rename      |                      21 |                22 |
| subset (9 rows): rows with a rename |                       0 |                 4 |

- **Runs.** l2-push-249: before [40624045392](https://github.com/refit-dev/refit-bench/actions/runs/40624045392), after [40628689742](https://github.com/refit-dev/refit-bench/actions/runs/40628689742) (`gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=7af4994dbf21f374460f54f557f7937f34af8f12 -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249`). heldout-30: before [40624048377](https://github.com/refit-dev/refit-bench/actions/runs/40624048377), after [40628692513](https://github.com/refit-dev/refit-bench/actions/runs/40628692513) (`-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30`). Subset `subsets/pmt-version-path.json`, the 9 l2-push-249 rows whose draft still sent `payment_method_types` with an untraced or kept API version on main (rule in the file): before [40628750627](https://github.com/refit-dev/refit-bench/actions/runs/40628750627) at `9850ead0` (main plus the list), after [40628753242](https://github.com/refit-dev/refit-bench/actions/runs/40628753242) at `4f3f9cec` (`-f list=subsets/pmt-version-path.json -f offset=0 -f size=1 -f count=9`). All rows came back in all six runs. Renames are counted as `+allowed_payment_method_types` lines in each `migration.patch`.
- **No outcome changed; nothing validated was lost.** `node scripts/stripe-benchmark-compare.mjs` finds the same outcome on 249 of 249 and 30 of 30 rows. 244 of 249 l2-push-249 rows and 29 of 30 heldout rows are identical in every compared field. No row lost a rename.
- **6 rows gain renames (17 call sites).**
  - mhaowork/warranty-watcher: regression (TS2561 on the left `payment_method_types`) → checks pass; `[Needs review]` only for an untraced version elsewhere.
  - Bizgojo/drivetimetales: 5 renames. Main kept the `2023-10-16` pins after the pin move failed `tsc` (`api-version-kept`); now every traced pin moves to endive with stripe 14.25.0 → 23.0.0 and `tsc` passes on both sides (grade C).
  - hackerai-tech/hackerai: 2 renames on a lazily created client with no `apiVersion`, plus stripe 22.6.2 → 23.0.0; was a scan stop with no patch, now an untested draft (dependency preparation fails).
  - Sasu8823/Hairdresser_matching_service-backend (heldout-30): the confirmed `index.js` call renames; `routes/stripe.js:26` is a review-confidence call and keeps stopping, named in the draft; untested (no lockfile).
  - qesmsep/noir-crm-dashboard: 7 sites (literal lists with `card` and `us_bank_account`, `['us_bank_account']` and the computed `[payment_method_type]`); its baseline fails, as before.
  - kondax-com/Bocker: 1 rename; the subset pair shows the patch otherwise byte-identical. In the l2-push-249 after run its own timing test failed on the original code (`expected 199.07 to be less than 100`), so it ended `baseline-failed` instead of main's regression; neither validates.
- **Reviewed.** Every new or changed patch that validates, or is new, was applied to a clone at its pinned commit and read in full: warranty-watcher, drivetimetales and hackerai `correct`, Sasu8823 `correct-partial` ([fix-reviews.json](benchmarks/fix-reviews.json)).
- **What still stops.** On l2-push-249 the larger blockers are unchanged: stripe-node upgrades refused by dependency preparation (18 rows) and pin moves that fail the repository's checks (9). Getters that return a module client (puneethkotha/Zapd, geallenboy/ai-saas-template) and unconfirmed clients still stop.
- **Not measured:** AI patches, publication and the hosted worker.

## Type-only repair of upgrade-introduced type errors (October 28)

`claude/stripe-type-repair-gate` repairs type errors the stripe-node upgrade introduces in application code, under the founders' decision of 2026-10-27, without changing runtime behaviour. Each repair passes a type-only gate (`typeOnlyRepairFailures` in `pipeline/ai-patch-policies.ts`):

- Every changed file must compile to the same JavaScript under the repository's compiler options.
- The repair may edit only statements that hold an error the type oracle lists as introduced.
- It may not touch an enum, namespace or decorator.

The deterministic repair asserts the narrower type at the site where a widened Stripe type is assigned (`stripe-open-enums.ts`). An AI repair of such errors must pass the same gate and stays `[Needs review]` ([guard](AI-PATCH-GUARD.md#type-only-repairs-of-upgrade-introduced-type-errors-october-27)).

| Set (default flags)                      | Before: main `89f1c0ed` | After: `d311ec37` |
| ---------------------------------------- | ----------------------: | ----------------: |
| l2-push-249: production validated, no AI |                      84 |                84 |
| l2-push-249: production validated, AI    |                      88 |                88 |
| heldout-30: production validated, no AI  |                      10 |                10 |
| heldout-30: production validated, AI     |                      11 |                11 |

- **Runs.**
  - Before, at `89f1c0ed`: l2-push-249 no AI [40624045392](https://github.com/refit-dev/refit-bench/actions/runs/40624045392) and AI [40624062726](https://github.com/refit-dev/refit-bench/actions/runs/40624062726); heldout-30 no AI [40624360669](https://github.com/refit-dev/refit-bench/actions/runs/40624360669) and AI [40624075884](https://github.com/refit-dev/refit-bench/actions/runs/40624075884).
  - After, at `d311ec37`: l2-push-249 no AI [40626081878](https://github.com/refit-dev/refit-bench/actions/runs/40626081878) and AI [40626090687](https://github.com/refit-dev/refit-bench/actions/runs/40626090687); heldout-30 no AI [40626098795](https://github.com/refit-dev/refit-bench/actions/runs/40626098795) and AI [40626107102](https://github.com/refit-dev/refit-bench/actions/runs/40626107102).
  - Dispatch: `gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=<sha> -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249` and `-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30`, each also with `-f ai=true -f ai_budget=200` (l2) or `30` (heldout).
  - AI spend: l2 $1.07 before and $1.10 after; heldout $0.16 both times.
- **1 patch improves; it is not newly validated.** On Alex-Unnippillil/share-house-portal, the stripe-node 16.6.0 → 23.0.0 upgrade broke the type check with TS2322: the widened `Subscription.Status` was returned as the narrower Supabase status union. The patch therefore kept the old pin and package (`api-version-kept`).
  - The fix is one assertion inside the `if` that already narrows `status` to those four literals. It passes the gate, and the tests and `tsc` pass in offline Docker (grade B). The patch now moves the pin to `2026-09-30.endive` and upgrades stripe-node in both lockfiles.
  - Without AI and with AI the patch is byte-identical. Read in full and reviewed `correct` in [fix-reviews.json](benchmarks/fix-reviews.json).
  - The draft stays `[Needs review]` for one untraced `.type` read on a Plaid object, so the validated count does not move.
- **Other changed rows are run noise, none lost.** Without AI, 246 of 249 rows are identical in every compared field; with AI, also 246. Both heldout-30 pairs are identical on 30 of 30.
  - kondax-com/Bocker fails its own baseline in one run of each pair (a 288 ms timing test).
  - vinroger/onellm-frontend hit the 300-second dependency-preparation limit in the after run without AI.
  - CRONANANI/EzanaFinance3 reached the 20-minute limit in the before run with AI.
- **The AI path was never exercised.** No row had only upgrade-introduced errors that the deterministic repair left. The AI type-only gate refused nothing because nothing reached it.
  - The patched type errors on l2-push-249 (79 on 12 rows in run 40591181316) are mostly removed fields, removed request parameters, arity changes, nullable widening and errors in JavaScript files. A type-only repair must not hide those.
  - Only Bocker shows the widened-enum shape (4 errors), beside 31 others.
- **Not measured:** publication and the hosted worker.

## Runtime stand-ins and generated clients (October 28)

Generated stripe-mock checks call exported functions around each finding, and most stopped before their Stripe call on a database, a Supabase table or a session (data: [`2026-10-28-runtime-blockers.json`](benchmarks/2026-10-28-runtime-blockers.json)). `feat/runtime-stand-ins` adds stand-ins in Refit's own harness only (a `@prisma/client` built from the committed schema, answers at the placeholder service URL, NextAuth v4 and Clerk sessions; never Stripe), and generates the Prisma client before every check, by default since the founder's decision of October 28 ([Dependencies](DEPENDENCIES.md#generated-clients)).

| Set (no AI)                                    | Before: main `89f1c0ed` | Stand-ins: `6773b135` | Stand-ins and generated clients: `6773b135 --generate-clients` |
| ---------------------------------------------- | ----------------------: | --------------------: | -------------------------------------------------------------: |
| l2-push-249: production validated              |                      84 |                    84 |                                                             84 |
| l2-push-249: rows whose generated check ran    |                       5 |                    25 |                                                             25 |
| l2-push-249: rows with `@prisma/client` TS2305 |                      73 |                    73 |                                                              2 |
| heldout-30: production validated               |                      10 |                    10 |                                                             10 |
| heldout-30: rows whose generated check ran     |                       1 |                     6 |                                                              6 |

- **Runs.** l2-push-249 (`-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249`): before [40624045392](https://github.com/refit-dev/refit-bench/actions/runs/40624045392), stand-ins [40638303426](https://github.com/refit-dev/refit-bench/actions/runs/40638303426), with `-f flags=--generate-clients` [40638306398](https://github.com/refit-dev/refit-bench/actions/runs/40638306398). heldout-30 (`-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30`): before [40624360669](https://github.com/refit-dev/refit-bench/actions/runs/40624360669), stand-ins [40695266609](https://github.com/refit-dev/refit-bench/actions/runs/40695266609), with generated clients [40695271902](https://github.com/refit-dev/refit-bench/actions/runs/40695271902). Compared with `scripts/stripe-benchmark-compare.mjs`. `6be912a2` makes generation the default with no other change, so the flagged runs measure it.
- **Nothing lost, nothing newly validated.** Outcomes are identical on all 249 and all 30 rows in every run, so no new `migration.patch` needed a review label. Patches are byte-identical except kondax-com/Bocker on l2, whose own timing test (`expected 100.7 to be less than 100`) failed its baseline in both after runs, with and without generation, so its patched checks did not run.
- **Stand-ins.** 17 of the 25 l2 rows whose generated check passes used a stand-in (`validation.generated.standIns`): Prisma 9, PostgREST 7, Clerk 9 (some rows several); 8 rows reach the PostgREST stand-in and still stop later. No generated check counted a regression. Generated checks never raise the grade above D, so grades are unchanged.
- **Generated clients.** Type checks lose the missing-client errors in 71 of 73 l2 rows and change their error counts in 10 heldout rows, with no introduced error added; brandbite/brandbite's test baseline passes, and its draft stays `[Needs review]` for its other blockers.
- **Not measured:** AI patches, publication, behaviour tests and the hosted worker.

## checkJs type check for require()-only JavaScript (October 29)

`feat/checkjs-type-check` type-checks JavaScript that loads stripe only with `require()` and has no test script, with a generated `tsconfig` (`checkJs`, `node16` module resolution). Under owner decision D2c the check stands in for tests, at grade C, only where TypeScript types every changed Stripe expression with the target stripe-node's declarations and every contract change the patch handles is type-visible.

| Set (no AI, default flags)                        | Before | After |
| ------------------------------------------------- | -----: | ----: |
| l2-push-249: production validated                 |     86 |    89 |
| l2-push-249: rows that stop on "No check can run" |      6 |     0 |
| l2-push-249 merged with main, 224 rows: validated |     91 |    93 |

- **Runs.** Before, main at `efcb91ed`: [40806735877](https://github.com/refit-dev/refit-bench/actions/runs/40806735877). After, at `3ee00eb2`: [40806747841](https://github.com/refit-dev/refit-bench/actions/runs/40806747841). All rows came back in both. On the tree merged with main: main at `6161f020` [40821431837](https://github.com/refit-dev/refit-bench/actions/runs/40821431837), whose shard 2 failed, and this branch at `ce1f168f` [40821435089](https://github.com/refit-dev/refit-bench/actions/runs/40821435089); the merged row compares the 224 rows both returned.
- **5 rows move from D to C.** `dalemoncayo/express-stripe`, `mdalmamunit427/yoga-master-server` and `manfraio/stripe_elements_customized_card_form` validate. `samiamjidkhan/dota2-helper` stays a draft for untraced reads of Dota data, and `RescuePC/Donation-Link` for a submodule. Each patch is the card rule and the stripe-node upgrade, byte-identical on the merged tree. There `aionarae/amazon-beta`, which main now prepares, also reaches C and stays a draft for contract changes.
- **Reviews.** Every grade C patch was read in full against [FIX-REVIEW.md](FIX-REVIEW.md): 6 correct, 0 wrong ([fix-reviews.json](benchmarks/fix-reviews.json)). The unpatched express-stripe code fails the same check on `payment_method_types`, so it catches the removed parameter.
- **What still stops.** `App-4-Dat-LLC/LandLORDER-rp` now gets the check but stops on dependency preparation, since its lockfile does not lock stripe at the root. `SimplerDevelopment/SimplerDevelopment` differs between runs only because it hit the workflow time limit on busy runners.
- **Not measured:** AI patches, publication and the hosted worker. No held-out or holdout set was run.

## Before and after the overnight merges (October 22)

Two sets were run with the real CLI from pinned worktrees of `main`: once at `7b2c86a`, before the overnight merges, and once at `7360e3c`, after the last of them. Both runs used deterministic rules and offline Docker validation (`node:22-alpine`, generated `stripe-mock` checks), with no AI and no publication. They ran on a laptop, because AWS EC2 launches were denied by an organization policy, so timings are noisy; compare outcomes. Per-repository results: Stripe [before](benchmarks/2026-10-22-stripe-heldout-baseline-results.json) and [after](benchmarks/2026-10-23-stripe-heldout-rerun-results.json), Shopify [before](benchmarks/2026-10-22-shopify-baseline-results.json) and [after](benchmarks/2026-10-23-shopify-rerun-results.json). The runs after the merges also commit their harness record, with the image digest ([Stripe](benchmarks/2026-10-23-stripe-heldout-rerun-harness.json), [Shopify](benchmarks/2026-10-23-shopify-rerun-harness.json)).

| Set                                  | `7b2c86a` | `7360e3c` |
| ------------------------------------ | --------- | --------- |
| Stripe held-out: affected            | 24        | 24        |
| Stripe held-out: validated           | 9         | 9         |
| Shopify original: traced documents   | 350       | 350       |
| Shopify original: stopped for review | 39        | 39        |

- **No repository changed outcome.** `node scripts/stripe-benchmark-compare.mjs` on the two Stripe files finds 0 outcome changes. On Shopify every repository's outcome, traced documents, target and scan status match.
- **The same Shopify fix.** `samirjabib/shopify-apps-convex-template` is the 1 patched repository in both runs, validated by `npm test`.
- **Shopify schemas.** All four served Admin schemas differ from the SHA-256 pinned in the frozen list, so the setup script refuses fresh ones. Both runs used the same schemas, saved on October 22. They compare runs with each other, not with the pinned introspection.
- **Not measured:** AI patches, publication, the other Stripe sets, and the new features the merges added, which are mostly off by default. An unchanged score shows the merges did not break these repositories; it does not measure what they add.

## Hosted fork test (October 24)

The single-tenant hosted worker (`refit hosted serve` on Fly, with `--publish-draft --ai-patch --repair-attempts 2` and a $2 AI cap) ran the whole hosted path on 8 Stripe forks in `refit-dev`: GitHub App installation, stored approval, managed checkout, offline Docker validation and draft publication by Refit Agent. The operator wrote each fork's `.refit.json` and checks, with `fullDiff: false` as in the benchmarks, and picked the forks from the frozen sets, so every outcome was predicted before the run. Final outcomes are from main `c6c7665`, read from the worker log; the drafts are on the forks, and the upstream repositories were not touched.

| Fork                                 | Outcome                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| ai-companion                         | [Draft](https://github.com/refit-dev/ai-companion/pull/1), `tsc` before and after              |
| full-stack-starter-kit               | [Draft](https://github.com/refit-dev/full-stack-starter-kit/pull/2), `tsc` before and after    |
| spotify-clone                        | [Draft](https://github.com/refit-dev/spotify-clone/pull/1), `tsc` before and after             |
| stripe_elements_customized_card_form | [Draft](https://github.com/refit-dev/stripe_elements_customized_card_form/pull/1), `node -e 0` |
| web-scraping-course-app              | [Draft](https://github.com/refit-dev/web-scraping-course-app/pull/1), `node -e 0`              |
| querypdf                             | Checks passed, untraced reads unresolved: not published                                        |
| synthai                              | Stopped at `refit doctor`: dependency preparation inputs                                       |
| miro-clone                           | Stopped at `refit doctor`: dependency preparation inputs                                       |

- **Every outcome matched the prediction.** All 5 drafts come from deterministic rules. No AI request was made, so AI repair on the hosted worker is still unexercised.
- **Two Linux-only bugs, both fixed.** The sandbox runs as an unprivileged user and the hosted worker as root, while Docker Desktop on macOS ignores folder modes, so local runs never met either. Candidate and generated folders were created by `mkdtemp`, readable only by their owner ([#242](https://github.com/pierceluu10/Refit/pull/242)), and `stripe-mock` contracts were mounted from private run artifacts ([#243](https://github.com/pierceluu10/Refit/pull/243)). Before the fixes no patched check could read its input, and `stripe-mock` never started.
- **Shared CPU throttles.** On `shared-cpu-2x` the first full job took about 5 minutes. After an hour of back-to-back jobs, installs and type checks slowed until 2 jobs passed the 120-second check limit. On `performance-8x` the same retries took about 2 minutes each.
- **Weak checks on two drafts.** stripe_elements_customized_card_form and web-scraping-course-app have no tests, so the operator's check was `node -e 0`, and generated `stripe-mock` checks found no entry point in either. Those drafts show that the patch applies, not that the code works. spotify-clone's one `stripe-mock` entry point could not run on its own.
- **Not measured:** AI patches, approval issues, more than one installation, and draft updates: full-stack-starter-kit opened a second draft beside one from an earlier local run instead of updating it.

## Push-279 after merging the Laptop 1–3 PR batch (October 25)

refit-bench run [40236299492](https://github.com/refit-dev/refit-bench/actions/runs/40236299492) ran the merged batch (#288, #289, #284, #269, #286, #308, #309, #315, #324, #313, #331, #249 on top of #326–#330 and #312) at `179c6bc75d184142bddd9f3261431ba211a7a63c` on `subsets/push-279-affected.json` with no AI (`gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=179c6bc75d184142bddd9f3261431ba211a7a63c -f list=subsets/push-279-affected.json -f offset=0 -f size=2 -f count=279`). All 279 rows came back. Compared by production status with main run 40181262435:

| Production status | main (40181262435) | merged batch (40236299492) |
| ----------------- | -----------------: | -------------------------: |
| validated         |                 78 |                         83 |
| needs-review      |                167 |                        173 |
| none              |                 28 |                         22 |
| error             |                  6 |                          0 |
| missing-manifest  |                  0 |                          1 |

- 15 repositories improved: 5 to validated (Shefaul-22/AgriFlow from an error; web-scraping-course-app, backend-lazypress, GenForm and saas-pdf-analysis-dev from needs-review), and 10 from an error or no patch to a `[Needs review]` draft. All six archive-limit errors are gone.
- None lost a draft. SimplerDevelopment/SimplerDevelopment had no runnable checks before; the merged preparation now finds its tests, and its run hit the benchmark's 20-minute limit (`missing-manifest`) under the new 600-second check timeout.
- #310 (opt-in behaviour tests) merged after this run; it changes nothing without `--behaviour-tests`.

## Push-279 at Refit 0.38.0 and at main (October 25)

The same 279 affected Stripe repositories (`subsets/push-279-affected.json`), no AI, no publication, on `refit-dev/refit-bench`:

- **0.38.0 (October 16):** run 40211544936 at `32ab89f`. It is `v0.38.0` (`54ae277`) plus the push-279 list and today's `stripe-benchmark-setup.mjs` and its two helpers. Only the harness changed; 0.38.0's setup script had no `--offset`.
- **Main:** run 40181262435 at `05477b9`, whose tree is merged as `4f9dc9a`.

|                                                    |                                                                                0.38.0 |                                                 Main |
| -------------------------------------------------- | ------------------------------------------------------------------------------------: | ---------------------------------------------------: |
| Confirmed breaking usage                           |                                                                                   243 |                                                  273 |
| Possible breaking usage only (needs review)        |                                                                                    36 |                                                    6 |
| Validated patch (checks pass on the migrated code) |                                                                                     0 |                                                   78 |
| `[Needs review]` draft with a patch                |                                                                                     0 |                                                  167 |
| Stopped with no PR                                 | 189 at scan (176 on the removed `payment_method_types`) + 12 checks failed + 9 errors | 6 errors (source over the 50 MiB validation archive) |
| Not run: no checks the benchmark can run           |                                                                                    69 |                                                   28 |

- 0.38.0's `needs-review` rows stopped at the scan with no patch and no draft. Decision 1 (October 24) did not exist yet.
- Most of the change comes from owner decisions: the card-only and keep-listed `payment_method_types` policies, decision 1 and the 4 GiB sandbox. New rules add to it, such as list and search traces (#334) and the regression fallback (#319).
- Not measured here: AI and publication. The live hosted worker reached 190 of these targets: AI was asked on 40 (21%) and wrote the patch on 2, for $0.64 of a $7 cap.

## Night set (frozen October 24)

[`2026-10-24-stripe-night-repos.json`](benchmarks/2026-10-24-stripe-night-repos.json) is a held-back set for one end-of-night run. It was selected and committed before any run with `stripe-active-select.mjs --frozen-at 2026-10-24`, using the active-teams criteria. Each `--exclude` takes one of the four earlier Stripe lists. The file records every list, count and dropped repository:

- **Search.** The fresh set's 13 code searches, each split into 5 file-size ranges: 26,379 repositories. 556 belong to the four earlier sets (100 original, 50 held out, 381 fresh, 66 active), leaving 25,823.
- **Criteria.** Same as the active-teams set, with the 90-day window ending 2026-10-24. A light metadata pass (archived, fork, size, last push) ran before the full pass, which reads commit authors, workflows, `package.json` and lockfiles. 346 qualified. 16,758 had no commit in 90 days, 4,183 were over 50 MB, and 3,590 had one human author.
- **Kept.** The 130 most starred were shallow-cloned only to read their API version, then deleted. 104 were kept, after dropping repositories already on endive (15), with no derivable API version (5), with an API version that has no pinned spec (5), or that could not be cloned (1). 34 are owned by organisations. 85 of 104 pin a 2025–2026 API version, and the median repository has 1 star.

Nobody runs Refit on this set or reads its repositories' code before the final run, so the list stays unseen while Refit is tuned.

## New set (frozen October 28)

[`2026-10-28-stripe-new-repos.json`](benchmarks/2026-10-28-stripe-new-repos.json) holds 30 repositories that appear in no earlier Stripe list, so neither Refit nor its model has seen them. It was selected and committed before any run, with `stripe-active-select.mjs --frozen-at 2026-10-28 --limit 61` and one `--exclude` for each of the seven earlier Stripe lists (original, held out, fresh, active, the basil and endive replays, night):

- **Search.** The same 13 code searches in 5 size ranges found 26,525 repositories. 650 belong to the earlier lists, leaving 25,875.
- **Criteria.** The active-teams criteria, with the 90-day window ending 2026-10-28. 266 qualified. 16,833 had no commit in 90 days, 4,196 were over 50 MB, and 3,593 had one human author.
- **Kept.** The 61 most starred were shallow-cloned only to read their API version, then deleted. The limit is the smallest that keeps 30. 31 were dropped: 19 already on endive, 7 with an API version that has no pinned spec, 4 with no derivable version and 1 that could not be cloned. 25 of the 30 pin a 2025–2026 API version. 5 are owned by organisations, and the median repository has 0 stars.

## P4 draft lifecycle stack on the dev set (October 24)

Laptop 1's review of the P4 stack (#251 to #275) ran the 30-repository `subsets/dev-30.json` once at the stack head `c27f2dc`, which has `main` at `2143ee5` merged in: GitHub Actions run 40147129332 on `refit-dev/refit-bench`, `benchmark.yml` with `list=subsets/dev-30.json offset=0 size=2 count=30`, no AI, no publication. Each repository's row was compared with its row in run 40117208880 (`604cb81`, `subsets/f5-tuned-sets.json`).

- **18 rows unchanged.**
- **8 rows changed only in the reason text**, as #273 intends: the removed-parameter stop now ends with the calls that still send `payment_method_types` (one call in 7 rows, "and 4 more in the run report" in qesmsep/noir-crm-dashboard). Same status and stage.
- **4 rows changed outcome, all from `main`, not the stack.** Each was an `error` in the baseline because preparation hit the old 2 GiB workspace (ENOSPC once, a dependency archive over 1 GiB three times). With the 4 GiB default from #303 they ran: 2 `validated` (adamhitzger/financehb, tejashVaishnav/Fast-saas-next.js-boilerplate), 1 `needs-review` with 1 unresolved finding (shagunmistry/FlowCraft) and 1 `validation-failed`: the patch broke alanagoyal/branded's tests (regression).
- **Not measured:** publication and draft updates, which the benchmark never exercises; the stack's lifecycle is covered by `pipeline/draft-lifecycle.test.ts` and `pipeline/release-replay.test.ts` against simulated GitHub.

## Owner decision 1 on the dev set (October 24)

Two runs of `subsets/dev-30.json` on `refit-dev/refit-bench` (`benchmark.yml` with `list=subsets/dev-30.json offset=0 size=2 count=30`, no AI, no publication), each row compared with its row in run 40117208880 (`604cb81`):

- **Before the default changed:** run 40150763480 at `7487773` with `flags=--publish-unresolved`.
- **After:** run 40151036594 at `32d686c`, no flags, where decision 1 is the default.

The two runs have the same outcome and a byte-identical patch for every repository (21 ran the workflow). Both predate the merges of #296, #304, #285 and #314 into this branch. In all 21 reports, none of the 77 findings that need review is touched by the patch.

| Outcome                               | Repositories                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validated (5)                         | Anassarwar14/Chat-Nest-AI, imran-farooq7/next-gen-ai-yt, MuhammadTanveerAbbas/Clario-ai, nicuk/docsflow; tejashVaishnav/Fast-saas-next.js-boilerplate (an `error` in the baseline, fixed on `main` by the 4 GiB workspace)                                                                                                                                                                                                                                                                                                                                                                                                                |
| New `[Needs review]` draft (8)        | adamhitzger/financehb and shagunmistry/FlowCraft (contract changes no rule migrates; `error` in the baseline); ArhanAnsari/InspireGem and Miguel07Alm/text2question (preparation failed, untested; `error` in the baseline); brunobola-portfolio/GitHub-Repo-Manager (checks did not finish on the original code, webhook API version, contract changes); doganarif/build-it (`node -e 0`, removed parameter, contract changes), JensenMPillay/pdfai (baseline fails, removed parameter, contract changes) and karljuhl/Club_Connect (preparation failed, removed parameter, contract changes), all three stopped at scan in the baseline |
| Validated to `[Needs review]` (1)     | Emmah-oo/spotify-clone: a breaking contract change on a traced operation that no rule migrates (unknown reach)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `[Needs review]` as before (3)        | Devanshjain2110/QueryPDF and palashb01/DocuChat (untraced reads, unchanged); samiamjidkhan/dota2-helper (now names its `node -e 0` check)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| No PR: checks failed on the patch (4) | 4lbatr0s/jiro, ggallon/type-last and manu14357/smartdoc (stopped at scan in the baseline; the `payment_method_types` they keep sending fails `tsc` after the stripe-node upgrade); alanagoyal/branded (`error` in the baseline; its tests reject the helper import)                                                                                                                                                                                                                                                                                                                                                                       |
| No PR: conflicting API versions (3)   | createdbymax/Loopletter-Open-source-email-marketing-platform, qesmsep/noir-crm-dashboard, Small-Web-Co/tinypivot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| No PR: no patch (1)                   | liamstamper/lamp-bot: its only change is a removed parameter left for review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Not affected (5)                      | benlamiro/ShipGenAI, Harries/startfast-free, pretzelai/lumen, rishabhsingroha/MusicListeningPlatform, UNC-GDSC/Micro-SaaS-Starter-Kit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Not measured: publication (the benchmark publishes nothing), the hosted worker and AI patches.

## AI on coverage stops on the dev set (October 24)

One AI run of `subsets/dev-30.json` on `refit-dev/refit-bench` at `4433c96` (feat/ai-on-stops): GitHub Actions run 40156098317, `benchmark.yml` with `list=subsets/dev-30.json offset=0 size=5 count=30 ai=true ai_budget=5` (model `gpt-6.1-sol`), compared with run 40151479708 (main `96b5419`, same list, `--ai`, $5). Shards were 5 repositories, not 1: a shard's budget is `ai_budget` divided by the shard count, and $5 over 30 shards ($0.17) is below the about $0.27 one request reserves, so no request could have run.

- **AI was asked on 6 rows**, all coverage stops after the rules' patch passed its checks: adamhitzger/financehb (7 targets), doganarif/build-it (11), Emmah-oo/spotify-clone (2), palashb01/DocuChat (4), samiamjidkhan/dota2-helper (2) and shagunmistry/FlowCraft (5). No other row reached a coverage attempt; the safety stops (Loopletter, noir-crm-dashboard and tinypivot at the scan) made no request.
- **No request was billed: $0.00.** Five requests failed at OpenAI token counting with HTTP 401, so the repository's `OPENAI_API_KEY` secret is not accepted; financehb's evidence was over the 64 KiB input limit before any request. Each of the 6 rows fell back to the rules' `[Needs review]` draft, as designed, and recorded the refusal in `workflow.coverageAi`.
- **A failed AI attempt left the outcome as it was.** The 6 rows have the same status, stage, review gates, full-diff mode and patch as in run 40151036594 (decision 1, no AI, `32d686c`). financehb and spotify-clone are `validated` in run 40152743957 only because `4f86323` predates decision 1 (#316). Under decision 1 the production scan no longer stops on their contract changes, so the workflow runs the full diff and lists them for review, with or without AI.
- **Not measured:** whether AI patches validate or are correct. That needs a working key and another run.

Rerun with a replaced key at `22b4ab3`: GitHub Actions run 40158922107, same inputs (`size=5 count=30 ai=true ai_budget=5`, 6 shards of $0.83), compared with run 40156098317 as the AI-off outcome.

- **Spend: $0.180452**, from `jq '[.[] | (.workflow.aiCostUsd // 0) + (.ai.costUsd // 0)] | add'`. No request failed with HTTP 401.
- **The model proposed no edit on any of the 5 coverage requests** (`no-proposal`): doganarif/build-it ($0.022904, 11 targets), Emmah-oo/spotify-clone ($0.028386, 2), palashb01/DocuChat ($0.028514, 4), samiamjidkhan/dota2-helper ($0.035218, 2) and shagunmistry/FlowCraft ($0.036340, 5). financehb was refused before a request (evidence over 64 KiB). ggallon/type-last spent $0.029090 in the existing repair loop and stayed `validation-failed`.
- **Every row's status, stage, reason, review gates and patch equal the AI-off run.** No AI diff was checked or published, so none is labelled.
- **One clear miss:** FlowCraft `src/app/api/subscription/route.ts:71` still reads `s.current_period_end` on a listed subscription, which Stripe removed in basil, although the rules' patch adds a `getSubscriptionPeriodEnd` helper for it. The run recorded no reason for the empty proposals.

Why: a request rebuilt locally from the shard's report, specifications and changelog notes held the target, the helper and both docs.stripe.com pages, and an empty or truncated answer is refused, not counted as no proposal; so the model chose zero edits. The instructions called an untraced read something to edit only when the code proves the object, and nothing pointed it at the rules' helper. `0839fc4` records the model's summary, uncertainties and response id for an empty coverage proposal and adds that guidance. Run 40166116141 at `0839fc4`, same inputs:

- **Spend: $0.2014192.** No HTTP 401.
- **FlowCraft: AI kept and validated** ($0.059447). The one AI line is `src/app/api/subscription/route.ts:73`, `s.current_period_end` to `getSubscriptionPeriodEnd(s)`, after which `pnpm test` passed on the original and migrated code. **Correct** against [the basil period change](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end): the helper reads the old field, then the period every item shares; with items whose periods differ it reads undefined, because it chose no item. The draft adds the `ai-patch` gate and, because the patch is no longer rules-only, `webhook-api-version` for the rules' webhook lines; unresolved findings go from 5 to 4.
- **build-it, spotify-clone, DocuChat and dota2-helper: no proposal, correctly.** The recorded reasons: build-it's `.subscription` reads are Prisma models, DocuChat's `.price` reads are its plan table, dota2-helper's `.description` reads are Dota data, and the contract-change calls do not read or send what changed (spotify-clone's `customers.update` address stays, as the owner policy requires).
- Every other row has the same status, stage, reason, gates and patch as the AI-off run 40156098317. financehb is still refused over 64 KiB; type-last spent $0.02872 in the repair loop.
- **Not fixed here:** FlowCraft's adapter maps `subscriptions.retrieve` but not `subscriptions.list`, which is why the rules could not trace that read.

## Rule pack refactor (October 26)

Moving Stripe's built-in rules into `data/packs/stripe.json` (families plus data, [Rule packs](RULE-PACKS.md)) changed no result. Both runs used the GitHub workflow `benchmark.yml` in `refit-dev/refit-bench` on the frozen 100-repository list `2026-10-14-stripe-repos.json`, no AI, with validation.

|        | Commit                                     | Run         |
| ------ | ------------------------------------------ | ----------- |
| Before | `705b138af028aa78f1aba51fcab4cc7e0de02ae3` | 40282252631 |
| After  | `7c28763bad3ad746f37ef344c7c8b711ad605c2c` | 40283157378 |

Every repository's result record is identical once timings, the recorded commit, and per-run container names and temporary paths are removed (`jq` `walk` over both `results.json` files, then `diff`: no lines).

`gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=<sha> -f list=2026-10-14-stripe-repos.json -f offset=0 -f size=2 -f count=100`

## Shopify rule pack (October 26)

Moving Shopify's SDK facts and symbol reviews into `data/packs/shopify.json` changed no outcome. Both runs used the GitHub workflow `shopify.yml` in `refit-dev/refit-bench` on the frozen 50-repository list `2026-10-16-shopify-repos.json`, no AI, `contracts=current`, dispatched together, with identical Admin schema hashes (2026-01 `28b7deb873ac`, 2026-04 `dc4e89a095fb`, 2026-07 `e9f0a5087a66`, 2026-10 `688152ce99cf`; these differ from the frozen list's, so compare only with runs on the same hashes).

|                                  | Commit                                     | Run         |
| -------------------------------- | ------------------------------------------ | ----------- |
| Before (`feat/stripe-rule-pack`) | `7c28763bad3ad746f37ef344c7c8b711ad605c2c` | 40283606752 |
| After                            | `4b6389729bb31f5e5483fa2f8876fd3296623572` | 40283610311 |

Every repository's result record is identical apart from timings: 39 stopped, 3 current, 3 current for the SDK, 2 without Admin usage, 2 with no outcome recorded (same in both), 1 patched (validated).

`gh workflow run shopify.yml -R refit-dev/refit-bench -f commit=<sha> -f list=2026-10-16-shopify-repos.json -f offset=0 -f count=50 -f size=5`

## AI release classification against the Stripe catalog (October 26)

Two refit-bench runs of `refit classify-release` with `gpt-6.1-sol` over basil, clover, dahlia and endive, scored against the hand catalog's change statements; the catalog's handling is never sent. **Pages only** is what a new release gives: run [40285557374](https://github.com/refit-dev/refit-bench/actions/runs/40285557374) at `39d78f9848a13b8400532e7f7e27abe41efcb4da` (`gh workflow run classify.yml -R refit-dev/refit-bench -f commit=39d78f9848a13b8400532e7f7e27abe41efcb4da -f statements=none -f ai_budget=2 -f model=gpt-6.1-sol`) sent each saved changelog page alone; the model listed the changes, and each was matched to the catalog statement on its page it shares the most content words with. **Statements given** is the upper bound: run [40283655210](https://github.com/refit-dev/refit-bench/actions/runs/40283655210) at `54b5bb22b158a4c93e5c49dd5dde710b986bb22b` (the same command with `-f ai_budget=3` and no `statements` input, which refit-bench #5 added later) also sent the catalog's statements. Results: [`pages`](benchmarks/2026-10-26-release-classification-pages-results.json) and [`statements given`](benchmarks/2026-10-26-release-classification-results.json), each with its `-audit.json` of every prompt and output. Details and the review they call for: [Release classification](RELEASE-CLASSIFICATION.md).

| Measure                                                                                         | Pages only | Statements given |
| ----------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| Catalog statements whose matched changes all have its handling                                  | 70/125     | 95/125           |
| Catalog statements no change was matched to                                                     | 17         | 1                |
| Catalog statements given a rule or AI edit where the catalog stops or has no signal (dangerous) | 8          | 8                |
| Pages with the catalog's category (API or Stripe.js)                                            | 78/79      | 78/79            |
| Pages whose weakest handling is the catalog's                                                   | 62/79      | 61/79            |
| Statements whose matched changes all have the implied pack family                               | 9/26       | 21/26            |
| Spend                                                                                           | $0.70      | $0.56            |

- **The pages-only model listed 189 changes;** 2 shared no content word with any catalog statement and count as errors.
- **Word matching is approximate.** Read by hand, the pages-only run's 50 rule or AI changes describe 8 catalog statements that stop or have no signal, the same 8 as with statements given; word matching put 15 of those 50 changes on a different catalog statement than the hand reading.
- **Predicted `rule` was right on 7 of 18 pages-only changes, by hand,** and on 7 of 12 statements given.
- A first dispatch, run 40283460948 with `gpt-5.6-luna`, was refused with HTTP 403 on all 79 pages and billed nothing; the key accepts only `gpt-6.1-sol`.

## AI repair loop on build-breaking patches (October 28)

`feat/repair-loop` (Agent P in `docs/AI-REPAIR.md`, founder decision 2026-10-28):

- the version move updates every older `apiVersion` literal in a file that loads stripe, untraced clients included;
- a repeated AI proposal is asked again, up to the attempt limit, with the introduced type errors, the source around them, the stripe-node declarations they name and a note that the last proposal changed nothing;
- the repair log leaves out type errors the original code already had.

The subset `subsets/p-repair-loop.json` holds the 10 l2-push-249 rows whose patch failed its checks in runs 40621425780, 40624045392, 40639445000 and 40688452206. No heldout-30 row qualified. It shares no repository with progress-30.

| Subset, AI on ($5 cap), 3 repair attempts | Before `57b63cfc` ([40753170579](https://github.com/refit-dev/refit-bench/actions/runs/40753170579)) | After `fb5b00b4` ([40753185102](https://github.com/refit-dev/refit-bench/actions/runs/40753185102)) |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------: | --------------------------------------------------------------------------------------------------: |
| Patches that break the build              |                                                                                                    6 |                                                                                                   6 |
| Rows with a repair requested              |                                                                                                    5 |                                                                                                   5 |
| Repair requests                           |                                                                                                    5 |                                                                                                   9 |
| Repairs accepted                          |                                                                                                    0 |                                                                                                   0 |
| `repeated-proposal` stops                 |                                                                                                    2 |                                                                                                   1 |
| AI spend (USD)                            |                                                                                                 0.42 |                                                                                                0.57 |

- **Runs.** `gh workflow run benchmark.yml -R refit-dev/refit-bench --ref feat/stripe-test-mode-key -f commit=<sha> -f list=subsets/p-repair-loop.json -f offset=0 -f size=1 -f count=10 -f ai=true -f ai_budget=5 -f "flags=--resolve-lockfiles --webhook-checks --behaviour-tests --stripe-test-mode"`. Before is `bf81624d` (`bench/all-feats-2026-10-28`) plus the subset file.
- **No patch was repaired, so there is nothing to hand-review.** All 10 rows have the same outcome and grade in both runs.
- **Panda2Chan/ai-asmr** asked 3 times and got the same proposal each time. Its only introduced error is the moved pin against the old stripe-node types: the upgrade was skipped because its pnpm lockfile version is not one Refit upgrades. No code edit fixes that, so this row needs the upgrade, not a repair.
- **Drago-03/Neural-Nexus** asked 3 times. The first two proposals repeated an earlier attempt, and the third request was refused because the shard's $0.50 share of the budget could not cover its maximum output.
- **The other 3 rows stop for policy reasons this change does not touch** (Agent Q's lane): declared-type provenance, `invoices.retrieveUpcoming`, and an AI edit on a line a rule already changed.
- No subset row had a second `apiVersion` literal the old move missed, so the "every pin" change moved no row here. It is covered by tests in `declared-api-versions.test.ts` and `api-version-pins.test.ts`.

## Shopify GraphQL document tracing, round 3 SH13 (October 29)

Reading more Admin GraphQL documents statically changed no validated count. `shopify.yml` in `refit-dev/refit-bench` ran on the 250 practice repositories (`2026-10-16-shopify-repos.json` and `2026-10-16-shopify-fresh-repos.json`, which hold all of dev-60), with `size=1`, an explicit `count`, `--sdk-upgrade`, no AI and `contracts=current`. Both sides used identical schema hashes.

|        | Commit                                     | Practice 50 | Fresh 200   |
| ------ | ------------------------------------------ | ----------- | ----------- |
| Before | `1de287fe8d3d959274d08864c5f6056308535bbe` | 40966481779 | 40966491852 |
| After  | `2c89270a32a66dfa9b7e2d1f2512baabc6d7fb85` | 40967527548 | 40967536624 |

- Unreadable Admin calls went from 58 to 47, and repositories with one from 32 to 25. Documents read went from 1676 to 1732, and traced documents from 1288 to 1332. On dev-60, unreadable calls went from 16 to 9 and traced documents from 354 to 369.
- Validated stayed at 7 of 250 (3 of 60 on dev-60), with the same repositories. Needs review went from 21 to 23, and nothing was lost.
- Hujjat/easy-product-recommendations and alirafat2024/25_oct-shopify_functions move from stopped to patched. Both are `[Needs review]` because their own type check fails on the original code (grade D, schema proof proven). Both diffs are reviewed `correct` in `docs/benchmarks/fix-reviews.json`.
- Five more repositories clear every unreadable call and now stop at the next gate: SDK `LATEST_API_VERSION` (ndrishinski, sarim-alis, umxr, omakatse) or a document that already fails (t-maypat).
- yan-ad/shopify-app-nuxt goes from 1 to 6 calls. It is a Nuxt module whose exported functions receive their users' queries, and each export is now its own stop.
- Most of what remains is runtime by design and keeps stopping:
  - raw queries passed through from a CLI, an MCP tool or a GraphiQL proxy;
  - library exports and `Effect.fn` or `Object.assign` wrappers;
  - argument lists built with `push`, and aliases built from IDs;
  - one document with more than 64 variants (bloomreach).

With AI (Claude `claude-sonnet-5-5` through #431's Anthropic backend, `ai_budget` 300, otherwise the same settings), the base is #431's head `0b160d23` (runs 40981167687 and 40981175529) and the branch is `ce605d8d`, this branch merged with #431 (runs 40981302107 and 40987435368):

- Validated stayed at 4 of 250 (3 of 60 on dev-60), with the same repositories. Needs review went from 24 to 26, from the same two patches as without AI.
- AI reconstructions: 5 kept and 50 refused on the base ($1.52), against 2 kept and 44 refused on the branch ($0.99).
  - Two calls the base reconstructed with AI (alistairmartin's `definitionsQuery`) are now read without AI.
  - aura-historia's stop moved from the route to the export it calls, where the model declines. Its outcome is unchanged.
  - No reconstruction changed an outcome on either side.
- With AI on, both sides validate 3 fewer repositories than without AI: ersinkoc/CouponEngine, cornerstone-report/x-money-shopify and danyn/shopify-app-rr. Their checks pass, but the development-store live proof runs and fails (`liveProof: failed`), which grades them D. This happens with or without this change.

Each repository that had an unreadable call before, with its next stop after:

| Repository                                       | Unreadable (base → branch) | Next stop on the branch                                                                                        |
| ------------------------------------------------ | -------------------------: | -------------------------------------------------------------------------------------------------------------- |
| alirafat2024/25_oct-shopify_functions            |                      2 → 0 | needs-review: baseline-failed                                                                                  |
| alistairmartin/honey-birdette-checkout-amd (dev) |                      5 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| ArseniyX/taskly (dev)                            |                      2 → 2 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| asap-xt/shopify-ai-seo-app                       |                      4 → 3 | A Shopify GraphQL document already fails on Admin API 2026-01; fix it before any version upgrade.              |
| aura-historia/shopify-app                        |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| BillyND/shopify-uploads                          |                      2 → 2 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| bloomreach/shopify-discovery-connector-v2        |                      1 → 1 | A Shopify GraphQL document does not parse; Refit cannot prove it works on the target API version.              |
| callobuzz/cob-shopify-mcp                        |                      1 → 1 | A Shopify GraphQL document's variables reach an input change on Admin API 2026-10 (InventoryQuantityInput.comp |
| carlosrebelo14-ai/alterpop-importer2             |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| codeyogi911/shopify-mcp                          |                      3 → 2 | A Shopify GraphQL document already fails on Admin API 2026-01; fix it before any version upgrade.              |
| drizzle-team/tento (dev)                         |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| flwrdev/delivery-scheduler                       |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| GeLi2001/shopify-mcp                             |                      2 → 2 | A Shopify GraphQL document's variables reach an input change on Admin API 2026-10 (InventoryQuantityInput.comp |
| Hujjat/easy-product-recommendations              |                      1 → 0 | needs-review: baseline-failed                                                                                  |
| lisandrophan/designify                           |                      3 → 3 | A Shopify GraphQL document already fails on Admin API 2026-01; fix it before any version upgrade.              |
| madeburo/GEO-AI-Shopify                          |                      3 → 2 | A Shopify GraphQL document already fails on Admin API 2026-01; fix it before any version upgrade.              |
| mw10013/tanstack-cloudflare-effect-shopify-app   |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| ndrishinski/bulk-update-tags                     |                      1 → 0 | LATEST_API_VERSION is 2024-10 in @shopify/shopify-api 11.7.0, and only an SDK upgrade changes it. ApiVersion.O |
| Nuraveda/ai-seo-agent                            |                      4 → 4 | A Shopify GraphQL document already fails on Admin API 2026-01; fix it before any version upgrade.              |
| Nuraveda/shopify-agentic-seo-app (dev)           |                      4 → 4 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| omakatse-dev/omakatse (dev)                      |                      2 → 0 | The Shopify SDK upgrade stops for review: LATEST_API_VERSION, removed in the upgraded SDK, sets a Storefront A |
| psydao/psydao-io (dev)                           |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| rrichie551/Quantity-Breaks                       |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| sanjeev744/smart-variants-display                |                      2 → 2 | A Shopify GraphQL document's variables reach an input change on Admin API 2026-10 (InventoryQuantityInput.comp |
| sarim-alis/redemption-solutionsss                |                      1 → 0 | LATEST_API_VERSION is 2025-04 in @shopify/shopify-api 11.12.0, and only an SDK upgrade changes it. ApiVersion. |
| serebano/busymate-ai-connector-shopify           |                      1 → 1 | A Shopify GraphQL document already fails on Admin API 2026-07; fix it before any version upgrade.              |
| shxhid-dev/shxhid-chat-agent                     |                      2 → 2 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| t-maypat/xsight                                  |                      1 → 0 | A Shopify GraphQL document already fails on Admin API 2026-01; fix it before any version upgrade.              |
| The-Rapid-Apps/Rapid-CRM                         |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| umxr/shopify-product-reviews (dev)               |                      1 → 0 | LATEST_API_VERSION is 2024-01 in @shopify/shopify-api 9.0.1, and only an SDK upgrade changes it. ApiVersion.Oc |
| yan-ad/shopify-app-nuxt                          |                      1 → 6 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |
| Yespo-CDP/yespo-shopify                          |                      1 → 1 | Refit cannot read an Admin API call's GraphQL document statically, so it cannot prove it works on Admin API 20 |

## Untraced reads Refit proves are not Stripe objects (October 28)

Founder decision (Otabek, 2026-10-28), widening D2b to runs with or without AI (`localReceiverReads` in `pipeline/stripe-type-evidence.ts`). l2-push-249 on refit-bench, before at main `89f1c0ed`, after at `5309a76e` (`feat/untraced-read-proof`):

| Run                                | Before      | After       | Validated |
| ---------------------------------- | ----------- | ----------- | --------- |
| No AI                              | 40624045392 | 40635544850 | 84 → 97   |
| AI (`-f ai=true -f ai_budget=200`) | 40624062726 | 40635555316 | 88 → 97   |

- **No AI: 13 rows move from needs-review to validated, all grade C,** and no other outcome changes (236 of 249 identical). They are the 13 the census at main predicted: 7 Payload marketplaces (`generated-type`), 5 PDF and SaaS apps reading their own `PLANS` (`repository-type`) and miljan-code/gpt-writer's credit-plan list (`literal-config`).
- **AI: 9 rows move.** The other 4 (CiphersLab/SaaSPilot, JensenMPillay/pdfai, abhirupkumar/docwhisperer, palashb01/DocuChat) were already validated through D2b's AI path. CRONANANI/EzanaFinance3 failed to clone in the before run.
- **The 13 patches match the before runs and the AI run** in the diffs `results.json` keeps (first 8000 characters), and nothing validated before is lost. All 13 `migration.patch` files from the after run's shards are read in full and labelled in `docs/benchmarks/fix-reviews.json`: 12 `correct`, and JensenMPillay/pdfai `correct-partial` for the invoice-event read noted on 2026-10-27.
- **A wrong proof in the measured commit, fixed after it.** Of the 22 rows carrying `validation.localReads`, createdbymax/Loopletter had reads proven on a parameter whose value comes from `event.data.object as StripeInvoice` two calls up. That row and the other 8 with proofs still needed review for other reasons, so no draft was published on a wrong proof. The fix (`sourced`) follows every value back through parameters, `const`s, conditionals and returns, and rejects any assertion, `let` or annotated return on the way. Re-run on all 73 census repositories with untraced reads at their benchmark commits (every file treated as type-checked, an upper bound), it clears 44 reads in 26 repositories instead of 137 in 36. Every read the 13 rows cleared still clears, and each of the 44 was read at its source line.
- **Not yet run:** l2-push-249 at the fixed commit, and heldout-30 (`-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30`, without and with `-f ai=true -f ai_budget=30`, against 40624360669 and 40624075884). Both are on hold by founder instruction (2026-10-28).

```sh
gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=<full-sha> -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249 [-f ai=true -f ai_budget=200]
node scripts/stripe-benchmark-compare.mjs <before>/results.json <after>/results.json
```

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
gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=<full-sha> -f count=N -f size=1   # see GITHUB-BENCHMARKS.md
node scripts/paypal-benchmark.mjs --root <dir> --refit <worktree> --list docs/benchmarks/2026-10-21-paypal-repos.json
node scripts/ai-app-select.mjs --provider openai --work <cache> --root <checkouts> --output <openai-list.json>
node scripts/ai-app-select.mjs --provider anthropic --work <cache> --root <checkouts> --output <anthropic-list.json>
```

The two selector commands need a `gh` login. A rerun against the moving code-search index is not expected to match the committed lists; they are the record.
