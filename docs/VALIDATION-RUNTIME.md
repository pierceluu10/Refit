# Validation runtime

Refit prepares dependencies and runs a repository's checks in a Docker image the workflow names (`image` in `.refit.json`, or `--image`). A repository that declares a Node.js version the image does not satisfy is still checked on that image: npm's `--engine-strict` then refuses the install, or the checks run on a release the project never targets.

`pipeline/validation-runtime.ts` reads the repository's declarations and records whether the configured image satisfies them. The approved configuration chooses the image (owner decision, 2026-10-22), with one exception (requested for the setup-fixes branch, 2026-10-28, to be confirmed by the owner): when the root `package.json` `engines.node` excludes the configured allowlisted image's release, so `npm ci --engine-strict` would fail with `EBADENGINE`, validation runs on the newest allowlisted image `engines.node` accepts. `.nvmrc`, `.node-version`, `volta.node` and `.tool-versions` still never switch it.

## Declarations

Refit reads these files from the committed root, never from the working tree:

| Source                        | Example                                          | How it is read                                    |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| `.nvmrc`                      | `v18.17.0`, `20`, `lts/iron`, `lts/*`, `node`    | The first line that is not empty or a `#` comment |
| `.node-version`               | `20.11.1`                                        | As `.nvmrc`                                       |
| `package.json` `engines.node` | `>=18 <21`, `^20.19.0 \|\| >=22.12.0`, `20.x`    | npm's range grammar                               |
| `package.json` `volta.node`   | `20.11.1`                                        | As `.nvmrc`                                       |
| `.tool-versions`              | `nodejs 20.11.1` (asdf) or `node 20.11.1` (mise) | The first version on the `nodejs` or `node` line  |

`engines.node` is evaluated exactly as npm would: `||` alternatives, hyphen ranges, x-ranges (`18`, `18.x`, `*`), `~`, `^`, and comparators with partial versions (`>18` means `>=19.0.0`, `<=20` means `<21.0.0`). Prerelease versions are not supported and are refused. An empty `engines.node` means any version, as it does for npm.

The version-manager files pin a release line, so Refit counts them by major: `.nvmrc 18.17.0` accepts any 18.x. Refit's images carry the newest release of a line, so matching the exact patch would rule out every image. `lts/<codename>` maps to its major using Node's release index (`https://nodejs.org/dist/index.json`, read 2026-10-22), and `lts/*`, `node`, `stable`, `latest` and `current` accept any release.

Every declaration must hold at once. `.nvmrc 20` with `engines.node ">=20.19 <23"` needs a 20.x release of at least 20.19.

## Comparison

The allowlist is four named constants: `node:18-alpine`, `node:20-alpine`, `node:22-alpine` and `node:24-alpine` (`VALIDATION_NODE_IMAGES`).

1. A configured image outside the allowlist (a custom image) is used as configured, and its declarations are not read.
2. For an allowlisted image, Refit reads its Node.js release (`NODE_VERSION`, from `docker image inspect`; the image is never run for this) and records whether it satisfies every declaration.
3. The configured image is used unless `engines.node` excludes its release. Then Refit tries the other allowlisted images, newest first, skipping any whose release line cannot satisfy the range, and uses the first whose release it accepts, for preparation and checks alike; the reason names the range, both releases and the image used. An image that is not installed is pulled (`docker pull -q node:<major>-alpine`, an official image from the allowlist only); when no image Docker has or can pull satisfies the range, the configured image stays. A declaration Refit cannot read (`.nvmrc "v22/*"`, a non-string `engines.node`) is recorded as the reason; it is not a stop.

`docker run --pull never` is unchanged: only the switch above pulls.

## Package manager pins

`packageManager` pins the package manager the way the files above pin Node.js. Refit does not run Corepack: Corepack would download the manager itself, and the installer containers keep `COREPACK_ENABLE_NETWORK=0`. Instead, preparation installs the exact pinned release from the npm registry with `--ignore-scripts`, and checks its version and registry integrity, plus a Corepack `sha512` checksum when the pin has one, before using it.

- **pnpm and Yarn** pins were already handled this way.
- **npm** pins are new: `npm@10.8.2`, optionally `+sha512.<hex>`, installs that npm, runs `npm ci` with it, and moves it into `node_modules/.refit-tools`, so the offline checks run the same npm. The environment records it as `npmToolVersion` and `npmToolIntegrity`; `npmVersion` stays the image's own npm. A pin that is not exact (`npm@10`, `npm@^10.8.0`) keeps the image's npm, as before.
- **Not read:** `engines.npm`. Official Node.js images do not record their npm release in their environment, so reading it would mean starting the image. A repository that needs a newer npm than its image ships can pin it with `packageManager`.

