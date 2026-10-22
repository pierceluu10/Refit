# Stripe `payment_method_types` in endive: proposed policy

**Status: approved by the owner on 2026-10-16 and implemented for case A only.** Cases B and C keep stopping for review, and Refit never drops the parameter. A per-repository opt-in for case B was [approved by the owner on 2026-10-21](#approved-2026-10-21-a-repository-opt-in-for-case-b).

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

### Case A: replace `['card']` with `allowed_payment_method_types: ['card']` (approved)

Refit would rename the property and keep the value. It would apply this only when all of these hold:

- The value is exactly the literal `['card']`, on one of the three operations, in a traced SDK call.
- The same patch moves the API version to endive: the literal `apiVersion` pin, or, when no client sets `apiVersion` at all, the stripe-node upgrade itself, because stripe-node 12 and later sends the API version its release pins. `apiVersion: null` (the account default), a dynamic option and `setApiVersion` never count, and one such client anywhere in the repository keeps every call stopping, because Refit cannot tell which client sends which request. For a TypeScript project, the patch must also upgrade `stripe` to a release whose types have the new property (23.0.0 or later). Otherwise, as in pnpm projects today, the call keeps stopping.
- No other stop applies to the repository. A stop for webhooks, skipped files, declared types or other removed parameters still stops the run.

The draft PR would state, in its "please check" section, that the account must keep cards enabled in the Dashboard or payment method configuration.

| For | Against |
|---|---|
| Customers still see only cards, so no new payment method appears. Async methods (bank debits, vouchers) cannot arrive, so fulfillment that runs on `checkout.session.completed` without checking `payment_status` stays safe. | If an account has turned cards off in the Dashboard, the filter leaves nothing to offer. Before, the static list kept offering cards. This is rare, but it fails visibly at checkout, not at review. |
| It unblocks the most repositories: 167 of 193 stop only on case A sites. | Whether wallets and Link look the same under the filter cannot be checked offline. Refit makes no live calls, and `stripe-mock` only checks that the request is accepted. |
| It is deterministic, and its scope is one exact value. | Earlier, the AI made the same rename and Refit rejected it. That rejection was right for an unreviewed edit applied to any value. This policy is narrower and owner-approved, and the PR discloses it. |

### Case B: card plus other methods (decided: keep stopping)

The same rename would keep the methods listed. But dynamic eligibility can hide a listed method for some customers: PayPal, Cash App, BLIK, P24 and Boleto depend on the buyer's country, currency, amount and device. The static list showed them whenever the session was created. A merchant who lists PayPal by name relies on it being offered, so a silent change in which methods buyers see is a product decision.

| For automating | Against |
|---|---|
| Unblocks 24 more repositories, and 1 that mixes both cases. | Can quietly remove a payment option the merchant chose. |
| Valid calls already proved these methods are activated and compatible. | Filtering by buyer is invisible in tests, typecheck and `stripe-mock`. |

Optional middle ground: rename case B too, but list it under "please check" with each method that may now be filtered. I recommend keeping the stop until a customer asks for it.

#### Approved 2026-10-21: a repository opt-in for case B

Proposed 2026-10-17; approved by the owner on 2026-10-21 as written below. Benchmarks simulate a repository's opt-in with `--keep-listed-payment-methods`.

The default stays the decision above. A repository whose owner wants the middle ground asks for it in `.refit.json`:

```json
{ "stripePaymentMethodTypes": "keep-listed" }
```

Only the string `"keep-listed"` is accepted; any other value is a configuration error. With the opt-in, a literal list of distinct string methods that includes `card`, but not `card_present`, moves to `allowed_payment_method_types` with the same methods. Every case A gate applies unchanged: a confirmed traced call on one of the three operations, the endive pin moved in the same patch, the stripe-node upgrade for TypeScript, and no other stop. Case C, computed lists, spreads, duplicates and lists without `card` keep stopping. The patch warning and the draft PR name each non-card method and say it may no longer be offered to some buyers, by country, currency, amount or device. Refit still never drops the parameter or merges.

In the 82 benchmark repositories still stopped on this parameter at `7238e46`, a source scan of the pinned clones found literal case B lists in 25: `['card', 'paypal']` in 19, and one each of `card` with `link`, `link`+`paypal`, `cashapp`, `us_bank_account`, `paypal`+`us_bank_account` and `boleto`. One repository sends `card_present` and one a computed value. The other 56 send only `['card']` and stop for other reasons: no literal pin, an SDK that could not be upgraded, or a call site Refit did not trace.

### Case C: Terminal `card_present` (decided: keep stopping)

In-person payments depend on reader and location configuration that offline validation cannot see. 1 repository.

### Dropping the parameter (decided: never automatic)

Dropping it lets the Dashboard decide, which can add Link, wallets, BNPL and async bank methods. Apps that grant access on `checkout.session.completed` without checking `payment_status` would then fulfill unpaid async payments. Of the 164 stopped repositories that handle `checkout.session.completed`, only 20 mention `payment_status` anywhere. Refit would offer this only as a review suggestion, never as an edit.

## Implementation

- **Rule.** `removedRequestParameters` (`pipeline/request-removals.ts`) marks the removal as having a reviewed replacement only for Stripe, only on the three operations, and only when the target contract has `allowed_payment_method_types`. The analyzer emits a rename edit only when the traced call is confirmed and the value is exactly an array literal holding the string `'card'`. `['card'] as const`, computed lists and every other value get no edit.
- **Gates.** `runPipeline` keeps the edit only when the same patch moves a literal `apiVersion` to the target, or every traced client omits the option (no request override, no `setApiVersion`), so the package upgrade moves the version. Any client or request whose version Refit cannot resolve (dynamic, `null` or unsafe to trace) drops the edit. When a patch is generated for a TypeScript project, or any client omits the option, the stripe-node upgrade must also succeed; that needs a root npm, pnpm v9 or Yarn 1 lockfile ([supported projects](DEPENDENCIES.md#stripe-node-upgrade-in-a-patch)). Otherwise the edit is dropped and the run stops for review as before. Validation's preflight and plain scans request no patch, so they check only the pin; the patch run then enforces the upgrade. A run still stops when any other site sends a value the rule does not cover.
- **Disclosure.** The proposal carries a warning, and the draft PR lists the removed request field under breaking changes. A review line asks the reviewer to confirm cards stay enabled in the Dashboard or payment method configuration.
- **Tests.** `pipeline/request-removals.test.ts` covers each value class, quoted keys and an unconfirmed client. `pipeline/card-payment-methods.test.ts` covers the end-to-end gates: no pin, a mixed card and PayPal repository, a TypeScript project without an upgradable package, and the PR text.

## Results (Refit `6d02116`, October 16)

All three Stripe sets were rerun from a pinned worktree with the full pipeline, and every repository was measured. Docker was shut down partway through the fresh set; the 48 fresh repositories it had not reached were validated after a restart, at the same commit.

**Validated fixes: 10 → 53** on the same 531 repositories. `YunmeiYe/nextjs-ai-platform` counts as validated: it hit a dependency-cache lock held by a concurrent run of the same repositories, and validated when rerun alone at `6d02116`, the same commit as the other 380 fresh results.

| | Original 100 | Held-out 50 | Fresh 381 |
|---|---|---|---|
| Validated before the policy | 4 | 1 | 5 |
| **Validated with the policy** | **11** | **7** | **35** |
| Stopped on `payment_method_types` before | 27 | 18 | 148 |
| … still stopped (case B or C, no literal pin, or a TypeScript project whose SDK cannot be upgraded) | 12 | 8 | 69 |
| … now validated | 7 | 6 | 30 |
| … patch proposed, then refused by validation preparation (lockfile, archive size, pnpm settings) | 4 | 4 | 35 |
| … validation regression: other type errors after the stripe-node 23 upgrade, caught and not proposed | 4 | 0 | 6 |
| … other (baseline failing, review stop, no checks) | 0 | 0 | 8 |

- **Every one of the 43 validated card-rule fixes was checked against its diff.** Each renames only the key on an exact `['card']` literal and moves the pin to `2026-09-30.endive`. Every TypeScript fix upgrades stripe-node to 23.0.0. The three JavaScript ones keep their package, as the gate allows.
- **Three were also read in full by hand:** `pra9711/lexinote`, `sudeepmahato16/airbnb-clone` and `mahin67580/FoodieFrog`. In lexinote, only the invoice branch's `session.subscription` read moved.
- **Evidence.** For 40 of the 43, `tsc` passed with no new errors, 17 of them with generated `stripe-mock` checks as well. The other 3 have no checks of their own, so only the generated `stripe-mock` checks ran.
- **No other outcome changed.** Every repository that was not stopped on `payment_method_types` has the same outcome as before, and no previously validated fix was lost.
- **The rerun found one bug, fixed with a test before these numbers.** Validation's preflight requests no patch, so it had dropped the rename and refused 29 patches the run had proposed.
