# Stripe fresh-set recall

The [fresh Stripe set](benchmarks/2026-10-16-stripe-fresh-repos.json) is 381 repositories that were never used to tune Refit. Its [committed results](benchmarks/2026-10-16-stripe-fresh-results.json) gave only Refit's outcome for each repository, so recall there was unknown. This page adds ground truth for **120 of them** and scores Refit against it.

- Labels: [`2026-10-22-stripe-fresh-labels.json`](benchmarks/2026-10-22-stripe-fresh-labels.json), in the format of the [original answer key](benchmarks/STRIPE-LABELS.md).
- Every hand decision, with its reason: [`*-decisions.json`](benchmarks/2026-10-22-stripe-fresh-labels-decisions.json).
- Every miss, with its cause: [`*-misses.json`](benchmarks/2026-10-22-stripe-fresh-labels-misses.json).
- Tooling: `scripts/stripe-fresh-labels.mjs` (`sample`, `prepare`, `assemble`, `score`), tested in `pipeline/stripe-fresh-labels.test.ts`.

The labels were made by Claude (an AI assistant) with the tooling below, on 2026-10-22. A human spot-check of a sample is recommended before these numbers are quoted outside the team.

## Results

Refit at `7b2c86a` (`main`, clean detached worktree), scan only: `npm run benchmark:stripe` without `--ai` or `--validate`. 120 labelled repositories, 89 of them broken by the upgrade to `2026-09-30.endive`.

| | Recall | Precision |
|---|---|---|
| Breaking reads, confirmed findings | **72%** (159/222) | **86%** (159/185); 99% (184/185) if the 25 disputed reads count as breaking |
| Breaking reads, any finding (confirmed or review) | 98% (218/222) | 37% (218/596) |
| Removed request parameters, confirmed | **86%** (83/96) | **100%** (83/83) |
| Removed request parameters, any | 91% (87/96) | 100% (87/87) |

| Repositories | Count |
|---|---|
| Broken repositories where a confirmed finding names at least one break | **83 of 89** (93%, 95% CI 86–97%) |
| Broken repositories where any finding names at least one break | 88 of 89 |
| Broken repositories where the findings name every break (any confidence) | 83 of 89 |
| Unaffected repositories with a confirmed finding | 1 of 31: `ARCPrivus2026/ARCPrivus-AI-Madre`, a removed parameter in a `backup-arc-privus/` copy that no script runs (labelled `excluded`) |

- Read-level intervals would treat reads as independent, but they cluster by repository (`wyvern800/tldkp` alone has 12 missed reads), so none are given.
- Precision is reported as labelled. Of the 26 confirmed "false positives", 25 are the disputed pattern below. The remaining one is `helloworld9912/Stripe-Account-Migration` `src/scripts/products.ts:40`: `feature.name` on a product marketing feature, which keeps `name` (the removed field is `product.features` itself, on line 37).

### What the committed outcomes got wrong

The sample was drawn from the outcomes in the committed results, recorded at `6733a99`:

- **40 of the 40 "affected" repositories really are broken** (95% CI 91–100%).
- **10 of the 40 "not affected" repositories are broken** (25%, 95% CI 14–40%). Applied to the 206 repositories in that group, roughly 29 to 82 of them are broken.
  - The 10 are `papay0/Ideate.build`, `puneethkotha/Zapd`, `wyvern800/tldkp` and `Alex-Unnippillil/share-house-portal` (all `no-mapped-methods`), and `SeaMossBros/sea-moss-api`, `cavidaga/lnk`, `CapChris20/Retronix-Wallpapers-Startup`, `techblitzdev/TechBlitz`, `billychen0894/florist-ecommerce-app` and `SimplerDevelopment/SimplerDevelopment` (all `not-affected`).
  - At `7b2c86a`, 4 of the 10 now have a confirmed finding on a break. 5 more are flagged for review only, and `techblitzdev/TechBlitz` still has no finding at all.
- 39 of the 40 extension repositories, drawn from the "stopped" outcomes, are broken. The exception, `ARCPrivus2026/ARCPrivus-AI-Madre`, stopped for unparseable source. That is a safety stop, not a wrong edit.

### Outcomes with validation, at `6d4f38a`

`7b2c86a` was scanned without validation, so its outcomes cannot be scored. The last full run with `--ai --validate` is `6d4f38a` (2026-10-20), and `npm run benchmark:stripe-score` against these labels gives the following. The run directory is named for that commit; whether its worktree was clean was not recorded.

