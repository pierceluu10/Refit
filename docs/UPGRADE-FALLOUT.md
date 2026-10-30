# Upgrade fallout: behaviour repairs for stripe-node upgrade errors

**Status: diagnosis and design, 2026-10-28. No repair is built.** This is Agent 4 of `docs/VALIDATION-CEILING.md` (branch `docs/heldout-easy-wins`). The repairs wait for lane T (`feat/stripe-test-mode`, Stripe test mode as the referee) to merge, because each one changes what the code reads or sends and only Stripe can prove that. Until then this branch holds the diagnosis, the shape classifier it uses (`pipeline/upgrade-fallout.ts`), its script (`scripts/upgrade-fallout.mjs`) and the repair's acceptance tests as `it.todo` (`pipeline/upgrade-fallout.test.ts`).

## Problem

A rules' patch moves the API-version pin to `2026-09-30.endive` and upgrades stripe-node to 23.0.0. The new types drop fields and calls that older API versions removed, so code that the rules did not touch stops type-checking. Today either:

- the patch regresses and is not published, or
- the workflow retries without the move (`api-version-kept`, owner decision 1) and publishes a `[Needs review]` draft that leaves the old pin and the old stripe-node in place.

Lane B (`claude/stripe-type-repair-gate-6ad48e`) repairs only errors a type assertion fixes without changing the JavaScript. Everything else is a real behaviour change and belongs here.

## Diagnosis

### Runs used

The assigned before runs, 40624345477 (no AI) and 40624353088 (AI) at main `89f1c0ed`, were still queued on refit-dev/refit-bench when this was written, behind about 35 other runs. The diagnosis uses the newest finished l2-push-249 pair instead: [40591181316](https://github.com/refit-dev/refit-bench/actions/runs/40591181316) (no AI) and [40591190068](https://github.com/refit-dev/refit-bench/actions/runs/40591190068) (AI, $200 cap), both at Refit `63646f2a`. Lane B measured the same no-AI run. The two runs differ only in `kondax-com/Bocker`'s period reads, so the tables use the no-AI run. To repeat it on the assigned runs once they finish:

```bash
node scripts/upgrade-fallout.mjs <merged/results.json>
```

There are two sources, because the benchmark keeps the type oracle only for the report it publishes.

### Source A: the type oracle on the published patch (12 rows, 79 errors)

`workflow.typeOracle.patched.introduced` holds errors the final patched code has on stripe-node 23 that the original code did not have on its own stripe-node. A row whose patch upgraded stripe-node and regressed adds its `workflow.typeErrors.introduced`. Rows where the pin moved without the upgrade (`sdkUpgrade.skipped`) are another lane's failure and are left out.

| Rows | Errors | In JS | Lane         | Shape                     | Member                                           |
| ---: | -----: | ----: | ------------ | ------------------------- | ------------------------------------------------ |
|    4 |      6 |     1 | behaviour    | changed-type              |                                                  |
|    4 |      5 |     0 | request-rule | removed-request-parameter | `SessionCreateParams.payment_method_types`       |
|    3 |      7 |     6 | behaviour    | removed-field             | `Subscription.current_period_end`                |
|    3 |      5 |     1 | cascade      | cascade                   |                                                  |
|    3 |      4 |     4 | behaviour    | expandable-field          |                                                  |
|    2 |      2 |     0 | behaviour    | removed-method            | `InvoiceResource.retrieveUpcoming`               |
|    2 |      2 |     1 | behaviour    | arity                     |                                                  |
|    2 |      2 |     1 | behaviour    | removed-field             | `Subscription.current_period_start`              |
|    1 |      8 |     0 | behaviour    | removed-field             | `Subscription.discount`                          |
|    1 |      5 |     0 | behaviour    | removed-field             | `InvoiceLineItem.price`                          |
|    1 |      4 |     0 | request-rule | removed-request-parameter | `SubscriptionUpdateParams.coupon`                |
|    1 |      4 |     0 | type-only    | widened-enum              |                                                  |
|    1 |      4 |     4 | behaviour    | widened-null              |                                                  |
|    1 |      3 |     0 | behaviour    | request-options-in-params | `BalanceTransactionRetrieveParams.stripeAccount` |
|    1 |      2 |     0 | behaviour    | removed-field             | `Discount.coupon`                                |
|    1 |      2 |     0 | behaviour    | removed-type              | `UpcomingInvoice`                                |
|    1 |      2 |     0 | behaviour    | removed-field             | `Invoice.paid`                                   |
|    1 |      2 |     2 | api-version  | api-version-literal       |                                                  |
|    1 |      2 |     0 | behaviour    | removed-field             | `Invoice.subscription`                           |
|    1 |      2 |     0 | request-rule | removed-request-parameter | `PaymentIntentCreateParams.payment_method_types` |
|    1 |      2 |     0 | request-rule | removed-request-parameter | `SetupIntentCreateParams.payment_method_types`   |
|    1 |      1 |     0 | behaviour    | request-options-in-params | `EventRetrieveParams.stripeAccount`              |
|    1 |      1 |     0 | behaviour    | request-options-in-params | `ChargeRetrieveParams.stripeAccount`             |
|    1 |      1 |     0 | behaviour    | request-options-in-params | `PaymentIntentRetrieveParams.stripeAccount`      |
|    1 |      1 |     0 | behaviour    | removed-field             | `InvoiceLineItem.proration`                      |

"In JS" counts errors in JavaScript files. A Refit-generated type check reports those as advisory, so they never fail validation alone.

### Source B: the 12 `api-version-kept` rows

These rows are the clearest upgrade fallout: the patch with the move and the upgrade failed its checks, and the retry without them passed. The workflow keeps only the retry's report (`pipeline/workflow.ts`), so the failed attempt's errors are not in the artifacts. Recording them is build step 1.

They were reproduced locally on 2026-10-28:

- shallow clone at the benchmark commit;
- the row's published `migration.patch` (the rules' edits without the move) applied;
- stripe-node at the version range the repository declares, then at 23.0.0, with only `stripe` and `@types/node` installed and lifecycle scripts off;
- `tsc -p . --noEmit --skipLibCheck` with TypeScript 5.9.3 (Refit's TypeScript 6 rejects these repositories' older tsconfig options).

