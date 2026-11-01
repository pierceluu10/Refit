# Shopify REST: version proof

Shopify has made the REST Admin API legacy. Refit first checks each REST Admin call against a versioned REST contract: a call that uses only what both versions state, unchanged, stays REST and moves with the version pin ([Versioned REST contract](#versioned-rest-contract)). The other REST Admin calls go to the agent fixer.

## Versioned REST contract

`data/shopify-rest-contract.json` holds, for every REST resource and Admin API version from 2022-10 to 2026-10, its endpoints (method, operation, path), the query or body parameters each endpoint's SDK method sends, and every field with its declared type. `node scripts/shopify-rest-contract.mjs` builds it from two sources, read as text and never installed or run:

- **Shopify's generated REST resources** in `@shopify/shopify-api`. Each release ships the versions it supports under `rest/admin/<version>/`; 12.3.0 has 2022-10 to 2024-07 and 15.0.1, the newest on 2026-10-29, has 2024-10 to 2026-07. Each version comes from the newest release that has it. Tarballs come from the npm registry and are checked against its SHA-512 integrity, which the file records.
- **shopify.dev's REST reference** for 2026-10, which no SDK release ships. A resource is carried from 2026-07 to 2026-10 only when its reference page (`/docs/api/admin-rest/<version>/resources/<page>.md`) has identical Endpoints, Properties and Parameters sections once the version in links is masked; examples are ignored. The file records both pages' SHA-256 per resource. 65 of the 72 resources 2026-07 has carry over. ApplePayCertificate, GiftCardAdjustment and PaymentGateway have no 2026-10 page, and Checkout, OrderRisk, Payment and ShippingZone have no reference page at all, so calls to them stay unproven. The reference is versioned: FulfillmentService's 2026-01 and 2026-04 pages differ exactly where the SDK drops `permits_sku_sharing`.

`restContractDiff` (`pipeline/shopify-rest-contract.ts`) lists what a later version lacks: resources, endpoints, parameters, fields and changed field types, plus the removals in `data/shopify-rest-deprecations.json` between the two versions. A renamed item shows as removed, because the sources do not say what replaced it. 2024-10 to 2025-01, for example, removes Customer `accepts_marketing`, Order `gateway`, Shop `eligible_for_card_reader_giveaway` and the Metafield list parameter `metafield`.

`refit rules check` verifies the file: its body digest, that every version names its source, that each carried 2026-10 resource is the 2026-07 contract with matching reference digests, and that each SDK tarball's URL and integrity still match the registry.

### What a proof needs

Refit traces each REST call with the rewrite's tracer below (paths, query parameters and every read of the response), and also reads write bodies: a client call's `data`, `fetch`'s `body` and axios `post`/`put` data, when they are object literals, directly or in `JSON.stringify`, or a `const` holding one whose other uses are property writes (`body.page.title = …`, which add their keys) or logging. A response's `text()` is a read of the whole body. The call is proven when, between the run's before and after versions:

- its endpoint is in the before contract and kept in the after one (a resource class call picks the endpoint by operation and the ids it passes; `save` must keep both create and update);
- every query parameter or resource option it sends is listed for that endpoint in both versions (`asset[key]` is `asset`; ids fill the path);
- every field it reads, and every body key it sends, under the resource's singular or plural key (or `count`), exists with the same declared type in both versions, through nested records (`orders.[].customer.email`);
- a record or field holding records that the code uses whole has every field of those records unchanged;
- no removal in `data/shopify-rest-deprecations.json` falls inside the move.

A read of `errors` at the top of a path call's response is proven too: every version's reference documents error responses as a JSON object with an `errors` key (`"errors": "Not Found"`, [status and error codes](https://shopify.dev/docs/api/admin-rest/2026-10#status-and-error-codes), read 2026-10-29 on the 2026-01 and 2026-10 pages).

Two more shapes are proven (`pipeline/shopify-rest-records.ts`, `pipeline/shopify-rest-clients.ts`):

- **A resource record built and saved in one scope.** `const page = new admin.rest.resources.Page({ session })`, then `page.title = …` and `await page.save()`: every assigned field is a body key under the resource's singular key, `save` must keep both its create and update endpoints, and every field read back (`page.id`) is a read. Serializing the record (`json({ page })`, `JSON.stringify`) reads it whole; logging reads nothing. A record built with options other than `session`, reassigned, passed to a function, returned or stored stops, because code Refit does not see could assign more fields; so does any instance method other than `save`.
- **A REST client nobody uses.** A client only returned, directly or in an object (`return { client, session }`), from a provider function that no file in the repository calls sends no request. Refit follows the provider by name through the consts and object literals that hold it, its export and default-import aliases in every other file, and allows only declarations, exports and member reads that leave the chain (`clientProvider.offline.graphqlClient(…)`). Any call, argument, array element, `require` it cannot follow, namespace import, string-keyed read, or a non-JavaScript file naming it stops; a provider held anywhere but in a const or an export (a NestJS `useFactory` in `providers: [...]`, which the framework calls by convention) is not followed.

What stops, naming the item: a removed or retyped endpoint, parameter or field; anything the before contract does not list (an undocumented parameter such as `phone` on `customers.json`, a response key other than the resource's or `errors`, a body key such as DraftOrder's `use_customer_default_address`, which shopify.dev shows only in examples, not in the resource's Properties); a read inside a field the contract describes only as an object (`{[key: string]: unknown}`); the result of a delete used whole; a body that is not an object literal; a resource record that leaves its scope; a REST client used in any way but calls Refit proves or none; and every call the tracer cannot follow.

A proven call is not rewritten. It stays REST, the version pin moves as for GraphQL (with the SDK upgrade and lockfile handling of [Shopify](SHOPIFY.md)), and the draft lists it. In validation the schema proof ([Shopify proof](SHOPIFY-PROOF.md)) counts REST calls only when every one is proven. Calls the contract cannot prove go to the GraphQL rewrite below, and otherwise stop with the contract's reason as the review.

The contract states what Shopify's generated resources and reference describe. It says nothing about behaviour they do not describe, such as a default that changes while a field keeps its type; the repository's own checks still run.

## REST calls the contract does not prove

Refit no longer rewrites REST calls itself. A REST call the contract does not prove goes to the [agent fixer](SHOPIFY.md#agent-fixer), with the contract's reason, the REST to GraphQL mappings in `data/shopify-rest-graphql.json` (each quoting the REST reference and the GraphQL page) and its `nonEquivalent` endpoints as context. The contract prover and the schema proof judge the agent's patch ([Shopify proof](SHOPIFY-PROOF.md)).
