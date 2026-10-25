# Migrate changed SDK request fields

Refit 0.12 can rename top-level JSON request fields across configured providers. An operator supplies the SDK method, its body argument position and the old/new property names. Refit resolves the operation in both contracts and verifies that the complete recorded operation differs only by those configured names. The shared scanner, worker, Docker checks and draft publisher then handle the migration.

This applies to request construction such as `client.items.create({ legacy_name, quantity }, options)`. A supported patch changes it to `client.items.create({ display_name: legacy_name, quantity }, options)`. The function parameter, value expressions, property order, other body fields, positional arguments and call options remain intact. Existing response-field and endpoint rules remain available.

## Configure a reviewed mapping

The complete fictional catalog adapter is:

```json
{
  "id": "catalog-request-example",
  "packageName": "@example/catalog",
  "defaultImport": false,
  "namedExport": "Catalog",
  "apiVersion": { "constructorArgument": 0, "property": "apiVersion", "requestArguments": [] },
  "operations": [
    { "resource": "items", "method": "create", "schema": "Item", "operationId": "createItem" }
  ],
  "requestPropertyRenames": [
    {
      "resource": "items",
      "method": "create",
      "argumentIndex": 0,
      "removed": "legacy_name",
      "replacement": "display_name"
    }
  ]
}
```

`schema` continues to identify the SDK response. The request component is discovered from the mapped OpenAPI operation's body. `argumentIndex` is zero-based, from 0 to 16. SDK resources support existing nested names such as `chat.completions`. Up to 100 request rules are allowed; names are identifier-style fields, and `__proto__` is refused. Each SDK operation must have an existing unique `operationId`, one selected body argument, and distinct source/target mappings. Several field renames can be verified together on that operation.

The operator must verify that SDK argument keys correspond to those wire properties, that the installed SDK accepts the replacement, and that the fields mean the same thing. Refit does not infer SDK serialization or business semantics from an OpenAPI name. Dependencies, exported functions and API-version settings are not upgraded by this rule.

## Contract and source gates

The operation must retain the same unique ID, path and HTTP method. Its body must have exactly one `application/json` media entry referencing a supported local component object. Local request-body references and component aliases are resolved. Each removed field must exist before, disappear afterward, and be replaced by a field absent before. Refit normalizes all active configured names and their required-property entries, then compares the complete referenced operation: constraints, requiredness, other fields, response definitions, parameters, effective servers and security must match. Reference siblings, external/dynamic/anchored references and unsupported bodies stop the rule. Traversal stays bounded by the shared contract comparator.

Direct object literals support ordinary, quoted and shorthand field declarations. Shorthand replacements retain the original variable. Spreads, computed names, duplicate keys, methods/accessors, request aliases, type assertions, conditional bodies and requests already supplying both names require review. Optional SDK calls and mutated/escaped clients remain review-only. Imported shared clients and nested SDK resources use the existing symbol resolver; an awaited response is not required to identify a request call.

Every traced call for an affected mapping must have supported request construction before its breaking changelog entries are considered handled. Only exact recognized request-property removal and new-required-property entries on the reviewed path/method are covered. Other breaking changes retain their gates. A mix of supported and uncertain requests stops automatic execution before model generation or validation. Absence of a finding still does not prove complete usage coverage.

These proposals are deterministic, including when `--ai-patch` is supplied. Explicit request mappings are not handed to AI generation or repair. A failing check retains failure evidence and needs correction or an explicit retry after its cause is resolved. Ordinary optional AI assessment remains advisory and separately authorized. API-version applicability and source-verification policies still apply.

Human output identifies the SDK method, argument index and field replacement. Draft descriptions put that context above the collapsed JSON evidence. Publication independently requires supported request evidence, passing before/after checks, no unresolved findings and the current GitHub base. Named integration PR isolation remains in effect.

## Reproduce the offline migration

Use Git, Node 22.12+, `oasdiff`, Docker and a local `node:22-alpine` image. From the Refit checkout, create a disposable application:

```sh
cp -R pipeline/fixtures/request-renames/repository /tmp/refit-request-app
cp pipeline/fixtures/request-renames/{before,after,provider}.json /tmp/refit-request-app/
git -C /tmp/refit-request-app init -b main
git -C /tmp/refit-request-app add .
git -C /tmp/refit-request-app commit -m "test: seed request migration demo"
refit run --repository /tmp/refit-request-app \
  --before /tmp/refit-request-app/before.json --after /tmp/refit-request-app/after.json \
  --provider-config /tmp/refit-request-app/provider.json \
  --api-version 1 --api-version-policy source-verified --full-diff \
  --image node:22-alpine \
  --baseline-command '["node","--experimental-strip-types","simulator/check.mjs","before"]' \
  --command '["node","--experimental-strip-types","simulator/check.mjs","after"]' \
  --output /tmp/new-refit-request-run --human
```

Both temporary paths must be new. The application remains unmigrated; only isolated validation copies receive the patch. The simulator checks exact body values, request IDs, a fixed version header and propagated errors. Response behavior is forced independently of that header, so this is migration conformance, not a verified provider rollout. The [fixture README](../pipeline/fixtures/request-renames/README.md) includes the expected original-code failure and a real OpenAI SDK test with a synthetic request-field rename.

For monitoring, use the same approved workflow fields in `.refit.json` and point `after` at a committed current contract or configure a public source. [App onboarding](APP-ONBOARDING.md), [multiple integrations](MULTIPLE-INTEGRATIONS.md), dependency preparation and the shared spending ledger keep their existing behavior. Request-rule changes alter adapter approval and require reapproval. Baselines never advance automatically.

## Removed request parameters

Without any rule, Refit compares each mapped operation's top-level request body parameters in both contracts. A traced SDK call whose direct object-literal body still sends a removed parameter is a confirmed finding (`request-parameter:<operationId>.<parameter>`), and the run stops for review before any patch, AI request or publication: dropping or replacing a parameter changes what the request does, so a human chooses. Path parameters are positional before the body, so `customers.update(id, params)` is checked at argument 1. Bodies built elsewhere (variables, spreads) are not traced, and a parameter covered by an operator-authored rename is migrated by that rule instead.

Example: Stripe `2026-09-30.endive` no longer accepts `payment_method_types` on `POST /v1/checkout/sessions`. Before this check, 4 of the 5 held-out validation regressions were patches whose upgraded SDK types rejected that parameter.

One owner-approved exception has a built-in rule ([policy](STRIPE-PAYMENT-METHOD-TYPES.md)). A literal `payment_method_types: ['card']` on Checkout Session, PaymentIntent or SetupIntent creation becomes `allowed_payment_method_types: ['card']`. The rule applies only when the same patch moves the `apiVersion` literal to the target and, in a TypeScript project, upgrades `stripe` to the target's release. The draft PR asks the reviewer to confirm cards stay enabled, because the new field filters the dynamically eligible methods instead of listing them. Any other value, or a repository that also sends another value, still stops.

A second built-in rule lowercases currency codes ([details](STRIPE-CURRENCY-CODES.md)). Where the target contract gives a request `currency` the `currency` format, an uppercase literal written in a traced call's own request, such as `currency: 'USD'`, becomes `'usd'`, because [Stripe's currency page](https://docs.stripe.com/currencies) asks for lowercase three-letter ISO codes in every payment request. Constants, computed values and test files are not edited, and a call that sends them still stops.
