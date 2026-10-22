# Yarn 2+ (Berry) dependency preparation

Refit prepares dependencies in Docker before it runs a repository's checks offline (see `docs/DEPENDENCIES.md`). npm, pnpm and Yarn 1 projects were already supported, and Yarn 2+ only for a single-package project with an exact `packageManager` pin. This page covers what Refit now prepares for Yarn 2 and later, how each form is verified, and where it stops.

## What is prepared

A Yarn 2+ project is one whose root `yarn.lock` has a `__metadata` header (Yarn 1 lockfiles start with `# yarn lockfile v1`). Refit prepares it when:

- `.yarnrc.yml` sets `nodeLinker: node-modules`. The only other settings allowed are `enableTelemetry` and `yarnPath`.
- The Yarn release is named exactly, by `packageManager` (`yarn@4.9.2`, optionally `+sha512.<hex>`), by a committed `yarnPath` release named `yarn-<version>.cjs`, or by both, in which case they must agree.
- Every lock entry resolves an exact npm version with a checksum. Yarn's built-in compatibility patches are accepted in both spellings: `optional!builtin<compat/…>` (Yarn 4) and `~builtin<compat/…>` (Yarn 2 and 3).
- Workspaces, if any, are listed in `package.json` `workspaces`. Each must have its own `workspace:` entry in `yarn.lock`, and a `workspace:` range must name a sibling workspace. The npm limit of 64 workspace packages applies.

Installation is unchanged from the single-package case. Refit installs `@yarnpkg/cli-dist` at the named version through npm, with scripts off, and checks its version and registry integrity. It then runs `yarn install --immutable --mode=skip-build`, configured only through environment variables: node-modules linker, scripts off, a private cache, the public npm registry, no telemetry, and `YARN_IGNORE_PATH=1`. The repository's `.yarnrc.yml` and `.npmrc` never reach the installer. The result is cached by the lockfile, manifests, Yarn release and image, like every other manager. Validation stays offline and is unchanged.

Yarn 2+ builds each package's zip in the operating system's temporary directory before moving it into its cache. The sandbox's `/tmp` holds 64 MiB, so every real Yarn 4 project in the frozen sets ran out of space there, even with the `4g` profile. The installer therefore sets `TMPDIR` to `/workspace/.yarn-tmp`, inside the installer workspace, which is the space the profile sizes. Yarn 2+ keeps a zip of every package in its cache beside the unpacked tree, so it needs more workspace than npm for the same dependencies. When it runs out, the error says so and points to the operator's `4g` profile.

The Node.js image follows the repository's declaration (`docs/VALIDATION-RUNTIME.md`), so a Yarn release runs on the Node.js line the project names.

## Platform-specific packages

Yarn 3.2 and later record a package that only installs on some platforms (`@esbuild/linux-x64`, `@rollup/rollup-darwin-arm64`, `@next/swc-*`) with a `conditions` field. Yarn 4 never writes a checksum for these entries, not even for the platform that created the lockfile. Observed on 2026-10-22: Yarn 4.9.2 wrote a lockfile for `esbuild@0.25.0` on linux-arm64 with 25 `@esbuild/*` entries and no checksum on any of them. An immutable install then fetched and installed `@esbuild/linux-arm64` with nothing to verify it against.

Refit used to refuse such lockfiles, which ruled out nearly every Yarn 4 project that uses esbuild, Vite, Rollup or SWC. It now accepts an entry with `conditions` and no checksum, but installs none of them. Before installing, it writes `supportedArchitectures` with `os`, `cpu` and `libc` set to `refit-none` into the installer's own `/workspace/.yarnrc.yml`, a platform no package declares. Yarn then skips every conditional package, the lockfile stays unchanged under `--immutable`, and every installed package was checked against a lockfile checksum. The setting is written only when the lockfile has conditional entries, because Yarn releases older than 3.2 do not know it (and do not write `conditions` either).

The count is recorded as `platformPackages` in the dependency environment, and the CLI summary says how many platform-specific packages were not installed. A check that needs one of those binaries fails at baseline with the tool's own message, for example `The package "@esbuild/linux-arm64" could not be found, and is needed by esbuild.`, so Refit stops rather than reporting a result. Type checks and tests that do not load a native binary run as usual. Entries without `conditions` still need a checksum.

**Operator opt-in (Needs owner decision).** `REFIT_YARN_PLATFORM_PACKAGES=install` leaves the setting out, so Yarn installs this host's platform packages, fetched from the npm registry over HTTPS with no lockfile checksum to check them against. The default is `skip`; any other value is refused. The mode keys the dependency cache and is recorded as `platformPackageMode`, and the summary then says how many platform-specific packages were installed without checksums. Whether Refit should offer this, and whether it should become the default, is an owner decision; the measurements below are the evidence.

