# Validate npm workspace repositories

Refit can prepare a committed root npm lockfile and its selected workspace manifests, then validate an API migration across the repository in offline Docker. No new workflow flag is needed: use `prepareDependencies: true` and commands that select the appropriate workspace.

For example, a checked-in `.refit.json` can contain:

```json
{
  "formatVersion": 1,
  "before": "./api/before.json",
  "after": "./api/current.json",
  "apiVersion": "2022-08-01",
  "apiVersionPolicy": "source-verified",
  "image": "node:22-alpine",
  "prepareDependencies": true,
  "baselineCommand": ["npm", "test", "--workspace", "@example/billing"],
  "command": ["npm", "test", "--workspace", "@example/billing"]
}
```

Replace the example paths, version and workspace name with the repository's actual contracts and checks. This is a configuration example, not a historical migration for that package. `npm test --workspaces` can check all workspace packages; select commands deliberately so sibling behavior is covered. Different before/after simulator commands require the same review as single-package workflows.

```sh
refit doctor --repository /path/to/monorepo
refit prepare --repository /path/to/monorepo --image node:22-alpine
refit run --repository /path/to/monorepo --config /path/to/monorepo/.refit.json \
  --output /tmp/new-workspace-run --human
```

The existing `watch`, enrollment and App service paths use the same preparation. Repository approval and migration gates still apply. Scanning does not automatically resolve a shared SDK client imported by a workspace package name; supported relative client imports and reviewed provider mappings are described in [client modules](CLIENT-MODULES.md).

## What is prepared

Only committed root/workspace `package.json` files and the root `package-lock.json` enter the networked install container. Application source, `.env`, `.npmrc` and repository scripts are not copied or executed there. `npm ci` installs public locked dependencies with lifecycle scripts disabled.

`workspaces` may be an array of up to 64 positive relative globs, or `{ "packages": [...] }` with no other keys, the form Shopify's app templates use; npm reads both the same way. Negations, escaping paths and other object declarations require a custom image.

The validator compares each workspace's dependencies, name and version against its lockfile importer. Links must name and target declared committed workspaces. Installation checks the actual links and physical dependency directories before archiving root and nested `node_modules`. The archive contains dependencies and links; workspace source comes from the separate committed application snapshot during offline validation.

Workspace manifest hashes are part of the cache identity and environment evidence. Even a script-only manifest change creates a new environment. Changed source alone need not reinstall dependencies. Verified repeat preparations reuse the cache. Recipe 3 separates these environments from older preparation bundles.

## Supported boundaries

- Root npm lockfile versions 2 and 3; at most 20,000 package records.
- Up to 64 committed workspace packages with explicit, unique npm names.
- Array declarations with positive relative patterns such as `packages/*`, `apps/**`, literal paths and brace groups. Leading `./` and trailing slashes are normalized.
- Public registry packages and implicit workspace links selected by npm. Ordinary version ranges such as `"@example/shared": "*"` can refer to a declared workspace.
- Root and workspace dependency versions can differ; nested dependency directories are retained.

Negative patterns, object workspace declarations, nested workspace declarations, workspace `bin` entries, bundled dependencies, explicit `file:`, `link:` or `workspace:` protocols, Git/URL/private dependencies, tracked dependency directories, tracked symlinks and submodules require the custom-image path. Packages that require install/build scripts also need a prepared custom image. Refit does not enable those scripts automatically. pnpm and Yarn lockfiles are outside this npm feature.

## Offline conformance example

The bundled `pipeline/fixtures/npm-workspaces/repository` is a synthetic TypeScript billing monorepo. It uses Stripe 19.1.0 at the root, Stripe 10.17.0 inside the billing workspace and a linked local ID package. Its test wrapper reuses the canonical Stripe HTTP simulator, staged as `simulator/stripe-contract.mjs` when the test repository is assembled; no simulator implementation is duplicated.

The tests demonstrate the original history failure after the simulated historical API removal, then validate Refit's patch with multi-page and empty history, exact version headers and TypeScript. They also check manifest-only install inputs, lifecycle-script suppression, nested dependencies, cache reuse/invalidation and stale graph refusal. They use loopback responses and dummy credentials, with no live Stripe charge or paid AI request.
