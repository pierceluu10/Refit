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
