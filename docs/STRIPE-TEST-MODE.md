# Stripe test mode as the referee, and more AI

**Status: plan, 2026-10-28. Nothing here is built.**

## Founder decision (Otabek, 2026-10-28)

Refit may check a migration against Stripe's real API in test mode, and AI may do much more of the work, as long as a check other than the AI decides what counts as validated. The AI's word alone still never clears a stop (D2b).

## Why

Refit already has most of the pieces, but they never decide anything:

- **Behaviour tests** (`pipeline/behaviour-test-writer.ts`, `pipeline/behaviour-tests.ts`). One model request writes `node:test` files from the original code and the contract change only, and never sees the patch. The same tests then run on the original code and on the patched code. This is the only route to grade A (`pipeline/check-selection.ts`). AGENTS.md says "the typed hook exists, nothing grants it yet", and the benchmark never passes `--behaviour-tests`.
- **Generated stripe-mock checks** (`docs/GENERATED-CHECKS.md`). These run the changed functions against stripe-mock on each version's spec. They are capped at grade D, because stripe-mock accepts placeholder data and checks shapes, not behaviour.
- **AI usage is tiny.** Recent AI benchmark runs spent $0.18 to $0.70 in total (`docs/BENCHMARKS.md`), on the small default model (`gpt-5.6-luna`), with about one request per site.

The plan has two parts. Stripe test mode is a referee strong enough to grant validation. Heavy AI does the writing and lets that referee decide.

## Lanes

| Lane | Work                                                                                    | Touches                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| T    | Stripe test-mode runs and behaviour tests that can grant validation                     | new `pipeline/provider-sandbox.ts` and `pipeline/stripe-test-mode.ts`, `behaviour-tests.ts`, `check-selection.ts`, refit-bench `benchmark.yml` |
| H    | Heavy AI by default: behaviour tests on, a stronger model, more repair rounds, measured | `stripe-benchmark-cli.ts`, `ai-budget.ts`, `ai-patches.ts`, `behaviour-test-writer.ts` prompts                                                 |

Lane T owns the refit-bench workflow. Lane H passes everything through the existing `model`, `ai_budget` and `flags` inputs. Lane H's measurement runs use lane T's work only after T merges.

## What a founder must do first (Claude cannot)

1. Create a Refit-owned Stripe account used only for testing, in test mode. Never a customer's account, never live mode.
2. Create a **restricted test key** (`rk_test_…`) with write access only to the resources the benchmark creates (Customers, Products, Prices, Checkout Sessions, PaymentIntents, SetupIntents, Subscriptions, Invoices), and nothing else.
3. Add it to refit-dev/refit-bench as the repository secret `STRIPE_TEST_KEY` (Settings → Secrets and variables → Actions). Never as a workflow input: that repository's logs are public.

## Prompts

### Lane T: Stripe test mode as the referee

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md, docs/GENERATED-CHECKS.md and docs/AI-PATCH-GUARD.md first and follow them. Then read docs/STRIPE-TEST-MODE.md (git show origin/docs/heldout-easy-wins:docs/STRIPE-TEST-MODE.md).

Goal: a migration can be validated by Stripe itself. Behaviour tests the model writes from the original code (never seeing the patch) run on the original code at the old API version and on the patched code at the new one, against Stripe's real API in test mode. Where every changed Stripe line runs and Stripe accepts both, that is grade A and the patch may publish validated, whether a rule or the AI wrote it.

Founder decision (Otabek, 2026-10-28): record it in AGENTS.md as written in docs/STRIPE-TEST-MODE.md, with your evidence. It does not change D2b: the AI's word alone never clears a stop.