## How the Yarn release is verified

- **`packageManager` pin:** the named version is installed from npm. With `+sha512.<hex>`, the installed `bin/yarn.js` must have that SHA-512.
- **Committed `yarnPath` release:** the file is never run. Refit reads it as bytes, and its SHA-512 becomes the digest that the installed `@yarnpkg/cli-dist` `bin/yarn.js` must match, so only a byte-identical published release passes. This holds in practice: on 2026-10-22, the committed `.yarn/releases/yarn-3.2.3.cjs` of a frozen repository had the same SHA-512 as `@yarnpkg/cli-dist@3.2.3`'s `bin/yarn.js`. A modified or custom build fails preparation with `The installed @yarnpkg/cli-dist manager differs from the declared version or checksum`.

## Stops

Each stops before Docker runs, with this message:

| Situation | Message |
| --- | --- |
| Plug'n'Play: `nodeLinker: pnp`, or no `nodeLinker` | `Yarn Plug'n'Play requires a custom validation image: Refit prepares Yarn 2+ only with nodeLinker: node-modules in .yarnrc.yml[, and without nodeLinker Yarn uses Plug'n'Play].` |
| Another linker | `Yarn's "pnpm" linker requires a custom validation image; …` |
| Plugins | `Yarn plugins (plugins in .yarnrc.yml) run their own code during installs, so they require a custom validation image.` |
| Other settings | `.yarnrc.yml sets checksumBehavior, nmMode, which Refit does not apply; validating with them requires a custom image.` |
| Yarn 1 pin over a Yarn 2+ lockfile | `packageManager pins yarn@1.22.19, but yarn.lock is a Yarn 2+ lockfile. …` |
| Yarn 2+ pin over a Yarn 1 lockfile | `packageManager pins yarn@4.9.2, but yarn.lock is a Yarn 1 lockfile. …` |
| `.yarnrc.yml` without `yarn.lock` | `The repository commits .yarnrc.yml but no yarn.lock, so the dependency versions to verify are unknown. …` |
| No version named | `Yarn 2+ preparation requires an exact packageManager pin such as yarn@4.9.2 …, or a committed yarnPath release named yarn-<version>.cjs.` |
| `yarnPath` names an uncommitted file | `yarnPath in .yarnrc.yml must name a committed Yarn release under .yarn/releases.` |
| `yarnPath` and `packageManager` disagree | `packageManager pins Yarn 4.10.0, but yarnPath names Yarn 4.9.2.`, or `The packageManager checksum differs from the committed yarnPath release.` |
| A workspace missing from `yarn.lock`, or one the manifests do not declare | `yarn.lock has no entry for workspace packages/shared; …`, or `yarn.lock records workspace …, which the committed workspace manifests do not declare; …` |
| A lock entry without an exact npm version and checksum (repository patches, git, local sources) | `Every Yarn 2+ lock entry must resolve an exact npm version with a checksum; patches, git and local sources require a custom image.` |

## Tests

- `pipeline/yarn-preparation.test.ts` (default suite): each stop's exact message, `yarnPath` digest and version rules, Yarn 3 patches, workspace acceptance and refusals, and the missing lockfile.
- `pipeline/yarn-berry-docker.test.ts` (gated: `REFIT_DOCKER_IMAGE=node:22-alpine REFIT_NPM_PREPARE=1`) runs real Yarn 4.9.2 from the npm registry. It covers a workspace project (`pipeline/fixtures/yarn-workspaces`, generated by Yarn and kept byte-exact) with offline checks that load the workspace link at the root and a dependency from inside the workspace; a committed `yarnPath` release, accepted, with a one-byte change refused; a Corepack `sha512` pin, accepted, with a wrong digest refused; and the Plug'n'Play stop.

## How many repositories this unblocks

Census of 2026-10-22: every repository in the frozen lists, with its root `yarn.lock`, `.yarnrc.yml` and `package.json` read at the pinned commit from raw.githubusercontent.com, then scored with Refit's own `readPreparationInputs` on a shallow clone. The census counts are not backed by a committed results file.

- **Stripe and Shopify lists** (847 repositories): 41 commit a `yarn.lock`. 37 are Yarn 1, which was already supported, and 4 are Yarn 2+. `main` prepares none of the 4; this branch prepares 2:

