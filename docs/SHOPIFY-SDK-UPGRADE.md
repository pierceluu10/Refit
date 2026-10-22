# Shopify SDK upgrade (opt-in)

**Status: off by default.** Needs owner decision: enable by default. Until then a run proposes the upgrade only when asked to.

## Why

In the [200-app fresh Shopify list](benchmarks/2026-10-16-shopify-fresh-repos.json), 44 apps stop only because their locked `@shopify/shopify-api` cannot name the target `ApiVersion` member, at main `7b2c86a`. They pin `ApiVersion.<member>` or use `LATEST_API_VERSION`, and every member for a supported Admin API version ships in a newer SDK major than the one they lock. These 44 apps are frozen in [`2026-10-22-shopify-sdk-upgrade-repos.json`](benchmarks/2026-10-22-shopify-sdk-upgrade-repos.json).

## Turning it on

- `refit run --shopify-sdk-upgrade`, or `"shopifySdkUpgrade": true` in `run.json`.
- `npm run benchmark:shopify -- --sdk-upgrade` for the benchmark.

It runs only when the version move needs it: the code uses `LATEST_API_VERSION` or an `ApiVersion` enum pin outside a codegen config, and the locked `@shopify/shopify-api` does not define the target member. Otherwise the run behaves exactly as with the flag off.

## What it upgrades

The upgrade moves the one Shopify package the project declares to the oldest major that serves a supported Admin API version. Each of these majors depends on `@shopify/shopify-api` 12, whose 12.1.0 first ships `ApiVersion.January26`.

| Declared package                    | Target major |
| ----------------------------------- | ------------ |
| `@shopify/shopify-api`              | 12           |
| `@shopify/shopify-app-remix`        | 4            |
| `@shopify/shopify-app-react-router` | 1            |
| `@shopify/shopify-app-express`      | 6            |

The target release is the oldest in that major whose `@shopify/shopify-api` names the target member: 12.1.0 for `January26`, 12.3.0 for `April26`. `July26` (13.1.0) and `October26` (14.0.0) need a later major, so the upgrade refuses them. With `--sdk-upgrade`, the benchmark aims `LATEST_API_VERSION` and enum pins at the newest member that major has. Today that member is `April26`.

The upgrade writes `package.json` and `package-lock.json` the way the [Stripe package upgrade](DEPENDENCIES.md) does. It uses npm registry metadata and locks only releases that metadata gives with the canonical registry tarball URL and a SHA-512 integrity. It follows npm's key order and package order.

- Packages from Shopify/shopify-app-js move together: the API, app and session-storage packages, `admin-api-client`, `storefront-api-client` and `graphql-client`. A session-storage adapter moves to the first release built for the new `@shopify/shopify-api`.
- Any other package is added or moved only when it has no dependencies of its own (for example `isbot`, `lossless-json`, `compare-versions`). Lock entries that nothing requires any more are removed.
- A release with install scripts, `bin`, `os`/`cpu`, optional or bundled dependencies, or a native build is refused.

## Source edits it makes

Only in files that import a Shopify package:

- **`LATEST_API_VERSION` becomes `ApiVersion.<member>` where it sets `apiVersion`.** `@shopify/shopify-api` 12.0.0 (48d3631), `@shopify/shopify-app-remix` 4.0.0 (762224d) and `@shopify/shopify-app-react-router` 0.2.0 (c02018f) removed it. The import (ESM `import`, or a CommonJS `const { … } = require(…)`) is renamed to `ApiVersion`, or dropped when `ApiVersion` is already imported.
- **`removeRest: true` is dropped from a `shopifyApp` or `shopifyApi` config's `future` flags.** `@shopify/shopify-app-remix` 4.0.0 (d7bd799) removed REST and the flag, so `true` was already the only behavior.

## What stops for review

Every stop names the file, line and reason. The citations are the shopify-app-js changelogs and the [v12 migration guide](https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/docs/migrating-to-v12.md), read on 2026-10-22.

