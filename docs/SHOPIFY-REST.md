# Shopify REST → GraphQL rewrites

Shopify has made the REST Admin API legacy. Refit rewrites REST Admin reads as GraphQL Admin queries where Shopify documents the mapping, and leaves everything else as a stop for review. Every rewrite ships in a `[Needs review]` draft.

## What is rewritten

A REST call is rewritten only when all of these hold:

1. **A rule covers the endpoint.**
   - `data/shopify-rest-graphql.json` holds 12 GET rules: `shop.json`, `products.json`, `products/{id}.json`, `products/count.json`, `variants/{id}.json`, `orders/{id}.json`, `customers.json`, `customers/{id}.json`, `customers/count.json`, `webhooks.json`, `themes.json` and `pages.json`.
   - Each rule quotes the REST reference and the GraphQL page it names. It maps only fields that Shopify's REST pages map to a GraphQL field.
   - Endpoints whose GraphQL counterpart returns different rows are recorded as `nonEquivalent` and never rewritten, not even by AI: `orders.json` and `orders/count.json` (REST defaults to open orders), `locations.json`, `custom_collections.json` and `smart_collections.json`.
2. **Refit recognises the call.**
   - `fetch(url, init)` and `axios.get(url, config)` on a versioned `/admin/api/<version>/…json` URL.
   - Remix `admin.rest.get({ path, query })`.
   - `client.get({ path, query })` on a `const client = new shopify.clients.Rest({ session })`.
   - The resource classes `admin.rest.resources.X.all/find/count` and `shopify.rest.X.all/find/count`.
3. **Refit traces every field the code reads.**
   - It follows the response through `await`, `.then`, `.json()`, `.data`, `.body`, destructuring, `const` and `let` that are never reassigned, `map`/`filter`/`find`/`for…of`, optional chaining, `||` and `??` defaults, and conditions.
   - A read the rule does not produce stops the rewrite. So does a response used whole: returned, stored or passed to unknown code.
   - Logging (`console.*`) is not a read, and the draft says logged bodies change.
4. **Every query parameter has a mapping.**
   - `limit` becomes `first` (REST's default is 50), and `page_info` becomes `after`.
   - `fields` is dropped, because the adapter returns only the fields the code reads.
   - Any other parameter stops the rewrite.
5. **The generated document validates** with graphql-js on the before and after Admin schemas.

## What the rewrite looks like

The call expression becomes an async function evaluated in place, with a comment naming the rule's source. It does three things:

- sends the GraphQL document through the same transport and credentials (same host, version and headers for `fetch` and axios, `admin.graphql` for Remix, `new <shopify>.clients.Graphql({ session })` for the SDK);
- rebuilds the REST JSON shape from the GraphQL result, for the fields the code reads only;
- returns what the original returned: a `Response`, an axios response, `{ body }`, a resource `{ data, pageInfo }` or a record.

The code that reads the result is unchanged.

Conversions are explicit in the rule:

- `gid-number`: `gid://shopify/Product/1` becomes `1`;
- `lowercase`: an enum becomes REST's lower case;
- `join-comma`: tags become `"a, b"`.

A REST client whose every call is rewritten becomes a GraphQL client in its own declaration, so the session is read where and when it was; if any use stays REST, none of its calls are rewritten. A URL `const` used once moves into the call only when both sit in one function and nothing reassigns or redeclares the names it reads. A response held in a `var`, a callback that reads `arguments`, and a dynamic key into a nested object stop the rewrite. REST writes (POST, PUT, DELETE, resource `save()`) are never rewritten.

## Behaviour differences the draft lists

- **Errors:** they come back as GraphQL errors, either a thrown `Error` or a 400/404 `Response`, not as REST status codes.
- **Timestamps:** they are UTC.
- **Nested lists:** they stop at 250 entries.
- **Money:** amounts are GraphQL `Decimal` strings.
- **Each rule's `notes`:** the draft lists them too.

## AI for endpoints without a rule

With `--ai-patch`, a GET that Refit understands but no rule covers goes to the model. The model proposes a mapping in the rule format; it writes no code. A kept mapping may rewrite any call in the file that it fully covers, under the same per-call gates as a documented rule. Refit keeps the mapping only when all of these hold:

- the REST resource is in `data/shopify-rest-resources.json`, the field types of `@shopify/shopify-api` 15.0.1's REST resources, generated from the verified tarball by `scripts/shopify-rest-resources.mjs`;
- every GraphQL path exists on both schemas, and every conversion fits its GraphQL type;
- every mapped value has the type the REST resource declares. Ids accept numbers, because REST JSON sends numbers where the SDK declares `string`;
- it sends no constant argument except `null`, puts no arguments in its root field, uses no field arguments other than `first: 250`, and takes arguments only from path placeholders, each used exactly once. Any of these could change which records come back;
- it maps no enum values (REST and GraphQL differ in case) and no nested objects (Refit has no REST types for them), and every numeric REST id read from a GraphQL `ID` converts with `gid-number`;
- re-running the file with the mapping rewrites that call, with every read produced and the document valid on both schemas.

The repository's type check then runs in validation like any other check. Attempts and costs are recorded under `shopify.restAi`.

## Proof

The generated documents are ordinary traced Admin documents, so [Shopify proof](SHOPIFY-PROOF.md) validates them on the patched code. REST rewrites always publish as `[Needs review]` (`unresolvedFindings`). Live calls on Refit's development store could raise the grade, but they exercise the GraphQL document, not the adapter, so the draft stays `[Needs review]`.

## Measured

Measured offline on SH3's 250 non-blind Shopify repositories (the 2026-10-16 lists), on 2026-10-29, without AI:

- the 54 repositories that use REST make 180 REST calls;
- 15 calls in 11 repositories are rewritten, and 3 repositories have every REST call rewritten;
- every rewrite was read by hand, and all are correct for the fields the code reads.

The largest remaining stops:

- 30 calls to endpoints with no rule and 8 reading fields a rule does not map (the AI path);
- 25 REST clients still used by other calls;
- 19 resource records built and saved, plus 14 other REST writes;
- 22 client calls whose `query` is built at runtime or whose client Refit does not follow;
- 8 URLs not passed straight to `fetch` or axios, and 7 responses used whole.

AI was not measured, because no OpenAI key is available outside the benchmark.