Build:
1. Branch feat/stripe-test-mode from origin/main in its own worktree; npm ci.
2. Build it provider-neutral; Stripe is only the first adapter (Refit will add Shopify, Twilio, PayPal and others the same way). pipeline/provider-sandbox.ts holds everything that is not Stripe: the egress-allowlisted sandbox, key redaction, run tagging and cleanup hooks, rate-limit backoff with a pool of keys, and the grade A rule. An adapter (pipeline/stripe-test-mode.ts here) declares only its hosts, how a test key is recognised, how the API version is pinned, how stand-in objects are created and deleted, and its rate limit. Where a provider has no test environment, the same harness runs against a mock generated from that provider's OpenAPI spec (as stripe-mock does for Stripe); a mock alone never grants grade A. No Stripe name may appear in provider-sandbox.ts; a test proves it with a fake second adapter. Then the sandbox itself, separate from offline validation, which stays offline:
   - Network egress only to api.stripe.com through an allowlisting proxy; nothing else resolves.
   - The key comes only from the STRIPE_TEST_KEY environment variable. Refuse anything that does not start with rk_test_ or sk_test_. Never log, print, write to an artifact or pass it to the model; redact it from every captured output.
   - No repository .env, .npmrc or credentials. Lifecycle scripts off.
   - Every object the run creates is tagged with metadata (refit_run=<id>) and deleted or expired at the end.
   - Pin each side's API version through the Stripe-Version header the code under test sends, using the same pins the patch moves.
3. Customers never provide anything (docs/STRIPE-TEST-MODE.md, "Customers do nothing"): always use Refit's own test account. Where the code names account-specific objects (hard-coded price_, prod_, cus_ IDs, enabled payment methods), the behaviour tests create stand-ins with the same shape in Refit's account and substitute them; what cannot be reproduced stays outside grade A and the draft names it. Run the behaviour tests (pipeline/behaviour-tests.ts) in that sandbox: original code with the before version, patched code with the after version. Record every Stripe request and response status (no bodies containing secrets).
4. Grade A in pipeline/check-selection.ts: only when the behaviour tests ran every changed Stripe line, passed on both sides and Stripe returned no error on the patched side that it did not return on the original. A test that fails on the original code proves nothing and is dropped. Anything less keeps today's grade.
5. Wire it into the benchmark: STRIPE_TEST_KEY as a repository secret in refit-dev/refit-bench benchmark.yml (never an input; the logs are public), a flag such as --stripe-test-mode, off by default.
6. Tests: key refusal (live keys, missing key), redaction in every output path, egress denial to other hosts, cleanup, and the grade A conditions including a test that fails on the original.
7. Evidence on refit-bench once a founder has added STRIPE_TEST_KEY (until then, prove it with unit tests and a local run against your own test key from .env, never committed):
   - l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) with -f ai=true -f ai_budget=200 -f flags="--behaviour-tests --stripe-test-mode", compared with 40624062726 (main 89f1c0ed, AI) using scripts/stripe-benchmark-compare.mjs.
   - Read every newly validated migration.patch and its behaviour tests in full and label them in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost.
   - Only then heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30, -f ai_budget=30, same flags), compared with 40624075884.
   - AI spend is authorized up to those caps.
8. Update docs/GENERATED-CHECKS.md, docs/BENCHMARKS.md (run ids, commits, commands), docs/READINESS.md and AGENTS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one draft PR to main as soon as the code and tests are in; fill in the benchmark section and mark it ready when the runs finish. Never merge, never push to main. Never print or commit a key. Never use live mode. Never tune on heldout-30.

Subagents that help: one for the egress proxy and redaction with their tests; one to read Stripe's docs on test mode, restricted keys, rate limits and versioning (cite URLs with read dates); one to review newly validated patches and their tests.

