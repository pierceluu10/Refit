---
provider: generic
kind: rest-to-graphql
reviewed: false
drafted: 2026-11-02
sources:
  - https://graphql.org/learn/
  - https://relay.dev/graphql/connections.htm
  - https://spec.graphql.org/October2021/
---

# Moving from REST to GraphQL (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** A REST resource is retired in favour of a GraphQL query or mutation. Fields are named differently (often `camelCase`), IDs may become global IDs, lists become connections with cursors ([connections](https://relay.dev/graphql/connections.htm)), and errors arrive in the response body (`errors`, or `userErrors` on mutations) with HTTP 200. Writes become mutations with input objects.

**How to spot it in code.** Find each REST call: the path, the method, the SDK resource class, and the code that reads the JSON response. Note exactly which fields are read, because a GraphQL query must ask for each one.

**What to check.**

- Find the matching query or mutation with `search_docs` and `graphql_lookup` (`search` with the resource name, then `type` for the fields).
- Write the document with only the fields the code reads, then validate it with `graphql_check` (pass `variables` too). Fix every error it reports, then check again.
- If the provider publishes a mapping from REST to GraphQL, read it with `fetch_changelog` or `search_docs`.

**Pitfalls.** Pagination changes from page numbers to cursors; loops that relied on `page=` need rewriting. GraphQL APIs often limit query cost or depth, so very large selections fail at runtime. ID formats differ between the two APIs, so stored REST IDs may need converting. Mutations report validation problems in `userErrors`, not as HTTP errors, so the error handling must read them.

**When you're unsure.** Port one call at a time with the smallest document that returns what the code reads, keep the function signatures the rest of the repo uses, and say in the PR which responses could only be checked statically.