| Stop                                                                                                                                                                                           | Source                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `LATEST_API_VERSION` used anywhere but an `apiVersion` value, or imported under another name, as a type, with a default value, beside a default import or through a namespace                  | 48d3631                                                         |
| A `shopifyApp` or `shopifyApi` config with no `apiVersion` Refit can see (express settings are read under `api`)                                                                               | 48d3631: `apiVersion` is required                               |
| `RELEASE_CANDIDATE_API_VERSION`                                                                                                                                                                | 48d3631                                                         |
| `getJwt` (now async) and `setCrypto` (use `globalThis.crypto`)                                                                                                                                 | dc41d09                                                         |
| `future.lineItemBilling`, `future.v10_lineItemBilling`, a `billing` config, or any `.billing` use                                                                                              | a5be0d0; `billing.check` returns an object (migration guide)    |
| A `future` flag the upgraded package does not accept. The accepted flags were read from the published types of shopify-api 12.3.0, shopify-app-remix 4.1.1 and shopify-app-react-router 1.1.1. |                                                                 |
| `future` flags that are not an object literal, or a spread, shorthand or computed flag                                                                                                         |                                                                 |
| `future.removeRest` set to anything but `true`, or `removeRest` elsewhere                                                                                                                      | d7bd799                                                         |
| REST Admin API use (already a stop without the upgrade)                                                                                                                                        | c3005a6: REST IDs become strings; d7bd799: remix 4 removes REST |

Before any edit, the upgrade also refuses these projects:

- **Lockfiles.** A lockfile other than a lone root `package-lock.json` (pnpm, yarn, bun, shrinkwrap, or none), a lockfile version other than 3, a lockfile not in npm's formatting or order, or nested copies of a Shopify package.
- **Packages.** More than one Shopify app package, or a package more than one major behind the target. The migration guides in between are not applied.
- **Resolution.** A lockfile that cannot take the upgrade without npm resolving it again, because a new release needs a range the lockfile does not satisfy and the package is not dependency-free. The reason names each range and the locked version.

Every proposed upgrade warns that `@shopify/shopify-api` 12 requires Node.js 20.10 or later (dc41d09). The published `engines` field says `>=20.0.0`; Refit uses the changelog's stricter bound.

## Results on the 44 (Refit `cedb1aa`, 2026-10-22)

| Outcome             | Apps                      |
| ------------------- | ------------------------- |
| Validated           | **0**: Blocked, see below |
| Regressed           | 0: not run                |
| Proposed, scan only | **7**                     |
| Stopped             | **37**                    |

The 44 were rerun with the flag on locally (`npm run benchmark:shopify -- --list docs/benchmarks/2026-10-22-shopify-sdk-upgrade-repos.json --sdk-upgrade`). Both planned routes for that run were Blocked:

- **AWS.** The run could not launch on AWS: `ec2:RunInstances` is explicitly denied by an organization service control policy (retried once; `status` showed no instances and `stop` was run).
- **Docker.** Local Docker was unresponsive, so no proposed patch was validated in offline Docker. No AI was used (spend: $0), and nothing contacted a store.

All seven proposed diffs were read in full. Each is **correct** as a proposal, though none has been validated:

- **johnshields/northstar** (`@shopify/shopify-api` 11.14.1 → 12.3.0)
  - The CommonJS `require` renames `LATEST_API_VERSION` to `ApiVersion`, and `apiVersion` becomes `ApiVersion.April26`.
  - The lockfile adds `lossless-json` 4.3.3, moves `isbot` to 5.2.2 and drops `@shopify/network`, the `jsonwebtoken` chain, `node-fetch`, `uuid` and `semver`, which nothing requires any more.
  - No remaining source imports a removed package.
