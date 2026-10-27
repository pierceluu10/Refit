# Deterministic Stripe rules mined from stops

What still stops Refit on the four committed Stripe benchmark sets (fresh 381, original 100, held-out 50, active 66), which of those stops a deterministic rule can remove, and the rules this branch built. **Owner decision (2026-10-24, overnight sign-off; supersedes the 2026-10-22 decision that disabled them):** the four rules below are automatic, under the conditions each section names. The evidence is in `docs/overnight/F4.md`. Every Stripe fact below comes from a changelog page or OpenAPI document that was read for this work on 2026-10-22, and those pages were re-read on 2026-10-24.

## Generated rules

**Owner decisions D3 and D5 (Pierce, 2026-10-27).** Stripe's field and request moves are no longer hand-written. `refit rules generate` derives them from Stripe's docs and pinned contracts, and they live as versioned tables in [`data/rules/stripe/`](../data/rules/stripe/), one file per API version.

What existed before this work: the rule pack as data with its edit families ([Rule packs](RULE-PACKS.md)), the saved changelog catalog and pages, and `refit classify-release`, which scores AI answers against the catalog and feeds nothing. What was built:

- **Rule tables.** Each rule is a pack entry plus its evidence: the docs.stripe.com page (`source`), a verbatim `quote` from it, `checkedAt`, the oasdiff entry it answers (`diff`: `id`, `operationId`, `text`), `status` (`auto` or `review-only`), `origin` (`generated` or `hand-written`), `generatedBy` (model and response id) and, for `auto`, `benchmark`. A field move documented on several pages joins them under `also`. Only `auto` rules join the pack; a rule in both the pack and a table is refused.
- **Checker.** `npm run rules:check` (`refit rules check`) loads each table's two pinned contracts by SHA-256, runs oasdiff between them and checks every rule: the page is saved and holds the quote verbatim, the diff entry is in the changelog and is the removal the rule answers, every moved property is removed, every target exists in the after contract, and a request move agrees with both contracts on every operation it names.
- **Generator** (`pipeline/rule-generation.ts`). For each version, it reads the changelog index, saves every page marked Breaking under `docs/benchmarks/stripe-changelog/pages/<version>/`, diffs the version's pinned contract with the one before it, and sends each page with the diff entries that page names to OpenAI (strict JSON). The model proposes only the family, the names and the quote. Everything else is derived from the contracts: operation IDs from `METHOD /path`, `unlessExpanded` and `typeofGuard` from `x-expansionResources`, `narrowTested` from `nullable`, `droppedFields`, and the helper, which must be one of the generated helpers that reads exactly those new locations (`HELPER_TARGETS` in `stripe-subscription-periods.ts`). The candidate is then checked as `rules:check` does. New rules are written `review-only`.
- **One applier.** Generated rules run through the existing families. `moved-value` no longer rewrites writes or deletes for any rule, since a helper call cannot be assigned to (before, only the rules flagged `readsOnly` had this).

### Run of 2026-10-27

`gpt-6.1-sol`, every pinned version from 2022-11-15 to 2026-09-30.endive (30 versions, 102 Breaking pages), $0.62 for the final run and $0.73 in all, including trial runs.

|                                    | Count                    |
| ---------------------------------- | ------------------------ |
| Candidates                         | 20                       |
| Verified                           | 9, which join to 8 rules |
| Unverifiable (refused)             | 11                       |
| Hand-written pack rules reproduced | 8 of 8                   |
| New verified rules                 | 0                        |
| Wrong rules                        | 0                        |

