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
   - l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) with -f ai=true -f ai_budget=200 -f flags="--behaviour-tests --stripe-test-mode", compared with 40624353088 (main 89f1c0ed, AI) using scripts/stripe-benchmark-compare.mjs.
   - Read every newly validated migration.patch and its behaviour tests in full and label them in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost.
   - Only then heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30, -f ai_budget=30, same flags), compared with 40624369322.
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
2. Diagnose first. From the AI runs at main 89f1c0ed on refit-dev/refit-bench (l2-push-249 40624353088), list every AI request and outcome: no-proposal, proposal refused by which gate, proposal that failed checks, kept. Group by reason and rank. For no-proposal, read the request (pipeline/ai-patches.ts, pipeline/patch-context.ts) and find out what context the model lacked.
3. Fix the top causes generically: richer context (the full function, its callers, the contract change and Stripe's documented replacement), more repair rounds with the failing check's output, and per-step model choice (the stronger model where the small one gives no proposal). Add any new model to the price table in pipeline/ai-budget.ts with its source and read date.
4. Make behaviour tests (pipeline/behaviour-test-writer.ts) run by default whenever AI is on, with the same model choice. Improve the writer so its tests reach every changed Stripe line.
5. Tests for every change, including that every gate still holds.
6. Evidence on refit-bench (benchmark.yml, full pushed SHA): l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) with -f ai=true -f ai_budget=200, once with the default model and once with -f model=<stronger model>, compared with 40624353088 using scripts/stripe-benchmark-compare.mjs. Report validated, needs-review, regressions and total spend for each. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then run heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30 -f ai=true -f ai_budget=30) and compare with 40624369322. AI spend is authorized up to those caps. If lane T (feat/stripe-test-mode) has merged by then, also run with its flags.
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
4. Report production-validated, needs-review, regressions and spend for each set. Compare with the census and the 2026-10-27 baselines in docs/BENCHMARKS.md. For each set, run node scripts/validation-ceiling.mjs <dir>/merged/results.json --artifacts <dir> on the downloaded artifacts and report "validated X of Y validatable" from it, with every not-validatable row's reason and evidence and every gap's lane or cause (docs/VALIDATION-CEILING.md, "Ceiling audit"). Compare with docs/benchmarks/2026-10-28-validation-ceiling.json.
5. Read every validated fresh-30 migration.patch in full and label it in docs/benchmarks/fix-reviews.json. A wrong fix is reported first, before any score.
6. Record everything in docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Do not change pipeline code in this lane: a fix found here goes in a new lane and is measured on a new set. Run the format check. Conventional commits, no co-author or AI attribution. Open one PR to main with the list and results. Never merge, never push to main. Never pass a key in a workflow input.

Subagents that help: one to run the selection and scan; one per set to download artifacts and compare; one to review every validated patch.