- **Six react-router apps**: Shopify/shop-chat-agent, sabbir-noyon/wishkit-app-shopify, Naqi-Haider/Hype-Counter, jgasimli04/marketoracle, peterwalker-svg/pos-ui and shxhid-dev/shxhid-chat-agent.
  - Each moves `ApiVersion.October25` to `April26` in `app/shopify.server` and `.graphqlrc`.
  - `@shopify/shopify-app-react-router` moves to 1.1.1 (from 1.1.0, or 1.0.0 for pos-ui). `@shopify/shopify-api` moves to 12.3.0 and the session-storage adapter to 4.0.5. `isbot` moves to 5.2.2 where the new range needs it.
  - Naqi-Haider/Hype-Counter and jgasimli04/marketoracle also drop stale `peer` flags from rewritten entries. A dropped flag can only make npm install more, not less.

### Each app's blocker

| Repository                                                                   | Package                  | Outcome  | Upgrade, or exact blocker                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| jgasimli04/marketoracle                                                      | shopify-app-react-router | proposed | react-router 1.1.0 → 1.1.1, shopify-api 12.3.0                                                                                                                                                                           |
| johnshields/northstar                                                        | shopify-api              | proposed | shopify-api 11.14.1 → 12.3.0                                                                                                                                                                                             |
| Naqi-Haider/Hype-Counter                                                     | shopify-app-react-router | proposed | react-router 1.1.0 → 1.1.1, shopify-api 12.3.0                                                                                                                                                                           |
| peterwalker-svg/pos-ui                                                       | shopify-app-react-router | proposed | react-router 1.0.0 → 1.1.1, shopify-api 12.3.0                                                                                                                                                                           |
| sabbir-noyon/wishkit-app-shopify                                             | shopify-app-react-router | proposed | react-router 1.1.0 → 1.1.1, shopify-api 12.3.0                                                                                                                                                                           |
| Shopify/shop-chat-agent                                                      | shopify-app-react-router | proposed | react-router 1.1.0 → 1.1.1, shopify-api 12.3.0                                                                                                                                                                           |
| shxhid-dev/shxhid-chat-agent                                                 | shopify-app-react-router | proposed | react-router 1.1.0 → 1.1.1, shopify-api 12.3.0                                                                                                                                                                           |
| Manuel1996-coder/shoppulseai                                                 | shopify-app-express      | stopped  | Upgrade planned (express 5.0.17 → 6.0.5); the source stops on `future.lineItemBilling` and the `billing` config (a5be0d0) at `api/index.js:90,93` and `web/shopify.js:25,28`. It also uses REST resources.               |
| Rakesh161rausahn/promo-banner-app                                            | shopify-app-remix        | stopped  | Upgrade planned (remix 3.8.5 → 4.1.0); the app pins two Admin API versions (`January25` in `app/shopify.server.js`, 2025-07 through `LATEST_API_VERSION` in `.graphqlrc.js`). The same stop applies without the upgrade. |
| kellyannclark/subscription-sync                                              | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.0): prisma and @prisma/client ^6.15.0 (has 6.13.0)                                                                                                                                         |
| ra-shopify/product-recommendations                                           | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.0): prisma and @prisma/client ^6.15.0 (has 6.10.1)                                                                                                                                         |
| Shubham13th/chatbot-app                                                      | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.0): prisma and @prisma/client ^6.15.0 (has 6.9.0)                                                                                                                                          |
| darongmean/shopify-on-cloudflare                                             | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): isbot ^5.1.32 (has 4.4.0); @remix-run/server-runtime ^2.17.3 (has 2.16.3)                                                                                                              |
| hak193/i-devr-code                                                           | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.16.7); prisma and @prisma/client ^6.15.0 (has 6.8.2)                                                                                          |
| jahmedabeer/Shopify-Storefront-AI-agent                                      | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.16.5); prisma and @prisma/client ^6.15.0 (has 6.6.0)                                                                                          |
| mssalemi/b-is-for-bundles                                                    | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.16.5); prisma and @prisma/client ^6.15.0 (has 6.6.0)                                                                                          |
| othman4dev/SEOMASTER                                                         | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.16.5); prisma and @prisma/client ^6.15.0 (has 6.6.0)                                                                                          |
| Stephnn0/shipping-discounts-shopify-app                                      | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.16.0); prisma and @prisma/client ^6.15.0 (has 6.4.1)                                                                                          |
| Hujjat/functions-basic                                                       | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.15.2); prisma and @prisma/client ^6.15.0 (has 5.22.0)                                                                                         |
| Mitakshar15/RemixShopifyApp                                                  | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.15.0); prisma and @prisma/client ^6.15.0 (has 5.22.0)                                                                                         |
| Shopify/loyalty-extension-example                                            | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.13.1); prisma and @prisma/client ^6.15.0 (has 5.22.0)                                                                                         |
| bangtbtb/shopify-discount                                                    | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.12.1); prisma and @prisma/client ^6.15.0 (has 5.20.0)                                                                                         |
| avocadomayo/cart-checkout-validation-app                                     | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.12.0); prisma and @prisma/client ^6.15.0 (has 5.19.1)                                                                                         |
| narayanan13/new-app                                                          | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.12.0); prisma and @prisma/client ^6.15.0 (has 5.19.1)                                                                                         |
| ntwrk1/test-checkout-app                                                     | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.12.0); prisma and @prisma/client ^6.15.0 (has 5.19.1)                                                                                         |
| jaysontolentino/Shopify-QRCodeGeneratorApp                                   | shopify-app-remix        | stopped  | Re-resolve (closest remix 4.1.1): @remix-run/server-runtime ^2.17.3 (has 2.11.2); prisma and @prisma/client ^6.15.0 (has 5.19.1)                                                                                         |
| mas-iota/shopify-non-embedded                                                | shopify-api              | stopped  | `package-lock.json` is lockfile version 2                                                                                                                                                                                |
| ozzyonfire/shopify-app-next-external                                         | shopify-api              | stopped  | Lockfiles: `package-lock.json` and `pnpm-lock.yaml`                                                                                                                                                                      |
| pranav-kural/products-vectro                                                 | shopify-app-remix        | stopped  | Lockfiles: `package-lock.json` and `pnpm-lock.yaml`                                                                                                                                                                      |
| SankaiAI/iHeard.ai                                                           | shopify-app-remix        | stopped  | Lockfiles: `package-lock.json` and `pnpm-lock.yaml`                                                                                                                                                                      |
| Shopify/example-storefronts--customer-account-api-authentication--javascript | shopify-app-react-router | stopped  | Lockfiles: `package-lock.json` and `pnpm-lock.yaml`                                                                                                                                                                      |
| Shopify/editions-dev-2025-workshop-customer-account                          | shopify-app-remix        | stopped  | Lockfiles: `package-lock.json` and `yarn.lock`                                                                                                                                                                           |
| dalenguyen/shopify-remix-qr-app                                              | shopify-app-remix        | stopped  | Lockfile: `pnpm-lock.yaml`                                                                                                                                                                                               |
| grocco/flarify                                                               | shopify-app-remix        | stopped  | Lockfile: `pnpm-lock.yaml`                                                                                                                                                                                               |
| kampfire-dev/bulkify                                                         | shopify-api              | stopped  | Lockfile: `pnpm-lock.yaml`                                                                                                                                                                                               |
| Shopify/example-admin-action-and-block-preact                                | shopify-app-react-router | stopped  | Lockfile: `pnpm-lock.yaml`                                                                                                                                                                                               |
| iqbaldp/shopify-promotion-agent                                              | shopify-app-remix        | stopped  | Lockfile: `yarn.lock`                                                                                                                                                                                                    |
| Shopify/shopify-react-conf-22-app                                            | shopify-api              | stopped  | Lockfile: `yarn.lock`                                                                                                                                                                                                    |
| speedcubing-ireland/speedcubingireland.com                                   | shopify-api              | stopped  | Lockfile: `bun.lockb`                                                                                                                                                                                                    |
| alucardislit-coder/shopify-stripe-backend                                    | shopify-api              | stopped  | No lockfile committed                                                                                                                                                                                                    |
| safwanadnan/shopiflare                                                       | shopify-app-react-router | stopped  | No lockfile committed                                                                                                                                                                                                    |
| Shabir300/QRCode-generator-react-router-app-v7-shopify                       | shopify-app-react-router | stopped  | No lockfile committed                                                                                                                                                                                                    |
| Shopify/shopify-app-template-remix                                           | shopify-app-remix        | stopped  | No lockfile committed                                                                                                                                                                                                    |
| shopsavvy/shopify-shopsavvy                                                  | shopify-app-remix        | stopped  | No lockfile committed                                                                                                                                                                                                    |

