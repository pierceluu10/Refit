# Shopify Admin API

Refit checks a Shopify app's Admin GraphQL usage against Shopify's published schemas, and moves the app's pinned API version only when every document it can read is proven to work on the target version. The migration is deterministic: no AI is involved, and nothing runs against a store.

## Contracts

Shopify publishes the Admin API as a GraphQL schema for each supported quarterly version (`2026-01`, `2026-04`, …). Save one per version:

```sh
refit shopify-snapshot --version 2026-01 --output refit/shopify-before.json
refit shopify-snapshot --version 2026-10 --output refit/shopify-after.json
```

The command introspects Shopify's public documentation proxy (`https://shopify.dev/admin-graphql-direct-proxy/<version>`). No store, credentials or store operation are involved. The snapshot records the version, the URL and a SHA-256 of the schema, and Refit refuses a snapshot whose content does not match its hash.

Only supported versions are published. Shopify serves a request for an unsupported version as the oldest supported version, so an app pinned to `2025-01` is answered by `2026-01` today. Refit therefore uses the oldest supported schema as the before contract for older pins, and says so in the report.

## What Refit reads

- **Clients:** `admin.graphql(...)` from `@shopify/shopify-app-remix`, `-react-router` and `-express` (`authenticate.admin`, `unauthenticated.admin`); `createAdminApiClient(...).request(...)` from `@shopify/admin-api-client`; `new shopify.clients.Graphql(...).request/query(...)` from `@shopify/shopify-api`.
- **Documents:** literals and constants in scope or imported from another module (named or default exports, re-exports such as `export { QUERY as PRODUCT } from` and `export *`, including Remix-style `./shopify.server` paths), `await import()` destructuring, `${FRAGMENT}` interpolation of constant fragments, ternaries between documents, `{ query }` bodies, members of constant objects (`QUERIES.product`) and every element of a constant array looped with `for (const tier of TIERS)`. `#graphql` literals no call reaches are checked too.
- **Helpers, callbacks and closures:** when the document is a parameter of a function, Refit follows that function to every call: named helpers (`adminQuery(admin, query)`) called in the same file or through named, namespace or re-exported imports; callbacks passed to a repository function (`fetchAll((query) => admin.graphql(query))`); `const` arrows passed on; and closures returned by a factory (`const request = createRequest(admin); request(QUERY)` or `createRequest(admin)(QUERY)`). A call site passing a runtime-built document stops at its own line. If the function leaves what Refit can follow (stored in an object, passed to a package such as `Effect.fn`, reassigned, or in a module loaded with `import()`), some callers are unknown, so the run stops at that line. Mocks and spies in test files do not stop the run; documents that tests pass are checked as fixtures, as before.
- **Pins:** `ApiVersion.<Month><YY>`, `apiVersion: 'YYYY-MM'` in files that use Shopify, `/admin/api/YYYY-MM/` URLs, and `LATEST_API_VERSION`, which the locked `@shopify/shopify-api` release fixes (the constant was removed in 12.0.0). Pins in `.graphqlrc.*` are codegen configuration: they are moved with the runtime pin but never count as a conflict.
- **REST:** `admin.rest.*`, `shopify.clients.Rest`, `/admin/api/<version>/*.json` URLs, and versioned URLs with a resource path before a substitution (`/admin/api/2024-01/products/${id}.json`).

## The rule

Each document is validated against both schemas with the standard GraphQL rules:

| Result | What Refit does |
|---|---|
| Valid on both, no selected field changes type | Counts as proven for the target |
| Invalid only on the target (removed field, argument, enum value or type) | Stops for review at the exact line |
| Invalid on the before contract too | Stops: the query already fails on every version Shopify serves |
| A selected field changes type (for example `Date` → `DateTime`) | Stops: returned values change shape |
| Built at runtime, sent by a function Refit cannot follow, or a fragment Refit cannot inline | Stops: the document cannot be checked |
| `#graphql` literal no Admin call reaches, invalid on both | Noted as another Shopify API (Storefront, Customer Account, Partner), not Admin usage |

Only when nothing stops does the rule move every pin to the target version. An `ApiVersion` enum pin is moved only if the locked `@shopify/shopify-api` release defines the target member (`October26` first ships in 14.0.0, `July26` in 13.1.0, `April26` in 12.3.0, `January26` in 12.1.0). Otherwise the run stops, because upgrading the SDK is a separate, major change. REST calls, several different runtime pins, and pins Refit cannot resolve also stop for review. Fields deprecated on the target are listed in the draft PR, not changed.

A field rename is not inferred from a deprecation notice. Of the 401 fields deprecated in `2026-01`, 23 name a same-typed replacement that still exists in `2026-10`, but same type does not mean same value: `ShopifyPaymentsPayout.gross` points to `net`.

## Add the agent

```sh
refit agents --add shopify
```

This writes a `shopify` integration into `.refit.json` with `refit/shopify-before.json` and `refit/shopify-after.json` and the repository's check command. Save the two snapshots, review the command, run `refit doctor`, and approve with `refit enroll`. Validation then runs the app's own checks in offline Docker on the original and the migrated code, like every Refit migration.

## Local lab

`~/Repos/refit-shopify-lab` is a TypeScript app on `@shopify/shopify-api` 14.0.1, pinned to `ApiVersion.January25`. It lists and renames products through `shopify.clients.Graphql` with a shared fragment. Its tests replace the SDK's fetch with simulated Admin responses and fail on any unexpected request, so nothing reaches a store. End to end:

1. `refit agents` detects Shopify (locked 14.0.1) and `--add shopify` scaffolds the integration.
2. `refit run --integration shopify` finds both documents valid on `2026-10`, moves `ApiVersion.January25` to `ApiVersion.October26`, and runs `tsc` and the tests in offline Docker on both versions of the code: **validated**, with a draft PR description ready.
3. On the `scenario/removed-field` branch, a query of `deliverySettings` (removed in `2026-10`) stops for review at `app/delivery.ts:6`.

## Limits

- Admin GraphQL only. REST has no published versioned contract; `shopify-api-node` is detected but not migrated.
- Validation proves a document is well-formed against the schema, not that the app handles every new behavior (rate limits, new error codes, changed defaults). Application checks remain the evidence for behavior.
- Webhook subscriptions keep their own API version in `shopify.app.toml`; the draft PR points this out.
- Documents built at runtime (interpolated IDs, cursors or filters, string builders) are not read, and neither are documents sent through class or object methods (`service.query(admin, QUERY)`), because finding their callers needs the receiver's type. Both stop for review at the exact line.
