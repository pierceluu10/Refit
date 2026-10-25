# Automatic validation dependencies

Refit can prepare dependencies from a clean repository's committed `package.json` and `package-lock.json`, then run its checks in an ordinary local Node Docker image. This removes the custom dependency-image setup for supported npm projects. The same preparation works through `run`, `validate`, `watch` and service profiles.

Pinned pnpm projects and bounded workspaces use the same commands with `pnpm-lock.yaml`. Catalogs, explicit workspace links and pnpm's separate manager/application lock documents are supported. See [pnpm setup and limits](PNPM-WORKSPACES.md).

Positive-glob npm workspaces with committed manifests and root lockfiles are supported through the same preparation. Workspace links and nested dependency directories are verified and retained. See [workspace setup and boundaries](NPM-WORKSPACES.md).

## Test the Stripe pipeline

The local Docker daemon must be running and `node:22-alpine` must already be installed. Refit never pulls a base image automatically. If needed, download it explicitly with `docker pull node:22-alpine`.

From the Refit checkout, run the installed App with the prepared npm profile:

```sh
cd ~/Repos/Refit
refit serve --env .env --config examples/local-service.npm.refit.json \
  --state ~/.refit/stripe-prepared-pilot --once
```

This discovers the installed App's access, fetches the billing demo into a managed checkout, scans the supplied historical Stripe contracts, prepares dependencies when necessary, and validates a deterministic migration. The example checks original behavior, both original/changed behavior after patching, and TypeScript. It leaves your billing checkout unchanged and does not publish a PR. Subsequent polls reuse the saved job and report that checks were not rerun. Omit `--once` for continuous polling.

For draft publication, use a **fresh service state directory** and add `--publish-draft`. PR #3 predates the approved configuration merge and does not cover the current monitored base. Refit reuses an App draft only when its base and migration identity match; publication can create a new draft after validation. See [the current App evaluation](AUTOMATION.md). To evaluate a new AI proposal locally, add `--ai-patch --repair-attempts 1` with fresh state and your shared spending allowance:

```sh
REFIT_AI_BUDGET_USD=2 \
REFIT_AI_BUDGET_DIRECTORY=~/.refit/evaluations/2026-10-12 \
refit serve --env .env --config examples/local-service.npm.refit.json \
  --state ~/.refit/stripe-prepared-ai-pilot \
  --once --ai-patch --repair-attempts 1
```

This uses the existing project allowance rather than resetting spending. AI generation and publication remain explicit. Configuring a different source or baseline uses the same environment preparation; the historical sample does not discover a new live Stripe change.

## Prepare or validate a local repository

Inspect dependency preparation independently:

```sh
refit prepare --repository ~/Repos/refit-billing-demo \
  --image node:22-alpine
```

It prints the recorded Node/npm versions, number of locked package records and evidence path. This is not a count of installed packages: platform-specific optional records can be skipped by npm. `--json` supplies machine output. `--cache /absolute/path/outside-git` chooses a cache explicitly; otherwise `REFIT_DEPENDENCY_CACHE_DIRECTORY` or `~/.refit/dependencies` is used. An empty environment setting uses the default.

You can also opt in on a run without creating a service:

```sh
refit run --repository ~/Repos/refit-billing-demo \
  --before pipeline/fixtures/before.json --after pipeline/fixtures/after.json \
  --output /tmp/new-refit-prepared-run --image node:22-alpine \
  --prepare-dependencies --baseline-command '["npm","test"]' \
  --command '["sh","-c","npm test && npm run test:after && npm run typecheck"]' \
  --human
```

Or add `"prepareDependencies": true` to a workflow file. `image` then names the existing Node base image; your commands can use ordinary `npm test` and `npm run ...` without linking a custom image's dependency directory. The prepared service example uses [this workflow](../examples/billing-demo.npm.refit.json).

## Installation and checks

