---
provider: generic
kind: field-renamed
reviewed: false
drafted: 2026-11-02
sources:
  - https://spec.openapis.org/oas/v3.1.0
  - https://spec.graphql.org/October2021/#sec--deprecated
---

# A field is renamed (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** A request parameter, response field, enum value or SDK property gets a new name. Often both names work for a while, then the old one is removed. Sometimes the rename comes with a small change in type, nesting or meaning (a number becomes an object, a flag becomes an enum).

**How to spot it in code.** Search for the old name in all spellings (`snake_case`, `camelCase`, `kebab-case` in headers), in string keys, typed models, form builders, GraphQL documents, fixtures and snapshots. Check config and env templates too: names sometimes live there.

**What to check.**

- Confirm the new name and its type in the spec: `openapi_lookup` for the operation, or `graphql_lookup` for the type. A deprecation reason usually reads "use X instead".
- After the edit, `openapi_check` or `graphql_check` the changed requests; misspellings come back with "did you mean" suggestions.
- `fetch_changelog` with `query` set to the old name finds the announcement and any dates.

**Pitfalls.** Renaming in requests but not in response handling (or the reverse) is the most common miss. Enum renames hide in comparisons (`status === 'old_value'`). If the code stores the field, a data migration may be needed; leave existing data alone and say so. Keep wire names and internal names apart: rename only what crosses the API.

**When you're unsure.** Use the new name everywhere it crosses the API, keep internal names unless they must change, and note in the PR any place where both names might still arrive (for example, old webhooks in a retry queue).