The 8 reproduced rules replace the pack's 6 field moves and 2 request moves, which were deleted. They keep the hand rules' ids and warnings and are `auto`. Behaviour is identical on the tests (`pipeline/rule-generation.test.ts` compares every reproduced rule with its hand rule, and every `stripe-*.test.ts` passes unchanged) and on the benchmark (see [Benchmarks](BENCHMARKS.md#generated-stripe-rules-october-27)). `stripe-coupon-id-helper` covers two schemas, documented on two clover pages, so it is one rule with `also` evidence, as the hand rule was one.

Refused, each with its recorded reason in the run's `results.json`:

- 2024-04-10 `rendering_options` → `rendering`, and 2024-09-30.acacia billing alert filters: the diff removes none of the named properties.
- 2024-06-20 issuing fuel `volume_decimal` (two pages, two candidates each): no generated helper reads the new location, and the dotted property is not a removal in the diff.
- 2025-03-31.basil invoice item `parent` fields (2) and invoice `pricing` (2): no generated helper reads the new location. The request renames `price` → `pricing.price`: the contracts disagree with a plain rename, and `lines[].price` is not a removal in the diff.
- 2023-08-16 produced no candidates: oasdiff's output between the 2022-11-15 and 2023-08-16 contracts is over 256 MiB, so no rule could be verified.

Not generated, and still code:

- `payment_method_types` → `allowed_payment_method_types`, `invoices.createPreview`, the currency-code rule and `trial_from_plan`. Their conditions are owner decisions (value checks, SDK upgrades) that no family expresses, and the model proposed no rule for those pages.
- **Helper bodies.** A new moved field needs a generated helper body before a rule can name it; four refusals above are this gap.
- **Enum value changes** (for example dahlia's `ui_mode` values). No edit family exists for them, so they stay review findings.

## What stops Refit, ranked

### By outcome

These are the committed outcomes of all 597 repositories (fix-rate runs at `7238e46`, Yarn repositories at `fecd935`): [fresh](benchmarks/2026-10-16-stripe-fixrate-fresh-results.json), [original](benchmarks/2026-10-16-stripe-fixrate-original-results.json), [held out](benchmarks/2026-10-16-stripe-fixrate-heldout-results.json), [active](benchmarks/2026-10-16-stripe-active-results.json).

| Outcome                                                                | Repositories | Rule material?                                  |
| ---------------------------------------------------------------------- | ------------ | ----------------------------------------------- |
| `stopped-removed-request-parameter`                                    | 88           | Almost all `payment_method_types`; see below    |
| `refused-for-validation`                                               | 41           | No: dependency preparation and sandbox refusals |
| `validation-regression`                                                | 12           | No: see "Rejected candidates"                   |
| `stopped-invalid-source`                                               | 8            | No: unparseable files                           |
| `stopped-declared-types-or-pin-conflict`                               | 7            | No: the provenance and pin gates                |
| `stopped-for-review`                                                   | 6            | Partly: unresolved fields below                 |
| `exceeds-scan-limits`, `proposed-no-checks`, `baseline-failed`, `ai-*` | 14           | No                                              |

### By parameter and field

The committed rows record only the outcome. For what each stop is made of:

- the fresh set uses the `6d4f38a` run with `--ai --validate`;
- the other three sets were scanned at `7b2c86a`, current `main` (`npm run benchmark:stripe` without `--ai` or `--validate`).

These scans are not backed by a committed results file. Repositories with a confirmed finding:

| Removed request parameter                            | Confirmed | Any confidence | Rule material?                                            |
| ---------------------------------------------------- | --------- | -------------- | --------------------------------------------------------- |
| `payment_method_types` on `checkout.sessions.create` | 225       | 248            | Owner decision: only `['card']` (and opted-in lists) move |
| `payment_method_types` on `paymentIntents.create`    | 12        | 12             | Owner decision                                            |
| `payment_method_types` on `setupIntents.create`      | 5         | 8              | Owner decision                                            |
| `coupon` on `subscriptions.update`                   | 2         | 3              | Rejected (below)                                          |
| `coupon` on `promotionCodes.create`                  | 2         | 2              | Built, automatic with the pin                             |

| Removed field read, without a rule today                                                               | Repositories | Rule material?                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice.payment_intent`                                                                               | 5            | Rejected (below)                                                                                                                              |
| `line_item.type`                                                                                       | 3            | Rejected: already a documented stop                                                                                                           |
| `subscription.discount`, `charge.invoice`, `payment_intent.invoice`                                    | 2 each       | Rejected (below)                                                                                                                              |
| `promotion_code.coupon`, `discount.coupon`                                                             | 1 each       | Built, automatic (ID reads)                                                                                                                   |
| `product.features`                                                                                     | 1            | Built, automatic                                                                                                                              |
| `product_feature.name`                                                                                 | 1            | No: a schema-name artefact. In 2023-10-16 `product_feature` was the marketing feature; from 2024-04-10 the name means the Entitlements object |
| `invoice.subscription_details`, `invoice.paid`, `invoice.tax`, `line_item.proration`, `invoice.charge` | 1 each       | Rejected: no equivalent field                                                                                                                 |

### Not ranked by any stop

One break was missing from every list above, because Refit did not see it: `invoices.retrieveUpcoming`.

- stripe-node names the method by hand, so the `GET /v1/invoices/upcoming` path never maps to it.
- 5 repositories that start before basil call it: `internxt/payments-server`, `ReeceHarding/firebase-next.js-boilerplate`, `yuga-hashimoto/ai-tool-navigator`, `kondax-com/Bocker` and `EngMajdSayedTaha/reelspy`. These were found by searching every clone for the call.

## Built rules

These rules are now generated (see [Generated rules](#generated-rules)), except `stripe-invoice-create-preview`. `pipeline/run.ts` keeps these edits under the conditions below; anywhere else, the site stays a finding for review with its reason.

| Rule                                                                  | Change                                                                                                                              | Stripe source                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe-promotion-code-promotion`                                     | `promotionCodes.create({ coupon })` sends `promotion: { type: 'coupon', coupon }`                                                   | [clover: polymorphic coupon](https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon)                                                                                              |
| `stripe-coupon-id-helper`                                             | `promotionCode.coupon.id` and `discount.coupon.id` read through `getCouponId()`                                                     | [polymorphic coupon](https://docs.stripe.com/changelog/clover/2025-09-30/polymorphic-coupon), [discount source](https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property) |
| `stripe-product-marketing-features`, `stripe-product-features-helper` | `products.create/update({ features })` sends `marketing_features`; `product.features` reads through `getProductMarketingFeatures()` | [2024-04-10: renames features](https://docs.stripe.com/changelog/2024-04-10/renames-features-attribute-product-object)                                                                            |
| `stripe-invoice-create-preview`                                       | `invoices.retrieveUpcoming(params)` becomes `invoices.createPreview(params)`, `subscription_*` moved under `subscription_details`   | [basil: invoice preview](https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations)                                                                                     |

All four follow the existing rule style:

- each checks both recorded contracts before it offers an edit;
- each edits only direct, statically traced sites on confirmed clients;
- each stops with a named reason everywhere else.

### `stripe-promotion-code-promotion`

**Change.** Clover moved a promotion code's top-level `coupon` into a polymorphic `promotion` hash with `type: 'coupon'`.

**Contract checks.** The before contract requires `coupon` on `POST /v1/promotion_codes`, so any value the code sends is moved unchanged. The rule applies only when the after contract's `promotion` declares a string `coupon` and a `type` whose enum includes `coupon`.

**Stops.**

- A body with a spread, a computed key or an existing `promotion`.
- An optional call.
- Promotion code parameters built in a variable. These are not traced; see [the fresh-set misses](STRIPE-FRESH-RECALL.md#misses-ranked-by-cause).

**Rollout.** Automatic, under the card rename's conditions: the patch moves every client's pin to the target and, for TypeScript or an SDK-pinned version, the stripe-node upgrade is prepared first. Otherwise the parameter keeps stopping. The product `features` request rename follows the same conditions; the coupon ID and product features read helpers read either API version and need only the target contract's new locations.

### `stripe-coupon-id-helper`

**Change.** Clover stopped auto-expanding coupons: a promotion code's coupon is now at `promotion.coupon`, and a discount's at `source.coupon`. Both hold an ID unless expanded.

**Edit.** `x.coupon.id` reads (SDK responses, webhook payloads and `Stripe.*`-typed values) call the generated `getCouponId()`. It returns:

- the old coupon's ID when present (old-version payloads);
- otherwise the ID or expanded Coupon at `promotion`/`source` when its `type` is `coupon`.

**Stops.** Reads of other Coupon fields (`percent_off`, `amount_off`, …) need an expand or `coupons.retrieve`. They stay unresolved, with that reason.

### `stripe-product-marketing-features` and `stripe-product-features-helper`

**Change.** 2024-04-10 renamed a product's `features` to `marketing_features`.

**Request edit.** On `products.create` and `products.update`, the key is renamed only when the before `features` and after `marketing_features` schemas are identical apart from descriptions. That covers the same `{ name }` items, and the same `''` unset form on update.

**Read edit.** Reads call `getProductMarketingFeatures()`, which returns the old list when present, otherwise `marketing_features`.

**Stops.** Writes, spreads, and bodies that already send `marketing_features`.

### `stripe-invoice-create-preview`

**Change.** Basil removed `GET /v1/invoices/upcoming` in favour of `POST /v1/invoices/create_preview`, which Stripe says "offers equivalent functionality and parameters". It also stopped previewing a customer's next invoice across all their subscriptions.

**Why it matters.** Refit did not see these calls at all: stripe-node names the method `retrieveUpcoming`, which no contract path produces.

**Edit.** A call that sends `customer` and `subscription` in a direct object literal becomes `createPreview`. Each parameter is sent:

- under its own name, when the target accepts every value the old parameter accepted;
- or, for `subscription_<name>`, as `subscription_details.<name>`.

`accepts()` in `pipeline/stripe-invoice-preview.ts` checks this structurally: types, formats, enums, lengths, required properties and nested properties. A later addition passes, a changed shape does not; for example, endive changed `subscription_details.billing_cycle_anchor` to an object.

**Stops.**

- Customer-wide previews (no `subscription`).
- Parameters with no equivalent (`coupon`).
- Spreads.
- Calls that send both `subscription_details` and `subscription_*`.

**Rollout.** stripe-node's published type definitions have `createPreview` from 15.6.0 on: it is absent in 15.1.0 and every earlier tarball read for the [fresh-set labels](STRIPE-FRESH-RECALL.md). So the rewrite is kept only when the stripe-node upgrade is prepared, **in any language**, and the upgrade is added to the patch. Without it, the call keeps stopping.

## Measurement

This measurement was taken on 2026-10-22 with the rules enabled. It is not backed by a committed results file. The 2026-10-24 before/after on GitHub Actions is in `docs/overnight/F4.md`.

**Setup.** The 9 repositories with a site for one of the rules, at their pinned commits:

- `main` at `7b2c86a` ("before") against this branch at `0c287f0` ("after");
- each with the generated full adapter the benchmark builds for it (`npm run benchmark:stripe`);
- then `runPipeline({ proposePatch: true })`, which includes the stripe-node upgrade lookup on the npm registry.

| Repository                                              | Before                                                                                              | After                                                                                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boristenkes/shop.co`                                   | Stops: removed request parameter (`promotionCodes.create` `coupon`)                                 | **Patch proposed**: promotion move, the `['card']` rename, the endive pin, stripe-node 18.1.1 → 23.0.0; 6 review-only reads left unresolved                                                                  |
| `Nag-Software/proanbud2`                                | Stops: removed request parameter                                                                    | Stops: the promotion edit is made but not kept, because `lib/billing/cancellation.ts:162` sets a request-level API version Refit cannot read, so the endive-only parameter could be sent on an older version |
| `helloworld9912/Stripe-Account-Migration`               | Stops: declared types                                                                               | Stops: declared types. The coupon ID and product features helper edits are made; the repository-wide declared-type gate still blocks                                                                         |
| `ReeceHarding/firebase-next.js-boilerplate`             | Unsupported: no rule, 15 unresolved, and the upcoming invoice call not reported                     | Stops with a named reason: a customer-wide `retrieveUpcoming`, which has no `createPreview` equivalent                                                                                                       |
| `kondax-com/Bocker`, `yuga-hashimoto/ai-tool-navigator` | Stops: removed request parameter (`subscriptions.update` `coupon`); `retrieveUpcoming` not reported | Same stop; `retrieveUpcoming` is now reported for review (their clients are not provably stable), so nothing is edited                                                                                       |
| `thematters/matters-server`                             | Stops: `subscriptions.update({ coupon: '' })`                                                       | Same, now with the reviewer note                                                                                                                                                                             |
| `EngMajdSayedTaha/reelspy`                              | Stops: helper client                                                                                | Same: the client is a helper parameter, so the call is not traced                                                                                                                                            |
| `internxt/payments-server`                              | Error: the generated adapter exceeds 100 operations                                                 | Same                                                                                                                                                                                                         |

**Counts.** One repository moves from a stop to a proposed patch (shop.co). Three upcoming invoice calls that Refit did not report at all are now reported (one confirmed stop, two review). Every other outcome is unchanged, and no new patch edits anything the rules do not name.

**Docker validation: Blocked.** The before and after `--validate` runs on shop.co (the one repository with a proposed patch) did not run.

- They need the machine-wide Docker lock (`/tmp/refit-docker.lock`), and other lanes held it for well over the 45-minute timebox.
- The lock passed from one lane straight to the next (OG6, then OP4, last checked 2026-10-22T10:05Z), while this lane polled every 5 minutes as the shared rules ask.
- So the table above is patch-level only: what Refit proposes, not whether shop.co's checks pass on the patch.
- To unblock it, run `npm run benchmark:stripe -- --offset 0 --limit 1 --validate` against the measurement root, once on `main` and once on this branch, while holding the lock.

### Every diff, read in full and labelled

`boristenkes/shop.co`, applied to its pinned clone (`git apply`, then `git diff`), excluding the lockfile body:

```diff
--- a/features/coupon/actions/create.ts
+++ b/features/coupon/actions/create.ts
-			coupon: stripeCoupon.id,
+			promotion: { type: 'coupon', coupon: stripeCoupon.id },
--- a/features/orders/actions/create.ts
+++ b/features/orders/actions/create.ts
-			payment_method_types: ['card'],
+			allowed_payment_method_types: ['card'],
--- a/lib/stripe.ts
+++ b/lib/stripe.ts
-	apiVersion: '2025-04-30.basil'
+	apiVersion: '2026-09-30.endive'
--- a/package.json
+++ b/package.json
-    "stripe": "^18.1.1",
+    "stripe": "^23.0.0",
```

`pnpm-lock.yaml` changes the `stripe` entry to 23.0.0 (24 lines).

- **Label: correct.**
  - `stripeCoupon.id` comes from `stripe.coupons.create` two lines above, so the moved value is a coupon ID, as `promotion.coupon` expects.
  - `promotion.type` is `coupon`, the only value the endive enum allows.
  - The card rename is the owner-approved rule.
  - The pin and the SDK upgrade are the ones every endive patch carries.
- **Not part of the patch:** the 6 unresolved findings are review-only `couponValidation.coupon` reads in `features/orders/actions/create.ts:83-84`, on the app's own validation object. They are not Stripe reads, and the draft lists them for review.

## Rejected candidates

| Candidate                                                      | Repositories                                                                                                                                       | Why it is not a rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `payment_method_types` beyond `['card']`                       | 225+                                                                                                                                               | Owner decision (`docs/STRIPE-PAYMENT-METHOD-TYPES.md`); excluded as instructed                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Subscription `coupon`/`promotion_code` → `discounts`           | `kondax-com/Bocker`, `yuga-hashimoto/ai-tool-navigator`, `thematters/matters-server`. Every site is an update                                      | Endive documents that on update "a populated array overwrites the existing discounts on the subscription", and `''` clears them. The old singular parameter's effect on other discounts is not documented, so the update has no proven equivalent. A creation-only version was built and dropped: no repository creates subscriptions with a coupon. The stop now carries a reviewer note                                                                                                                                                  |
| Customer `coupon`/`promotion_code`                             | `gitroomhq/postiz-new-support-bot` (type only)                                                                                                     | The [basil page](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-singular-coupon-promotion-code) gives customers no replacement                                                                                                                                                                                                                                                                                                                                                                                               |
| `invoice.payment_intent` → `confirmation_secret.client_secret` | About 25 repositories expand `latest_invoice.payment_intent` for a Payment Element client secret                                                   | Stripe [documents](https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices) this replacement for that use. A rule was built (move the `expand` entry and every `.payment_intent.client_secret` read of the response together, stop on any other use) and then dropped: every real site reads through the expandable `latest_invoice` union, which Refit reports only for review. Editing review sites is out of bounds. It needs Refit to confirm reads of literally expanded paths first |
| `subscription.discount`, `invoice.discount` → `discounts`      | `kondax-com/Bocker`, `helloworld9912/Stripe-Account-Migration`                                                                                     | The new field is a list of expandable IDs; picking one entry changes behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `charge.invoice`, `payment_intent.invoice`, `invoice.charge`   | 2, 2, 1                                                                                                                                            | Replaced by the Invoice Payments API, a different lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `invoice.paid`                                                 | `internxt/payments-server`                                                                                                                         | Stripe points to `invoice.payments` and `amount_paid_off_stripe`; no boolean equivalent is documented                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Schedule phase `iterations` → `duration`                       | none sends it                                                                                                                                      | Needs the price's interval to convert; [clover page](https://docs.stripe.com/changelog/clover/2025-09-30/remove-iterations)                                                                                                                                                                                                                                                                                                                                                                                                                |
| Validation regressions                                         | 12 at `7238e46`, of which 3 remain at `6d4f38a` (`adityayaduvanshi/Full-Stack-Music-Web-App`, `afdon/music-app`, `AlefeSk8/Spotify-Clone-Next.js`) | Not an API migration. The stripe-node upgrade's types reject the app's own code: open-enum `Interval` and `Type` values typed with `OtherString`, and `subscription_data.trial_from_plan`, which no recorded contract since 2022-11-15 accepts. That is a request for the stripe-node upgrade's owner                                                                                                                                                                                                                                      |

## Not verified

- **No Docker validation.** shop.co's checks were not run on the proposed patch; see Measurement.
- **Simulated contracts only.** The rules' tests use contracts reduced from the real documents and snippets from the benchmark repositories. No live Stripe call was made.
- **Real checks prove only what they cover.** A repository's own checks are evidence about the code paths they cover. They do not prove a request behaves the same at Stripe.
- **Request-side simulation is still open.** Whether `discounts[0][coupon]=` (empty) and `coupon=` behave the same at Stripe was not tested. That is why subscription coupons stay for review.
