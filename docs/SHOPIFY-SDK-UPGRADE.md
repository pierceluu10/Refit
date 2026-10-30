# Shopify SDK upgrade (opt-in)

**Status: off by default.** Needs owner decision: enable by default. Until then a run proposes the upgrade only when asked to.

## Why

In the [200-app fresh Shopify list](benchmarks/2026-10-16-shopify-fresh-repos.json), 44 apps stop only because their locked `@shopify/shopify-api` cannot name the target `ApiVersion` member, at main `7b2c86a`. They pin `ApiVersion.<member>` or use `LATEST_API_VERSION`, and every member for a supported Admin API version ships in a newer SDK major than the one they lock. These 44 apps are frozen in [`2026-10-22-shopify-sdk-upgrade-repos.json`](benchmarks/2026-10-22-shopify-sdk-upgrade-repos.json).

## Turning it on

- `refit run --shopify-sdk-upgrade`. It is off by default, and a repository cannot turn it on from its configuration (owner decision, 2026-10-22); `refit serve` and the hosted worker never run it.
- `npm run benchmark:shopify -- --sdk-upgrade` for the benchmark.

It runs only when the version move needs it: the code uses `LATEST_API_VERSION` or an `ApiVersion` enum pin outside a codegen config, and the locked `@shopify/shopify-api` does not define the target member. Otherwise the run behaves exactly as with the flag off.

## What it upgrades

The upgrade moves the one Shopify package the project declares to the first major whose `@shopify/shopify-api` ships the target `ApiVersion` member, applying or stopping on the documented breaking changes of every major it crosses, from the oldest major each package served a supported version with (`@shopify/shopify-api` 11, remix 3, react-router 0, express 5).

| Target member          | `@shopify/shopify-api` | remix     | react-router | express |
| ---------------------- | ---------------------- | --------- | ------------ | ------- |
| `January26`, `April26` | 12 (12.1.0, 12.3.0)    | 4         | 1            | 6       |
| `July26`               | 13 (13.1.0)            | 4 (4.2.0) | 1 (1.2.0)    | 7       |
| `October26`            | 14 (14.0.0)            | 5         | 2            | 8       |

The app package's major is read from the registry: the first release whose `@shopify/shopify-api` dependency takes the release that ships the member. The target release is the newest in that major that fits the lockfile. With `--sdk-upgrade`, the benchmark aims pins at the newest member; when the upgrade cannot reach it, the pipeline falls back to the newest supported version the app can take ([Shopify](SHOPIFY.md#fallback-to-a-supported-version)).

`@shopify/shopify-api` 14 needs Node.js 22 (9fec7af), 12 and 13 need 20.10: a project whose `engines.node` excludes it is refused, and the draft asks to check the deployment runtime.

The upgrade writes `package.json` and `package-lock.json` the way the [Stripe package upgrade](DEPENDENCIES.md) does. It uses npm registry metadata and locks only releases that metadata gives with the canonical registry tarball URL and a SHA-512 integrity. It follows npm's key order and package order.

- Packages from Shopify/shopify-app-js move together: the API, app and session-storage packages, `admin-api-client`, `storefront-api-client` and `graphql-client`. A session-storage adapter moves to the first release built for the new `@shopify/shopify-api`.
- Any other package is added or moved only when it has no dependencies of its own (for example `isbot`, `lossless-json`, `compare-versions`). Lock entries that nothing requires any more are removed.
- A release with install scripts, `bin`, `os`/`cpu`, optional or bundled dependencies, or a native build is refused.

## Source edits it makes

Only in files that import a Shopify package:

