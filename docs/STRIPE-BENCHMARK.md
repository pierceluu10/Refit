# Stripe real-repository benchmark

This measures what Refit does today on **100 real public Stripe integrations** with **real Stripe API changes**: each repository's own API version, upgraded to the latest version, using Stripe's published OpenAPI specifications. Nothing is simulated and nothing is published. Run on October 14, 2026 at Refit `03648a6`, which includes the shared SDK client support.

## Method

- **Repositories:** GitHub code search for TypeScript/JavaScript files using the `stripe` package (imports, `require`, `new Stripe(…apiVersion…)`, common calls) found 1,556 repositories. We kept those that are not archived or forks, are under 50 MB and were pushed since January 2024. From the 140 most-starred we cloned them shallowly, kept the ones with a `stripe` dependency whose API version maps to a real specification, and took the top 100 that have an upgrade ahead of them (7 to 2,110 stars). Repositories and commits are pinned in [`benchmarks/2026-10-14-stripe-repos.json`](benchmarks/2026-10-14-stripe-repos.json). No repository code was installed or run.
- **Each repository's API version:** taken from its literal `apiVersion: '…'` (68 of the 100), or else from its locked or declared `stripe` package version (32). We read each stripe-node release's `OPENAPI_VERSION` and `apiVersion` to map 175 SDK releases to 31 API versions.
- **Real contracts:** for each API version, `openapi/spec3.json` from the `stripe/openapi` release that version shipped with. We verified that each spec's `info.version` equals the API version, after correcting two releases. The target is the latest, `2026-09-30.endive`. 80 repositories start before `2025-03-31.basil`, Stripe's large breaking release.
- **Stages,** run with `npm run benchmark:stripe` (`pipeline/stripe-benchmark-cli.ts`):
  1. read the repository;
  2. trace Stripe SDK calls;
  3. scan for removed fields with the built-in Stripe adapter;
  4. scan again with a **generated full Stripe adapter**: every stripe-node method the repository calls, mapped to the object it returns, from `x-stripeOperations` in Stripe's SDK spec (`pipeline/stripe-benchmark.ts`);
  5. run production mode (full contract diff);
  6. for confirmed affected code, run an AI patch and Docker validation through `refit run`.

## Results

| Stage | Repositories |
|---|---|
| Selected | 100 |
| Refit reads the repository | 100 |
| Scanner completes without crashing | **97**. Three crashed on a single file: a syntax error, a declaration error and a binary `.ts` file |
| Stripe SDK calls found | 96 |
| At least one call **traced** | **55**. Only 355 of 1,556 likely Stripe calls were traced (23%) |
| A traced call maps to a Stripe object | 54 |
| Breaking-field reads reported, any confidence | 83 (built-in adapter) |
| **Confirmed** affected code, built-in adapter (`paymentIntents` only) | **0** |
| **Confirmed** affected code, generated full adapter | **0** |
| Production mode (full contract diff) completes | **0 of 54**. `oasdiff` exceeded its 30s limit or could not compare the real specs |
| AI proposal attempted | **0**: nothing was confirmed |
| Validated draft PR | **0** |
| Could be validated with the repository's own checks at all | **10**: needs a root npm lockfile, a real `test` script and `stripe` in the root `package.json` |

### The breakage is real

Refit's scanner sees the right fields. The most common removed fields read by these repositories, counted per repository: `line_item.type` (66), `line_item.price` and `invoiceitem.price` (58), `invoice.subscription` (40), `subscription.current_period_end` (30), `invoice.payment_intent` (11).

A plain source check confirms the scale for one field only Stripe uses. **31 of the 80 pre-basil repositories (39%) read `subscription.current_period_end` or `current_period_start`, 97 reads in total.** Stripe removed both from subscriptions in `2025-03-31.basil`. These applications break on upgrade, and 21 of the files involved are webhook handlers.

### Why Refit confirmed nothing

All 6,539 reported reads were `review` confidence:

| Reason recorded by the scanner | Reads |
|---|---|
| "Response or SDK client may be mutated or escape through an alias or call…" | 6,026 |
| "Receiver or property cannot be proven by the supported local analysis" | 513 |

Behind those reasons:
1. **Stripe objects arrive through webhooks.** 74 of 100 repositories call `stripe.webhooks.constructEvent`, then read `event.data.object` (often `as Stripe.Subscription`). Refit doesn't trace event payloads.
2. **Objects are passed around.** A subscription retrieved in one function is read in another, often typed as `Stripe.Subscription`. Refit's tracing stops at the first call or alias, and doesn't use TypeScript's `Stripe.*` type annotations.
3. **Common names cause noise.** Because Stripe removed `line_item.type`, any `.type` read near Stripe code is reported, for example in a UI toast hook.
4. **The built-in Stripe adapter maps only `paymentIntents`.** Custom adapters can't use the reserved `stripe` id. The benchmark's generated adapter uses `stripe-full`, which skips Stripe-specific extras such as the charges rule.

### Other blockers found

- **Production mode can't diff real Stripe specs.** The 30s `oasdiff` limit is exceeded on 8–11 MB specifications, and some pairs fail to compare at all. The default worker mode therefore never reaches the code stage for Stripe.
- **Validation coverage:** 57 repositories use npm, 26 pnpm, 5 yarn and 12 have no lockfile. Only 17 have a real test script.

## Score against the ground truth

[`benchmarks/STRIPE-LABELS.md`](benchmarks/STRIPE-LABELS.md) labels 30 of the repositories: 40 real breaking reads in 11 repositories. Today's Refit, generated full adapter, labelled set:

| | Recall | Precision |
|---|---|---|
| Confirmed findings (what Refit acts on) | **0%** (0/39) | n/a |
| Any finding, including review | 100% (39/39) | **1%** (39/3,048) |

Refit reports every real break but can't separate it from about 3,000 false matches, so it confirms none. Phase 2 of the [plan](STRIPE-PLAN.md) targets confirmed recall ≥ 90% at precision ≥ 98%.

## Reproduce

```sh
npm run benchmark:stripe -- --root <dir with repos/, specs/, selected.json, needed-specs.json> \
  --output <new-dir> --env .env --ai --validate
```

The collection steps (GitHub search, SDK version mapping, spec downloads) are described above. The pinned list is in `docs/benchmarks/`.