Don't ask me questions; pick the best option, write down why, and keep going.
```
# Stripe test mode as the referee

**Status: built (lane T), 2026-10-28.** The plan this follows is on `docs/heldout-easy-wins` (`docs/STRIPE-TEST-MODE.md` there); lane H (heavy AI) is separate.

## Founder decisions (Otabek, 2026-10-28)

- Refit may check a migration against Stripe's real API in test mode, and AI may do much more of the work, as long as a check other than the AI decides what counts as validated. The AI's word alone still never clears a stop (D2b).
- **Customers do nothing.** A customer installs Refit and approves PRs, nothing else: no Stripe key, no sandbox, no configuration. Test-mode validation always runs in Refit's own test account, for the benchmark and the product alike. Where the code names account-specific objects, Refit creates stand-ins with the same kind in its own account; what it cannot reproduce stays outside grade A and the draft names it.

## What it does

`refit run --write-behaviour-tests --stripe-test-mode` (and `benchmark:stripe --behaviour-tests --stripe-test-mode`) runs the behaviour tests the model writes from the original code, never seeing the patch ([behaviour tests](GENERATED-CHECKS.md#behaviour-tests-written-by-a-model-opt-in)), against Stripe's API in test mode instead of stripe-mock:

1. **Stand-ins.** String literals `price_…`, `prod_…` and `cus_…` in the changed Stripe files get stand-ins created in Refit's account: a customer, an active product, or a USD 10.00 price on a new product (monthly recurring where the code mentions `'subscription'` or `recurring`, else one-time). The proxy swaps the customer's ID for the stand-in in requests and back in responses. Other account objects the code names (`sub_`, `acct_`, `pi_`, `in_`, `promo_` and similar; Stripe's own `pm_card_…` and `tok_…` test objects excepted) cannot be reproduced and keep the run below grade A. The draft lists every stand-in with its assumed shape, and every object it could not reproduce, as something to check when approving.
2. **Original side.** The original code runs at the before API version, behind a proxy for that side.
3. **Patched side.** The patched code runs at the after version, behind a new proxy. The sides run one after the other.
4. **Cleanup.** Everything the run created is deleted, expired, cancelled or deactivated, newest first, whatever happened: customers, coupons, subscriptions and draft invoices are deleted; Checkout Sessions expired; PaymentIntents and SetupIntents cancelled; prices, products, promotion codes and payment links deactivated (a price has no delete endpoint and a product with prices cannot be deleted). Anything else is left, tagged, and listed. A cleanup failure is recorded and never stops the others.

## Sandbox

Provider-neutral, in `pipeline/provider-sandbox.ts`; Stripe is the first adapter (`pipeline/stripe-test-mode.ts`). A test with a made-up second provider proves the harness assumes nothing about Stripe, and fails if the file names it.

- **Network.** Each run creates an internal Docker network (`docker network create --internal`): no route out and no DNS. The test containers join only that network. A proxy container joins it and the default bridge, and forwards only requests whose `Host` is one of the adapter's hosts (`api.stripe.com`); any other host gets 403 and is recorded. `pipeline/provider-sandbox-docker.test.ts` (Docker-gated) shows a test container cannot resolve `example.com` or reach `1.1.1.1`, gets 403 for another host through the proxy, and reaches only Stripe. The repository's own checks and offline validation keep `--network none`.
- **The key.** It comes only from `STRIPE_TEST_KEY` (one key, or a pool separated by commas or whitespace). Anything that is not `rk_test_…` or `sk_test_…` is refused before any repository runs, and the refusal never repeats the value. The key is passed to the proxy container's environment by name, never on a command line, and **never enters a test container**: the code under test sends a placeholder (`sk_test_123`) and the proxy replaces it. The keys, and anything shaped like a Stripe secret, restricted or webhook key (live ones included), are redacted from both sides' output, the proxy's records, responses passed back to the code, setup errors and cleanup errors. The model never sees it.
- **Repository files.** `.env`, `.env.*`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.netrc` and `credentials.json` are deleted from the sandbox copy before the tests run; lifecycle scripts stay off (`npm_config_ignore_scripts=true`, and dependencies come from the prepared archives, installed without scripts).
- **Tagging.** Every create operation whose form body takes `metadata`, read from that side's contract, gets `metadata[refit_run]=<run id>` added by the proxy, as do the stand-ins. The proxy records the ID and type of every object a tagged request created, for cleanup.
- **API version.** The code under test sends its own `Stripe-Version` (stripe-node sets it from `apiVersion` or its release default). Where it sends none, the proxy sets the side's version, read from that side's contract (`info.version`): the same pins the patch moves. A request that sends any other version keeps the run below grade A.
- **Records.** Per request: method, path (no query), host, version, whether the code sent it, status, attempts, whether it was tagged and what it created. Never a body or header.
- **Rate limits.** A 429 is retried up to 5 times with exponential backoff and jitter, moving to the next key in the pool each time. A request still limited after that, or a 5xx, makes that side **unavailable**: reported, never a regression.
- **A mock.** A provider without a test environment would run the same harness against a mock generated from its OpenAPI spec, as stripe-mock is for Stripe (the proxy takes an upstream override). A mock never grants grade A.

## Grade A

`sandboxGrade` (`pipeline/provider-sandbox.ts`), applied by `gradeEvidence` (`pipeline/check-selection.ts`). Grade A only when all of these hold:

