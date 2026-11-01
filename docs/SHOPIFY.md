# Shopify Admin API

Refit checks a Shopify app's Admin GraphQL usage against Shopify's published schemas, and moves the app's pinned API version only when every document it can read is proven to work on the target version. The migration is deterministic: no AI is involved, and nothing runs against a store.

## Contracts

Shopify publishes the Admin API as a GraphQL schema for each supported quarterly version (`2026-01`, `2026-04`, …). Save one per version:

```sh
refit shopify-snapshot --version 2026-01 --output refit/shopify-before.json
refit shopify-snapshot --version 2026-10 --output refit/shopify-after.json
```

The command introspects Shopify's public documentation proxy (`https://shopify.dev/admin-graphql-direct-proxy/<version>`). No store, credentials or store operation are involved. The snapshot records the version, the URL and a SHA-256 of the schema, and Refit refuses a snapshot whose content does not match its hash.

Refit also pins Admin and Storefront schemas in the repository, with deterministic diffs and quoted migration rules: [Shopify contracts and rules](SHOPIFY-RULES.md).

Only supported versions are published. Shopify serves a request for an unsupported version as the oldest supported version, so an app pinned to `2025-01` is answered by `2026-01` today. Refit therefore uses the oldest supported schema as the before contract for older pins, and says so in the report.

## What Refit reads

