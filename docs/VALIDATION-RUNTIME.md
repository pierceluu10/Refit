# Validation runtime

Refit prepares dependencies and runs a repository's checks in a Docker image the workflow names (`image` in `.refit.json`, or `--image`). Before this change, a repository that declares a Node.js version was still checked on that image even when the declaration excluded it. npm's `--engine-strict` then refused the install, or the checks ran on a release the project never targets.

`pipeline/validation-runtime.ts` now picks the image from the repository's own declaration, within an operator allowlist.

## Declarations

Refit reads these files from the committed root, never from the working tree:

| Source | Example | How it is read |
| --- | --- | --- |
| `.nvmrc` | `v18.17.0`, `20`, `lts/iron`, `lts/*`, `node` | The first line that is not empty or a `#` comment |
| `.node-version` | `20.11.1` | As `.nvmrc` |
| `package.json` `engines.node` | `>=18 <21`, `^20.19.0 \|\| >=22.12.0`, `20.x` | npm's range grammar |
| `package.json` `volta.node` | `20.11.1` | As `.nvmrc` |
| `.tool-versions` | `nodejs 20.11.1` (asdf) or `node 20.11.1` (mise) | The first version on the `nodejs` or `node` line |

`engines.node` is evaluated exactly as npm would: `||` alternatives, hyphen ranges, x-ranges (`18`, `18.x`, `*`), `~`, `^`, and comparators with partial versions (`>18` means `>=19.0.0`, `<=20` means `<21.0.0`). Prerelease versions are not supported and are refused. An empty `engines.node` means any version, as it does for npm.

The version-manager files pin a release line, so Refit counts them by major: `.nvmrc 18.17.0` accepts any 18.x. Refit's images carry the newest release of a line, so matching the exact patch would rule out every image. `lts/<codename>` maps to its major using Node's release index (`https://nodejs.org/dist/index.json`, read 2026-10-22), and `lts/*`, `node`, `stable`, `latest` and `current` accept any release.

Every declaration must hold at once. `.nvmrc 20` with `engines.node ">=20.19 <23"` needs a 20.x release of at least 20.19.

## Selection

The allowlist is four named constants: `node:18-alpine`, `node:20-alpine`, `node:22-alpine` and `node:24-alpine` (`VALIDATION_NODE_IMAGES`).

1. A configured image outside the allowlist (a custom image) is used as configured. The declarations are still recorded.
2. A repository with no declaration uses the configured image, as before.
3. If the configured image's Node.js release satisfies every declaration, it is used.
4. Otherwise, Refit takes the highest installed allowed image whose release satisfies every declaration. The release is the image's `NODE_VERSION`, read with `docker image inspect`; the image is never run for this.
5. If no allowed release line could satisfy the declarations (for example `.nvmrc v16.18.0`, or `.nvmrc 18` with `engines.node ">=20"`), the configured image is used and the reason is recorded. The baseline check then shows whether the repository works there; this keeps such repositories exactly as they were.

The choice applies to dependency preparation and to every check of the run, and the dependency cache is keyed by the image, as before.

## Stops

Images are never pulled; `docker run --pull never` is unchanged. A run stops before preparation with a named reason when:

- **An allowed image it needs is not installed:** `Validation needs a Node.js image that satisfies .nvmrc "24". Install node:24-alpine on the Docker host (docker pull node:24-alpine); Refit never pulls images.`
- **No installed allowed image carries a satisfying release**, for example `engines.node "22.14.0"` when `node:22-alpine` carries 22.23.3: `None of the installed allowed images does (node:22-alpine (22.23.3)); install a release that does, or configure a custom validation image.`
- **A declaration cannot be read:** `Validation cannot read .nvmrc "v22/*" as a Node.js version or range.` The same happens for a non-string `engines.node`.

An operator who wants every allowed line available installs the images once: `docker pull node:18-alpine node:20-alpine node:24-alpine`. On the hosted worker, that means listing them in `REFIT_HOSTED_IMAGES`.

## Before and after on repositories that failed for this reason

Because none of the committed failures was a Node.js mismatch, the candidates came from the census instead: repositories whose `engines.node` excludes Node.js 22, which npm, pnpm and Yarn enforce at install time. Each was screened with Refit's own preparation input checks, without Docker. Four that reached Docker turned out to stop for unrelated reasons and are listed at the end.