| | 120 labelled repositories |
|---|---|
| Strict (validated fix that changes every breaking line, or no patch for an unaffected repository) | **62** (52%) |
| Lenient (adds review stops whose findings name every break) | **90** (75%) |
| Incorrect | 30: 19 workflow errors before validation (dependency preparation and sandbox refusals), 7 stops that do not name every break, 2 validation regressions, 2 validated fixes the scorer says leave a break |

Of the two validated fixes:
- `profullstack/vibe-stack`: a partial fix. The reads Refit reported only for review (`current_period_*`, `invoice.subscription`, `invoice.paid`) were left in place. That run predates the 2026-10-21 owner decision that such reads make a draft `[Needs review]`.
- `tmachnacki/podvex`: a scorer artefact, not a wrong patch. The patch rewrites the whole file and does change line 117 (`getInvoiceSubscription(completedEvent)`). The scorer matches lines by trimmed text, and the identical line in the `checkout.session.completed` branch is kept, so it hides the edit. See "Requests for other lanes" in the PR.

## Misses ranked by cause

Every labelled break that Refit did not confirm at `7b2c86a` (76: 63 reads, 13 request parameters), grouped by the shape of the code. Ranking is by repositories affected, then misses. "Review only" means Refit reported the line at review confidence, so it stopped for a human; "not reported" means no finding at all.

The causes describe what the code does. Refit's internal reason for each miss is not recorded per finding; per-repository review reasons are in each result's `reviewReasons`.

1. **Request parameters built in a variable or helper, changed or passed by name before the call:** 9 misses in 5 repositories.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| zainulabedeen123/Best-Saas-Kit--V2 | not reported | `src/lib/stripe.ts`: 113 | `payment_method_types` (POST /v1/checkout/sessions) |
| helloworld9912/Stripe-Account-Migration | not reported | `src/scripts/promotion_codes.ts`: 25 | `coupon` (POST /v1/promotion_codes) |
| helloworld9912/Stripe-Account-Migration | not reported | `src/scripts/prices.ts`: 49 | `recurring.aggregate_usage` (POST /v1/prices) |
| helloworld9912/Stripe-Account-Migration | not reported | `src/scripts/products.ts`: 47 | `features` (POST /v1/products) |
| helloworld9912/Stripe-Account-Migration | not reported | `src/scripts/subscriptions.ts`: 177 | `coupon` (POST /v1/subscriptions) |
| wyvern800/tldkp | not reported | `utils/stripe.js`: 42 | `payment_method_types` (POST /v1/checkout/sessions) |
| billychen0894/florist-ecommerce-app | not reported | `actions/checkout.ts`: 54 | `payment_method_types` (POST /v1/checkout/sessions) |
| aresjinwoo94-cpu/EliteVault | not reported | `lib/stripe/checkout-session.ts`: 169 | `payment_method_types` (POST /v1/checkout/sessions) |
| aresjinwoo94-cpu/EliteVault | not reported | `lib/stripe/report-unlock-params.ts`: 56 | `payment_method_types` (POST /v1/checkout/sessions) |

2. **List item read in a for-of loop or an array callback:** 10 misses in 4 repositories.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| zainulabedeen123/Best-Saas-Kit--V2 | review only | `src/app/api/stripe/webhook/route.ts`: 110, 112 | `discount.coupon` |
| habibjutt/nextjs_boilerplate | review only | `scripts/auto-sync-subscriptions.ts`: 85, 86, 92 | `subscription.current_period_start`, `subscription.current_period_end` |
| habibjutt/nextjs_boilerplate | review only | `scripts/sync-subscriptions.ts`: 110, 111 | `subscription.current_period_start`, `subscription.current_period_end` |
| shagunmistry/FlowCraft | review only | `src/app/api/subscription/route.ts`: 72 | `subscription.current_period_end` |
| thematters/matters-server | review only | `src/routes/pay/stripe/circle.ts`: 348 | `line_item.price` |

3. **Plain-JavaScript webhook payload (event.data.object, no types), read inline or in a handler it is passed to:** 19 misses in 3 repositories.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| profullstack/vibe-stack | review only | `public/js/modules/payment-gateway/src/providers/stripe.js`: 399, 403, 417, 421, 436, 437, 453, 454 | `invoice.subscription`, `invoice.paid`, `subscription.current_period_start`, `subscription.current_period_end` |
| profullstack/vibe-stack | review only | `src/services/stripe-payment-service.js`: 289 | `invoice.subscription` |
| cavidaga/lnk | review only | `api/billing/webhook.js`: 166, 195 | `invoice.subscription` |
| wyvern800/tldkp | review only | `src/instances/server.js`: 177, 208, 239, 255, 1771, 1786, 1817, 1833 | `subscription.current_period_end`, `invoice.subscription` |