Preparation reads committed root manifest/lock files and selected workspace manifests. It verifies public registry package URLs and integrity records before starting a container. `npm ci` installs frozen dependencies, including development dependencies, with install lifecycle scripts, audit and funding requests disabled. If it rejects the lockfile's peer dependencies (`ERESOLVE`), Refit retries once with `--legacy-peer-deps` on the same lockfile and records `installation.legacyPeerDeps` in `environment.json` and the draft. pnpm uses its declared pinned manager and frozen lockfile instead. Engine requirements are enforced. Separate empty npm configuration files override image-level configuration; repository `.npmrc`, `.env`, source files and host credentials are not provided to the installer. The one exception is read on the host: a root `.npmrc` line `legacy-peer-deps=true` adds `--legacy-peer-deps` to `npm ci`, for lockfiles generated with it, and is part of the dependency cache key. Every other `.npmrc` setting, including the registry, is still ignored. No repository Dockerfile or build script runs during preparation.

The installer has bridge networking to download public npm packages, runs as a non-root user, and uses the same restricted Docker resources as validation: read-only root filesystem, no capabilities, no privilege escalation, 1 CPU, 1 GiB memory, 128 processes and a bounded writable workspace. By default (owner decision, 2026-10-24) the installer and validation containers both get a 4 GiB workspace and 5 GiB of memory, with a 2 GiB dependency archive limit: the package cache and the unpacked tree coexist during installation, tmpfs counts against container memory, and the archive is unpacked into the validation workspace. Each container may claim 5 GiB, so the Docker host needs 8 GiB and runs one such check at a time. `REFIT_VALIDATION_WORKSPACE` selects a smaller profile on a smaller host: `2g` (3 GiB memory, 1 GiB archive), `1g` (2 GiB memory, 512 MiB archive) or `512m` (1 GiB memory, 256 MiB archive); under these the installer keeps a 2 GiB workspace and 3 GiB of memory. It changes no other restriction. `REFIT_VALIDATION_OVERLAP=1` lets one validation run its patched side and the baseline in two sandboxes at once, only when `docker info` reports room for both; it is off by default, and an operator running several validations on one host should leave it off. Network stays disabled in every profile, and the report and dependency evidence record the workspace and memory used. Before archiving, Refit checks dependency symlinks resolve inside `node_modules`; broken or escaping links and special files fail preparation. Preparation has a 300-second deadline, the validation profile's archive limit (2 GiB by default, 1 GiB under `2g`) and a 1 MiB log limit. For a larger dependency tree, set `REFIT_DEPENDENCY_TIMEOUT_SECONDS` to a whole number from 60 to 1800; the evidence records the deadline used. CPU, process and validation limits do not change. Cancelled, failed or excessive output stops the client and removes the container; no successful cache is published.

Validation snapshots the verified dependency archive into its own private temporary directory. Both baseline and patched containers extract that same snapshot into their temporary workspace, with **network disabled**. The configured application checks execute there. A passing installation is not a passing test or migration; baseline failures still stop before AI generation.

## Cache, evidence and recovery

Cache identity includes the exact committed manifest and lock bytes, immutable Docker image ID and preparation recipe version. Completed bundles are atomically published and include `dependencies.tar`, `environment.json`, `install.log` and an unsigned hash manifest. Refit verifies file types, hashes, sizes and input identity before reuse. Truncated, changed or incomplete existing bundles stop rather than silently reinstalling. Changing manifests or images creates a different cache entry.

Use `refit verify --directory /absolute/path/to/bundle` for byte integrity. Verification does not authenticate the producer, audit npm packages or establish application behavior. Review `install.log` and input identity before removing an invalid bundle and deliberately preparing it again. Cache and worker state must remain outside Git repositories, including through directory symlinks. Active preparation locks are refused; a verified dead owner can be recovered using the existing state-lock rules.

Validation reports and collapsed PR evidence record the runtime, image, input hashes, dependency archive hash, preparation policy and whether the cache was reused. Human output summarizes dependency preparation separately from check results. Previous configurations without preparation retain their worker identity; enabling preparation needs fresh worker/service state.

## Supported projects

