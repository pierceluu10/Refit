---
provider: shopify
kind: webhook-payload
reviewed: false
drafted: 2026-11-01
sources:
  - https://shopify.dev/docs/api/usage/versioning
  - https://shopify.dev/docs/apps/build/webhooks/subscribe/https
  - https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
  - https://shopify.dev/docs/api/admin-rest/latest/resources/webhook
---

# Shopify: webhook payloads, versions and verification

**What usually changes.** Webhook payloads are serialized with an API version and fall forward like API calls ([versioning](https://shopify.dev/docs/api/usage/versioning)). A version bump can therefore add, remove or reshape payload fields even when your queries didn't change. Product webhooks send full variant data only for the first 100 variants. Topics get added and deprecated, and SDK majors change handler signatures (`@shopify/shopify-api` v15 removed `eventId`/`resourceId` from events webhooks in favour of `webhookId`).

**How to spot it.** Look at `[webhooks] api_version` and `[[webhooks.subscriptions]] topics/uri` in `shopify.app.toml` ([app config](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)), `webhookSubscriptionCreate`/`webhooks.json` registration code, `shopify.webhooks.addHandlers`/`registerWebhooks`, `ShopifyAPI::Webhooks::Registry`, routes that read `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256` or `X-Shopify-Api-Version`, and handlers that parse topic payloads (`products/update`, `orders/create`, `app/uninstalled`).

**What to check.**

- The `X-Shopify-API-Version` header on deliveries shows the version actually used. Compare it with the version you think you're on.
- HMAC: compute HMAC-SHA256 of the **raw** body with the app's client secret and compare it in constant time with the base64 `X-Shopify-Hmac-SHA256` header. Read the raw body before any JSON body parser ([HTTPS delivery](https://shopify.dev/docs/apps/build/webhooks/subscribe/https)). After a secret rotation, signatures can take up to an hour to switch.
- Respond 2xx within 5 seconds. Shopify retries 8 times over 4 hours, and deletes an Admin-API-created subscription after 8 consecutive failures. Deduplicate with `X-Shopify-Webhook-Id`.
- REST `webhooks.json` registration maps to `webhookSubscriptionCreate` and friends. Use `shopify_rest_to_graphql` with "webhooks", and `shopify_validate_graphql` for the subscription mutation.
- `shopify_search_docs` for a topic name or a header.

**Pitfalls.**

- Moving to app-specific (TOML) subscriptions while also registering in code produces duplicate deliveries.
- Body-parsing middleware (Express `json()`, Next.js API routes) destroys the raw body and breaks HMAC.
- Webhook GIDs and REST-style numeric IDs coexist in payloads (`id` and `admin_graphql_api_id`).
