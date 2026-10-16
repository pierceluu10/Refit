# Stripe `payment_method_types` in endive: proposed policy

**Status: proposal for owner approval.** Until it is approved, the 2026-10-16 decision stands: every traced call that still sends `payment_method_types` stops for review, and Refit adds no automatic replacement.

## The change

`2026-09-30.endive` removed `payment_method_types` from three request bodies:

- `POST /v1/checkout/sessions`
- `POST /v1/payment_intents`
- `POST /v1/setup_intents`

The closest remaining parameter is `allowed_payment_method_types`, and the contracts define the two differently:

| | `payment_method_types` (dahlia and earlier) | `allowed_payment_method_types` (endive) |
|---|---|---|
| Meaning | An explicit static list: offer exactly these methods. | A filter. Offer only methods that are **both** dynamically eligible and in the list. |
| What decides eligibility | The list itself. A method that is not activated or not compatible makes the request fail. | The Dashboard or payment method configuration, plus compatibility with currency, amount, mode and, for Checkout, the customer. |
| Checkout Sessions | Existed | New in endive |
| PaymentIntents, SetupIntents | Existed | Already existed in dahlia |

Dropping the parameter is the other option. Without a list, Stripe offers whatever the account enables in the Dashboard.

## What real code sends

Every call site that still sends the parameter was collected from the 193 benchmark repositories that stop on it: 148 fresh, 27 original and 18 held out. Per-site data is in [`2026-10-16-payment-method-types-sites.json`](benchmarks/2026-10-16-payment-method-types-sites.json).

| Case | Call sites | Repositories where it is the only case |
|---|---|---|
| A. Exactly `['card']` (186 Checkout, 6 PaymentIntent, 2 SetupIntent) | **194 (87%)** | **167 (87%)** |
| B. `card` plus other methods (`paypal` 20, `us_bank_account` 4, `link` 2, `cashapp`, `boleto`, `blik`+`p24`) | 27 | 24 (1 more mixes A and B) |
| C. Terminal `['card_present']` (PaymentIntent) | 1 | 1 |

There are 222 call sites in 193 repositories. Every value is a literal array; none is computed at runtime. None of these calls also sets `automatic_payment_methods`, `payment_method_configuration` or `excluded_payment_method_types`. Of the case A Checkout calls, 121 use `mode: 'subscription'`, 62 use `mode: 'payment'` and 3 compute the mode. All calls are in application code, none in tests.

## Proposal

### Case A: replace `['card']` with `allowed_payment_method_types: ['card']` (recommended: approve)

Refit would rename the property and keep the value. It would apply this only when all of these hold:

- The value is exactly the literal `['card']`, on one of the three operations, in a traced SDK call.
- The same patch moves the `apiVersion` pin to endive. For a TypeScript project, the patch must also upgrade `stripe` to a release whose types have the new property (23.0.0 or later). Otherwise, as in pnpm projects today, the call keeps stopping.
- No other stop applies to the repository. A stop for webhooks, skipped files, declared types or other removed parameters still stops the run.

The draft PR would state, in its "please check" section, that the account must keep cards enabled in the Dashboard or payment method configuration.

| For | Against |
|---|---|
| Customers still see only cards, so no new payment method appears. Async methods (bank debits, vouchers) cannot arrive, so fulfillment that runs on `checkout.session.completed` without checking `payment_status` stays safe. | If an account has turned cards off in the Dashboard, the filter leaves nothing to offer. Before, the static list kept offering cards. This is rare, but it fails visibly at checkout, not at review. |
| It unblocks the most repositories: 167 of 193 stop only on case A sites. | Whether wallets and Link look the same under the filter cannot be checked offline. Refit makes no live calls, and `stripe-mock` only checks that the request is accepted. |
| It is deterministic, and its scope is one exact value. | Earlier, the AI made the same rename and Refit rejected it. That rejection was right for an unreviewed edit applied to any value. This policy is narrower and owner-approved, and the PR discloses it. |

### Case B: card plus other methods (recommended: keep stopping)

The same rename would keep the methods listed. But dynamic eligibility can hide a listed method for some customers: PayPal, Cash App, BLIK, P24 and Boleto depend on the buyer's country, currency, amount and device. The static list showed them whenever the session was created. A merchant who lists PayPal by name relies on it being offered, so a silent change in which methods buyers see is a product decision.

| For automating | Against |
|---|---|
| Unblocks 24 more repositories, and 1 that mixes both cases. | Can quietly remove a payment option the merchant chose. |
| Valid calls already proved these methods are activated and compatible. | Filtering by buyer is invisible in tests, typecheck and `stripe-mock`. |

Optional middle ground: rename case B too, but list it under "please check" with each method that may now be filtered. I recommend keeping the stop until a customer asks for it.

### Case C: Terminal `card_present` (recommended: keep stopping)

In-person payments depend on reader and location configuration that offline validation cannot see. 1 repository.

### Dropping the parameter (recommended: reject as automatic)

Dropping it lets the Dashboard decide, which can add Link, wallets, BNPL and async bank methods. Apps that grant access on `checkout.session.completed` without checking `payment_status` would then fulfill unpaid async payments. Of the 164 stopped repositories that handle `checkout.session.completed`, only 20 mention `payment_status` anywhere. Refit would offer this only as a review suggestion, never as an edit.

## If approved

1. **Rule.** Add a deterministic Stripe rule next to `pipeline/request-removals.ts` for case A on the three operations. The generic request-rename rule cannot be used: it handles JSON request bodies and has no value condition, and Stripe uses form bodies.
2. **Gates.** Apply it only together with the endive `apiVersion` bump, and for TypeScript, the SDK upgrade. Every other value keeps the current stop.
3. **Tests.** Cover each value class above, mixed files (case A and case B in one repository still stop), and the PR disclosure text.
4. **Benchmark.** Rerun the 531 Stripe repositories and report how many of the 167 reach validation and how many validate. Others will still stop on webhook gates, preparation or checks.
5. **Records.** Record the new owner decision in `AGENTS.md`, and update [request migrations](REQUEST-MIGRATIONS.md) and readiness.

Estimated effort: about half a day including tests, plus a 25-minute benchmark rerun.