- **`LATEST_API_VERSION` becomes `ApiVersion.<member>` where it sets `apiVersion`.** `@shopify/shopify-api` 12.0.0 (48d3631), `@shopify/shopify-app-remix` 4.0.0 (762224d) and `@shopify/shopify-app-react-router` 0.2.0 (c02018f) removed it. The import (ESM `import`, or a CommonJS `const { … } = require(…)`) is renamed to `ApiVersion`, or dropped when `ApiVersion` is already imported. It is also replaced where it fills the version segment of an Admin API URL in a template literal (`` `…/admin/api/${LATEST_API_VERSION}/graphql.json` ``), as test mocks build the URL the SDK requests; it gets the same member as `apiVersion`. Any other URL, such as a Storefront `/api/` path, still stops.
- **`removeRest: true` is dropped from a `shopifyApp` or `shopifyApi` config's `future` flags.** `@shopify/shopify-app-remix` 4.0.0 (d7bd799) removed REST and the flag, so `true` was already the only behavior.
- **`future.unstable_newEmbeddedAuthStrategy: true` is dropped from a `@shopify/shopify-app-react-router` config.** React Router 0.1.1 and 1.1.1 accept the flag in their types but never read it (`shopify-app.mjs` always uses token exchange, or the merchant custom-app strategy), so `true` was already the only behavior. Any other value stops; `@shopify/shopify-app-remix` keeps the flag, which it still reads.
- **`future.lineItemBilling: true` and `future.v10_lineItemBilling: true` are dropped.** a5be0d0: "If you have already adopted either of these flags you only need to remove the flags from your shopifyApi config." In 11.12.0 they only gate a log line (`future/flags.mjs`); requests branch on `'lineItems' in plan`.
- **`<AppProvider embedded={false}>` becomes what it rendered**, crossing `@shopify/shopify-app-react-router` 2. 0dbb90c says to "Remove Polaris-only or login-page usage of `AppProvider`". In 1.1.1 that element rendered the Polaris script and its children (`AppProvider.mjs`), so the edit writes `<>`, `<script src="https://cdn.shopify.com/shopifycloud/polaris.js" />`, the children and `</>`, and drops the `AppProvider` import once nothing uses it. Shopify's template made the same edit (commit 89f43482 of Shopify's React Router app template). Any other prop stops.

- **The template's `restResources` goes**, crossing `@shopify/shopify-app-remix` 4, when no source file reads `.rest`. d7bd799 "Remove REST entirely" from remix 4; in remix 3 `restResources` only filled `admin.rest.resources`. The `@shopify/shopify-api/rest/admin/<version>` import goes with its last use.
- **`AppProvider` imported under another name** (`AppProvider as ShopifyAppProvider`) is the same component for the React Router 2 edits.

Left in place, with a draft note:

- **The template's `...(process.env.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] } : {})`**, crossing `@shopify/shopify-api` 13. 78c8968 removed `customShopDomains` and says "The `SHOP_CUSTOM_DOMAIN` environment variable is no longer supported", and 14.0.1 never reads the key. Shopify's own React Router template keeps this exact line on `@shopify/shopify-app-react-router` 3 (fa091e35, 2026-10-09), so Refit leaves it too and the draft says that it no longer has an effect. A rewrite to `domainTransformations` is not equivalent: 11.x treats each entry as a regular expression source, the new rule's domain is extracted heuristically from its regex, and it widens host validation unless `includeHost` is false. Every other `customShopDomains` stops.

Accepted as they are:

- **Billing plans 12.0.0 reads the same way**: every plan an object literal with `lineItems` (no top-level `interval`), or a one-time plan (`interval: BillingInterval.OneTime`). a5be0d0 moved only recurring plans into `lineItems`.
- **The remix and React Router adapters' `billing` context** (`const { billing } = await authenticate.admin(request)`). Their `billing.check`, `require` and `request` already pass `returnObject: true` to `@shopify/shopify-api` (remix 3.8.2 `server/authenticate/admin/billing/*.mjs`), so 12.0.0's change to `billing.check`'s return value leaves them as they are; remix 4 and 5 and React Router 2 list no billing change.

## What stops for review

Every stop names the file, line and reason. The citations are the shopify-app-js changelogs and the [v12 migration guide](https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/docs/migrating-to-v12.md), read on 2026-10-22.

