# Request-field migration conformance

This is an internal simulated catalog API and SDK, not a real vendor. The before contract accepts `CreateItem.legacy_name`; the after contract removes it and requires `display_name` with the same constraints. `items.create` is explicitly mapped to OpenAPI `createItem`, and `requestPropertyRenames` selects its first SDK argument. The small TypeScript application uses a shared client and an ordinary shorthand request object.

The simulator makes actual loopback HTTP requests through the fixture SDK, checks the entire body, request ID and version header, and propagates a 503 error. Its response mode is forced independently of the fixed application version. No repository scanner code is imported into the application. Before passes, after deliberately fails until Refit's patch is applied in a disposable copy. Client version configuration and dependencies stay unchanged; a real API rollout still needs coordination.

From the fixture's `repository` directory, with Node 22.12+:

```sh
npm test
npm run test:after
```

The second command is expected to fail with `Missing required item name`. Neither needs credentials or downloads a package. The harness creates its local SDK link and removes it afterward; it refuses to replace an existing `node_modules` directory.

From the Refit checkout:

```sh
REFIT_DOCKER_IMAGE=node:22-alpine REFIT_OASDIFF=/opt/homebrew/bin/oasdiff \
REFIT_OPENAI_SDK=1 REFIT_NPM_PREPARE=1 \
npm test -- pipeline/request-rename-docker.test.ts --maxWorkers=1
```

The optional OpenAI variant reuses the real **OpenAI 7.32.0** client fixture and simulates a **request** `model` → `model_id` rename on `chat.completions.create`. This change is invented, not historical or announced by OpenAI. The SDK serializes real HTTP requests to a loopback server with an explicit dummy key. Tests demonstrate the original request fails against the changed contract, then verify the patched body, unchanged headers and propagated 400. npm prepares locked packages; application checks run in offline Docker. No model generation or vendor-server request is involved. SDK configuration follows the [official TypeScript SDK reference](https://developers.openai.com/api/reference/typescript).

Mixed dynamic request construction remains review-only; failing patched checks never trigger AI repair of an explicit mapping. See [request migration configuration and boundaries](../../../docs/REQUEST-MIGRATIONS.md).
