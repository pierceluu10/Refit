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