Don't ask me questions; pick the best option, write down why, and keep going.
```

### Lane H: heavy AI by default

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md and docs/AI-PATCH-GUARD.md first and follow them. Then read docs/STRIPE-TEST-MODE.md (git show origin/docs/heldout-easy-wins:docs/STRIPE-TEST-MODE.md).

Goal: Refit uses AI heavily wherever a check other than the AI decides: AI patches on every stop, behaviour tests written for every affected repository, a stronger model where it helps, and more repair rounds. Today the AI benchmark runs spend $0.18 to $0.70 in total on gpt-5.6-luna, with about one request per site. Find out how much better Refit gets with real AI effort, and at what cost.

Founder decision (Otabek, 2026-10-28): record it in AGENTS.md as written in docs/STRIPE-TEST-MODE.md, with your evidence. Every existing gate stays (D2, D2a, D2b, decision 8): AI patches the checks do not back still ship [Needs review].

1. Branch feat/heavy-ai from origin/main in its own worktree; npm ci.
2. Diagnose first. From the AI runs at main 89f1c0ed on refit-dev/refit-bench (l2-push-249 40624062726), list every AI request and outcome: no-proposal, proposal refused by which gate, proposal that failed checks, kept. Group by reason and rank. For no-proposal, read the request (pipeline/ai-patches.ts, pipeline/patch-context.ts) and find out what context the model lacked.
3. Fix the top causes generically: richer context (the full function, its callers, the contract change and Stripe's documented replacement), more repair rounds with the failing check's output, and per-step model choice (the stronger model where the small one gives no proposal). Add any new model to the price table in pipeline/ai-budget.ts with its source and read date.
4. Make behaviour tests (pipeline/behaviour-test-writer.ts) run by default whenever AI is on, with the same model choice. Improve the writer so its tests reach every changed Stripe line.
5. Tests for every change, including that every gate still holds.
6. Evidence on refit-bench (benchmark.yml, full pushed SHA): l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) with -f ai=true -f ai_budget=200, once with the default model and once with -f model=<stronger model>, compared with 40624062726 using scripts/stripe-benchmark-compare.mjs. Report validated, needs-review, regressions and total spend for each. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then run heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30 -f ai=true -f ai_budget=30) and compare with 40624075884. AI spend is authorized up to those caps. If lane T (feat/stripe-test-mode) has merged by then, also run with its flags.
7. Recommend the default model, repair rounds and per-repository budget from the evidence: the cost per extra validated fix. Make that the default for refit run, refit serve, the hosted worker and the benchmark.
8. Update docs/AI-PATCH-GUARD.md, docs/BENCHMARKS.md (run ids, commits, commands, spend), docs/READINESS.md and AGENTS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one draft PR to main as soon as the code and tests are in; fill in the benchmark section and mark it ready when the runs finish. Never merge, never push to main. Never pass a key in a workflow input. Never tune on heldout-30.

Subagents that help: one to classify every AI request outcome from the artifacts; one to rewrite the request context and test it; one to review newly validated patches.

Don't ask me questions; pick the best option, write down why, and keep going.
```

## Risks

- **Untrusted code holds a key.** The repository's code runs with a test key and network access. Mitigations: a restricted test key on a dedicated account, egress to api.stripe.com only, no live keys, rotation after a leak. Worst case, someone sees or edits test data in Refit's own test account.
- **Behaviour tests can be wrong in the same way the patch is.** The writer never sees the patch, and a test must pass on the original code to count. That makes it independent, but not perfect, so every new grade A fix gets read by a person in `fix-reviews.json`.
- **Rate limits.** Stripe test mode limits request rates. Lane T records 429s as "unavailable", never as a regression.
- **Account-specific behaviour.** Refit's account is not the customer's. What it cannot reproduce (dashboard-only settings, Connect accounts, webhook endpoints) stays outside grade A, and the draft names it as the one thing to check when approving.

## Other providers