The stops fall into a few groups:

- **Lockfile type: 17 apps.** Of these, 5 commit no lockfile, 4 have only `pnpm-lock.yaml`, 2 only `yarn.lock`, 1 only `bun.lockb`, and 5 have `package-lock.json` beside a pnpm or yarn lockfile. Refit cannot tell which lockfile the project installs from.
- **npm would have to resolve again: 17 remix apps.** The closest blocker is `@shopify/shopify-app-session-storage-prisma` 7.0.0, the first release for `@shopify/shopify-api` 12.3.0, which needs `prisma` and `@prisma/client` ^6.15.0. remix 4.1.1 also needs `@remix-run/server-runtime` ^2.17.3. kellyannclark, ra-shopify and Shubham13th are closest: remix 4.1.0 fits, and only Prisma blocks them.
- **Lockfile version 2: 1 app.**
- **Source stop: 1 express app**, for billing.
- **Several pinned Admin API versions: 1 app.** This is an existing stop.

## Flag off is unchanged on the full 200

The 200-app list was scanned at main `7b2c86a` and at this branch with the flag off. `results.json` matches for every app except timing, and the 13 proposed patches are byte-identical.

## Flag on, outside the 44

With the flag on, the 200 give 20 proposed patches: the same 13, plus the 7 above. No app outside the 44 changes outcome.

