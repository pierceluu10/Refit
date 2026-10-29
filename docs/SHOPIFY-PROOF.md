# Shopify proof

Written 2026-10-29. This covers the Proof column of [Shopify and Meta Graph engines](SHOPIFY-META-ENGINES.md), and AI uses 3 (behaviour tests) and 5 (second opinion). Proof levels are the ones in [Proof-based validation](PROOF-BASED-VALIDATION.md).

Shopify publishes a GraphQL schema for each Admin API version. Every document the code sends can be checked against the schema of the version it will run on. That is the main proof for a Shopify patch, ahead of the repository's own checks.

## Offline schema proof

`pipeline/shopify-proof.ts` (`shopifySchemaProof`) runs on every Shopify validation. It needs no network and no credentials.

- Each traced document in the original code is validated with `graphql-js` against the original version's pinned schema. Failures are recorded as `originalFailures`: they already fail before the patch.
- Each traced document in the patched code is validated against the target version's schema. `#graphql` literals no Admin call reaches are checked too. A literal that fails on both versions targets another Shopify API and is listed under `otherApi`.
- A valid document can still break, so these count as failures too:
  - a selected field whose type changes (a nullable output that becomes non-null is allowed);
  - a variable whose input type loses a field, changes a field's type, gains a required field with no default, or loses an enum value. Variables are not checked by GraphQL validation, so this is checked separately.
