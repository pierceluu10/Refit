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
- **Codegen.** Where the repository generates types (`.graphqlrc.*` or a `codegen` config naming `@shopify/api-codegen-preset` or `@graphql-codegen/`), the committed types count for the target only if nothing the documents use differs between the versions. That covers selected fields, variable input types, enum values and union members. Refit cannot regenerate the types offline. Where an enum or union the documents select gains members, the type check ran on stale types, so the proof is `unproven`.
- The proof is `failed` when any patched document fails. It is `unproven` when the code sends a document Refit cannot read (built at runtime, or a fragment it cannot inline), when there is no document to check, or when codegen types are stale.

## Live proof (optional)

`pipeline/shopify-live-proof.ts` runs only when both `SHOPIFY_TEST_STORE` and `SHOPIFY_TEST_TOKEN` are set, and only once the schema proof holds.

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

Passing checks without schema proof stay grade D, because they say nothing about the documents.

## AI second opinion (advisory)

With `--assess` (or `--ai-patch`), every Shopify patch gets a second opinion (`reviewShopifyPatch`). The model reads the diff, the summary, the warnings and the schema proof's result. It names concrete problems that schema validation cannot see. Its verdict is recorded under `validation.shopifyProof.review`, and the draft shows it as "AI Second Opinion (advisory; it does not change the grade)". It never sets the grade, clears a stop or holds a draft.

The cost of each AI request is recorded: `review.costUsd`, `liveCases.costUsd`, and their sum, `aiCostUsd`. The Shopify benchmark copies the grade, both proof statuses and `aiCostUsd` into each row, and passes `--assess` to `refit run` with `npm run benchmark:shopify -- --validate --assess`.

## Not covered

- Behaviour that validation cannot see: semantics, defaults, pagination, rate limits and webhook payload versions.
- Enum values added to a selected output field when the repository does not use codegen. These are not treated as breaking, as for Stripe.
- Subscriptions are never sent to the store.
- Live proof is not yet measured on a benchmark. No run was started for this change.