| Stop                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Source                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `LATEST_API_VERSION` used anywhere but an `apiVersion` value, or imported under another name, as a type, with a default value, beside a default import or through a namespace                                                                                                                                                                                                                                                                                                | 48d3631                                                         |
| `LATEST_API_VERSION` setting a Storefront client's or Storefront codegen project's `apiVersion` (Refit checks only Admin documents, so it does not choose a Storefront version)                                                                                                                                                                                                                                                                                              | 48d3631                                                         |
| A `shopifyApp` or `shopifyApi` config with no `apiVersion` Refit can see (express settings are read under `api`)                                                                                                                                                                                                                                                                                                                                                             | 48d3631: `apiVersion` is required                               |
| `RELEASE_CANDIDATE_API_VERSION`                                                                                                                                                                                                                                                                                                                                                                                                                                              | 48d3631                                                         |
| `getJwt` (now async) and `setCrypto` (use `globalThis.crypto`)                                                                                                                                                                                                                                                                                                                                                                                                               | dc41d09                                                         |
| `future.lineItemBilling` or `future.v10_lineItemBilling` set to anything but `true`, a billing config with a flat recurring plan, or `.billing` use when the app package is `@shopify/shopify-api` or `@shopify/shopify-app-express`                                                                                                                                                                                                                                         | a5be0d0; `billing.check` returns an object (migration guide)    |
| A `future` flag the upgraded package does not accept. The accepted flags were read from the published types of shopify-api 12.3.0, shopify-app-remix 4.1.1 and shopify-app-react-router 1.1.1.                                                                                                                                                                                                                                                                               |                                                                 |
| `future` flags that are not an object literal, or a spread, shorthand or computed flag                                                                                                                                                                                                                                                                                                                                                                                       |                                                                 |
| `future.removeRest` set to anything but `true`, or `removeRest` elsewhere                                                                                                                                                                                                                                                                                                                                                                                                    | d7bd799                                                         |
| REST Admin API use (already a stop without the upgrade)                                                                                                                                                                                                                                                                                                                                                                                                                      | c3005a6: REST IDs become strings; d7bd799: remix 4 removes REST |
| Crossing `@shopify/shopify-api` 13: `customShopDomains` other than the template's `SHOP_CUSTOM_DOMAIN` line (now `domainTransformations` with `{ match, transform }` rules)                                                                                                                                                                                                                                                                                                  | 78c8968                                                         |
| Crossing session-storage prisma 8 when the Prisma `Session` model lacks `refreshToken` or `refreshTokenExpires`, or cannot be read. The changelog calls the fields optional, but 8.0.0 to 10.0.1 write both on every store (`sessionToRow`, `null` when absent), and Prisma rejects an argument the model does not declare, so storing any session would fail; Refit never writes the migration. The source also stops where the app turns on `expiringOfflineAccessTokens`. | 700377f; 10.0.1 `dist/esm/prisma.mjs`                           |
| Crossing `@shopify/shopify-api` 14: any `subTopic` (webhooks filter with `filter`)                                                                                                                                                                                                                                                                                                                                                                                           | 84397d9                                                         |
| Crossing `@shopify/shopify-app-react-router` 2: `isEmbeddedApp` with any value but `true`, or `<AppProvider embedded>` with any value but `true` or a lone `embedded={false}` (edits drop `isEmbeddedApp: true` and `embedded`/`embedded={true}`, and replace `<AppProvider embedded={false}>`)                                                                                                                                                                              | 0dbb90c                                                         |
| Crossing `@shopify/shopify-app-express` 7 (Express 4 to 5), sqlite, postgresql or mysql 6 (column data migration), drizzle 4 (refresh-token columns) or mongodb 6 (driver v7)                                                                                                                                                                                                                                                                                                | each package's CHANGELOG.md                                     |

Before any edit, the upgrade also refuses these projects:

