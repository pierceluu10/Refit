---
provider: stripe
kind: webhook-payload
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/webhooks/versioning
  - https://docs.stripe.com/upgrades
  - https://docs.stripe.com/api/versioning
  - https://docs.stripe.com/event-destinations
  - https://docs.stripe.com/webhooks
---

# Stripe webhook payload changes

**What changes.** Snapshot events carry the object in `event.data.object`, rendered at the **webhook endpoint's** `api_version`. If the endpoint has none, the account default version is used. The SDK's version and your request headers play no part ([versioning](https://docs.stripe.com/api/versioning)). An API upgrade in code therefore leaves webhook payloads on the old shape until the endpoints change. The endpoint version can only be set when the endpoint is created. To upgrade, create a new endpoint with the new `api_version`, run both with idempotent handlers, switch over, then disable the old one ([upgrades](https://docs.stripe.com/upgrades), [webhook versioning](https://docs.stripe.com/webhooks/versioning)). Within one major release you can move endpoints freely. Before acacia, every version could break ([webhook versioning](https://docs.stripe.com/webhooks/versioning)).

**Thin events.** Event destinations can instead send thin events: the type plus a `related_object` reference, with no versioned object. Your code fetches what it needs. Stripe recommends thin events for new integrations because they avoid webhook versioning ([event destinations](https://docs.stripe.com/event-destinations)). v2 types look like `v2.core.account.updated`.

**How to spot it.** Look for `constructEvent` / `Webhook.construct_event` / `ConstructEvent`, `Stripe-Signature`, `whsec_`, handlers switching on `event.type`, `parseThinEvent` / `parseEventNotification`, and infra code creating endpoints (`webhookEndpoints.create` with `api_version`, Terraform `stripe_webhook_endpoint`).

**What to check.**

- `stripe_webhook_events` for each `event.type` the handler uses. It tells you whether the type exists, its `data.object` type, and close matches for typos.
- `stripe_api_versions` between the endpoint's version and the target, for payload-shape breaking changes.
- With Go, Java or .NET, the endpoint must match the SDK's pinned version or deserialization fails ([webhook versioning](https://docs.stripe.com/webhooks/versioning)).
- Signature verification must use the raw body ([webhooks](https://docs.stripe.com/webhooks)).

**Pitfalls.** Code and endpoint versions can drift apart, and only the code is in the repo, so say in the PR that endpoints need recreating. Events can arrive out of order and more than once ([webhooks](https://docs.stripe.com/webhooks)). Reading `previous_attributes` only works with snapshot events.