- **Clients:** Storefront API clients (Hydrogen's `storefront.query/mutate`, `createStorefrontApiClient(...).request`, `shopify.clients.Storefront`) are told apart from Admin ones. Their documents and `apiVersion` are listed in `shopify.storefrontDocuments` and never checked against or moved to the Admin contract. A Storefront document Refit cannot read is listed there too and named in the draft; it does not stop the Admin move, and the schema proof leaves Storefront documents out.
- **Admin clients:** `admin.graphql(...)` from `@shopify/shopify-app-remix`, `-react-router` and `-express` (`authenticate.admin`, `unauthenticated.admin`); `createAdminApiClient(...).request(...)` from `@shopify/admin-api-client`; `new shopify.clients.Graphql(...).request/query(...)` from `@shopify/shopify-api`. Clients other packages build for an Admin `graphql.json` URL count as Admin clients: `new GraphQLClient(url)` (graphql-request), `createGraphQLClient({ url })` (`@shopify/graphql-client`), urql's `createClient({ url })` and Apollo's `new ApolloClient({ uri })`, held in a `const` or a class's `this.client`; their `request`, `rawRequest`, `query` and `mutate` calls are read like `admin.graphql`. A client returned, exported or passed on stops at that line.
- **Documents:** literals and constants in scope or imported from another module (named or default exports, re-exports such as `export { QUERY as PRODUCT } from` and `export *`, including Remix-style `./shopify.server` paths), `await import()` destructuring, `${FRAGMENT}` interpolation of constant fragments, ternaries between documents, `{ query }` bodies, members of constant objects (`QUERIES.product`) and every element of a constant array looped with `for (const tier of TIERS)`. Constant numbers and booleans are folded in (`first: ${PAGE_SIZE}`). A `let` is read through every value assigned to it (`let query = A; if (x) query = B`); any other write (`+=`, `++`, destructuring) stops. A call to a repository function is read through what it returns (`admin.graphql(productsQuery(id))`), a class field through its initializer when it is `readonly` or private, or when no code assigns it and no other class declares it, and a template that only wraps a value (`` `#graphql\n${query}` ``) as that value. `#graphql` literals, `gql`/`graphql` tagged templates, imported `graphql(...)` documents (codegen client preset, gql.tada) and `.graphql`/`.gql` files no call reaches are checked too, as untraced documents. A fragment one document spreads and another file defines (once, under that name) is appended before validation. A runtime value inside a GraphQL string (`product(id: "gid://shopify/Product/${id}")`) cannot change what a document selects, so a placeholder stands in for it.
- **Helpers, callbacks and closures:** when the document is a parameter of a function, Refit follows that function to every call: named helpers (`adminQuery(admin, query)`) called in the same file or through named, namespace or re-exported imports; callbacks passed to a repository function (`fetchAll((query) => admin.graphql(query))`); `const` arrows passed on; and closures returned by a factory (`const request = createRequest(admin); request(QUERY)` or `createRequest(admin)(QUERY)`). An options parameter is followed by property (`options.query`, `({ query }) => …`, `const { query } = input`), a private method through `this.method(...)` calls in its class, a member of a local `const` object (`const client = { graphql: (query) => fetch(...) }`) through every `client.graphql(...)`, and a function a module exports through `const { name } = await import('./module')`. A local function nothing calls sends no document. A call site passing a runtime-built document stops at its own line. If the function leaves what Refit can follow (stored in an object Refit does not follow, passed to a package such as `Effect.fn`, reassigned, returned from an exported function nothing calls, or in a module loaded with `import()` other than by destructuring), some callers are unknown, so the run stops at that line. An exported function nothing in the repository calls stops too. Mocks and spies in test files do not stop the run; documents that tests pass are checked as fixtures, as before.
- **Pins:** `ApiVersion.<Month><YY>`, `apiVersion: 'YYYY-MM'` in files that use Shopify (directly, through `const` bindings and imports, or as the default of `process.env.NAME ?? 'YYYY-MM'`, whose move the draft names because the variable overrides it where set), `/admin/api/YYYY-MM/` URLs and `/admin/api/${VERSION}/` URLs whose version is such a constant, and `LATEST_API_VERSION`, which the locked `@shopify/shopify-api` release fixes (the constant was removed in 12.0.0). Pins in `.graphqlrc.*` are codegen configuration: they are moved with the runtime pin but never count as a conflict.
- **REST:** `admin.rest.*`, `shopify.clients.Rest` and `createAdminRestApiClient` clients and every `get`, `post`, `put`, `patch` or `delete` call on them, REST resource classes (`shopify.rest.Product.all()`, `new admin.rest.resources.Metafield(...)`), `/admin/api/<version>/*.json` URLs, versioned URLs with a resource path before a substitution (`/admin/api/2024-01/products/${id}.json`), and versioned URLs whose whole path is a substitution (`/admin/api/2024-01/${path}`), which may name any resource. Each one is reported at its file and line with the HTTP method and path where the code states them: the `path` of a REST client call (a literal or constant), the operation of a resource class (`all`, `find` and `count` are GET, `delete` is DELETE, `save` is POST or PUT), and for a URL its path plus the method of the `fetch` or HTTP verb call it is passed to, directly or through a `const`. Substitutions show as `{id}`. The report lists them under `shopify.restCalls`, and `refit scan` prints them. A REST call whose endpoint, parameters, body keys and read fields the versioned REST contract keeps unchanged stays REST and moves with the version ([REST contract](SHOPIFY-REST.md#versioned-rest-contract)). Every other REST call goes to the [agent fixer](#agent-fixer), with the documented REST → GraphQL mappings as its context.
- **Raw GraphQL requests:** a URL to `/admin/api/<version>/graphql.json` is an Admin GraphQL call made without Shopify's clients. Refit reads the document of `fetch(url, { body: JSON.stringify({ query }) })` and `axios.post(url, { query })`, for the URL and every use of a `const` holding it, following `query` into helper parameters as for client calls. The options and the body may be `const`s or a ternary, and with an `application/graphql` content type the body is the document itself. Any other body stops for review at that line.
- **Webhook version:** `api_version` in `shopify.app.toml` (and `shopify.app.<name>.toml`) is listed under `shopify.webhookApiVersions` and named in the draft. Refit never moves it: handlers read the payload of that version.

## The rule

Each document is validated against both schemas with the standard GraphQL rules:

| Result                                                                                      | What Refit does                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Valid on both, no selected field changes type                                               | Counts as proven for the target                                                       |
| Invalid only on the target, or on the before contract too                                   | Handed to the [agent fixer](#agent-fixer) with the errors                             |
| A selected field changes type (for example `Date` → `DateTime`)                             | Handed to the agent fixer: returned values change shape                               |
| Built at runtime, sent by a function Refit cannot follow, or a fragment Refit cannot inline | Handed to the agent fixer: the document cannot be checked                             |
| `#graphql` literal no Admin call reaches, invalid on both                                   | Noted as another Shopify API (Storefront, Customer Account, Partner), not Admin usage |

Refit makes no edits itself. Every pin older than the target, an `ApiVersion` enum member or `LATEST_API_VERSION` the locked SDK cannot give, a pin Refit cannot resolve and every REST call the versioned REST contract does not prove ([REST](SHOPIFY-REST.md#versioned-rest-contract)) goes to the agent fixer, which moves the pins and upgrades the SDK where needed. Pins are compared by the version Shopify serves: a pin older than the oldest supported version is served as that version, so several such pins do not conflict. An environment variable with no default in code and the `unstable` version are named in the draft. Fields deprecated on the target are listed in the draft PR.

Validation grades the patch again on the patched code ([Shopify proof](SHOPIFY-PROOF.md)): without schema proof at the target it is grade D and `[Needs review]`, and Refit's own development store can raise it to grade A.

### Agent fixer

There are no stops and no codemods (docs/GUT-PLAN.md). Every finding that needs an edit is handed, all at once, to the agent fixer (`pipeline/agent-fix.ts`, through `pipeline/shopify-agent.ts`): Claude works in a copy of the repository, told what changed (the schema diff for the types the code uses, the quoted rule tables between the versions, the REST mappings when a REST call is handed off) and why each finding was handed off, at its file and line. Its judge is deterministic: the [schema proof](SHOPIFY-PROOF.md) on the patched tree (every Admin document validates on the target, every REST call is proven against the REST contract, nothing left unread) plus every runtime pin naming the target on an SDK that has it. tsc, build and tests run afterwards in validation.

- **Passed:** the agent's patch is proposed with generator `openai`; validation and the proof levels decide whether it is validated, as for any AI patch.
- **Unproven:** the patch is proposed `[Needs review]`, listing the judge errors left and the agent's summary.
- **No change or failed:** nothing is proposed, and the report says why.

Without `--ai-patch` the agent does not run and nothing is proposed. The report records `shopify.handoff` (each reason) and `shopify.agent` (outcome, errors, summary, cost). Within one run (`REFIT_AI_BUDGET_DIRECTORY`) the scan, the workflow and validation reuse the first agent result for the same tree.

With `--ai-patch`, an Admin call whose document Refit cannot read statically (built at runtime, passed through a table or function) is sent to the model with its file and the files that file imports (AI use 5, `aiReconstructDocument`). The model returns the document the call sends; Refit keeps it only when every operation, field, argument, alias, fragment and variable name in it is written in that code, and graphql-js validates it on both the before and the target schema. A kept reconstruction is recorded under `shopify.reconstructed`, quoted in the draft for the reviewer to confirm, and validated again by the schema proof at the call's line in the patched code. A refused one is handed to the agent fixer with the reason.

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
3. On the `scenario/removed-field` branch, a query of `deliverySettings` (removed in `2026-10`) is handed to the agent fixer at `app/delivery.ts:6`.

## Limits

- REST calls the REST contract does not prove are migrated only by the agent fixer. `shopify-api-node` is detected but not migrated.
- Validation proves a document is well-formed against the schema, not that the app handles every new behavior (rate limits, new error codes, changed defaults). Application checks remain the evidence for behavior.
- Webhook subscriptions keep their own API version in `shopify.app.toml`; the draft PR names it and Refit does not move it.
- Storefront and Customer Account documents are classified, not checked: this pipeline compares Admin contracts.
- Documents built at runtime (interpolated cursors or filters outside strings, string builders) are not read, and neither are documents sent through class or object methods (`service.query(admin, QUERY)`), because finding their callers needs the receiver's type. Both go to the agent fixer at the exact line.