- **Lockfiles.** An `npm-shrinkwrap.json`, several root lockfiles that the documented lockfile choice (`chosenLockfile`, as for stripe-node) cannot pick between, a pnpm, Yarn or Bun project that preparation refuses (`readPreparationInputs`), pnpm patches, a binary `bun.lockb`, and for npm a lockfile version other than 3 or one not in npm's formatting or order. When the choice picks one lockfile, only it and `package.json` are edited, and the draft names each other lockfile left on the older release.
- **Packages.** More than one Shopify app package, or a package older than the oldest major whose migration Refit applies, or a target past `@shopify/shopify-api` 14.
- **Resolution.** A lockfile that cannot take the upgrade without npm resolving it again, unless lockfile resolution is on (validation's networked step, `REFIT_LOCKFILE_RESOLUTION`, on by default). Then the declared Shopify packages move to the target major's releases in `package.json`, npm re-resolves the committed `package-lock.json` from it in networked Docker (lifecycle scripts off, no repository `.npmrc`, as of the commit date), and the re-resolved lockfile ships in the patch, with the draft naming the framework packages it moved. It is refused when anything outside the Shopify packages, the Remix and React Router packages (`@remix-run/*`, `@react-router/*`, `react-router`, `react-router-dom`) and what only they reach changes (decision of 2026-10-29 in AGENTS.md).
- **pnpm, Yarn and Bun.** These lockfiles always take the upgrade through re-resolution, with the manager release preparation installs with: the `packageManager` pin, else preparation's default (pnpm 9.15.9, 8.15.9 for lockfile v6, 10.34.7 for a settings-only `pnpm-workspace.yaml`; Yarn 1.22.22). Preparation installs a `bun.lock` through npm, so Bun runs at the pin or 1.4.3. pnpm keeps the committed lockfile's `autoInstallPeers` and `excludeLinksFromLockfile`; Yarn 1 installs with scripts off into a folder nothing reads, since it has no lockfile-only mode; Yarn Berry runs `install --mode=update-lockfile`; Bun runs `install --lockfile-only`. The result is compared as a graph (`pipeline/lockfile-graph.ts`): every importer's declarations outside the Shopify and framework packages, every package those reach (release, integrity and what each of its other dependencies resolves to) and the lockfile's settings must be unchanged. npm lockfiles with nested copies of the SDK take npm's re-resolution the same way. Every locked copy of `@shopify/shopify-api` must be the target's.
- **Prisma.** Every session-storage release for `@shopify/shopify-api` 12 and later peers `prisma` 6.15 or later. When the project declares `prisma` and `@prisma/client`, the upgrade moves both to the newest release of the major the peer range names, and the draft says "Prisma upgraded because session storage requires it". Prisma's documented 5 to 6 breaking changes stop: TypeScript older than 5.1, models named `async`, `await` or `using`, `Bytes` fields, PostgreSQL `fullTextSearch`, PostgreSQL implicit many-to-many relations (they need a migration), and code naming `NotFoundError`. Refit never writes a migration or changes the data model (decision of 2026-10-29 in AGENTS.md).
- **No lockfile.** A project that commits none gets a `package.json`-only upgrade; validation resolves a lockfile for its checks, which never ships.

Every proposed upgrade warns that `@shopify/shopify-api` 12 requires Node.js 20.10 or later (dc41d09). The published `engines` field says `>=20.0.0`; Refit uses the changelog's stricter bound.

## Results on the 44 (Refit `cedb1aa`, 2026-10-22)

These counts and the per-repository table below are not backed by a committed results file.

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

## pnpm, Yarn and Bun lockfiles (2026-10-29)

Measured offline with SH3's census (`runPipeline` with `--sdk-upgrade` and re-resolution on, no AI, no validation, no benchmark run) on the 250 non-blind repositories of the 2026-10-16 Shopify lists, against SH3's run at `871d3f4d`:

- Proposed patches: 28 → 30. Nothing else changed outcome, and the 28 earlier patches are byte-identical.
- The two new patches are pnpm projects: grocco/flarify (remix 3.8.2 → 5.0.1, `@shopify/shopify-api` 14.0.1, KV session storage 7.0.1, `@remix-run/server-runtime` 2.17.5 added) and kampfire-dev/bulkify (`@shopify/shopify-api` 11.6.0 → 14.0.1 with its client packages). Both lockfile diffs were read in full: only the Shopify family, `isbot` and the framework packages move, and the `jsonwebtoken`/`node-fetch`/`uuid` chain that only `@shopify/shopify-api` 11 needed is dropped. pnpm also refreshed `deprecated` notices on a few other entries; the graph check ignores those, since the release and integrity are unchanged. Each patched repository then installed with Refit's own preparation (pnpm 9.15.9, frozen lockfile, scripts off).
- Of the 42 repositories this blocker stopped, the other 40 now stop on their next real blocker or a named lockfile stop:
  - Prisma or Drizzle session storage (peers outside the decision, or Drizzle's schema migration): 8.
  - remix 2 or `@shopify/shopify-api` older than 11, below the oldest migratable major: 7.
  - Preparation refusals (pnpm patches, workspace names, unsupported pnpm settings, non-registry tarballs, a Yarn record without integrity, a workspace `bun.lock`): 7.
  - Other findings (documents, REST, react-router 2's embedded-only change), with the SDK upgrade itself succeeding: 5.
  - npm re-resolution of a nested SDK copy adds optional platform packages (`@esbuild/*`, `@parcel/watcher-*`) the committed lockfile lacks: 3.
  - The re-resolution changed something else, a correct stop: 2 (a Yarn 1 lockfile missing a descriptor Polaris needs; a pnpm 10.33 re-resolution that also moved 24 other packages).
  - Several lockfiles no rule picks: 2; two Shopify app packages: 1; binary `bun.lockb`: 2; npm lockfile version 1 or 2: 2; Yarn 1 running out of the 4 GiB workspace while installing (it has no lockfile-only mode): 1.

## Shared packages npm moves (2026-10-29)

npm's re-resolution of an SDK major used to be kept only when nothing outside the Shopify packages, the framework packages and what only they reach changed. On the 310 practice rows of round 3 that refused about 60 apps, because `@shopify/shopify-api` 14 and remix 5 need newer releases of packages the app also reaches: `isbot` `^5.2.0`, `tslib` `^2.8.1`, `jose`, `dotenv`. It also refused apps where npm only re-hoisted `node-fetch` and flipped its `dev` flag after 14 dropped the dependency.

`sharedMovesOutside` (`pipeline/shopify-sdk-upgrade.ts`, npm lockfiles only) now decides by the dependents' declared ranges instead of the layout. Every package the app reaches without passing through the upgraded packages must:

- keep its own release and record, wherever npm hoists it (npm's `dev`, `optional`, `devOptional` and `peer` flags are ignored, since they follow from the graph);
- get the same release of each dependency as before, or a newer release of the same major (the same minor for 0.x) that its declared range accepts and that an upgraded package also reaches.

The root record's other declarations still must not change. A package new to the lockfile that only the app reaches, another major, or a move a dependent's range rejects still stops. Validation (type check, the repository's tests and build, schema validation of every document) stays the gate. pnpm, Yarn and Bun keep the graph comparison of `pipeline/lockfile-graph.ts`.

On the 91 practice rows whose first stop was the SDK upgrade, run locally with re-resolution on and no validation: 0 → 43 proposed upgrades. After the source codemods above, 42 of the 43 have no source stop; othman4dev/SEOMASTER calls `shopifyApi` in `vite.config.js` without an `apiVersion`.

## Dated version string

When the SDK upgrade does not apply, a GraphQL-only app keeps its locked SDK and pins the dated string instead: every `ApiVersion.<member>` and `LATEST_API_VERSION` in a file that imports a Shopify package becomes `'2026-10' as ApiVersion` in TypeScript (`'2026-10'` in JavaScript), and a `LATEST_API_VERSION` import becomes `ApiVersion` (`shopifyVersionStringPins` in `pipeline/shopify-sdk-source.ts`). It runs only with `--shopify-sdk-upgrade`, after the upgrade refused.

Why it is sound, from the published source read on 2026-10-29:

- **`@shopify/shopify-api` 8.1.1, 9.7.2, 10.0.0, 11.12.0, 12.3.0 and 13.1.0.** `validateConfig` never compares `apiVersion` with the enum (12 and 13 check only that it is set). The value goes into request URLs (`/admin/api/<version>/graphql.json`), override log lines, `utils.versionCompatible`'s numeric comparison, which `'2026-10'` passes, and the REST resources' mismatch warning.
- **`@shopify/admin-api-client`.** From 9.x the GraphQL client is `@shopify/admin-api-client`. Its `validateApiVersion` (graphql-client 0.10.4 and 1.4.2) only warns when the version is outside a list computed from today's date. 8.x builds the URL itself.
- **Adapters.** remix 3.8.2 and 4.1.1, React Router 1.1.1, and express 5.0.17 and 6.0.5 pass `apiVersion` through.
- **TypeScript.** The type is the `ApiVersion` string enum, so a literal needs `as ApiVersion`. tsc accepts that assertion.
- **The SDK's own requests.** `shopify.webhooks.register` (and remix `registerWebhooks`) sends the same documents in 8.1.1 to 13.1.0. Refit validates them on the target schema whenever the code registers webhooks, and every topic key of a `webhooks` config or `addHandlers` must be a target `WebhookSubscriptionTopic`. 7.7.0 also reads `privateMetafieldNamespaces`, so 7.x is out.

It does not apply, and the SDK upgrade's stop stands with this reason added, when:

- the locked release is outside 8 to 13, or Refit cannot read a single locked release;
- the app sends REST, since REST resources ship only for older versions;
- any source file names `billing`, `storefront` or `Storefront`, since the SDK sends those requests with its own code at the pinned version;
- a webhook config is not an object literal, or names a topic the target lacks;
- a version is used as a type.

Every app GraphQL document must still validate on the target, and validation runs as for any patch. The draft says the locked SDK stays and why. This is the smaller fix the founders' "move the version and the SDK together" rule allows only where proven: the SDK upgrade is always tried first.

On the 48 SDK-stopped practice rows the upgrade still refuses, run locally: 14 get a string pin with the 10 to 13 range. Extending it to 8 and 9 adds the remix 2 apps (`@shopify/shopify-api` 9). The rest stop on REST (10), billing or Storefront (2), unreadable webhooks (1), 7.x or 3.x (4), or no readable locked release (11).

## Contract drift

The four published Admin schemas changed after the 2026-10-16 freeze. These runs used the schemas read on 2026-10-22; their hashes are in the frozen list. The default-off comparison used the same snapshots on both commits.

## Not covered

- `@shopify/shopify-api` 15 and later, and behaviour changes the draft only names: 13.1.0 signs cookies with a derived key, 14 hardens App Proxy validation and OAuth callback errors (b1bcc27); type changes (1eb863d, 493094d) are left to the type check.
- pnpm, Yarn and Bun projects that preparation refuses, and the binary `bun.lockb`.
- REST, `getJwt` and `setCrypto` call sites, flat recurring billing plans and `@shopify/shopify-api` billing calls. These stop with the changelog entry rather than being rewritten.
- remix 2 to remix 3, and `shopify-app-remix` to `shopify-app-react-router`. Shopify documents no mechanical path for the app packages (React Router's `npx codemod remix/2/react-router/upgrade` covers only the framework), so these keep stopping with "older than 3, the oldest major whose migration Refit applies".