Errors only the second run reports are kept, compared by file, code and message. Missing dependencies give the same errors on both sides and drop out, but they can hide errors in code whose types collapse to `any`. These counts are therefore a lower bound, not the oracle's.

What stripe-node 23 still rejects after the rules' edits. A pin literal or a `payment_method_types` key is left out because the first attempt moves it.

| Row                                                                                         | Left on stripe-node 23                                                                                                     | Lane                                                                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 4NDR3S-01/TuSuerteEC                                                                        | `Subscription.current_period_*`, `Invoice.subscription` (twice), `Invoice.payment_intent`, `PaymentIntent.invoice` (twice) | behaviour                                                                                                |
| habibjutt/nextjs_boilerplate                                                                | `Invoice.payment_intent`                                                                                                   | behaviour                                                                                                |
| Alex-Unnippillil/share-house-portal                                                         | an `OtherString` status assignment                                                                                         | type-only (lane B)                                                                                       |
| brendansudol/punchlines-ai                                                                  | `Status`, `Price.Type` and `Interval \| null` assignments; one TS7053 index on `Type`                                      | type-only (lane B); the index is a lane B gap                                                            |
| different-ai/embedbase                                                                      | a `Status` assignment, an `OtherString` index, `subscription_data.trial_from_plan`                                         | type-only (lane B), request rule                                                                         |
| mrwebwork/spotify                                                                           | misspelled `event.type` literals (TS2678), an `OtherString` index, `trial_from_plan`                                       | existing stop, lane B gap, request rule                                                                  |
| ggallon/type-last                                                                           | a `next-auth` type error, not Stripe (missing dependency noise)                                                            | none                                                                                                     |
| Yosef-Ali/compasstio-ai, aabhiyann/talkifydocs, karljuhl/Club_Connect, omar99elnemr/Docubot | nothing beyond pins and `payment_method_types`                                                                             | none: the first attempt failed on something other than the type check, or on the rename's own conditions |
| Bizgojo/drivetimetales                                                                      | not measurable: a file that does not parse stops tsc before type errors (noted in AGENTS.md)                               | none                                                                                                     |

So of the 12 kept rows, 2 are behaviour fallout, 3 are lane B's, and 6 failed for reasons this lane cannot see from types.

### Ranked behaviour shapes and Stripe's documented replacement