## Evidence

The validation result records the choice as `validation.runtime`: the configured image, the image used, its Node.js release, the declarations read and the reason. The CLI summary shows it as a `Runtime` row, with the reason when the repository declares a version. `validation.image` remains the immutable image ID the checks ran on.

## How often it matters

The census covers every repository in the frozen Stripe and Shopify lists, read at each pinned commit on 2026-10-22. It is committed as `docs/benchmarks/2026-10-22-node-declarations.json`, and each repository is classified against Node.js 22.23.3, the release in `node:22-alpine` for the committed benchmark runs.

| List                         | Repositories | Declare a version | 22.23.3 satisfies | Needs another allowed line | No allowed line | Unreadable |
| ---------------------------- | ------------ | ----------------- | ----------------- | -------------------------- | --------------- | ---------- |
| Stripe `2026-10-14`          | 100          | 17                | 13                | 3                          | 1               | 0          |
| Stripe held-out `2026-10-15` | 50           | 7                 | 3                 | 4                          | 0               | 0          |
| Stripe fresh `2026-10-16`    | 381          | 55                | 32                | 17                         | 5               | 1          |
| Stripe active `2026-10-16`   | 66           | 31                | 20                | 11                         | 0               | 0          |
| Shopify `2026-10-16`         | 50           | 39                | 35                | 4                          | 0               | 0          |
| Shopify fresh `2026-10-16`   | 200          | 121               | 104               | 14                         | 3               | 0          |
| **All**                      | **847**      | **270**           | **207**           | **53**                     | **9**           | **1**      |

- **By source:** `engines.node` 240, `.nvmrc` 51, `.node-version` 7, `.tool-versions` 2, `volta.node` 0. A repository can declare in several places.
- **Lines needed:** of the 53 repositories that need another allowed line, the highest satisfying line is 24 for 23, 20 for 21, 18 for 7, and an older 22.x release than 22.23.3 for 2 (exact `engines.node` pins).
- **No allowed line:** 6 of the 9 pin Node 16 in `.nvmrc`; the others are `.nvmrc 26.1.0`, `.nvmrc v19.4.0`, and `.nvmrc 18` with `engines.node ">=20.0.0"`.
- **Unreadable:** the one unreadable declaration is `.nvmrc "v22/*"`.

## Failures in the committed results

The committed Stripe and Shopify results record 12 repositories whose dependency preparation or baseline check failed. Their stored reasons keep only the first line of the error, so each was rerun on 2026-10-22 at its frozen commit with Refit at `973d476`. Dependency preparation ran on `node:22-alpine`, the benchmark's image, and when it succeeded the benchmark's own check followed: the test script, else `tsc --noEmit -p .`. None of the 12 fails because of a Node.js version mismatch. Ten declare no version; deepa-test-app (`>=20.19 <22 || >=22.12`) and ampertalent (`>=18.0.0`) declare one that 22.23.3 satisfies, so the configured image satisfies them.

| Cause on 2026-10-22                                                                                                                 | Repositories                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Yarn 1 runs out of space in the 2 GiB installer workspace (ENOSPC)                                                                  | vignesh-gupta/digibee-marketplace, Strata-Labs/BitScript, shaoxuan0916/life-slice, Addisu87/digital-marketplace                |
| Checks need the Prisma client generated (`@prisma/client` has no `PrismaClient`, or `.prisma/client/default` is missing)            | zero19124/next-ai-platform, Sanjdcool/ApanStack-Newsletter, utsavkrishnatra/pdf_answers (which also has unrelated type errors) |
| `package-lock.json` out of sync with `package.json`                                                                                 | muhallimir/ampertalent, devczero/saas-pdf-analysis-dev                                                                         |
| Dependency archive over 1 GiB                                                                                                       | adamhitzger/financehb                                                                                                          |
| `tsc` finds no input files for the committed `tsconfig.json`                                                                        | Mohanatheeba/deepa-test-app                                                                                                    |
| Jest cannot load `jest.config.ts`: Node.js 22 loads it as native ESM, where the extensionless `import 'next/jest'` does not resolve | 4NDR3S-01/StyleHub                                                                                                             |

StyleHub is the only one that may depend on the Node.js release, and it declares none. These reruns are not backed by a committed results file. next-ai-platform and pdf_answers failed preparation in the committed run but prepare at current `main`; the stored reasons do not say why they failed then.
