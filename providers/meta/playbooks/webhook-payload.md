---
provider: meta
kind: webhook-payload
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.facebook.com/docs/graph-api/webhooks/getting-started
  - https://developers.facebook.com/docs/messenger-platform/webhook-reference
  - https://developers.facebook.com/docs/graph-api/changelog/version25.0
---

# Webhook payload changes

Meta webhooks (Page, Instagram, WhatsApp Business Account, Ad Account, Messenger...) are versioned per subscription: the payload shape follows the subscription's API version, which you set in the App Dashboard or via `/{app-id}/subscriptions` ([webhook reference](https://developers.facebook.com/docs/messenger-platform/webhook-reference)). Bumping the outbound REST version does not change what you receive, and vice versa.

**Security basics to verify while you're there** ([getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)):

- Verification `GET` with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; echo the challenge.
- Each POST has `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the **raw** body with the app secret. Compute on raw bytes (before JSON parsing) and use a constant-time compare. Code still checking the old SHA-1 `X-Hub-Signature` header should move to the 256 variant.
- Retries for up to 36 hours, then dropped; batches up to 1000 entries; dedupe.
- mTLS: from 2026-03-31 Meta's client certificate is signed by a Meta-owned CA; trust `meta-outbound-api-ca-2025-12.pem`, CN `client.webhooks.fbclientcerts.com`, or webhooks stop arriving ([v25.0](https://developers.facebook.com/docs/graph-api/changelog/version25.0)).

**Spotting usage.** Grep `hub.challenge`, `hub.verify_token`, `X-Hub-Signature`, `entry[0].changes`, `entry.messaging`, `object === 'page'|'instagram'|'whatsapp_business_account'`, and field names like `feed`, `messages`, `ratings` (Page ratings webhook removed in [v22.0](https://developers.facebook.com/docs/graph-api/changelog/version22.0)).

**What to check.** `meta_lookup_field` for each subscribed field; `meta_search_docs` for the webhook field reference. Parse defensively: tolerate unknown fields and missing optional ones.

**Pitfalls.** Body-parser middleware that re-serializes JSON breaks signature checks. Removed webhook fields simply stop arriving, which tests rarely catch.