- the tests ran against the provider's test environment, not a mock;
- every kept test passed on both sides, and none was skipped;
- every changed executable Stripe line ran on both sides;
- both sides made at least one Stripe request, each with that side's version;
- Stripe returned no error on the patched side for an operation and status it did not return on the original side;
- the code names no account object Refit could not reproduce.

A test file with a test that fails on the original code proves nothing: it is dropped with its coverage (coverage is collected per test file), listed in `validation.behaviour.dropped`, and the remaining files decide. Anything less keeps today's grade (B, C or D). A test that passed on the original code and fails an assertion on the patched code is still a regression and fails validation. A grade A patch publishes as validated, whether a rule or the AI wrote it; the AI's own claims never count (D2b).

## Evidence

- `validation.behaviour` records `target: test-environment`, the run ID, both versions, stand-ins with their assumptions, what could not be reproduced, new Stripe errors, every request record per side and the cleanup result, beside the existing coverage and per-test results. Benchmark rows keep the target, dropped files and that sandbox record.
- Unit tests: `pipeline/provider-sandbox.test.ts` (key refusal, redaction, egress denial, tagging, version pinning, stand-in swapping, key-pool backoff, cleanup, grade A rule), `pipeline/stripe-test-mode.test.ts` (live, publishable and missing keys, tagging from a contract, stand-ins, cleanup, a new patched-side error, a rate-limited side), and `pipeline/behaviour-tests.test.ts`, which runs real behaviour tests from three benchmark repositories through the real proxy script in front of a simulated Stripe: grade A with every changed line covered, stripe-mock giving no grade A for the same run, and a test that fails on the original code dropped while the others still give grade A.
- Benchmark runs: [BENCHMARKS.md](BENCHMARKS.md#stripe-test-mode-october-28).

## Stripe facts used

Read 2026-10-28:

- Key prefixes `sk_test_`, `rk_test_`, `pk_test_` and their `live` forms; test and live objects are separate: https://docs.stripe.com/keys.md. Restricted keys grant None, Read or Write per resource, and a missing permission returns 403: https://docs.stripe.com/keys/restricted-api-keys.md, https://docs.stripe.com/api/errors.md.
- Sandbox transactions do not move funds: https://docs.stripe.com/testing.md, https://docs.stripe.com/testing-use-cases.md.
- Rate limits: 25 requests per second in a sandbox (100 live), 429 with `Stripe-Rate-Limited-Reason`, retry with exponential backoff and jitter: https://docs.stripe.com/rate-limits.md.
- Versioning: `Stripe-Version` per request, else the account default; stripe-node 12 and later send their release's version: https://docs.stripe.com/api/versioning.md, https://docs.stripe.com/sdks/set-version.md.
- Metadata: up to 50 keys, 40-character keys, 500-character values: https://docs.stripe.com/api/metadata.md.
- Cleanup endpoints: https://docs.stripe.com/api/customers/delete.md, https://docs.stripe.com/api/products/delete.md (only without prices), https://docs.stripe.com/api/prices/update.md (`active=false`; prices have no delete), https://docs.stripe.com/api/invoices/delete.md (drafts only), https://docs.stripe.com/api/checkout/sessions/expire.md, https://docs.stripe.com/api/payment_intents/cancel.md, https://docs.stripe.com/api/setup_intents/cancel.md, https://docs.stripe.com/api/subscriptions/cancel.md, https://docs.stripe.com/api/coupons/delete.md.

## Limits

- Only the Stripe SDK's default Node HTTP client is redirected (as for stripe-mock); `fetch`-based clients fail in the sandbox, so their tests fail on the original side and are dropped.
- Stand-ins match the kind of object, not its configuration: an assumed price amount or interval can differ from the customer's. The draft says so.
- Account settings (enabled payment methods, Connect, webhook endpoints, Dashboard-only settings) are Refit's, not the customer's. A request they make fail fails on both sides and is not counted against the patch; a difference only the customer's account would show is not caught.
- The code under test can make any request the restricted key allows in Refit's test account, including on other runs' objects. Worst case: test data in Refit's own test account is read or changed. The key should stay restricted to the resources the benchmark creates.
- Generating a mock from another provider's OpenAPI spec is not built; only the upstream override it would use is.