Automatic npm preparation supports a root project or bounded positive-glob workspaces with a committed lockfile version 2 or 3, matching dependency declarations and public `registry.npmjs.org` HTTPS tarballs with SHA-256-or-stronger integrity. A record npm marks `inBundle` ships inside its nearest non-bundled ancestor's tarball, so it is accepted without its own source only when it records a version, carries no `resolved` or `integrity` of its own, and that ancestor passes the same registry and integrity checks (the `npm` package's bundled dependencies are the common case). [pnpm](PNPM-WORKSPACES.md) has its own pinned-manager and lockfile-v9 requirements. Preparation inputs are limited to 512 KiB per manifest/configuration, 8 MiB for the lockfile and 20,000 package records per graph; the scanner's existing repository limits also apply. The image must already contain compatible Node, npm, `/bin/sh` and `tar`.

Yarn 1 root projects and bounded Yarn 1 workspaces use the same preparation with a committed `yarn.lock`. Every lock entry must resolve an exact version to a public `registry.yarnpkg.com` or `registry.npmjs.org` tarball with SHA-256-or-stronger integrity, and every root dependency range must be recorded in the lockfile. Refit installs the pinned Yarn 1 release from `packageManager` (default 1.22.22) through npm, verifies its version and registry integrity, and runs `yarn install --frozen-lockfile --ignore-scripts --no-default-rc` with a private HOME. Only `package.json` and `yarn.lock` enter the installer; repository `.yarnrc`/`.npmrc` files do not. `yarn` is on PATH for offline checks. Workspaces use up to 64 positive patterns, as a list or `{ packages }`. Names must be unique, and sibling dependencies must use `*` or the sibling's exact version; Refit verifies each root `node_modules/<name>` link. `nohoist`, workspace CLI bins, git or local sources, and `yarn.lock` committed alongside another lockfile use the custom-image path.

Yarn 2+ root projects are prepared when `package.json` pins an exact `yarn@2`–`yarn@4` version and `.yarnrc.yml` sets only `nodeLinker: node-modules` (plus optional `enableTelemetry`). Every lock entry must resolve an exact npm version with a checksum. Yarn's built-in `compat` patches are accepted because they ship inside the pinned Yarn bundle, but repository patches are not. Refit installs `@yarnpkg/cli-dist` through npm, verifies a Corepack `+sha512` pin against the bundled `yarn.js`, and configures the install only through environment variables: node-modules linker, scripts off, private cache, immutable lockfile. Repository `.yarnrc.yml` and `.npmrc` never reach the installer. Yarn rewrites manifests it would format differently, so `package.json` must already match Yarn's formatting (sorted dependencies); otherwise preparation stops instead of changing a committed input. Plug'n'Play, Yarn 2+ workspaces, and lockfiles with platform packages that lack checksums (common for `@esbuild/*`) need a custom image, because Yarn would install those packages unverified.

Scans and readiness also read a root `yarn.lock`, both Yarn 1 (`# yarn lockfile v1`) and Yarn 2+ (`__metadata`), to record the SDK version for the exact manifest range. A version is recorded only for a public registry resolution. Aliased, workspace, patched, git and local sources stay unknown. So does a repository that commits `yarn.lock` alongside another package-manager lockfile, or a `yarn.lock` the reader cannot parse.

## Nested packages

When every file the scan reports, each finding and each API-version declaration, belongs to one nested package that declares `stripe` and commits its own lockfile, Refit prepares and checks that package instead of the repository root (`pipeline/preparation-packages.ts`). A file belongs to the nearest `package.json` above it that declares `stripe`, the package Node resolves the SDK from. Preparation reads that package's `package.json`, lockfile and workspaces from the same commit and installs them exactly as it installs a root project: frozen lockfile, public registry tarballs with verified integrity, lifecycle scripts off, then offline checks. A tracked `node_modules` anywhere in the repository is still refused, because Node resolves modules up the directory tree. The validation sandbox copies the whole committed repository, unpacks the package's dependencies into the package directory and runs `command` and `baselineCommand` there, so checks can still read files outside the package. Reports record `validation.packageDirectory`.

Everything else keeps the repository root, as before: files in the root package, files spread over several packages, and a package without an npm, pnpm or Yarn lockfile of its own, such as a workspace member the root lockfile installs. A patch's stripe-node upgrade still edits only the root `package.json`, so a TypeScript package's patched type check can fail on the new `apiVersion` until the patch upgrades the package itself.

## Check time limit

