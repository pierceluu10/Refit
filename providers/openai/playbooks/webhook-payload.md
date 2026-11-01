---
provider: openai
kind: webhook-payload
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/docs/guides/webhooks
  - https://developers.openai.com/api/reference/resources/webhooks
  - https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
---

OpenAI sends project webhooks for events such as `response.completed` (background responses), batch completion and fine-tuning job status. The full event list is in the [webhooks reference](https://developers.openai.com/api/reference/resources/webhooks). Endpoints and subscriptions are set up in the dashboard, and the signing secret is shown once ([guide](https://developers.openai.com/api/docs/guides/webhooks)).

**Shape.** Delivery follows the [Standard Webhooks spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) with `webhook-id`, `webhook-timestamp` and `webhook-signature` headers. The JSON body carries a `type` and a `data` object holding the id of the affected object (e.g. `event.data.id` is the response id). Fetch the object for details instead of expecting it inline ([guide](https://developers.openai.com/api/docs/guides/webhooks)).

**Verifying.** Use `client.webhooks.unwrap(rawBody, headers)` with the secret set on the client (`OpenAI(webhook_secret=...)` / `new OpenAI({ webhookSecret })`). It raises `InvalidWebhookSignatureError` on a bad signature. It needs the raw body, so in Express use `express.text({type: 'application/json'})`, not `express.json()` ([guide](https://developers.openai.com/api/docs/guides/webhooks)). Standard Webhooks libraries work too.

**Delivery.** Return 2xx fast and move slow work to a background job. Failures are retried with exponential backoff for up to 72 hours, 3xx redirects aren't followed, and duplicates can happen, so dedupe on `webhook-id` ([guide](https://developers.openai.com/api/docs/guides/webhooks)).

**When payloads change.** Expect new event types and new fields, which OpenAI treats as backwards-compatible ([API overview](https://developers.openai.com/api/reference/overview)). Handlers should ignore unknown `type` values and unknown keys rather than throw. If a product is retired (e.g. Assistants run events, Evals), its events stop.

**Spot it.** Grep for `webhooks.unwrap`, `webhook-signature`, `OPENAI_WEBHOOK_SECRET`, handlers switching on `event.type`, and polling loops that could be replaced by webhooks.

**Check.** `openai_search_docs` with the event name. Compare your switch cases with the reference's event list.
