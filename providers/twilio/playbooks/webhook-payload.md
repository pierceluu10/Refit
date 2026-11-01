---
provider: twilio
kind: webhook-payload
reviewed: false
drafted: 2026-11-01
sources:
  - https://www.twilio.com/docs/usage/webhooks/webhooks-security
  - https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
  - https://www.twilio.com/docs/events/webhook-quickstart
  - https://www.twilio.com/docs/events/event-streams/sink-resource
---

# Twilio webhooks and callbacks

**Classic webhooks** (incoming SMS/voice, `StatusCallback`, `statusCallbackEvent`, recording callbacks):

- Form-encoded POSTs, signed with `X-Twilio-Signature`.
- The signature is HMAC-SHA1 keyed with the Auth Token over the full URL plus the sorted POST params.
- For JSON bodies, Twilio adds a `bodySHA256` query param, and you validate the raw body ([security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)).
- Twilio adds parameters without notice, so validate over everything you received, not a fixed list.

**Message status callbacks:**

- `MessageStatus` (queued/sent/delivered/undelivered/failed/read...).
- `ErrorCode` on failures.
- SMS can include `RawDlrDoneDate`.
- WhatsApp/RCS can include `ChannelInstallSid`, `ChannelStatusMessage` and `EventType=READ`.
- Callbacks can arrive out of order ([status guide](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status)).

**Event Streams** (`events.twilio.com/v1` Sinks and Subscriptions):

- Delivers a JSON array of CloudEvents 1.0. The `data` field follows a versioned schema (`schema_version` on the subscription, version suffix on `dataschema`).
- Validate with the SDK validator using the sink URL plus the query string and the raw body ([quickstart](https://www.twilio.com/docs/events/webhook-quickstart)).
- Delivery is at-least-once with 24 hours of retries ([sink resource](https://www.twilio.com/docs/events/event-streams/sink-resource)).

**Spotting it:** routes that read `req.body.MessageStatus`, `CallStatus`, `From`/`To`/`Body`, `X-Twilio-Signature`, `validateRequest`, `twilio.webhook()`, `RequestValidator`, `bodySHA256`, `specversion`, and `dataschema`.

**What to check:**

- **Moving to Event Streams.** Moving from per-message StatusCallback to Event Streams changes the payload shape completely (form fields → CloudEvent JSON with `data`). Handlers need rewriting, not renaming.
- **Proxies and URL rewriting.** Signature failures after infrastructure changes usually come from a proxy changing scheme/host/port, a body parser eating the raw body, or URL re-encoding.
- **Idempotency and ordering.** Make handlers idempotent and order-tolerant: compare status precedence, don't just overwrite.

**Pitfalls:**

- Don't hand-roll HMAC. Use the SDK validators.
- Don't validate with an API key secret. Only the Auth Token works.
- Return 200 quickly. Event Streams times out after 5 s.

`twilio_search_docs` has the parameter lists.
