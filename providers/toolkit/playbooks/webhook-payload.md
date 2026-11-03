---
provider: generic
kind: webhook-payload
reviewed: false
drafted: 2026-11-02
sources:
  - https://www.standardwebhooks.com/
  - https://www.rfc-editor.org/rfc/rfc2104
---

# Webhook payload change (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** Event names, payload fields, nesting, the version a payload is rendered at, the signature header or algorithm, or the delivery format (for example, a full object becomes a thin event that only carries an ID). Many providers sign payloads with an HMAC ([RFC 2104](https://www.rfc-editor.org/rfc/rfc2104)) over the raw body; some follow [Standard Webhooks](https://www.standardwebhooks.com/).

**How to spot it in code.** Find the webhook route (framework routes, serverless handlers), the signature verification, the switch over event types, and every field read from the payload. Look for raw-body handling: signature checks need the exact bytes, and body parsers often break them. Fixture payloads in tests show which shape the code expects.

**What to check.**

- Read the event catalog and the change with `search_docs` and `fetch_changelog` (`query`: the event name or field).
- If the provider describes webhooks in its OpenAPI spec (`webhooks` in OpenAPI 3.1, or callback schemas), `openapi_lookup` shows the payload fields.
- Update test fixtures to the new shape, then `run_checks`.

**Pitfalls.** Old and new payloads may both arrive during a rollout, and retries may redeliver old events later, so handlers should accept both for a while. The payload version is often set per endpoint in the provider's dashboard, not in code; the PR must say if a human has to change it. Signature changes need a new secret or header name. Never log full payloads with personal data.

**When you're unsure.** Accept both shapes where you can, keep the signature check strict, update the fixtures, and list in the PR the dashboard settings and event types you could not verify.
