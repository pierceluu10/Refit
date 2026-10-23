# Supply chain

What Refit ships, what it depends on, and how each part is pinned, verified and audited. Refit reads customer code as a GitHub App, so a compromised dependency, base image or build step would reach that code. Audited on 2026-10-22 from `main` at `7b2c86a`.

## Summary

| Audit item | Result |
|---|---|
| `npm audit`, production | 0 advisories, before and after this change |
| `npm audit`, development | 9 advisories (2 high, 6 moderate, 1 low) in vite, source-map-js and vitest, all unreachable from shipped code; **fixed** by updating to vite 8.3.5, source-map-js 1.2.2 and vitest 4.1.12, so 0 now |
| Direct dependencies | 27 declared; 1 unused (`@testing-library/user-event`), **removed** after a clean build and full suite |
| GitHub Actions | `actions/checkout` and `actions/setup-node` were pinned by tag (`@v4`); **now pinned by commit SHA** in every workflow |
| Dockerfiles | Both base images were tags. The hosted image downloaded `oasdiff` with no checksum. **Now** pinned by digest, and `oasdiff` is verified against its published SHA-256 |
| Container runtime in the hosted image | **High, open:** bookworm's `runc` 1.1.5, `containerd` 1.6.20 and `docker.io` 20.10.24 have open Debian security issues (5, 7 and 15). Listed for the owner; see [Hosted image](#hosted-image) |
| `fly.toml` | Validation image `node:22-alpine` is pulled by tag on boot. Read only here: **request for Pierce** |
| CLI tarball | Shipped 6 MB of benchmark data and AI evaluation records (third-party code included), had no `license`, and left 49 transitive versions to float at install. **Now** without that data, MIT-declared, with an `npm-shrinkwrap.json`. No secrets (gitleaks) |
| Licenses | CLI runtime: 57 packages, all permissive. Website bundle: 8 MIT plus 2 OFL-1.1 fonts. Hosted image: see [Hosted image](#hosted-image) |
| SBOM | `scripts/sbom.mjs` writes CycloneDX 1.5 for the tarball (offline, from the shrinkwrap) and for the hosted image (from a local run without network) |
| CI gate (Keep going) | `.github/workflows/supply-chain.yml` fails on any high or critical advisory without a reviewed exception |

## `npm audit`

`npm audit --omit=dev` reported nothing. The full tree reported these, per advisory. These IDs come from `node scripts/audit-gate.mjs` run against `main`'s lockfile. Each reason comes from the advisory's own *Impact* conditions, read through the GitHub advisory API.

| Advisory | Package (range) | Severity | Reachable? | Why |
|---|---|---|---|---|
| GHSA-587h-7wmj-h5pm | vite 8.3.0–8.3.2 | high | No | `launch-editor` check bypass on Windows, inside the dev server's open-in-editor handler. The CLI, the hosted image and CI never start the dev server. |
| GHSA-68fv-2mgg-jv7q | source-map-js < 1.2.2 | high | No | Event-loop DoS from a crafted indexed source map. Reached only when a build parses an attacker's source map; ours parse only this repository's own. |
| GHSA-698v-4r3x-3vcv | vite 8.3.0–8.3.2 | moderate | No | Windows `launch-editor` argument escaping, dev server only |
| GHSA-r825-w8mm-5pxw | vite 8.3.0–8.3.2 | moderate | No | `launch-editor` passes paths starting with `+` or `-` to editors such as Vim or Emacs as flags. Dev server open-in-editor only, and it needs an attacker-created file in the working directory. |
| GHSA-rq7h-c2jc-7f22 | vite 8.3.0–8.3.2 | moderate | No | `server.fs.allow` bypass that needs the dev server exposed to the network. `npm run dev` binds 127.0.0.1. |
| GHSA-vfpm-58rq-9qcg | vite 8.3.0–8.3.2 | moderate | No | `?vite-wasm-instance` reads 4 bytes outside `server.fs`; it needs the dev server exposed to the network |
| GHSA-9jrq-w75r-8gcw | vite 8.3.0–8.3.2 | low | No | Affects only dev servers that pass request URLs to `transformIndexHtml` (`middlewareMode` or `appType: 'custom'`); the site uses Vite's default SPA mode |
| GHSA-qxg6-89mg-rqv8 | @vitest/mocker < 4.1.12 | moderate | No | Unauthenticated mock registration on the dev-server WebSocket that `@vitest/mocker`'s interceptor plugin serves to a browser. Both test projects run in `node` and `jsdom`, with no browser-mode server. |
| GHSA-xp26-3454-mjgp | @vitest/mocker 4.1.11 | moderate | No | Windows path traversal in the same redirect allowlist |

None of these reach the CLI tarball, which ships none of these packages, or the hosted image, which installs that tarball. They were fixed anyway: `npm audit fix` for vite and source-map-js, and `vitest@^4.1.12`. Typecheck, format, the full suite (1699 passed) and the build pass on the new versions.

## Direct dependencies

Each declared dependency was traced to the files that import it, or to the npm script, compiler setting or Vite config that loads it.

| Dependency | Kind | Used by |
|---|---|---|
| `diff`, `fast-xml-parser`, `graphql`, `parse5`, `pg`, `yaml` | runtime | CLI and hosted worker (`pipeline/`) |
| `tsx`, `typescript-compiler` (TypeScript 5.9) | dev in the repository, runtime in the tarball | `bin/refit.mjs` loads `pipeline/*.ts` through tsx; the analyzer parses customer code with the 5.9 compiler API |
| `react`, `react-dom`, `react-router-dom`, `@phosphor-icons/react`, `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` | runtime of the website bundle | `src/` |
| `typescript` (7.x), `prettier`, `vite`, `vitest`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom` | dev | npm scripts, `vite.config.ts`, `src/test/setup.ts`, `tsconfig.json` |
| `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom` | dev | Picked up by the compiler for `node:*`, `pg` and React imports; no file names them |
| `@testing-library/user-event` | dev | **Nothing.** Removed; checks and the full suite pass without it |

The website's packages are declared as `dependencies` in the private root `package.json`. They are bundled by Vite and never reach the CLI tarball, which lists its own 8 runtime dependencies (`scripts/package-cli.mjs`).

## GitHub Actions

Every `uses:` names a commit with its release as a comment, the same pins in every workflow (see [CI pinning](CI.md#pinning)):

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
- `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`

The audit gate first used the v4.4.0 commits; it moved to these pins when the gated-suite workflow landed, so one set is maintained. `actionlint` was run against the v4.4.0 version of `supply-chain.yml` only.

Other workflow properties:
- `ci.yml` and `supply-chain.yml` run with `contents: read` only, so fork pull requests get a read-only token.
- `registry-sync.yml` grants write permissions only to its own job, and runs only on a schedule or a manual dispatch.

## Container images

| Image | Before | Now |
|---|---|---|
| `Dockerfile` (hosted worker), both stages | `node:22-bookworm-slim` | `node:22-bookworm-slim@sha256:de170b39…` (multi-arch index) |
| `oasdiff` in the hosted image | `curl … \| tar -xz`, unverified | Downloaded to a file, checked against the SHA-256 for its architecture from oasdiff's v1.33.0 `checksums.txt` (the two values matched the downloads on 2026-10-22), then unpacked. Unknown architectures fail the build. |
| CLI install in the hosted image | `npm install --global <tgz>` ran dependency install scripts | `--ignore-scripts`; the CLI runs without them (`pipeline/packaging.test.ts`) |
| `.dockerignore` | Excluded only root-level `.env`, `*.pem`, `node_modules` | Excludes them at any depth, plus `.claude` and `.planning`. A `fly deploy` from a clone with agent worktrees would otherwise upload their env files and keys to the remote builder. |
| `scripts/billing-validation.Dockerfile` | `node:22-alpine` | `node:22-alpine@sha256:fe4f6d74…`. Not built here: its context is the private billing demo. |
| `fly.toml` `REFIT_HOSTED_IMAGES` | `node:22-alpine`, pulled by tag at every boot | Unchanged (read only). Request: pin it by digest. |

Validation itself records what ran: `resolveDockerImage` turns a `.refit.json` image name into the local immutable image ID, and validation runs with `--pull never`. Images are still chosen by the repository's approved configuration. On this machine, `node:22-alpine` resolved to an older pull (`0a7108bf…`) than the registry's current index (`fe4f6d74…`), so the same name can mean different images on different machines.

Debian packages in the hosted image (`docker.io`, `git`, `iptables`, `curl`, `ca-certificates`) are not version-pinned: `apt-get` installs whatever the bookworm security mirror has at build time. Pinning them would block security updates, so this is accepted. The SBOM records the versions each build actually got.

## CLI tarball (`npm run package:cli`)

| Check | Before | Now |
|---|---|---|
| Size and files | 1.47 MB, 382 files | 885 KB, 316 files |
| `docs/benchmarks`, `docs/ai-evals` | Shipped (67 files, about 6 MB unpacked), never read at runtime. They include diffs of third-party repositories that declare no license (docs/PUBLIC-READINESS.md, D1). | Not shipped; asserted in `pipeline/packaging.test.ts` |
| Tests | None shipped (`*.test.ts` excluded, asserted) | Same |
| Fixtures | Shipped by design: `replay`, `demo` and the install test run them | Same |
| Guides (`docs/*.md`), `examples/` | Shipped; CLI messages and adapters point at them | Same |
| `license` in `package.json` | Missing | `MIT`, also declared in the root `package.json` |
| Transitive versions | Only the 8 direct dependencies were exact; 49 transitive versions resolved fresh on every install | `npm-shrinkwrap.json` pins all 57 runtime packages with integrity hashes. The packaging test asserts that every entry has the same name, version and integrity as in `package-lock.json` and none is a dev package. npm recommends this for "daemons and command-line tools intended as global installs" ([npm docs](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json), read 2026-10-22). |
| Secrets | Not checked | gitleaks v8.30.1 `dir` scan of the unpacked tarball: no findings |
| Install scripts | `esbuild` (through tsx) and `fsevents` run install scripts on `npm install` | Same for users. The hosted image now installs with `--ignore-scripts`. The release instructions could recommend that too (request for PP10/PP8). |

`REFIT_PACKAGE_INSTALL=1 npx vitest run pipeline/packaging.test.ts` installs the new tarball into an empty prefix (`--ignore-scripts --omit=dev`, honouring the shrinkwrap). It runs `--version`, the bundled replay, a configured run and every command's `--help`: 3/3 passed.

## Licenses

| Shipped in | Packages | Licenses |
|---|---|---|
| CLI tarball (`npm-shrinkwrap.json`) | 57, of which 28 are optional platform packages (26 esbuild binaries, `fsevents` and `pg-cloudflare`) | MIT 51, ISC 3, Apache-2.0 1 (TypeScript), BSD-2-Clause 1, BSD-3-Clause 1 |
| Website bundle | 10 | MIT 8, OFL-1.1 2 (`@fontsource-variable/geist`, `geist-mono`) |

Refit is MIT. Every CLI dependency license is permissive and compatible; attribution is satisfied by the packages' own license files, which npm installs with them.

The Geist fonts are under the SIL Open Font License 1.1, which allows bundling with software, provided the font keeps its copyright notice and license. The built site serves the font files without that text. This is low severity: add the OFL notice to the site, or link it, when the website is published.

## SBOM

```sh
npm run package:cli -- --output /tmp/refit-release
node scripts/sbom.mjs cli --archive /tmp/refit-release/refit-<version>.tgz --output refit-<version>.cdx.json
docker build -t refit-hosted:<tag> .
node scripts/sbom.mjs image --image refit-hosted:<tag> --output refit-hosted-<tag>.cdx.json
```

The script adds no dependency.
- **`cli` mode** unpacks the tarball and runs npm's built-in `npm sbom --package-lock-only --offline` against its shrinkwrap. Nothing is installed or downloaded. It then names the root `refit` and records the archive's SHA-256.
- **`image` mode** runs the local image without network or pulling. It combines `dpkg-query`, `node --version`, `oasdiff --version`, the global npm packages and `npm sbom` of the installed Refit tree into one CycloneDX 1.5 document whose root is the image ID.

Existing output files are never overwritten. `pipeline/sbom-helpers.test.ts` covers the conversions and runs `cli` mode end to end: 57 components, all npm package URLs, root hash equal to the archive's.

## Hosted image

Built locally from this branch (`e40468e` plus the Dockerfile changes) with `docker build --platform linux/amd64 -t refit-hosted:op7 .` in 65 s, under the machine's Docker lock. The image ID is `sha256:616deeb8…`, 242 MB.

- **Build.** The `oasdiff` checksum step printed `/tmp/oasdiff.tar.gz: OK`.
- **Smoke run** (`--network none`, entrypoint overridden so `dockerd` does not start): `refit --version` gives 0.39.0, `oasdiff version 1.33.0` and Node v22.23.4. `npm-shrinkwrap.json` is present in the installed package, and `refit replay --propose-patch` returns `affected` with a `proposed` patch.
- **`scripts/sbom.mjs image`.** 167 components:
  - 131 Debian packages;
  - Node.js and oasdiff;
  - 34 npm packages: `npm` 10.9.9, `corepack` 0.36.0, and `refit` with the 31 runtime packages installed for linux-x64.

**Container runtime (High).** Validation runs repository code under the Debian bookworm packages this image installs: `docker.io` 20.10.24+dfsg1-1+deb12u1+b6, `containerd` 1.6.20~ds1-1+deb12u3 and `runc` 1.1.5+ds1-1+deb12u1. On 2026-10-22, Debian's security tracker listed these as open in bookworm:

| Package | Open in bookworm | Source |
|---|---|---|
| `runc` | 5: CVE-2026-41579, CVE-2025-52881, CVE-2025-52565 and CVE-2025-31133 "vulnerable"; CVE-2024-45310 "vulnerable (no DSA)" | [tracker](https://security-tracker.debian.org/tracker/source-package/runc) |
| `docker.io` | 15 (9 "vulnerable", 6 "vulnerable (no DSA)") | [tracker](https://security-tracker.debian.org/tracker/source-package/docker.io) |
| `containerd` | 7 "vulnerable" | [tracker](https://security-tracker.debian.org/tracker/source-package/containerd) |

CVE-2025-31133, for example, is runc not verifying that the bind-mount source used to mask paths is a real `/dev/null` ([tracker](https://security-tracker.debian.org/tracker/CVE-2025-31133)). Debian fixed it in sid (1.3.6), not in bookworm or trixie.

On Fly, `dockerd` runs inside the worker's own VM. That VM also holds the App key file and every Fly secret (`docs/SECURITY.md`, T6 and T13 on #171), so a container escape there reaches them. This review did not test whether any of these CVEs is exploitable through Refit's validation flags; OG3 owns that audit. The fix is to install the container runtime from Docker's own apt repository, verified by key fingerprint and pinned, or from a Debian suite that carries the fixes. It changes the production runtime and needs a deploy-time test on Fly, so it is listed for the owner rather than made here.

**Licenses in the image.** Debian packages carry their own licenses (GPL, LGPL, MIT, BSD and others), installed as copyright files under `/usr/share/doc`. The image aggregates them; Refit links none of them into its code. `oasdiff` is Apache-2.0 per its repository, and Node.js is MIT. The image SBOM records names and versions, not licenses, for Debian packages.

## CI gate (Keep going)

`.github/workflows/supply-chain.yml` runs `node scripts/audit-gate.mjs` on every pull request, on `main` and weekly, because advisories appear without code changes. The gate:

- reads `npm audit` for all dependencies and for production only; nothing is installed;
- fails on any **high or critical** advisory unless `scripts/audit-exceptions.json` records why that exact advisory and package cannot be reached. Each exception needs a reason of at least 20 characters and an expiry within 365 days. An exception that npm no longer reports also fails, so it cannot hide a later reappearance. Any invalid entry rejects the whole file;
- reports moderate and lower advisories without failing;
- fails closed if `npm audit` itself errors (for example, the registry is unreachable).

Against `main`'s lockfile it fails on GHSA-587h-7wmj-h5pm (vite) and GHSA-68fv-2mgg-jv7q (source-map-js). On this branch it passes with 0 advisories and 0 exceptions. The file starts empty.

## Remaining items

| Severity | Item | Owner |
|---|---|---|
| High | The hosted image's container runtime (`runc` 1.1.5, `containerd` 1.6.20, `docker.io` 20.10.24 from bookworm) has open Debian security issues, including the 2025 runc mount-verification CVEs. Hostile repository code runs on it in the same VM as the hosted secrets. | Pierce (hosted image and Fly deploy), with OG3 for the sandbox |
| Medium | `fly.toml` pulls `REFIT_HOSTED_IMAGES=node:22-alpine` by tag on every boot, so the validation image can change between deploys without review | Pierce (read only here) |
| Low | Users who install the tarball run `esbuild`'s and `fsevents`' install scripts unless they pass `--ignore-scripts` | PP10/PP8: release and install docs |
| Low | Debian packages in the hosted image are not version-pinned (accepted; recorded by the image SBOM) | — |
| Low | Geist fonts' OFL notice is not shipped with the website | Website owner |
| Info | `.refit.json` images are chosen by name; validation records and runs the resolved local image ID | — |

## Requests for other lanes

- **Pierce (hosted image).** Replace bookworm's `docker.io`, `containerd` and `runc` with a currently patched runtime, then test a validation on Fly before relying on it. See [Hosted image](#hosted-image).
- **OG3 (sandbox).** Your hardening assumes the runtime itself is sound. The open runc and containerd issues above belong in `docs/SANDBOX.md` as an accepted or tracked risk.
- **Pierce (`fly.toml`).** Pin `REFIT_HOSTED_IMAGES` by digest, for example `node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914` (the index on 2026-10-22). Approved `.refit.json` files then need the same reference.
- **OG9 (CI).** `supply-chain.yml` is a separate workflow so it does not collide with `ci*.yml`. Keep it, fold it into `ci.yml`, or make "npm audit gate" a required check. Also keep the SHA pins this PR puts in `ci.yml`. OP8 (#183) asks for a pinned gitleaks job; with its `.gitleaksignore` merged, `docker run zricethezav/gitleaks@sha256:c00b6bd0… git /repo --log-opts=--all` passes on `main`.
- **PG6 (registry sync).** Your new `registry-sync.yml` should use the same pinned SHAs. `deadlines-sync.yml` is pinned here.
- **PP10 / PP8.** Release notes and `docs/INSTALL.md`: install with `npm install --global --ignore-scripts refit-<version>.tgz`, and attach the `scripts/sbom.mjs cli` output next to `SHA256SUMS`.