4. **Typed function parameter, or a variable assigned in branches (Stripe type declared, not traced):** 8 misses in 3 repositories.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| helloworld9912/Stripe-Account-Migration | review only | `src/scripts/prices.ts`: 48, 49 | `recurring.aggregate_usage` |
| helloworld9912/Stripe-Account-Migration | review only | `src/scripts/subscriptions.ts`: 177 | `discount.coupon` |
| Drago-03/Neural-Nexus | review only | `app/api/checkout-details/route.ts`: 82 | `subscription.current_period_end` |
| Drago-03/Neural-Nexus | review only | `app/api/webhooks/stripe/route.ts`: 229, 287 | `subscription.current_period_end`, `invoice.subscription` |
| thematters/matters-server | review only | `src/routes/pay/stripe/circle.ts`: 293, 336 | `invoice.payment_intent`, `invoice.subscription` |

5. **Stripe object returned from a helper in another module:** 8 misses in 3 repositories.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| cavidaga/lnk | not reported | `api/billing/subscription.js`: 37, 38 | `subscription.current_period_start`, `subscription.current_period_end` |
| wyvern800/tldkp | review only | `src/instances/server.js`: 128, 245, 1745, 1823 | `subscription.current_period_end` |
| techblitzdev/TechBlitz | not reported | `src/app/(app)/settings/billing/page.tsx`: 20, 21 | `subscription.current_period_end` |

6. **Request on an untyped client (plain JavaScript): reported for review, not confirmed:** 4 misses in 3 repositories.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| cavidaga/lnk | review only | `lib/stripe.js`: 149 | `payment_method_types` (POST /v1/checkout/sessions) |
| CapChris20/Retronix-Wallpapers-Startup | review only | `retronix/netlify/functions/create-checkout-session.js`: 48 | `payment_method_types` (POST /v1/checkout/sessions) |
| CapChris20/Retronix-Wallpapers-Startup | review only | `extras/functions/index.js`: 279 | `payment_method_types` (POST /v1/checkout/sessions) |
| doganarif/build-it | review only | `lib/stripe.js`: 15 | `payment_method_types` (POST /v1/checkout/sessions) |

7. **Plain-JavaScript SDK response (no types) read in the function that requested it:** 11 misses in 2 repositories.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| profullstack/vibe-stack | review only | `public/js/modules/payment-gateway/src/providers/stripe.js`: 185, 186, 250, 251 | `subscription.current_period_start`, `subscription.current_period_end` |
| SeaMossBros/sea-moss-api | review only | `src/api/order/controllers/payment.js`: 136, 137, 138, 139, 140, 141, 143 | `checkout.session.shipping_details` |

8. **Stripe object cast to a hand-written type (as unknown as {...}):** 3 misses in 1 repository.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| aresjinwoo94-cpu/EliteVault | review only | `app/api/stripe/webhook/route.ts`: 232, 235, 263 | `subscription.current_period_start`, `subscription.current_period_end` |

9. **Typed webhook payload cast and read before the event type is checked:** 3 misses in 1 repository.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| billychen0894/florist-ecommerce-app | review only | `app/api/webhook/route.ts`: 24, 27, 29 | `checkout.session.shipping_details` |

10. **Field of an expanded nested object (latest_invoice.payment_intent):** 1 misses in 1 repository.

| Repository | Reported as | File: lines | Fields |
|---|---|---|---|
| Librum-Reader/Librum-Website | review only | `app/api/subscribe/route.js`: 45 | `invoice.payment_intent` |

### What the misses suggest

Each item ranks a cause by how many repositories it blocks, for OP5 and the analyzer owners. None of these is changed in this lane.

1. **Request parameters built in a variable** (5 repositories, all not reported) is the only cause that produces silence instead of a review stop, so a fix there turns misses into stops at no precision cost: request precision is 100% today.
2. **List items in loops and callbacks** (4 repositories) and **typed parameters** (3) are typed TypeScript that already reaches review.
3. **Plain-JavaScript payloads and responses** (19 + 11 misses) are the largest by read count but sit in 4 repositories. They need the untyped-client provenance work.
4. **Helper returns across modules** (3 repositories) include 4 reads that are not reported at all.

## How the labels were made

### Sample