All pages were read on 2026-10-28. stripe-node 18.0.0 removed the basil fields from the types, 19.x the clover ones, and 22.0.0 changed argument parsing.

| Rank | Shape                                                        |                                               Rows (A + B) | Lane B covers                   | Documented replacement                                                                                                                                                                                                                                                                             |
| ---: | ------------------------------------------------------------ | ---------------------------------------------------------: | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | `Subscription.current_period_start` / `_end`                 |                                    3 + 1 (1 in TypeScript) | no                              | `items.data[i].current_period_*`; the period is now per item. [basil changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end.md). Reviewed helper exists.                                                                                |
|    2 | Changed types (`LineItem[]`, `Decimal`, request body shapes) |                                                      4 + 0 | no                              | none: four different errors, each its own fix                                                                                                                                                                                                                                                      |
|    3 | Expandable or nullable values passed as plain ones           |                                                      3 + 0 | no                              | narrow the value (`typeof x === 'string' ? x : x.id`, a null check). All 8 errors are in JavaScript and advisory                                                                                                                                                                                   |
|    4 | `Invoice.payment_intent`, `PaymentIntent.invoice`            |                                                      0 + 2 | no                              | `invoice.payments` (expand `payments`); from a PaymentIntent, list `invoice_payments` filtered by `payment[payment_intent]`. One invoice can have several payments. [basil changelog](https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices.md) |
|    5 | `Invoice.subscription`                                       |                                                      1 + 1 | no                              | `invoice.parent.subscription_details.subscription` after checking `parent.type`. [basil changelog](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects.md). Reviewed helper exists.                                                                      |
|    6 | `invoices.retrieveUpcoming`, `Stripe.UpcomingInvoice`        |                                                      2 + 0 | no                              | `invoices.createPreview`; a customer-wide preview is no longer possible. [basil changelog](https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations.md). Mined rule exists                                                                                              |
|    7 | `accounts.retrieve()` with no id (TS2554)                    |                                                      2 + 0 | no                              | `accounts.retrieveCurrent()` or `retrieve(null)`. Read from the stripe-node 22.0.0 and 23.0.1 type declarations; no docs page states it                                                                                                                                                            |
|    8 | Request options inside params (`stripeAccount`)              |                                                      1 + 0 | no                              | move to the options argument: `retrieve(id, undefined, { stripeAccount })`. [stripe-node v22 migration guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22)                                                                                                                  |
|    9 | `Subscription.discount`                                      |                                                      1 + 0 | no                              | `subscription.discounts` (a list). [basil changelog](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-singular-coupon-promotion-code.md)                                                                                                                                               |
|   10 | `Discount.coupon`                                            |                                                      1 + 0 | no                              | `discount.source.coupon`, no longer expanded. [clover changelog](https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property.md)                                                                                                                                              |
|   11 | `InvoiceLineItem.price`, `.proration`                        |                                                      1 + 0 | no                              | `pricing.price_details.price` and `parent.subscription_item_details.proration`, after checking each `type`. [basil changelog](https://docs.stripe.com/changelog/basil/2025-03-31/invoice-pricing-configurations.md)                                                                                |
|   12 | `Invoice.paid`                                               |                                                      1 + 0 | no                              | no one-to-one field; `status === 'paid'` or the amounts. Same page as rank 4. Stays a stop                                                                                                                                                                                                         |
|    — | `Charge.dispute`                                             | 0 (seen on nicitaacom/19_spotify-clone without an upgrade) | no                              | none documented; removed in stripe-node 13.0.0 ([CHANGELOG](https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md)). Stays a stop                                                                                                                                                         |
|    — | Widened enums (`OtherString`, `Status`, `Type`, `Interval`)  |                                                      1 + 3 | **yes**, TS2322 and TS2345 only | lane B's assertion                                                                                                                                                                                                                                                                                 |

### Ceiling on l2-push-249

Seven rows have only behaviour shapes, lane B shapes or cascades among their TypeScript errors:

| Row                                       | Behaviour errors                                                             | Other blocker in run 40591181316                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| zainulabedeen123/Best-Saas-Kit--V2        | `Discount.coupon`                                                            | declared-type evidence only (`source-evidence`)                    |
| dubbl-org/dubbl                           | `stripeAccount` in params                                                    | 4 contract changes outside the rules                               |
| Drago-03/Neural-Nexus                     | `LineItem[]` changed type                                                    | 10 traced calls with unresolved changes                            |
| ReeceHarding/firebase-next.js-boilerplate | `retrieveUpcoming`, `UpcomingInvoice`, `Invoice.paid`, `accounts.retrieve()` | customer-wide preview stop; `Invoice.paid` stays a stop            |
| LouisMbc/twitter-like                     | a cascade (`unknown` to `object`)                                            | the declared SDK version conflicts with the pin                    |
| 4NDR3S-01/TuSuerteEC                      | periods, `Invoice.subscription`, invoice payments                            | `source-evidence`, contract changes                                |
| habibjutt/nextjs_boilerplate              | `Invoice.payment_intent`                                                     | webhook API version, a removed request parameter, contract changes |

Every one also stops for something no type repair touches. So this lane alone moves **no l2-push-249 row to validated**.

What it can do is turn 5 rows that end as kept-but-unpublished regressions into `[Needs review]` drafts that include the upgrade: Best-Saas-Kit, dubbl, Neural-Nexus, firebase-next.js-boilerplate and twitter-like. It can also add the upgrade to the 2 `api-version-kept` drafts. Those rows validate only when lane T grants grade A and the other lanes clear their remaining stops. The other `api-version-kept` rows failed for reasons a type check cannot see, and the 3 JavaScript-only rows (Shiori-v1, PopIn, arcana-marketplace) already pass with advisory errors.

Not covered here, and why:

- **Removed request parameters**, such as `payment_method_types`, `SubscriptionUpdateParams.coupon` and `subscription_data.trial_from_plan`. The request rules own them (`pipeline/request-migration.ts`, owner decision 4), and AGENTS.md says a removed request parameter is never an AI target.
- **API-version literals** the patch did not move, such as ArkanaDeck/arcana-marketplace's JavaScript pins. The API-version rules own them.
- **Widened enums** (`OtherString`, `Subscription.Status`). Lane B owns them. Its gate covers TS2322 and TS2345 only, so the TS2538 and TS7053 index errors on `OtherString` (embedbase, mrwebwork/spotify, punchlines-ai) are a gap for lane B, not this lane.
- **Pins moved without the stripe-node upgrade** (Panda2Chan/ai-asmr, saidMounaim/tick-event, liamstamper/lamp-bot and others in `workflow.typeErrors`). Those are dependency-upgrade failures.

## Design

### Two tiers, deterministic first

AGENTS.md prefers deterministic, reviewed rules and keeps AI as a bounded assistant, so the repair has two tiers.

**Tier 1: reviewed helpers at oracle-located sites.** Refit already generates helpers that read the old field when a payload has it and the new location otherwise (`pipeline/stripe-subscription-periods.ts`):

- `getSubscriptionPeriodStart` and `getSubscriptionPeriodEnd`. They use the items' period when every item shares one, and otherwise return `undefined`, or the configured plan item.
- `getInvoiceSubscription`
- `getInvoicePriceId`
- `getCouponId`

Today they apply only to reads the tracer follows. The type oracle's unpatched run names every read the upgrade broke, at its position, and TypeScript's checker resolves the receiver's type there.

Tier 1 applies the same helper where both of these hold:

- the oracle reports the removed field on that member;
- the checker resolves the receiver to a type declared in the `stripe` package, never a local, `any` or unresolved type. This is the inverse of `localReceiverReads` in `pipeline/stripe-type-evidence.ts`.

The edit is the rule's own edit. It is limited to the statement holding the error and goes through the existing helper-module generation. This widens where a reviewed rule applies, so it needs a founder decision, recorded with its evidence. Until that decision it is held to the tier 2 gate below.

**Tier 2: AI repair, held to the documented replacement.** For shapes with no helper, `validateMigration`'s repair round asks the model to fix only the introduced errors of tier-2 shapes:

- `Invoice.payment_intent` and `PaymentIntent.invoice`
- `InvoiceLineItem.price` and `InvoiceLineItem.proration`
- `Subscription.discount` and `Discount.coupon`
- `retrieveUpcoming` → `createPreview`, where the mined rule stopped
- request options in params
- `accounts.retrieve()` with no id

Each error is passed with its shape's documented replacement from the table above. The rules' lines stay frozen, as the coverage AI does today.

The repair is kept only if every condition holds:

1. **Scope.** Every changed range sits inside one statement that holds an error the oracle attributes to the upgrade. This is lane B's statement check from `typeOnlyRepairFailures`, without its same-JavaScript condition.
2. **Documented replacement.** Each changed statement reads or sends the shape's new location: for example `parent.subscription_details.subscription`, `items.data`, `pricing.price_details.price`, `discounts` or `source.coupon`, or it moves a request option into the call's options argument. A statement that reads anything else is refused. The substitution guard (`docs/AI-PATCH-GUARD.md`) applies unchanged, so an old field may not stand in for the removed one.
3. **No owned shapes.** It drops or rewrites no removed request parameter, API-version literal or widened enum. The existing guards (`droppedRequestParameters` and the rule-line freeze) already refuse those.
4. **Existing stops stay.** Customer-wide `createPreview` (Stripe now requires `subscription`, `schedule` or items), `Invoice.paid` (no one-to-one field; the page offers `status === 'paid'` and amounts) and `Charge.dispute` (no documented replacement) stop for review.

### What counts as validated

A repair from either tier changes behaviour, so it publishes as validated only when every check holds:

- the type oracle shows zero new errors on the repaired code (`typeOraclePasses`);
- the repository's own checks pass in offline Docker;
- lane T's behaviour tests reach every changed line, and pass on the original code at the old version and on the repaired code at endive against Stripe test mode, with no error Stripe returns only on the patched side (grade A, `pipeline/check-selection.ts`).

Anything less ships `[Needs review]` with the AI-written lines marked (decision 8), naming the shape, the documented page and what Stripe did not prove. This includes:

- a repair that passes its checks and the type check, which is not proof of behaviour;
- a behaviour test that failed on the original code and was dropped;
- a changed line in a webhook handler no test reached;
- an error Stripe returned on the patched side only.

The D2 gate (`aiValidationGate`) is unchanged for every other AI patch. D2a's type-check stand-in never applies here, because every shape in this lane is a behavioural change.

### Build order (after lane T merges)

1. Keep the failed first attempt's introduced errors and type oracle on an `api-version-kept` report (`validation.keptApiVersion.attempt`), so the benchmark measures source B without a local reproduction.
2. Tier 1 helpers at oracle-located sites, behind the founder decision.
3. Tier 2 shape prompts with the documented replacements, and the scope and replacement checks.
4. Wire grade A from lane T into the validated decision for these repairs.
5. Measure on l2-push-249, then heldout-30, as the Agent 4 prompt says. Record in `docs/AI-PATCH-GUARD.md`, `docs/BENCHMARKS.md` and `docs/READINESS.md`.

### Acceptance tests

The `it.todo` cases in `pipeline/upgrade-fallout.test.ts`, each with a fixture taken from the rows above:

- scope: an edit outside the errored statements is refused;
- replacement: an edit that reads anything but the documented location is refused;
- owned shapes: request parameters, API-version literals and widened enums are never targets;
- validated only with zero new oracle errors, passing checks and grade A;
- **a behaviour repair that passes its checks without Stripe's proof stays `[Needs review]`**;
- a behaviour test failing on the original code, or an error Stripe returns on the patched side only, keeps `[Needs review]`;
- a changed webhook line no test reaches stops;
- the first attempt's errors are recorded on an `api-version-kept` report.

## Decisions taken here, and why

- **Diagnosed from 40591181316 and 40591190068, not the assigned runs.** The assigned runs had not started. These are the newest finished l2-push-249 runs, and lane B used the same no-AI run, so both lanes count the same errors. The script reruns on the assigned runs unchanged.
- **Reproduced the 12 kept rows locally rather than waiting for build step 1.** They hold most of the fallout, and the artifacts lack their errors. Without the reproduction the ranking would rest on 12 rows, half of them JavaScript advisories.
- **Deterministic tier first.** AGENTS.md prefers reviewed rules, and the top shape by far (subscription periods) already has a reviewed helper. The AI tier handles only what no helper covers.
- **Tier 1 still waits for proof.** Applying a helper where the tracer did not follow the read widens a reviewed rule, so it needs a founder decision. Until then it is held to the same grade A gate as the AI.
- **No repair code before lane T.** The brief says so, and without lane T every repair here would ship `[Needs review]` and change no benchmark row.
