# Stripe subscription periods selected by price

Refit can propose a deterministic migration for a narrow signed-webhook handler when its reviewed adapter explicitly selects a Stripe price ID. This is the first automatic subscription-period policy. Other webhook changes continue to require review.

Stripe [moved subscription periods onto individual items in 2025-03-31.basil](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end). Several items may have different periods. Selecting one by price is an application decision, not a conclusion Refit draws from the API diff.

## Every period read: the generated helper

Refit rewrites every `current_period_start/end` read on SDK responses, signed webhook payloads and `Stripe.Subscription`-typed values into a call to a generated helper. When one file calls the helpers, Refit writes the ones it uses into that file after its imports (or, without imports, after a shebang and the file's leading pragmas), so the patch adds no module and no import. When two or more files call them, it writes one module per repository (`stripeSubscriptionPeriod.ts` or `.js`, in the deepest folder the patched files share) and imports it in each file:

```ts
getSubscriptionPeriodEnd(subscription, (items) => items[0]);
```

The helper returns, in order:

1. the subscription-level field, when the event was rendered in an old API version;
2. the period every item shares (one item, or all items equal), which covers almost every real subscription;
3. for the rare subscription whose items have different periods, the period of the item the application already treats as its plan. Refit decides this at patch time: a `price.id` comparison on a subscription item, or a fixed `items.data[N]` index, in the same function, else in the same file. Without such code, the configured `stripeSubscriptionPeriods` price is used.

If neither exists, step 3 returns `undefined` and the pull request says: "Subscriptions with items on different billing periods are not handled. Set `stripeSubscriptionPeriods` to choose which item counts." Missing or empty items return `undefined`, as the removed field did, so existing missing-period checks still fire. Refit never picks an earliest or latest period across items.

Each migrated finding records `subscriptionPeriod.rareCase`: `item-in-code`, `price-policy` or `flagged`. The helpers written are only the ones the patch calls. A file that already uses one of the helpers' private names, or declares a global they read (`Array`, `Reflect`, `Set`, `NonNullable`), gets the module instead. Inlined helpers have one cost: their type errors carry the calling file's path, so a compared type check, which counts errors by file, code and message, does not flag a helper error whose code and message match an error that file already had. A separate module's errors always count as new. Imports follow each file's module style, line endings and existing relative-import extensions, or `tsconfig` Node16/NodeNext resolution. Where a configured policy's guarded handler applies (below), that migration takes precedence over the helper.

A read on one parenthesized cast of a traced receiver also moves, for every helper: `(subscription as any).current_period_end` becomes `(getSubscriptionPeriodEnd(subscription as any) as any)`, keeping the read typed `any`, and a typed cast such as `(invoice as Stripe.Invoice)` passes through as written. Double casts, a non-null assertion after a cast, a cast call result and `typeof`-guarded cast reads stay under review.

## Invoice subscription reads

Stripe [moved `invoice.subscription` to `invoice.parent.subscription_details.subscription`](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects) in the same release. The generated helpers also include `getInvoiceSubscription(invoice)`, and Refit rewrites `invoice.subscription` reads on the same sources (SDK responses, signed webhook payloads, `Stripe.Invoice`-typed values) to call it. It returns the old field when the payload has it, including `null`, otherwise the new location, otherwise `null`. Under TypeScript, the return type matches the old field with old `stripe` types and the new location with new ones.

Refit leaves the read for review when the code expands `subscription` anywhere, because the expand path moved too, or when the adapter configures its own `propertyMoves` entry for it.

## Invoice price ID reads

Stripe [replaced the `price` object on invoice line items and invoice items](https://docs.stripe.com/changelog/basil/2025-03-31/invoice-pricing-configurations) with `pricing`: "Instead of `invoice_item.price.id`, use `invoice_item.pricing.price_details.price` after verifying that `invoice_item.pricing.type` is `price_details`." The generated helpers also include `getInvoicePriceId(line)`, and Refit rewrites `line.price.id` and `line.price?.id` on the same sources to call it. It returns the old `price.id` when the payload has `price`, otherwise the `pricing.price_details.price` ID (or the expanded Price's `id`) when `pricing.type` is `price_details`, otherwise `undefined`. Its TypeScript return type is `string | undefined` under old and new `stripe` types.

Only the ID moves. Other reads of `price`, such as `line.price.nickname` or passing `line.price` on, need the full Price object, which the new location holds only when the code expands `pricing.price_details.price`; they stay for review. A `line.price.id` read on a line item without a price returned `undefined` with optional chaining and threw without it; the helper returns `undefined` in both cases.

## Checkout Session shipping details

Stripe [removed `checkout.session.shipping_details`](https://docs.stripe.com/changelog/basil/2025-03-31/checkout-session-remove-shipping-details) in the same release; the value is at `collected_information.shipping_details`, which [acacia added](https://docs.stripe.com/changelog/acacia/2025-02-24/checkout-sessions-collected-info). The generated helpers also include `getCheckoutShippingDetails(session)`: the old field when present (old-version events), otherwise the new location, otherwise `null`. Refit rewrites traced, typed and signed-event reads of `session.shipping_details` to call it when the target contract has the new location.

The new object holds only `address` and `name`, not the old Shipping object's `carrier`, `phone` and `tracking_number`, so a read of one of those three stays for review.

## Approved configuration

Use a provider adapter referenced by a checked-in `.refit.json` through its existing `providerConfig` field. The adapter's ID is distinct from the reserved built-in `stripe` ID; its package is `stripe`, so signed-event tracing still applies. Add:

```json
"stripeSubscriptionPeriods": {
  "priceId": "price_primary",
  "beforeApiVersion": "2025-02-24.acacia",
  "afterApiVersion": "2025-03-31.basil"
}
```

Use your real entitlement price ID instead of this simulated value. The complete [example adapter](../pipeline/fixtures/stripe-webhooks/provider-price-policy.json) includes constructor and outgoing-version mapping. Enrollment fingerprints the adapter with the workflow and baseline; changed policy requires approval again. Existing `run`, `watch`, doctor and App-managed service paths reuse that configuration.

This rule supports exactly the two listed historical incoming versions. It validates the supplied before/after field move, item list, price identity and period types. It does not infer deployment configuration, change a Stripe webhook endpoint, upgrade the SDK or change the outgoing request pin.

## Behavior of the proposed patch

- Signature verification and event-type handling remain in the original handler. Unrelated events retain their original result.
- Each affected signed event's `api_version` selects its behavior. The configured old version retains subscription-level fields and the existing number guard. Previously created events can still replay after the endpoint upgrade.
- The configured new version requires a complete embedded list (`has_more: false`) and exactly one item with the selected `price.id`. Reordering items does not change entitlement.
- Missing or duplicate matches, malformed price identities, incomplete lists, unsupported/null versions, missing periods, non-integer periods and invalid period order use the original application's missing-period error. No additional API request is made.
- The new period comes from the matched item's payload. Values are not copied from fixtures or fixed timestamps.

The patch uses version-aware field lookup so an older SDK's subscription-item types can coexist with newly rendered events. Legacy field lookup deliberately remains for the old incoming version. An empty rescan is therefore evidence about the scanner's supported patterns, not proof that every historical field name vanished.

## Supported source shape

The first rule accepts one directly exported/named function with a const signed event, a definite unrelated-event return, a const `event.data.object` subscription, a guard checking both old fields for numbers, and a plain result object reading those fields. Its error is a local empty subclass of the global `Error` with literal constructor arguments. The event, client and payload must pass existing mutation/escape analysis. A single whole-file edit keeps the injected version/item checks and all four field replacements atomic.

Transformed outputs, custom error constructors, mutated/escaped payloads, optional verification, shadowed globals, additional statement flows, multiple migrated handlers in one module and unsupported casts or aliases stay under review. This is not an arbitrary webhook refactoring agent. `previous_attributes` is outside this rule. Period reads on SDK responses, not webhook payloads, have a separate rule: they move to the subscription items (earliest start, latest end) in the same patch that bumps a literal Stripe `apiVersion`. See the [self-maintaining pipeline](STRIPE-PLAN.md#self-maintaining-pipeline-october-15-2026).

## Try the bundled application

From the Refit checkout:

```sh
npm run refit -- scan \
  --repository pipeline/fixtures/stripe-webhooks/repository \
  --before pipeline/fixtures/stripe-webhooks/before.json \
  --after pipeline/fixtures/stripe-webhooks/after.json \
  --provider-config pipeline/fixtures/stripe-webhooks/provider-price-policy.json \
  --api-version 2025-02-24.acacia \
  --api-version-policy source-verified \
  --propose-patch
```

Scanning requires no Docker, credentials or model request and leaves the application unchanged. Without the policy adapter, this same incompatibility stops for review.

Run the complete migration evaluation with Docker running and an existing `node:22-alpine` image:

```sh
REFIT_STRIPE_SDK=1 REFIT_DOCKER_IMAGE=node:22-alpine REFIT_NPM_PREPARE=1 \
  npm test -- pipeline/stripe-subscription-periods.test.ts --maxWorkers=1
```

The tests use actual Stripe 17.7.0 and 19.1.0 with simulated signed HTTP delivery, independently typecheck the historical TypeScript application, validate the complete workflow in offline Docker, check worker receipt reuse, and prove zero model requests even when AI/repair flags are supplied. Failed configured checks stop without AI repair. These are simulated Stripe events, not live Stripe webhook deliveries.

The proposal uses no AI. A human-readable PR body explains the price selection and incoming-version branches; machine evidence remains available for audit. Publication still requires successful configured checks, matching source revision, consistent patch evidence and human review of the entitlement policy.