- **Seed `20261022`**, `seededSample` from `scripts/ai-app-helpers.mjs` (sorted keys, mulberry32 Fisher–Yates), over the committed fresh results.
- **"Affected": 40 of 171.** These are outcomes where Refit reported affected code or stopped: every `stopped-*` outcome, `validated`, `proposed-no-checks`, `refused-for-validation`, `validation-regression` and `ai-*`. Drawn: 35 `stopped-removed-request-parameter`, 2 `validated`, and 1 each of `validation-regression`, `stopped-declared-types-or-pin-conflict` and `refused-for-validation`.
- **"Not affected": 40 of 206.** These are `not-affected`, `no-mapped-methods` and `no-sdk-calls`: every outcome in which Refit reported nothing to change, because that is where misses hide. Drawn: 25 `not-affected`, 12 `no-mapped-methods`, 3 `no-sdk-calls`.
- The 4 `exceeds-scan-limits` repositories were never scanned and are in neither group.
- **Extension: the next 40 of the seeded order of `stopped-*` outcomes** that were not already drawn: 37 `stopped-removed-request-parameter`, 2 `stopped-invalid-source`, 1 `stopped-declared-types-or-pin-conflict`.
- `node scripts/stripe-fresh-labels.mjs sample` reproduces all three lists, and a test pins them.

### Blind

Labels were made before looking at any Refit finding for these repositories.
- Sampling needs each repository's committed outcome.
- While reading the results file's format, the summary rows (outcome, confirmed read count and confirmed field names, no files or lines) of 8 sampled repositories were displayed before labelling: `Emmah-oo/spotify-clone`, `zainulabedeen123/Best-Saas-Kit--V2`, `profullstack/vibe-stack`, `helloworld9912/Stripe-Account-Migration`, `VishalRaut2106/HackMate_AI`, `LuqP2/Image-MetaHub`, `tomsoderlund/login-as-a-service` and `joschan21/contentport`.
- Refit's runs on these repositories were started only after the labels were committed.

### Labelling root

`node scripts/stripe-fresh-labels.mjs prepare` builds the root used for labelling:
- It copies each clone from an existing fresh-set root built by `scripts/stripe-benchmark-setup.mjs`, and refuses a clone that is not the pinned commit or has local changes.
- It records each repository's `stripe` version. That is the lockfile's (86 `package-lock.json`, 15 `pnpm-lock.yaml`, 6 `bun.lock`, 4 `yarn.lock`), else the declared range's minimum (9).
- It extracts that version's published tarball with `npm pack` and `tar`, without installing it or running any script.

No repository code was installed or run.

### Labels

1. **Oracle.** `npm run benchmark:stripe-labels` runs TypeScript's checker with the repository's exact `stripe` types (`pipeline/stripe-ground-truth.ts`). It shares no code with Refit's analyzer. It labels every `a.b` read of a property name that some Stripe object loses between the repository's version and `endive`, and every literal request parameter on a typed client that the target no longer accepts.
2. **Rules,** as in the original key:
   - Unresolved reads in files that never mention "stripe" (any case) are `not-stripe` (2,190 reads). This is stricter than the original rule (no `stripe` import, `Stripe.` or `constructEvent`). That rule hid two real `invoice.subscription` reads in `cavidaga/lnk` `api/billing/webhook.js`, which imports only a local helper.
   - The rule was checked by reading every hit of a distinctive Stripe field name (`subscription`, `current_period_*`, `payment_intent`, `discount`, `paid`, …) and every `price` and `unit_amount` hit that it covers: Prisma and Supabase rows, Firestore data, Razorpay payloads and app state.
   - `event.type` and its aliases are `stripe-unaffected` (190).
3. **Hand decisions** for every read the oracle left unknown in a file that mentions Stripe: 368 reads, grouped by receiver, each with a one-line note.
   - Most unknowns are nested Stripe types the oracle cannot map, such as `Stripe.Price.Recurring`, and untyped JavaScript clients.
   - Two receivers are labelled by what they are at runtime. An `event.data.object as any` read in an `invoice.*` branch is an Invoice. Reads in a branch testing `"invoice_payment_succeeded"`, an event type Stripe never sends, are `excluded`.
