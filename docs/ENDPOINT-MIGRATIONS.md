# Configured endpoint replacements

An adapter can name a replacement SDK method for a retired OpenAPI endpoint. Refit checks the recorded contracts and changes only the SDK resource/method tokens on supported direct calls. Arguments, client options, imports, dependencies and API-version configuration stay as they were. The mapping is supplied by the operator after reviewing the provider's migration guidance and SDK behavior. Source and replacement `resource` values can be dot-separated identifier paths up to 256 characters. For example, `inventory.legacy.items.retrieveLegacy` can become `inventory.current.products.get`; resource depth may change. Static named access is required, and optional or computed invocations stay review-only. SDK inventory, mutation checks, contract correlation, response tracing and post-patch rescanning use the same nested path handling.

```json
{
  "id": "catalog-endpoint-example",
  "packageName": "@example/catalog",
  "defaultImport": false,
  "namedExport": "Catalog",
  "operations": [
    {
      "resource": "items",
      "method": "retrieveLegacy",
      "schema": "Item",
      "operationId": "retrieveLegacyItem"
    }
  ],
  "operationReplacements": [
    {
      "resource": "items",
      "method": "retrieveLegacy",
      "replacementResource": "items",
      "replacementMethod": "retrieve",
      "replacementOperationId": "retrieveItem"
    }
  ]
}
```

The source must already have an adapter operation and a unique baseline `operationId`. The old path/method must disappear. The replacement ID must resolve to one newly introduced endpoint in the after contract; its ID may equal the old ID if that operation moved to a new path. Sources, replacement SDK methods and replacement IDs must be unique. Each adapter supports at most 100 replacements.

Before activating a rule, Refit compares the HTTP method, path-parameter names and required definitions, inherited and operation parameters, request body, success/error responses, effective servers, effective security and security-scheme definitions. Local component JSON-pointer references are followed, including recursive schemas, with bounded traversal. The success response must be one JSON response mapped to the same supported component object schema. External references, reference siblings, schema identifiers/anchors/dynamic references, ambiguous mappings, changed contracts and incomplete path parameters fail explicitly. Top-level operation summaries, descriptions, tags and deprecation flags are excluded from comparison; nested contract definitions are compared conservatively.

Direct calls on immutable, unescaped ESM SDK clients are eligible, including shared clients imported through supported relative named imports. Optional invocations, detected mutation/escape, method aliases, factories and unresolved client flows require review. If one tracked source call remains unsupported, the automatic workflow stops before validation or publication. Unrelated breaking changes retain their existing gates. Reports retain the mapping, contract hash and call locations as `operationChanges`; supported endpoint-removal records are handled only for that configured rule.

Equal recorded contracts do not prove business equivalence or SDK argument semantics. Confirm that the replacement method is available in the locked SDK and coordinate the API-version rollout. Refit does not update the SDK or the client version pin in this migration. Baseline checks run on the original code, patched checks run on the proposed code, and publication requires both to pass with no unresolved detected findings. Refit creates drafts for human review.

Configured endpoint replacements use deterministic edits. `--ai-patch` does not spend on model generation for these proposals, and AI repair does not reinterpret a failed endpoint mapping. Optional `--assess` still requests an advisory assessment when explicitly supplied.

## Reproduce the simulated HTTP migration

The [endpoint fixture](../pipeline/fixtures/endpoint-replacement/README.md) uses a fictional catalog API and a simulated SDK. It makes real loopback HTTP requests without credentials, npm downloads or live provider access. Its checks cover successful retrieval, preserved query/header options and propagated 404 errors. The original application uses a shared client and the retired method.

From the Refit source checkout, copy it into a new temporary repository:

```sh
cp -R pipeline/fixtures/endpoint-replacement/repository /tmp/refit-catalog-endpoint-demo
git -C /tmp/refit-catalog-endpoint-demo init -b main
git -C /tmp/refit-catalog-endpoint-demo add .
git -C /tmp/refit-catalog-endpoint-demo commit -m "test: seed simulated catalog migration"
```

`npm test --prefix /tmp/refit-catalog-endpoint-demo` passes against the before simulator. `npm run test:after --prefix /tmp/refit-catalog-endpoint-demo` deliberately fails with `Endpoint retired`. The checker creates a local link to the simulated SDK and removes it on exit; it refuses to replace an existing `node_modules` directory. Node.js with type stripping is required; the evaluated Docker image is `node:22-alpine`.

With Docker running, the Node image available and `oasdiff` on PATH, run:

```sh
node bin/refit.mjs run \
  --repository /tmp/refit-catalog-endpoint-demo \
  --before pipeline/fixtures/endpoint-replacement/before.json \
  --after pipeline/fixtures/endpoint-replacement/after.json \
  --provider-config pipeline/fixtures/endpoint-replacement/provider.json \
  --api-version 1 --full-diff --image node:22-alpine \
  --baseline-command '["node","--experimental-strip-types","simulator/check.mjs","before"]' \
  --command '["node","--experimental-strip-types","simulator/check.mjs","after"]' \
  --output /tmp/refit-catalog-endpoint-run --human
```

Both paths must be new. The workflow should return `Migration validated`, with a one-call patch from `items.retrieveLegacy(id, options)` to `items.retrieve(id, options)`. It checks isolated copies and leaves the original repository untouched. The output holds `migration.patch`, the report, logs, input contracts and draft text. No GitHub PR is published by this command.

Inspect the diff, then apply it to this temporary demo if desired:

```sh
git -C /tmp/refit-catalog-endpoint-demo apply /tmp/refit-catalog-endpoint-run/migration.patch
npm run test:after --prefix /tmp/refit-catalog-endpoint-demo
```

The before and after commands exercise different simulated contracts. Passing them verifies the recorded behaviors; it does not establish full application coverage or a real vendor migration. The gated tests additionally verify that a nonexistent replacement SDK method produces a regression and never triggers AI repair or publication.
