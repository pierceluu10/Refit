# Stripe subscription periods selected by price

Refit can propose a deterministic migration for a narrow signed-webhook handler when its reviewed adapter explicitly selects a Stripe price ID. This is the first automatic subscription-period policy. Other webhook changes continue to require review.

Stripe [moved subscription periods onto individual items in 2025-03-31.basil](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end). Several items may have different periods. Selecting one by price is an application decision, not a conclusion Refit draws from the API diff.

## Without a price policy

Without a configured policy, Refit rewrites period reads on signed webhook payloads and on values typed as `Stripe.Subscription` into a version-tolerant read:

```ts
Reflect.get(subscription, 'current_period_end') ??
  [Math.max(...(subscription.items?.data ?? []).map((item) => item.current_period_end))].find(Number.isFinite)
```

An event rendered in the old version keeps its subscription-level value. A new-version event uses the latest item end (earliest item start for `current_period_start`). Missing or empty items give `undefined`, as the removed field did, so existing missing-period checks still fire. The endpoint's API version can therefore change separately from the code. When items have different periods, the widest period is an entitlement choice: use the price-ID policy below to select a specific item instead. A configured policy always takes precedence.

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