Each check, the baseline, the patched and each generated check, runs for at most `checkTimeoutSeconds` from `.refit.json`, a whole number from 30 to 1800, and 600 by default. Refit then stops the container and the check reports `Check exceeded <N> seconds`, which is an execution error, never a failure of the patch. The default replaces 120 seconds and comes from measured durations, one CPU per check:

- **GitHub Actions** (refit-bench run 40144503063, 249 affected repositories, 4-vCPU runners): the 106 baseline checks took 13.3 s at the median and 31.6 s at the 95th percentile, and the 103 patched checks at most 62.5 s. Two baseline test suites were still passing tests when the 120-second limit stopped them.
- **Fly** ([P1](overnight/P1.md#what-should-the-120-s-check-limit-be-on-hosted-hardware)): a type check took 24.0 s and 29.5 s on performance-2x, and the same checks were estimated at 200 to 240 s on a throttled shared-cpu-2x.

The 300-second installation deadline stays: preparation took at most 51.6 s on Actions and 57 s on Fly performance-2x.

## stripe-node upgrade in a patch

When a Stripe patch for a TypeScript project moves `apiVersion`, it also moves the root `stripe` dependency to the release for the target version, because older type definitions accept only their own version. Refit edits only `package.json` and the one root lockfile, with the registry's SHA-512 integrity, and refuses anything it cannot reproduce exactly; the patch then stops for review rather than shipping a pin the old types reject.

- **npm:** lockfile versions 2 and 3, written with 2-space, 4-space or tab indentation and LF or CRLF line endings. The lockfile is rewritten in its own formatting.
- **pnpm:** lockfile v9 whose text round-trips byte for byte through pnpm's formatting, with `stripe` locked only by the root importer. The snapshot carries the optional `@types/node` peer the root installs, as pnpm writes it, and records only the old `stripe` reached are removed. pnpm 8's lockfile v6 is upgraded for a single project (no `importers`): the root `stripe` entry and its `/stripe@version(peers)` record are rewritten, packages only the old `stripe` reached are removed, and every package's `dev` and `optional` flag is recomputed from the new graph. Refit first recomputes the flags of the unchanged lockfile and refuses unless they match what pnpm recorded. Multi-document lockfiles and v6 workspaces are refused.
- **Yarn 1:** a root `yarn.lock` (LF line endings, no workspaces) whose `stripe` entry serves only the root declaration. The entry keeps the lockfile's registry host and SHA-1 fragment style; blocks only the old `stripe` reached are removed.

Every manager refuses a release that adds dependencies or required peers, an installed optional peer outside the release's range (stripe-node 23 needs `@types/node >=20`), and a `package.json` that declares `stripe` more than once. A reset registry connection is retried twice. Validation then installs the patched lockfile frozen in Docker, so the package manager itself has the last word.

stripe-node 22.4.0 added `OtherString` to every open enum (`Stripe.Price.Type` became `'one_time' | 'recurring' | OtherString`), so code that assigns these values to its own narrower types stops compiling after an upgrade across that release. When validation compares type errors and every error the patch introduced is one of those shapes, Refit restores the known values at the reported positions and reruns the checks before any AI repair: `Extract<Stripe.X.Type, keyof Stripe.X>` for an index, and `Extract<Stripe.Price.Type, 'one_time' | 'recurring'>` for a field or a read assigned to one. The known values come from the stripe@23.0.0 declarations ([`stripe-open-enums.json`](../pipeline/stripe-open-enums.json), generated by `scripts/stripe-open-enums.mjs`; top-level resources only). The repair is kept when the checks then pass. Before an AI repair of a rules patch, it also applies when only some introduced errors have those shapes, and it is kept if the checks then fail only on the errors it left; the model repairs those on the restored code, and the AI guards treat the restore as a rule edit. Either way the PR says so. Runtime code is unchanged, so a value Stripe adds later still reaches the code unchecked, as before the upgrade.

Unsupported workspace layouts, explicit local/Git/URL dependencies, private registries, tracked `node_modules`, shrinkwrap files, bundled lock records outside a verified registry ancestor, custom npm installation flags and packages requiring lifecycle builds use the existing custom-image path. A script-dependent package may install but fail its checks; Refit does not enable those scripts automatically. The supported preparation route is provider-independent, while SDK mapping, migration semantics and useful application checks still require verification.
