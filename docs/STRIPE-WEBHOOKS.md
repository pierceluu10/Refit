# Stripe snapshot webhook payloads

Refit traces supported Stripe snapshot events from `stripe.webhooks.constructEvent(...)` or awaited `constructEventAsync(...)` into removed-field findings. Without a configured price policy, confirmed reads of the moved fields the [generated helpers](STRIPE-SUBSCRIPTION-PERIODS.md#every-period-read-the-generated-helper) cover (subscription periods, `invoice.subscription`, invoice line price IDs, Checkout `shipping_details`, coupon IDs and product features) call those helpers. Each returns the old field when the payload has it and the new location otherwise, so the handler works before and after the endpoint's version moves; such reads count as migrated and no longer stop the run. That holds when the receiver is a cast (`(subscription as any).current_period_end`) and when other code expands the field: Stripe sends event objects "always in their minimal form" ([expanding responses](https://docs.stripe.com/expand#expansion-with-webhooks), read 2026-10-24). With `--ai-patch`, other webhook findings go to the AI patcher. It is told that the payload may arrive in the endpoint's older or newer version and must read the old field through `Reflect.get` when present, otherwise the new location. Webhook reads it rewrites are marked `ai-version-tolerant` and count as migrated; the checks and the patch guard still apply. Without AI, webhook findings no helper covers are left unedited: patch generation and validation continue for the rest of the repository, but publication stops until they are migrated. When webhook reads are the only confirmed findings and AI is off, the run stops at review as before. The reviewed [subscription-period price-ID policy](STRIPE-SUBSCRIPTION-PERIODS.md) keeps precedence. Advisory assessment remains blocked for webhook payloads.

## Separate incoming and outgoing versions

A Stripe client's `apiVersion` controls outgoing requests. An Event's `api_version` describes the version used to render `event.data`; already-created events keep their original shape. Refit records a webhook finding's incoming version as `unverified`, even when the outgoing client version is verified. See [Stripe's Event object](https://docs.stripe.com/api/events/object) and [webhook versioning](https://docs.stripe.com/webhooks).

Stripe's [March 31, 2025 Basil change](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end) removes subscription-level `current_period_start` and `current_period_end` and places periods on individual items. Multiple items can have different periods; an embedded list can also be incomplete. Choosing the first item without an application policy could grant the wrong entitlement period. Neither a type cast nor the outgoing client version establishes the correct item or incoming version.

## Supported tracing and boundaries

- A supported immutable ESM/CommonJS Stripe client, including configured repository aliases, must establish the SDK origin. Custom adapters for the `stripe` package use the same event mapping.
- Direct event construction and single `let event;` initialization inside a signature-verification `try` block are supported. Async construction must be awaited for confirmation.
- Exact literal type branches, equivalent immutable type aliases, grouped switch cases and a dominating negative guard with a definite exit establish the payload schema. Mixed-schema groups and uncertain fallthrough remain under review.
- Immutable event/data/object aliases and static nested object destructuring preserve the source. The ordinary schema reader handles removed fields and literal indexes. Defaults, rest/computed projections, mutable aliases and unknown event names do not confirm a payload.
- A parameter of a private function declaration in the file (`async function handlePaymentSuccess(invoice)`) is a payload when every reference to the function is a direct call passing a narrowed payload, or an immutable alias of one, of the same mapped schema; the event types are those of all the calls. An exported function, one passed or exported as a value, a call outside an event-type branch or with an SDK response or another schema, a default or rest parameter, and any write to the parameter or a member of it keep the parameter's reads under review.
- The curated [stripe-node 19.1.0 event mapping](https://github.com/stripe/stripe-node/blob/v19.1.0/types/EventTypes.d.ts) covers subscription, PaymentIntent, Invoice, Checkout Session, Customer, Product, Price and Charge snapshots. The mapped schema must resolve in the supplied before contract. Checkout Session uses `checkout.session`.
- Known event mappings also filter out same-named fields belonging to another schema when a projection omits the event's actual component. Nested component references, supported list indexes/loops and inline array callbacks preserve incoming-event provenance and its review gate.
- Mutations, optional constructors, missing/spread arguments, unawaited async construction and escaped clients/payloads stay under review. Known incoming-event provenance is retained when type evidence is incomplete, so those findings still stop automation. Passing, returning, storing or aliasing a payload no longer downgrades it; only mutations do. Confirmed webhook findings no helper migrates still stop automation through the incoming-version gate.

`confidence: confirmed` means a read was traced under the curated mapping. It does **not** prove deployed endpoint version, runtime signature verification, business meaning, complete item lists or migration correctness. `finding.webhook` records constructor location, narrowed event types, schema when established, and incoming-version status.

Unsigned `JSON.parse`, thin events, transformed wrappers, other cross-function payload flows (exported or shared handlers, arrow-function handlers, aliases inside a handler), arbitrary SDK factories and unsupported module forms are outside confirmed tracing. `previous_attributes` is not treated as the current snapshot. Unsupported code can still produce ordinary review findings; absence of a finding never proves no impact.

## Replay the historical incompatibility

The [fixture](../pipeline/fixtures/stripe-webhooks/README.md) uses actual Stripe SDKs 17.7.0 and 19.1.0, locally generated signatures and HTTP delivery to a loopback server. Before/after JSON files are reviewed projections of the documented field move, **not** downloaded full Stripe specifications. Events and secrets are simulated. There are no Stripe-server calls, charges or model requests.

```sh
REFIT_STRIPE_SDK=1 REFIT_DOCKER_IMAGE=node:22-alpine REFIT_NPM_PREPARE=1 \
  npm test -- pipeline/stripe-webhook-sdk.test.ts --maxWorkers=1
```

Docker must be running and the image available locally. Locked public dependencies are prepared with scripts disabled; HTTP deliveries then run with external networking disabled. The suite proves original success, changed failure, that the helper-patched handler returns the same result for old-version and new-version events (items on different periods keep the original missing-period error), old-event replay, wrong/tampered/stale signature rejection, ignored unrelated events and async construction. Publication still refuses webhook findings no helper migrates, even with otherwise passing validation.

For a static scan with no installation:

```sh
npm run refit -- scan \
  --repository pipeline/fixtures/stripe-webhooks/repository \
  --before pipeline/fixtures/stripe-webhooks/before.json \
  --after pipeline/fixtures/stripe-webhooks/after.json \
  --api-version 2025-02-24.acacia \
  --api-version-policy source-verified \
  --propose-patch
```

The fixture reports four entitlement-period accesses with webhook provenance. Without a policy, outgoing version is verified, incoming version is unverified, and the patch reads each period through the generated helper (`unresolvedFindings: 0`). The current projection also declares scalar event metadata and price identity so the configured policy can validate its narrowly supported handler.

## Before automatic migration

Approved configuration must describe an incoming-version boundary and a precise item-selection policy. The supported price-ID rule adds checks on the signed Event's `api_version` instead of assuming the SDK pin establishes it. It defines missing, duplicate and incomplete-list behavior, preserves signatures, unrelated/old events and the original error class, and runs historical contracts in isolation. All other webhook migrations are refused. The same field move can affect SDK responses and `previous_attributes`; those require their own supported migration rules.
