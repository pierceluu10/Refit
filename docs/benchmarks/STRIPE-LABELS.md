# Stripe ground truth

`2026-10-14-stripe-labels.json` is the answer key for the [Stripe benchmark](../STRIPE-BENCHMARK.md). It labels every read, in 30 repositories, of a property name that some Stripe object loses between the repository's API version and `2026-09-30.endive`. Labelled by Claude (an AI assistant) with the tooling below; a human spot-check of a sample is recommended.

## Sets

A seeded shuffle of the 100 benchmark repositories (seed `20261014`) gives:
- **30 labelled** repositories, used to score and tune Refit;
- **20 held-out** repositories, not to be inspected while tuning;
- **50 others.**

The split is stored as `labelled` and `heldOut` in the labels file.

## Labels

| Label | Meaning | Count |
|---|---|---|
| `breaking` | The receiver is a Stripe API object, and this field is removed from that object by the upgrade | 40 reads in 11 repositories |
| `stripe-unaffected` | A Stripe object whose field still exists, for example `event.type` or `price.unit_amount` | 210 |
| `not-stripe` | Not a Stripe object: the app's own models, configuration, UI or another provider | 2,783 |
| `excluded` | Ambiguous, or a hand-written fake Stripe in tests (`tests/stripe-mock.js`); ignored by scoring | 48 |

Each read records `source`:

1. **`oracle`:** TypeScript's checker, run over the repository with the exact `stripe` package type definitions its lockfile or `package.json` uses (`pipeline/stripe-ground-truth.ts`, `npm run benchmark:stripe-labels`). It resolves receivers such as `Stripe.Subscription`. Class names map to schemas through `x-stripeResource` in Stripe's SDK spec. Each file is checked against its nearest `tsconfig.json`. It decided 1,222 reads, including 39 of the 40 breaking ones. It shares no code with Refit's analyzer.
2. **`rule-no-stripe-in-file`:** unresolved reads in files that never mention Stripe are `not-stripe`. Checked: all 152 such reads of distinctive Stripe field names (`current_period_end`, `payment_intent`, `subscription`, …) were app models, another provider (Polar) or Stripe objects whose field still exists.
3. **`rule-event-type`:** `event.type` (and `evt`, `e`, …) is `stripe-unaffected`, because Stripe events keep `type`.
4. **`rule-app-config`:** reads on `config…`/`plan` values loaded from app configuration are `not-stripe`.
5. **`manual`:** the remaining 97 groups of reads, grouped by receiver and file, decided by reading the code:
   - `pretzelai/lumen` is a billing platform with its own invoice and subscription models (`not-stripe`);
   - one real break in `vue-stripe-subscriptions`: `subscription.latest_invoice.payment_intent`;
   - Stripe objects whose field still exists: Checkout Session `payment_intent` and `subscription`, `products.list` names, price `unit_amount`, `CustomerCreateParams`;
   - database rows and app objects (`not-stripe`);
   - the test fake and two ambiguous groups (`excluded`).

## Scoring

`npm run benchmark:stripe-score -- --results <results.json> --labels docs/benchmarks/2026-10-14-stripe-labels.json` matches benchmark findings by file, line and property:
- **recall** is labelled breaking reads that Refit reports;
- **precision** is reported reads, excluding `excluded`, that are labelled breaking.

It scores confirmed findings, and any finding including review.