- **Fragments** defined in another file, or in a `.graphql` or `.gql` document, are inlined before validation, as the scan does. A fragment defined twice with different text is still unreadable.
- **Codegen.** Where the repository generates types (`.graphqlrc.*` or a `codegen` config naming `@shopify/api-codegen-preset` or `@graphql-codegen/`) and commits them (a file declaring `@shopify/admin-api-client` or importing `@graphql-typed-document-node/core`), the committed types count for the target only if nothing the documents use differs between the versions. Generated types the repository does not commit never reach the type check, because the sandbox cannot run codegen offline, so codegen then counts for nothing either way. That covers selected fields, variable input types, enum values and union members. Refit cannot regenerate the types offline. Where an enum or union the documents select gains members, the type check ran on stale types, so the proof is `unproven`.
- **No Admin request.** Code with no Admin GraphQL call or document, no REST call and no webhook subscription registered in code (`DeliveryMethod`) sends nothing whose behaviour depends on the Admin API version, so a version move is `proven` there.
- **REST calls** count only when the versioned REST contract proves every one of them ([REST contract](SHOPIFY-REST.md#versioned-rest-contract)); one it cannot prove makes the proof `unproven`, naming the call and the item. Code whose only Admin requests are proven REST calls, with no webhook subscription registered in code, is `proven`.
- The proof is `failed` when any patched document fails. It is `unproven` when the code sends a document Refit cannot read (built at runtime, or a fragment it cannot inline) and no kept AI reconstruction exists for that call ([Shopify](SHOPIFY.md)), when Admin calls exist but there is no document to check, or when committed codegen types are stale.

## Live proof (optional)

`pipeline/shopify-live-proof.ts` runs only when both `SHOPIFY_TEST_STORE` and `SHOPIFY_TEST_TOKEN` are set, and only once the schema proof holds.

- **Credentials.** A ready Admin API token in `SHOPIFY_TEST_TOKEN` (for example a legacy custom app token, `shpat_…`) is used as is. Without one, `SHOPIFY_TEST_CLIENT_ID` and `SHOPIFY_TEST_CLIENT_SECRET` are exchanged at run time with Shopify's [client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant) (read 2026-10-29). Refit sends a form-encoded POST to `https://<store>/admin/oauth/access_token` with no `scope` parameter. The token lasts 24 hours and carries the scopes the installation granted. Per that page, the grant works only for a Dev Dashboard app installed on a store in the app's own organization; otherwise Shopify answers `shop_not_permitted`, and live proof is recorded as not run with that code. Neither the secret nor the token is ever logged.
- The store must be a bare `<name>.myshopify.com` domain from that variable. Nothing comes from the repository, so a customer's store is never used. Before sending anything else, Refit asks the store for `shop.plan.partnerDevelopment` and stops unless it is `true`.
- Refit sends each operation of every traced patched document itself: at the original version (with the original document) and at the target version (with the patched one). No repository code runs. Every operation must succeed on both versions, with no GraphQL errors and no `userErrors`. Only then is the live proof `passed`.
- **Queries** are read-only and always allowed. A query with required variables needs a case.
- **Mutations** run only with a case, and only on objects the same run created:
  - setup steps must only create (every root field ends in `Create`);
  - the mutation under test must either only create, or receive only IDs a setup step returned;
  - cleanup steps must only delete, and only those IDs;
  - a document that names a `gid://` ID itself is refused.
  - Each version gets its own setup. Created IDs and whether cleanup deleted them are recorded under `created`.
- **Cases** come from AI use 3 (`writeShopifyLiveCases` in `pipeline/shopify-ai.ts`) when AI is enabled. The model writes variables and setup and cleanup steps that refer to earlier results by `$ref`. A case is dropped unless every setup and cleanup document validates at both versions. The store rules above apply again before anything is sent.
- **Token safety.** The token travels only in the `X-Shopify-Access-Token` header. Recorded errors are truncated and have the token removed. Malformed settings are refused without echoing them.

This does not reuse the #386 sandbox harness, which runs repository code against a provider proxy. Shopify documents are static strings Refit already holds, so sending them directly gives the same proof without running customer code.

## Proof levels for a Shopify patch

`shopifyGrade` replaces the checks' grade for Shopify reports (`validation.grade`, with the details in `validation.shopifyProof`):

| Level | What proves it                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------- |
| A     | Schema proof holds, and every operation passed on the development store at both versions       |
| B     | Schema proof holds, and the repository's tests reach every changed file                        |
| C     | Schema proof holds, and the type check covers every changed file with no new errors            |
| D     | Schema proof failed or is unproven, or no check passed; the draft is `[Needs review]` with why |

A codegen configuration the patch changes only in its version pin (`codegenPinFiles`) is left out of "every changed file": the pin selects only the schema codegen generates types from, and the schema proof covers that schema. `.graphqlrc.ts` is usually outside the app's `tsconfig.json`, so no type check could cover it.

Passing checks without schema proof stay grade D, because they say nothing about the documents.

A patch that changes a document's variable definitions (a migration in `pipeline/shopify-migrations.ts`) is also grade D unless the development store ran every such operation and it passed: schema validation cannot see whether the code sends what the document now declares. The migration writes that operation's case itself (a product it creates, the variant it updates, the keys the code sends with stand-ins where the code computes a value, and the product deleted afterwards). Where the original document already fails on the before version, the live run sends the patched document at both versions.

## AI second opinion (advisory)

With `--assess` (or `--ai-patch`), every Shopify patch gets a second opinion (`reviewShopifyPatch`). The model reads the diff, the summary, the warnings and the schema proof's result. It names concrete problems that schema validation cannot see. Its verdict is recorded under `validation.shopifyProof.review`, and the draft shows it as "AI Second Opinion (advisory; it does not change the grade)". It never sets the grade, clears a stop or holds a draft.

The cost of each AI request is recorded: `review.costUsd`, `liveCases.costUsd`, and their sum, `aiCostUsd`. The Shopify benchmark copies the grade, both proof statuses and `aiCostUsd` into each row, and passes `--assess` to `refit run` with `npm run benchmark:shopify -- --validate --assess`.

## Not covered

- Behaviour that validation cannot see: semantics, defaults, pagination, rate limits and webhook payload versions.
- Enum values added to a selected output field when the repository does not use codegen. These are not treated as breaking, as for Stripe.
- Subscriptions are never sent to the store.
- Live proof is not yet measured on a benchmark. No run was started for this change.
