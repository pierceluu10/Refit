---
provider: twilio
kind: rest-to-graphql
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/twilio/twilio-oai
---

Rarely applies to Twilio: the public APIs are REST (OpenAPI in [twilio-oai](https://github.com/twilio/twilio-oai)) with no GraphQL migration. For moves between Twilio products or versions, see the `api-version` and `product-shutdown` playbooks and `twilio_endpoint_lookup`.