4. **Request parameters by hand.** Every Stripe-mentioning file was searched for each removed parameter name of its version, and each hit inside the operation that drops it was read. This found 14 that the oracle cannot see: untyped clients, and parameters assigned to a typed params variable after its literal. Two copies in backup files are `excluded`.
5. **Overrides (6).** The oracle follows casts:
   - 4 reads cast a Stripe object to a hand-written type (`subscription as unknown as { current_period_end: number }`, and an invoice line item's `price`) and are `breaking`.
   - 2 reads fall back to the subscription only after the item-level period field, so the code works on both versions. They are `excluded`, like the same pattern decided by hand in `app/(app)/app/billing/page.tsx`.
6. **Disputed (25).** An `invoice.payment_succeeded` payload cast to `Stripe.Checkout.Session` reads `.subscription`. At runtime that is an Invoice, whose `subscription` `basil` removed. Following the original key, these keep `stripe-unaffected` with `disputed` until a human decides (STRIPE-PLAN open decision 1). The results table scores them both ways.
7. **Destructuring.** The oracle sees only `a.b` reads. Every destructured or bracket-indexed removed field name in a Stripe file was read by hand (18 hits). None is a Stripe object that loses the field: they are pricing configs, React props and hooks, and a Checkout Session's `invoice`, which it keeps.

| Read label | Reads | Of which by hand |
|---|---|---|
| `breaking` | 227 | 40 |
| `stripe-unaffected` | 570 | 67 |
| `not-stripe` | 4,375 | 252 |
| `excluded` | 15 | 15 |

The labels also hold 98 request parameters: 96 `breaking` (82 from the oracle, 14 by hand) and 2 `excluded`.

### What breaks in these repositories

| Removed field read | Reads | Repositories |
|---|---|---|
| `subscription.current_period_end` | 121 | 52 |
| `invoice.subscription` | 36 | 17 |
| `subscription.current_period_start` | 35 | 14 |
| `checkout.session.shipping_details` | 15 | 3 |
| `invoice.payment_intent` | 5 | 3 |
| `discount.coupon`, `line_item.price` | 3 each | 2 each |
| `invoice.paid`, `recurring.aggregate_usage`, `subscription.discount` | 2 each | 1 each |
| `product.features`, `promotion_code.coupon`, `invoice.tax` | 1 each | 1 each |

| Removed request parameter | Sites | Repositories |
|---|---|---|
| `payment_method_types` on `POST /v1/checkout/sessions` | 90 | 80 |
| `coupon` on promotion codes and subscriptions | 3 | 2 |
| `payment_method_types` on `POST /v1/setup_intents`, `recurring.aggregate_usage` on prices, `features` on products | 1 each | 1 each |

60 of the 89 broken repositories have a breaking read. The other 29 break only through request parameters, almost all `payment_method_types`.

## Not verified

- **No human check yet.** No human has checked the labels; a sample check is the next step.
- **Owner decision.** The disputed reads wait on STRIPE-PLAN open decision 1.
- **Scan only at `7b2c86a`.** No AI and no Docker validation ran, so today's outcomes are not scored; outcome scores are from the `6d4f38a` run above.
- **The oracle's limits remain:**
  - reads through `Reflect.get`, computed property names and spreads are invisible to it and to the hand passes;
  - request parameters inside helpers are found only by the name search.
- **Unknown dynamic behaviour.** Code that runs conditionally (feature flags, unused routes) is labelled as present in the source.

## Reproduce

```sh
node scripts/stripe-fresh-labels.mjs sample > sample.json   # repository lists come from the labels file
node scripts/stripe-fresh-labels.mjs prepare --source <fresh-set root from stripe-benchmark-setup.mjs> --root <labelling root> --repos <repos.json>
npm run benchmark:stripe-labels -- --root <labelling root> --output <oracle dir>
node scripts/stripe-fresh-labels.mjs assemble --root <labelling root> --oracle <oracle dir> \
  --decisions docs/benchmarks/2026-10-22-stripe-fresh-labels-decisions.json \
  --output docs/benchmarks/2026-10-22-stripe-fresh-labels.json
# from a clean worktree at the commit being measured; selected.json and needed-specs.json list the 120
npm run benchmark:stripe -- --root <labelling root> --output <run dir>
node scripts/stripe-fresh-labels.mjs score --labels docs/benchmarks/2026-10-22-stripe-fresh-labels.json --results <run dir>/results.json
npm run benchmark:stripe-score -- --results <run dir>/results.json --labels docs/benchmarks/2026-10-22-stripe-fresh-labels.json --verbose
```

`SimplerDevelopment/SimplerDevelopment` ran the scan out of Node's default heap at `7b2c86a` ("Reached heap limit"). It finished in 521 s with `NODE_OPTIONS=--max-old-space-size=6144`, while at `6d4f38a` it finished in 439 s with the default heap.
