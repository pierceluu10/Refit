---
provider: twilio
kind: api-version
reviewed: false
drafted: 2026-11-01
sources:
  - https://www.twilio.com/docs/usage/requests-to-twilio
  - https://www.twilio.com/en-us/changelog/reminder--end-of-life-for-twilio-2008-api
  - https://github.com/twilio/twilio-oai
  - https://www.twilio.com/docs/lookup/v1-api
---

# Twilio API versions

Twilio has no dated, account-pinned versions or version headers like Stripe. It has two schemes:

- **Core API:** `api.twilio.com/2010-04-01/...` (Messages, Calls, Recordings, IncomingPhoneNumbers, ...). `2010-04-01` is the only live version ([docs](https://www.twilio.com/docs/usage/requests-to-twilio)). The 2008 API reached EOL on 2023-12-15 ([changelog](https://www.twilio.com/en-us/changelog/reminder--end-of-life-for-twilio-2008-api)).
- **Product APIs:** each product has its own host and a `vN` path prefix: `verify.twilio.com/v2`, `messaging.twilio.com/v1`, `lookups.twilio.com/v2`, `conversations.twilio.com/v1`. The twilio-oai spec has one file per product and version ([repo](https://github.com/twilio/twilio-oai)).

**A higher vN is not an upgrade of the same API:**

- Lookup v1 → v2 changes paths, query parameters (`Type=carrier` → `Fields=line_type_intelligence`) and response shape ([docs](https://www.twilio.com/docs/lookup/v1-api)).
- Conversations v2 ("Conversation Orchestrator") is a different API from v1.
- Chat v3 is a single Flex endpoint.

Move versions only when the old one is deprecated or you need a feature.

**Spotting it:** grep for `2008-08-01`, `/v1/`, `/v2/` next to `twilio.com`, and for SDK chains like `.lookups.v1`, `.verify.v1`, `.chat.v2`. `twilio_endpoint_lookup` reports every version it knows for a product, the status of each where Twilio has published one, and the SDK accessor.

**What to check:**

- **SDK default version.** Calls without a version (`client.lookups.phoneNumbers`) use the SDK's default version, which can change across SDK majors. Pin the version explicitly when it matters.
- **Response field names.** These change between versions. Read the response handling, not only the request.
- **Pagination shape.** It differs between the core API and product APIs (see pagination-or-limits).

**Pitfalls:**

- Regional hosts (`api.dublin.ie1.twilio.com`) are the same API version on a different edge. They are not a version change.
- `.json` is part of the 2010 path. Product APIs return JSON only.