The run still changes evidence for some of those apps. Apps that use `LATEST_API_VERSION` are now aimed at `2026-04`, the newest member the upgrade can name, instead of `2026-10`:

| Change                                      | Apps |
| ------------------------------------------- | ---- |
| Different target                            | 64   |
| Different `after` version                   | 73   |
| Different scan reason                       | 62   |
| Different "on the newest reachable version" | 3    |

84 apps outside the 44 record an upgrade attempt, and none ends in a patch:

| Upgrade attempt                                                                        | Apps |
| -------------------------------------------------------------------------------------- | ---- |
| Not a lone root `package-lock.json`                                                    | 28   |
| `October26` first ships in shopify-api 14.0.0                                          | 20   |
| npm would have to resolve again (12 remix, 3 api, 1 express)                           | 16   |
| Nested copies of a Shopify package (2 api, 1 remix)                                    | 3    |
| More than one major behind (2 api, 1 remix)                                            | 3    |
| Lockfile version 2                                                                     | 1    |
| Upgrade planned, but the app stops for another reason (5 remix, 4 api, 4 react-router) | 13   |

## Contract drift

The four published Admin schemas changed after the 2026-10-16 freeze. These runs used the schemas read on 2026-10-22; their hashes are in the frozen list. The default-off comparison used the same snapshots on both commits.

## Not covered

- Majors past the oldest supported one (13 and 14), and any upgrade more than one major behind.
- pnpm, yarn and bun lockfiles, and lockfiles that need npm to resolve again.
- Billing, REST, `getJwt` and `setCrypto` call sites. These stop with the changelog entry rather than being rewritten.
