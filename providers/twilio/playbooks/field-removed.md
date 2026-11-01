---
provider: twilio
kind: field-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/twilio/twilio-oai
  - https://www.twilio.com/docs/usage/webhooks/webhooks-security
  - https://github.com/twilio/twilio-python/blob/main/UPGRADE.md
  - https://www.twilio.com/docs/lookup/v1-api
---

# Twilio field removals

Twilio rarely deletes response fields within a live version. When fields disappear it is usually because:

- **Code moved versions or products.** Lookup v1's `carrier` object has no direct v2 twin unless you request `Fields=line_type_intelligence` ([v1 docs](https://www.twilio.com/docs/lookup/v1-api)).
- **List metadata changed.** `total`/`num_pages` are absent from current list schemas in [twilio-oai](https://github.com/twilio/twilio-oai).
- **SDK internals were removed.** twilio-python 8 dropped `instance._properties` ([UPGRADE.md](https://github.com/twilio/twilio-python/blob/main/UPGRADE.md)).
- **A parameter is no longer accepted.** TaskRouter worker statistics stopped taking a WorkerSid.

Webhooks go the other way: Twilio _adds_ parameters without notice and expects you to tolerate them ([security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)). Strict schema validation on inbound webhooks (zod `.strict()`, pydantic `extra='forbid'`) is a bug waiting to happen.

**Spotting it:**

- Find reads of response fields and check each one against the schema in the product's twilio-oai file. `twilio_endpoint_lookup` gives the file and path, and can fetch the current spec live.
- grep for `num_pages`, `total`, `_properties`, `carrier`, `.strict(` and `extra='forbid'` near Twilio handlers.

**What to check:**

- **Find a source for every field.** For each missing field, decide whether another field or an extra request param can supply it (Lookup `Fields`), or whether to drop the feature.
- **Fields used only in logs or analytics.** Removing them is fine, but say so in the PR.
- **Typed models (Java/C#).** Check generated models in typed SDKs. Java 13 now ignores unknown nested fields, which removes one class of crash ([Java UPGRADE](https://github.com/twilio/twilio-java/blob/main/UPGRADE.md)).

**Pitfalls:**

- A field that is `null` is not a removed field. Many Twilio fields are nullable until a later state (`price` on a fresh Message, for example).
- Look at the real response before deleting code that reads it. Use `twilio_search_docs` and the spec.
