---
provider: twilio
kind: field-renamed
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/twilio/twilio-python/blob/main/UPGRADE.md
  - https://github.com/twilio/twilio-java/blob/main/UPGRADE.md
  - https://www.twilio.com/docs/lookup/v1-api
  - https://www.twilio.com/docs/usage/requests-to-twilio
---

# Twilio field renames

Twilio's wire format is stable within a version. Renames mostly show up in three places.

**1. SDK naming, not the API.**

- **Wire names vs SDK names.** Request params are PascalCase on the wire (`StatusCallback`, `MessagingServiceSid`). SDKs expose them as camelCase in Node (`statusCallback`) and snake_case in Python (`status_callback`). Response fields are snake_case JSON (`date_created`), and twilio-node maps them to camelCase (`dateCreated`).
- **Raw HTTP vs SDK.** Mixing raw HTTP and SDK code is a common source of "renamed" bugs.
- **Symbol renames in SDK majors.** Python 8 renamed `available_phone_number` to `available_phone_number_country` ([UPGRADE.md](https://github.com/twilio/twilio-python/blob/main/UPGRADE.md)). Java 11 changed `StatusEnum` to `Status`, and Java 13 changed `ConversationsV…` enum class names ([UPGRADE.md](https://github.com/twilio/twilio-java/blob/main/UPGRADE.md)).

**2. Moving between product versions or products.**

- **Lookup v1 → v2.** `Type=carrier` / `caller-name` becomes `Fields=line_type_intelligence` / `caller_name`, and the carrier block moves into `line_type_intelligence` ([v1 docs](https://www.twilio.com/docs/lookup/v1-api)).
- **Chat → Conversations.** Channels become Conversations and Members become Participants.

**3. Core API vs product API conventions.** 2010 lists use `next_page_uri` and `subresource_uris`. Product APIs use `meta.next_page_url` and `links`.

**Spotting it:**

- Find where response fields are read: `.date_created`, `.dateCreated`, `["status"]`, destructuring.
- Find where params are built: object literals passed to `.create(` / `.update(`, and form bodies with `URLSearchParams` or `data=`.
- `twilio_endpoint_lookup` shows the paths. The per-field schema is in the product's twilio-oai file, which the tool can fetch live.

**What to check:**

- **Both sides of the rename.** Update both the request side and the response side, plus any stored copies (DB columns, analytics events) that kept the old name.
- **Silent failures.** For webhooks, an old field name usually reads as `undefined` rather than throwing. Tests may not notice, so add one.

**Pitfalls:**

- Don't "fix" casing that is correct for the layer. Use PascalCase in raw form posts and SDK casing in SDK calls ([requests](https://www.twilio.com/docs/usage/requests-to-twilio)).
- Check `twilio_search_docs` for the current field name before assuming a rename.