The referee is provider-neutral: `pipeline/provider-sandbox.ts` holds the harness, and each provider adds an adapter. Most API companies Refit plans to cover offer a free test environment Refit can own, so customers still do nothing. Shopify has development stores, Twilio has test credentials, and PayPal, Square and Plaid have sandboxes (from memory; each adapter verifies and cites its provider's docs). Providers without one fall back to a mock generated from their OpenAPI spec. That proves the request shapes, not behaviour, so those fixes stay below grade A.

## Customers do nothing (founder decision, Otabek, 2026-10-28)

A customer installs Refit and approves PRs, nothing else: no Stripe key, no sandbox, no configuration. Test-mode validation always runs in Refit's own test account, for the benchmark and the product alike. Refit makes up the difference itself: the behaviour-test writer creates stand-ins for account-specific objects the code names (a hard-coded `price_…`, `prod_…` or `cus_…` ID becomes an object Refit creates with the same shape) and sets the payment methods the code asks for on its own account. If the customer's own CI already runs tests against their Stripe sandbox, those results on Refit's PR count as extra evidence. That needs nothing from them either.

## Final measurement: a fresh, unseen 30

Run this once everything is merged: lanes 0, A, B, C and D from `docs/DEPENDENCY-BLOCKERS.md`, lanes 1, 2 and 3 from `docs/HELDOUT-EASY-WINS.md`, and lanes T and H here. The set is built from repositories no one has seen, so no lane could have tuned on it. It answers what Refit does on new code.

The selection rule is fixed now, before anyone sees a repository: `scripts/stripe-active-select.mjs` (the night set's selector, same filters), with the window opening 2026-10-28. Every list under `docs/benchmarks/` is excluded, the night set included. The first 30 repositories in the selector's order that Refit's scan finds affected by the endive change are kept. The list is frozen and committed before any benchmark runs on it.

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md first and follow it. Then read docs/STRIPE-TEST-MODE.md, "Final measurement" (git show origin/docs/heldout-easy-wins:docs/STRIPE-TEST-MODE.md).

Goal: measure Refit, with every lane merged, on 30 Stripe repositories no one has seen, and compare with heldout-30 and l2-push-249.

Start only when origin/main contains every lane named in that section (check each PR is merged). If one is not, say which and stop.

1. Branch bench/fresh-30 from origin/main in its own worktree; npm ci.
2. Select, without looking at any repository's code first: run scripts/stripe-active-select.mjs with GITHUB_TOKEN from .env, --frozen-at <today>, the activity window opening 2026-10-28 (add a flag for the window start if the script derives it only from --frozen-at; keep the old default), and --exclude every frozen list under docs/benchmarks/ (the night set 2026-10-24-stripe-night-repos.json included). Then run Refit's scan, without patching or validation, over the candidates in the selector's order, and keep the first 30 it finds affected by 2026-09-30.endive. Write docs/benchmarks/subsets/fresh-30.json with frozenAt, purpose, criteria (the exact commands) and the 30 entries, and commit and push it before any benchmark run.
3. Run on refit-dev/refit-bench (benchmark.yml, full pushed SHA of origin/main plus the subset), with lane T's and lane H's defaults (behaviour tests, Stripe test mode, the recommended model and budget):
   - fresh-30: -f list=subsets/fresh-30.json -f offset=0 -f size=3 -f count=30, without AI and with -f ai=true -f ai_budget=30.
   - heldout-30 and l2-push-249 at the same commit, with and without AI, for comparison (ai_budget 30 and 200). AI spend is authorized up to those caps.
4. Report production-validated, needs-review, regressions and spend for each set. Compare with the census and the 2026-10-27 baselines in docs/BENCHMARKS.md, and list what still blocks each fresh-30 row with scripts/validation-funnel.mjs --all-blockers.
5. Read every validated fresh-30 migration.patch in full and label it in docs/benchmarks/fix-reviews.json. A wrong fix is reported first, before any score.
6. Record everything in docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Do not change pipeline code in this lane: a fix found here goes in a new lane and is measured on a new set. Run the format check. Conventional commits, no co-author or AI attribution. Open one PR to main with the list and results. Never merge, never push to main. Never pass a key in a workflow input.

Subagents that help: one to run the selection and scan; one per set to download artifacts and compare; one to review every validated patch.

Don't ask me questions; pick the best option, write down why, and keep going.
```
