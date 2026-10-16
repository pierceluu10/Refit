# Stripe ground truth

`2026-10-14-stripe-labels.json` is the answer key for the [Stripe benchmark](../STRIPE-BENCHMARK.md). It covers all 100 benchmark repositories. For each one it gives a verdict (`broken` or `unaffected`) for the upgrade from the repository's API version to `2026-09-30.endive`, and it labels the evidence:

- every read of a property name that some Stripe object loses (`reads`);
- every request parameter the code still sends that the new contract no longer accepts (`requests`).

Labelled by Claude (an AI assistant) with the tooling below; a human spot-check of a sample is recommended.

## Sets

A seeded shuffle of the 100 benchmark repositories (seed `20261014`) gives:

- **30 labelled** repositories, used to score and tune Refit;
- **20 held-out** repositories, not to be inspected while tuning;
- **50 others.**

The split is stored as `labelled` and `heldOut` in the labels file. The first labelling (2026-10-14) covered only the 30. The 2026-10-16 pass added the other 70 and request parameters for all 100. It kept every read label from the first pass; the oracle found no breaking read that the first pass had missed.

## Verdicts

| Verdict      | Meaning                                                                             | Repositories               |
| ------------ | ----------------------------------------------------------------------------------- | -------------------------- |
| `broken`     | At least one breaking read or removed request parameter                             | 58 (15 of the labelled 30) |
| `unaffected` | Every read of a removed property name and every request is decided, and none breaks | 42 (15 of the labelled 30) |
| `undecided`  | The oracle and the hand check could not decide; scoring skips it                    | 0                          |

29 repositories are broken only by request parameters, almost all `payment_method_types` on Checkout Session, PaymentIntent and SetupIntent creation. The parameter is gone from the `endive` request schemas.

## Read labels

| Label               | Meaning                                                                                        | Count                       |
| ------------------- | ---------------------------------------------------------------------------------------------- | --------------------------- |
| `breaking`          | The receiver is a Stripe API object, and this field is removed from that object by the upgrade | 86 reads in 29 repositories |
| `stripe-unaffected` | A Stripe object whose field still exists, for example `event.type` or `price.unit_amount`      | 394                         |
| `not-stripe`        | Not a Stripe object: the app's own models, configuration, UI or another provider               | 4,171                       |
| `excluded`          | Ambiguous, or a hand-written fake Stripe in tests (`tests/stripe-mock.js`); ignored by scoring | 48                          |
| `unknown`           | Unresolved, and left so because the repository is already broken elsewhere; ignored by scoring | 121                         |

Each read records `source`:

1. **`oracle`:** TypeScript's checker, run over the repository with the exact `stripe` package type definitions it uses (`pipeline/stripe-ground-truth.ts`, `npm run benchmark:stripe-labels`). The version is the lockfile's, else the declared minimum. The checker resolves receivers such as `Stripe.Subscription`. Class names map to schemas through `x-stripeResource` in Stripe's SDK spec. Each file is checked against its nearest `tsconfig.json`. It reads both type layouts: the ambient `declare module 'stripe'` of stripe-node ≤ 21, including the per-version `types/<api>/` folders of v10 and v11, and the per-resource modules of v22. The oracle decided 85 of the 86 breaking reads. It shares no code with Refit's analyzer.
2. **`rule-no-stripe-in-file`:** unresolved reads in files that never mention Stripe are `not-stripe`. Checked: all 152 such reads of distinctive Stripe field names (`current_period_end`, `payment_intent`, `subscription`, …) in the labelled 30 were app models, another provider (Polar) or Stripe objects whose field still exists.
3. **`rule-event-type`:** `event.type` (and `evt`, `e`, …) is `stripe-unaffected`, because Stripe events keep `type`.
4. **`rule-app-config`:** reads on `config…`/`plan` values loaded from app configuration are `not-stripe`.
5. **`manual`:** the rest, decided by reading the code. The repository's `notes` record what was checked:
   - `pretzelai/lumen` is a billing platform with its own invoice and subscription models (`not-stripe`);
   - one real break in `vue-stripe-subscriptions`: `subscription.latest_invoice.payment_intent`;
   - Stripe objects whose field still exists: Checkout Session `payment_intent` and `subscription`, `products.list` names, price `unit_amount`, `CustomerCreateParams`;
   - database rows, forms and app objects (`not-stripe`);
   - the test fake and two ambiguous groups (`excluded`).

### Disputed reads

Ten reads carry `disputed` (STRIPE-PLAN open decision 1), six of them in the labelled 30. Each is `session.subscription` inside `if (event.type === 'invoice.payment_succeeded')`, where `session` is `event.data.object as Stripe.Checkout.Session`. At runtime the object is an Invoice, and `invoice.subscription` is removed, so these are likely real breaks. The oracle followed the cast. They keep the `stripe-unaffected` label until a human decides. No verdict depends on them: all ten repositories are broken by other evidence.

## Request labels

Request parameters are `breaking` when the before contract's request schema declares them and the `endive` schema does not. Nested objects and arrays are followed (`subscription_data.trial_from_plan`).

- **`oracle`** (42): the object literal's contextual type is a stripe-node parameter type. The type `Checkout.SessionCreateParams` maps to `POST /v1/checkout/sessions` through `x-stripeOperations`. The literal may be passed directly, or as a `const` passed by name.
- **`manual`** (54, in 12 repositories): untyped clients, such as `require('stripe')(key)` or `any`. Here the removed parameter names on checkout, subscription, customer, portal and payment-link operations were grepped in files that mention Stripe, and every hit was read. Each one sends `payment_method_types` to `checkout.sessions.create` or `paymentIntents.create`.

## Scoring

`npm run benchmark:stripe-score -- --results <results.json> --labels docs/benchmarks/2026-10-14-stripe-labels.json [--verbose]` matches benchmark findings by file, line and property:

- **recall** is labelled breaking reads that Refit reports;
- **precision** is reported reads, excluding `excluded` and `unknown`, that are labelled breaking.

It scores confirmed findings, and any finding including review.

It also scores each repository's **outcome** (`--verbose` prints each one with its reason):

- **correct:** a broken repository whose validated fix changes every breaking line (a line removed and not added back unchanged), or an unaffected repository with no proposed patch;
- **correct-review:** a broken repository that stops for review, or as a `[Needs review]` patch, with findings that name every breaking read and request parameter;
- **incorrect:** everything else, with the reason: a workflow error or failed validation, a validated fix that leaves a break unchanged, a stop that misses a break, or a patch for an unaffected repository.

The strict score counts `correct`; the lenient score adds `correct-review`. The full diff is read from `<results dir>/repos/<owner__repo>/run/report.json` when present.

On `baseline-failures-2026-10-15/out-final` (2026-10-16):

- strict: **50/100**, lenient: **55/100**;
- correct: all 42 unaffected repositories, and 8 validated fixes;
- incorrect (45): 34 stops whose findings do not name a breaking `payment_method_types` (Refit reports no request-parameter findings), 8 workflow errors (sandbox and dependency preparation), 2 failed validations, and `get-convex/convex-saas`, whose validated diff re-adds `payment_method_types` unchanged.