| Repository (list) | `main` | This branch |
| --- | --- | --- |
| ahmadk953/tasko (Stripe held-out) | Refused: 133 platform packages without checksums | Prepared |
| Crunchyman-ralph/shopify-app-node-monorepo-express-vite (Shopify fresh) | Refused: workspaces (plus `yarnPath`, Yarn 3 patches, platform packages, `JSONStream`, a transparent workspace range) | Prepared |
| naveennaidu/OpenformStack (Stripe) | Refused: no `packageManager` pin | Same stop: no Yarn version is named anywhere |
| strapi-community/shopify (Shopify fresh) | Refused: no Yarn 2+ pin | Named stop: `packageManager` pins Yarn 1.22.19 over a Yarn 2+ lockfile |

- **All 15 frozen lists** (1,384 rows; a repository on two lists counts twice): 71 rows commit a `yarn.lock`, and 6 distinct repositories are Yarn 2+. Besides the four above, a2arium/callLLM (OpenAI applications) is now prepared, and medusajs/medusa (PayPal) stops at the 64-workspace limit; it would also stop on its plugins and `checksumBehavior: ignore`.

## Real repositories

The three frozen Yarn 2+ repositories this branch can prepare were prepared and then checked locally on 2026-10-22, in Docker on `node:22-alpine` (their Node.js declarations allow it). Each ran at its frozen commit with the benchmark's own check: the test script, else `tsc --noEmit -p .`. Refit was at `e189b1f` (default runs) and `4634aa6` (install-mode runs); the preparation code is the same apart from the opt-in. These runs are not backed by a committed results file.

| Repository | Yarn | Default profile (2 GiB), platform packages skipped | Operator `4g` profile | `REFIT_YARN_PLATFORM_PACKAGES=install` |
| --- | --- | --- | --- | --- |
| Crunchyman-ralph/shopify-app-node-monorepo-express-vite `ed5dae0` (workspaces, `yarnPath`, Yarn 3 patches) | 3.2.3 | Prepared in 115 s; `tsc --noEmit` **passed** | Not needed | Not run |
| a2arium/callLLM `1e29285` | 4.9.4 | Prepared in 23 s; `yarn test`: 1,262 tests passed and 98 failed, all failures `sharp` unable to load its skipped native binary | Not needed | Prepared in 27 s; `yarn test` ran out of JavaScript heap (about 1.5 GB) before finishing |
| ahmadk953/tasko `c098402` | 4.12.0 | Out of space in the 2 GiB installer workspace (named ENOSPC) | Prepared in 51 s; `yarn test` failed because Next.js could not find its skipped SWC binary and cannot download it offline | Out of space in the 4 GiB workspace, now that the Linux platform binaries are installed too |

Before the `TMPDIR` fix, all three ran out of space in the sandbox's 64 MiB `/tmp`, even on the `4g` profile.

One repository validates end to end. In the other two, a check needs a platform binary, so Refit stops at baseline with the tool's own message; installing the binaries unverified did not produce a passing baseline for either. The measurements therefore do not argue for changing the `skip` default.

## Plug'n'Play

**Prevalence.** In the frozen lists, no Yarn 2+ repository declares `nodeLinker: pnp`. One (strapi-community/shopify) has no `.yarnrc.yml`, which means Plug'n'Play under Yarn 2+, but it pins Yarn 1, so its intent is unclear. Plug'n'Play repositories may be under-represented, because the lists were selected for SDK usage, not package manager. Still, in this sample it is not what blocks Yarn 2+ projects.

**Design (Needs owner decision).** Supporting Plug'n'Play would change preparation and validation:

1. **Install.** Install with `YARN_NODE_LINKER=pnp`. The result is `.yarn/cache/*.zip`, `.pnp.cjs` and `.pnp.loader.mjs` instead of `node_modules`. The archive would carry those files, and the dependency tree check would verify that every cache zip name and checksum matches `yarn.lock`, instead of walking `node_modules`.
2. **Zero installs.** Repositories that commit `.yarn/cache` would need every committed zip checked against its lockfile checksum before Refit trusts it, or Refit would ignore the committed cache and download again. Committed `.yarn/unplugged` content would be refused.
3. **Checks.** Commands only resolve packages through the Plug'n'Play loader, so checks must run as `yarn <command>` or with `node --require ./.pnp.cjs --loader ./.pnp.loader.mjs`. A configured `npx tsc` fails without Yarn's editor SDKs. The approved check commands would need rewriting, or a rule that Plug'n'Play repositories declare `yarn`-prefixed checks.
4. **Risk.** `.pnp.cjs` is generated by the pinned Yarn inside the installer and runs only in the offline check container, so there is no new host exposure. The cost is a second dependency-tree format to verify and maintain.

Given no Plug'n'Play repository in the current sample, the recommendation is to keep the named stop until a customer needs it, and to re-measure on a sample selected by package manager. Whether to build it is an owner decision.
