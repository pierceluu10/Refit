---
provider: generic
kind: field-removed
reviewed: false
drafted: 2026-11-02
sources:
  - https://spec.openapis.org/oas/v3.1.0
  - https://spec.graphql.org/October2021/#sec--deprecated
---

# A field is removed (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** A request parameter or a response field goes away, usually after a deprecation period. The changelog normally names a replacement: another field, an expansion or include option, a separate endpoint, or nothing at all. Specs mark the field first: `deprecated: true` in OpenAPI ([spec](https://spec.openapis.org/oas/v3.1.0)) or `@deprecated(reason: ...)` in GraphQL ([spec](https://spec.graphql.org/October2021/#sec--deprecated)).

**How to spot it in code.** Search for the field name in every spelling the code may use: `snake_case`, `camelCase`, quoted keys, typed models, serializers, test fixtures and mocks. Look at both directions: code that sends it, and code that reads it from responses, webhooks or stored JSON. Typed SDKs may already show it as deprecated.

**What to check.**

- `openapi_lookup` with `deprecated: true`, or `graphql_lookup` with `deprecated: true`, lists what the current spec marks. The deprecation reason often names the replacement.
- After the edit, `openapi_check` the changed request, or `graphql_check` the changed document; both report unknown and deprecated fields with suggestions.
- `search_docs` and `fetch_changelog` with `query` set to the field name find the announcement and its date.

**Pitfalls.** A removed response field often reads as `undefined` or `None` with no error, so code keeps running with wrong data. Data saved from old responses (databases, caches) may still contain the field. A replacement may differ in type or units. Removing a field from a request can change a default on the server.

**When you're unsure.** Move to the replacement the provider names; if none is named, stop sending or reading the field, keep behaviour as close as you can, and say in the PR what the code did with it and what now happens instead.