Each repository then ran twice on 2026-10-22, at its frozen commit, one Docker lock hold per repository. "Before" means preparation (and, when it succeeded, the benchmark's check) on the configured `node:22-alpine`, as `main` does. "After" means the same on the image `selectValidationRuntime` chose. Refit was at `973d476` to `d53318f`; the selection code is the same across that range, and `d53318f` only adds npm pins, which applied to both runs of the one repository that pins npm (the chr33s starter, `npm@12.0.2`).

| Repository (commit) | Declaration | Before: `node:22-alpine` | After |
| --- | --- | --- | --- |
| Kayange123/ecommerce-dashboard `d67efd0` | `engines.node 24.x` | npm refuses (`EBADENGINE`) | `node:24-alpine`: prepared; `npm test` passed |
| airwaylab-app/airwaylab `350571d` | `.nvmrc 20`, `engines.node 20.x` | npm refuses | `node:20-alpine`: prepared; `npm test` ran and was killed before it finished (no exit code: the 120-second limit or the output cap) |
| ondrej7lukac/fakturidias `329e2bf` | `engines.node 20.x` | npm refuses | `node:20-alpine`: prepared; the repository has no test script or typecheck to run |
| chr33s/shopify-cloudflare-hono-preact-iso-starter `76e4d3e` | `engines.node >=24.0.0` | npm refuses | `node:24-alpine`: prepared; `npm test` failed because Cloudflare's `workerd` cannot start its local server in the offline sandbox |
| ShopyOs/metaobjects-orm `50ef372` | `engines.node ^18 \|\| ^20` | npm refuses | `node:20-alpine`: prepared; Jest reported "Test suite failed to run" (the cause was beyond the captured output) |
| AlbanAndrieu/nabla-site-apache `b795de3` | `.nvmrc v24.14.1`, `engines.node 24.x` (and `npm >=11.6.2`) | npm refuses | `node:24-alpine`: installed; the dependency archive exceeds 1 GiB |
| meetingmindsexperts/ea-sys `1eea545` | `.nvmrc 24`, `engines.node 24.x` (and `npm 11.x`) | npm refuses | `node:24-alpine`: installed; archive over 1 GiB |
| papotte/stundenzettel `59e0c24` | `.nvmrc 24.15.0`, `engines.node 24` | npm refuses | `node:24-alpine`: installed; archive over 1 GiB |
| acm-uiuc/core `32a5dad` | `engines.node >=24.0.0 <25.0.0` | Yarn 1 refuses (`The engine "node" is incompatible`) | `node:24-alpine`: Yarn ran out of space in the 2 GiB workspace |
| meisbobzheng/pinpoint-archive `24f900a` | `engines.node >=23.0.0` | Yarn 1 refuses | `node:24-alpine`: out of space in the 2 GiB workspace |
| ACKaraca/draw-or-die `d0799c0` | `.nvmrc 22.23.1`, `engines.node 22.23.1` | npm refuses | Named stop before preparation: no installed allowed image carries 22.23.1 |
| Lightspace-dev/shopify-remix-app-template `01fe63d` | `engines.node 22.14.0` | npm refuses | Named stop: no installed allowed image carries 22.14.0 |
| mw10013/tanstack-cloudflare-effect-shopify-app `ca98413` | `engines.node 24.14.0` | pnpm refuses (`ERR_PNPM_UNSUPPORTED_ENGINE`) | Named stop: `node:24-alpine` carries 24.22.1 |

All ten repositories that failed on Node.js 22 because of their declaration now get past it. Five then prepare: one passes its tests, three run checks that fail for reasons of their own, and one has no check to run. The other five stop later, on limits that are already named (three archives over 1 GiB, two Yarn 1 workspaces out of space). The three exact pins that no moving image tag can meet now stop before preparation with a reason that names the declaration, instead of an installer error.

Excluded after screening, because their preparation stops for reasons unrelated to Node.js in both runs: UTDallasEPICS/Carson-s-Village (unsupported pnpm settings), LoLoSenPai/oryon-master (a non-registry tarball URL), thematters/matters-server (lockfile entries without integrity), PansaLegrand/sushi-saas-template (pnpm importer specifiers differ from the manifests).

## Package manager pins

`packageManager` pins the package manager the way the files above pin Node.js. Refit does not run Corepack: Corepack would download the manager itself, and the installer containers keep `COREPACK_ENABLE_NETWORK=0`. Instead, preparation installs the exact pinned release from the npm registry with `--ignore-scripts`, and checks its version and registry integrity, plus a Corepack `sha512` checksum when the pin has one, before using it.

- **pnpm and Yarn** pins were already handled this way.
- **npm** pins are new: `npm@10.8.2`, optionally `+sha512.<hex>`, installs that npm, runs `npm ci` with it, and moves it into `node_modules/.refit-tools`, so the offline checks run the same npm. The environment records it as `npmToolVersion` and `npmToolIntegrity`; `npmVersion` stays the image's own npm. A pin that is not exact (`npm@10`, `npm@^10.8.0`) keeps the image's npm, as before.
- **Not read:** `engines.npm` is not part of the image choice. Official Node.js images do not record their npm release in their environment, so reading it would mean starting each candidate image. A repository that needs a newer npm than its image ships can pin it with `packageManager`.

## Evidence

The validation result records the choice as `validation.runtime`: the configured image, the image used, its Node.js release, the declarations read and the reason. The CLI summary shows it as a `Runtime` row, with the reason whenever the image differs from the configured one. `validation.image` remains the immutable image ID the checks ran on.

## How often it matters

The census covers every repository in the frozen Stripe and Shopify lists, read at each pinned commit on 2026-10-22. It is committed as `docs/benchmarks/2026-10-22-node-declarations.json`, and each repository is classified against Node.js 22.23.3, the release in `node:22-alpine` for the committed benchmark runs.

| List | Repositories | Declare a version | 22.23.3 satisfies | Needs another allowed line | No allowed line | Unreadable |
| --- | --- | --- | --- | --- | --- | --- |
| Stripe `2026-10-14` | 100 | 17 | 13 | 3 | 1 | 0 |
| Stripe held-out `2026-10-15` | 50 | 7 | 3 | 4 | 0 | 0 |
| Stripe fresh `2026-10-16` | 381 | 55 | 32 | 17 | 5 | 1 |
| Stripe active `2026-10-16` | 66 | 31 | 20 | 11 | 0 | 0 |
| Shopify `2026-10-16` | 50 | 39 | 35 | 4 | 0 | 0 |
| Shopify fresh `2026-10-16` | 200 | 121 | 104 | 14 | 3 | 0 |
| **All** | **847** | **270** | **207** | **53** | **9** | **1** |

- **By source:** `engines.node` 240, `.nvmrc` 51, `.node-version` 7, `.tool-versions` 2, `volta.node` 0. A repository can declare in several places.
- **Lines needed:** of the 53 repositories that need another allowed line, the highest satisfying line is 24 for 23, 20 for 21, 18 for 7, and an older 22.x release than 22.23.3 for 2 (exact `engines.node` pins, which stop).
- **No allowed line:** 6 of the 9 pin Node 16 in `.nvmrc`; the others are `.nvmrc 26.1.0`, `.nvmrc v19.4.0`, and `.nvmrc 18` with `engines.node ">=20.0.0"`.
- **Unreadable:** the one unreadable declaration is `.nvmrc "v22/*"`.

## Failures in the committed results

The committed Stripe and Shopify results record 12 repositories whose dependency preparation or baseline check failed. Their stored reasons keep only the first line of the error, so each was rerun on 2026-10-22 at its frozen commit with Refit at `973d476`. Dependency preparation ran on `node:22-alpine`, the benchmark's image, and when it succeeded the benchmark's own check followed: the test script, else `tsc --noEmit -p .`. None of the 12 fails because of a Node.js version mismatch. Ten declare no version; deepa-test-app (`>=20.19 <22 || >=22.12`) and ampertalent (`>=18.0.0`) declare one that 22.23.3 satisfies, so this change keeps their image.

| Cause on 2026-10-22 | Repositories |
| --- | --- |
| Yarn 1 runs out of space in the 2 GiB installer workspace (ENOSPC) | vignesh-gupta/digibee-marketplace, Strata-Labs/BitScript, shaoxuan0916/life-slice, Addisu87/digital-marketplace |
| Checks need the Prisma client generated (`@prisma/client` has no `PrismaClient`, or `.prisma/client/default` is missing) | zero19124/next-ai-platform, Sanjdcool/ApanStack-Newsletter, utsavkrishnatra/pdf_answers (which also has unrelated type errors) |
| `package-lock.json` out of sync with `package.json` | muhallimir/ampertalent, devczero/saas-pdf-analysis-dev |
| Dependency archive over 1 GiB | adamhitzger/financehb |
| `tsc` finds no input files for the committed `tsconfig.json` | Mohanatheeba/deepa-test-app |
| Jest cannot load `jest.config.ts`: Node.js 22 loads it as native ESM, where the extensionless `import 'next/jest'` does not resolve | 4NDR3S-01/StyleHub |

StyleHub is the only one that may depend on the Node.js release, and it declares none, so a declaration-driven choice cannot reach it. next-ai-platform and pdf_answers failed preparation in the committed run but prepare at current `main`; the stored reasons do not say why they failed then.
