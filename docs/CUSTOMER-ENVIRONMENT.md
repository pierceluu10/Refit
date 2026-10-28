# Validating in a customer's environment

Refit validates a patch by running the repository's own checks, offline, on dependencies Refit installed itself from the committed lockfile ([Dependencies](DEPENDENCIES.md)). Some real repositories cannot be prepared that way: a private registry, a Git or URL dependency, a workspace layout the installer does not read, a tree larger than the sandbox, or a package that needs its install script. Each of these ends in a named preparation stop ([Preparation failures](PREPARATION-FAILURES.md#named-stops)). A customer already installs those dependencies somewhere, in CI or in a build image. This page designs how Refit validates inside that environment instead.

Founders' decision (2026-10-27): dependency blockers must be resolved for customers too. Anything that handles customer secrets (registry tokens) or runs customer build steps needs its own owner decision first. So this page designs three options and only option 1, which needs neither, is built ([below](#option-1-a-prebuilt-image-the-customer-publishes)). The public benchmark has no customer environments, so this is not expected to move it.

## What exists today

- **Preparation** (`pipeline/dependency-preparation.ts`) reads only committed manifests and lockfiles, verifies every tarball against `registry.npmjs.org` integrity and installs with scripts off, in a container that has network access only for that install.
- **Checks** run in `dockerSandboxArguments` (`pipeline/docker-sandbox.ts`): `--network none`, a read-only root filesystem, user 65534, all capabilities dropped, a pids limit and the memory and tmpfs workspace of the validation profile, and `--pull never`. The repository is copied into `/workspace` and the prepared archive unpacked there.
- **The image** is whatever `.refit.json` names in `image` (`pipeline/workflow-configuration.ts`). `selectValidationRuntime` (`pipeline/validation-runtime.ts`) never replaces a configured image. Locally the image must already exist; the hosted worker pulls the images in `REFIT_HOSTED_IMAGES` when it boots (`scripts/hosted-entrypoint.sh`, [isolation](HOSTED-ISOLATION.md)).
- **The manual path**: every named stop told the owner to set `image` to an image with dependencies installed and to prefix `command` and `baselineCommand` with `ln -s /opt/app/node_modules node_modules && ` (`CUSTOM_IMAGE` in `pipeline/preparation-stops.ts`). Refit had no idea that image held the dependencies, so a patch that upgrades stripe-node was checked against the image's old SDK, and `refit doctor` could say only that "a custom validation image must supply the dependencies".

## What stays the same in every option

- Checks always run offline, in the same sandbox, with every gate: baseline then patched, `compareTypeErrors`, evidence grades, the AI gates, `[Needs review]` publication and the rule that a patch whose checks failed never publishes. No option gives the check container network or a secret.
- Refit never runs a repository's build or install script itself. In the options below it is the customer, in their own CI or registry, who builds.
- An image is used only by an immutable ID (`resolveDockerImage`), which the baseline check cache, evidence and drafts record. A tag that moves gives a new ID, so cached results never cross images.
- Approval stays explicit: `.refit.json` is committed by the owner, and its bytes are what is fingerprinted and approved ([App onboarding](APP-ONBOARDING.md)).

## Option 1: a prebuilt image the customer publishes

**What the customer provides.** An OCI image, built in their own CI from the commit's lockfile, with the dependencies installed in a directory such as `/opt/app/node_modules`, readable by user 65534, and with Node.js, `/bin/sh` and `cp`. In `.refit.json`:

```json
{
  "image": "ghcr.io/acme/billing-refit@sha256:…",
  "imageNodeModules": "/opt/app/node_modules",
  "command": ["npx", "--no-install", "tsc", "--noEmit"]
}
```

`prepareDependencies` must be absent. A digest-pinned reference is recommended, so the approved configuration names exact bytes.

**Where it runs.** Locally, the operator pulls the image first (Refit never pulls). In hosted mode the operator adds the reference to `REFIT_HOSTED_IMAGES`, which the worker and job machines already pull at boot; checks then run with `--pull never`. A public image needs no credential. A private one would need a pull credential, which is option 3's secret question and is not built.

**What Refit does with it** (built, `pipeline/customer-image.ts`):

- Every check that has no Refit-prepared archive runs as `/bin/sh -c '<link script>' /opt/app/node_modules <command…>`: it links the directory as `node_modules` in the copy (the repository root, or the nested Stripe package), then `exec`s the approved command. Owners write ordinary commands.
- A `node_modules` already in the copy (committed) stops the check with exit 125, a check error, rather than linking into it or replacing it.
- **Gate:** the image holds the original lockfile's dependencies, so a patch that changes `package.json` or a lockfile (the stripe-node upgrade) is never checked against them. With owner decision 1's default it is published untested as a grade-D `[Needs review]` draft, with dependency failure `customer-image-package-change`, which says to rebuild the image from the draft branch or run CI on the draft. With `--publish-validated-only` the run stops. A patch that changes only code is checked as usual.
- `refit doctor`, `refit enroll` and the hosted worker read the setting through the one configuration parser, so all of them accept it. Doctor reports the dependencies check as `review`, with what it links and what baseline validation must confirm (the directory exists, user 65534 can read it, it matches the lockfile). Doctor still starts no container.
- Every named preparation stop now points to `imageNodeModules` instead of a hand-written symlink.

**What it does not do.** It runs nothing the customer wrote at preparation time, because there is no preparation. It does not verify that the image matches the committed lockfile: that is the customer's build, and a mismatch shows up as the baseline failing or as checks that pass on the wrong tree. Option 2 is the answer to that. It cannot check SDK upgrades, which the gate above makes visible instead of hiding. Workspaces with a `node_modules` in each package link only the one directory the checks run in.

**Next step without secrets or customer builds.** The gate matters in practice: on Stripe's endive target, almost every TypeScript patch upgrades stripe-node, so in a customer image it ends untested (the demo below does). Refit already prepares a verified stripe-only closure from the public registry for behaviour tests (`stripeOnlyDependencies` in `pipeline/validation.ts`). Overlaying the patched closure on the image's tree would let the upgrade be checked with no customer step and no credential. One way is a writable copy of the image directory with the stripe packages replaced, or `NODE_PATH` ordering. It needs a design for packages that the image and the closure both hold, and its own benchmark, so it is left for a follow-up.

**Needs from the founders.** Nothing new to run it locally or with public images. To list a customer image in the hosted worker's `REFIT_HOSTED_IMAGES`, the operator changes the live service (`fly secrets`/`fly.toml`), which is an owner action. Hosting stays single-owner ([hosted onboarding](HOSTED-ONBOARDING.md)): a customer image is code the customer controls running on the shared worker's Docker daemon. The sandbox limits it as it limits a repository's tests, but a multi-tenant worker needs per-job machines first.

## Option 2: Refit builds from the customer's Dockerfile or CI install steps

**What the customer provides.** A Dockerfile (for example `.refit/validation.Dockerfile`), or the install steps from their CI (`actions/setup-node` plus `npm ci`), committed and approved like `.refit.json`.

**Where it runs.** In a build sandbox separate from validation: a fresh VM or Fly job machine per build, with network, no Refit or App secrets in its environment, a time and size cap, and no access to the Docker daemon that runs checks. BuildKit rootless, or a per-job Fly machine as `--job-machines` already provides (`pipeline/fly-machines.ts`, `pipeline/hosted-runner.ts`). The result is saved by digest, then validation runs exactly as in option 1.

**What it adds.** Refit builds the original and the patched trees separately, so a stripe-node upgrade can finally be checked in the customer's environment and option 1's gate can be lifted for these images. The image is tied to the commit.

**Why it is not built.** It runs customer build steps: the Dockerfile's `RUN` lines and the CI install's lifecycle scripts execute arbitrary customer code with network. The founders' decision reserves that. It also widens what Refit controls: "Refit never runs repository build or install scripts" is stated across [Dependencies](DEPENDENCIES.md) and [Preparation failures](PREPARATION-FAILURES.md#needs-owner-decision), and the Prisma and `next-env.d.ts` generators were turned down on the same ground (2026-10-22).

**Needs from the founders.** A decision that Refit may execute customer build steps, where it may run them (per-job machines only, never on the control machine), the per-build limits (time, CPU, disk, egress), and whether a build may reach the network beyond registries.

## Option 3: registry credentials

**What the customer provides.** A read-only token for their private registry (npm, GitHub Packages, Artifactory), or for pulling a private validation image (option 1).

**How it would be stored and never logged.**

- Stored per installation, encrypted at rest, outside the repository. In hosted mode as a Fly secret or a Supabase Vault entry readable only by the `refit_hosted` role, never in the `refit_*` job tables that receipts and evidence read. Locally in an `0600` file under `~/.refit/`, like the App key.
- Scoped: one registry host and a read-only scope, checked when it is saved. A token is never accepted in `.refit.json`, `flags`, a CLI argument or an environment variable a job inherits. `parseSingleWorkflowConfiguration` already rejects unknown fields so a token cannot slip in.
- Given only to preparation, never to checks. It would be mounted as a temporary `.npmrc` file in the preparation container (`--network bridge`) for one install, then deleted. Checks keep `--network none` and never see the file. For image pulls it would be a temporary `DOCKER_CONFIG` for one `docker pull`, then removed.
- Never logged. Install and pull output already pass through Refit's capture (`install.log`). It would be redacted for the token value and for `_authToken`/`Authorization` patterns before anything is written. A test would assert that the token appears in no evidence file, report or draft, as `pipeline/workflow-configuration.test.ts` does for configuration fields.
- Cache keys hash the registry host and the token's ID, never the token. Bundles prepared with a credential are kept per installation and never reused across installations.

**Needs from the founders.** A decision to hold customer secrets at all, where they live (Fly secrets vs Vault), who may add or rotate them, how long they are kept, and how a customer revokes one. Lifting the public-registry and integrity checks for a private host also needs a decision, because the bytes are no longer verifiable against `registry.npmjs.org`.

## Recommendation

Ship option 1 now. It turns every named preparation stop into a configuration a customer can apply, and it changes nothing that runs without the new key. Decide option 3's pull-credential half next: with it, option 1 works for private images, which is how most customers publish CI images. Option 2 is the complete answer (checks SDK upgrades, ties the image to the commit) and waits for the build-steps decision and per-job machines.

## Demo

Run locally on 2026-10-27 against Refit `d329944` (this change), Docker 29.8.2 on arm64, no AI and no publication. The fork is `refit-dev/artisan-roast` at `15be9a627bfe0a96f8a6606e6016b961f2035f09` (Next.js, stripe 20.3.1, Node `>=24`, 1,377 locked packages). Its lockfile resolves `artisan-roast-sdk` from `git+ssh://git@github.com/yuens1002/artisan-roast-sdk.git`.

1. **Refit's own preparation refuses it.** `refit prepare --image node:24-alpine` stops with `non-registry-dependency`. `refit doctor` blocks on the same dependency, and its action now names `imageNodeModules`.
2. **The image is built from the committed lockfile only.** [`.refit/validation.Dockerfile`](https://github.com/refit-dev/artisan-roast/blob/refit/customer-image-demo/.refit/validation.Dockerfile) on the fork's `refit/customer-image-demo` branch starts from `node:24-alpine`, adds `git`, copies `package.json` and `package-lock.json` into `/opt/app` and runs `npm ci --ignore-scripts`. No credential is used: the Git dependency is a public repository. The local build is `sha256:0fefb40fbab6…` (2.2 GB). The branch's workflow builds and publishes the same Dockerfile to `ghcr.io/refit-dev/artisan-roast-validation` with the job's own `GITHUB_TOKEN`.
3. **The configuration.** `.refit.json` is `refit doctor`'s generated configuration with `prepareDependencies` removed, `image` set to the validation image and `imageNodeModules: "/opt/app/node_modules"`. Doctor's dependencies check goes from `blocked` to `review`. Doctor still blocks on migration coverage: 13 breaking changes no rule migrates, unrelated to dependencies.
4. **Validation.** `refit run --config .refit.json` ran the baseline in the image, offline, with the directory linked. 8 Jest suites with 69 tests passed. The type check ran with 362 existing type errors (the Prisma client is never generated, because install scripts stay off), which `compareTypeErrors` keeps as the baseline. The baseline took 19.5 s.
5. **The gate.** The rules' patch moves the API version to `2026-09-30.endive` and upgrades stripe-node, so it changes `package.json` and `package-lock.json`. Validation is `untested`, grade D, dependency failure `customer-image-package-change`. The patched checks were not run against the image's stripe 20.3.1, and the draft would be `[Needs review]`.

The first run used the generated check as it was. Its `npm test` is `jest --watch`, which never exits, so the baseline timed out at 600 s after the tests had passed (`tsc` alone takes 21 s in the image). That is check selection's existing watch-mode gap, the one already recorded for starmanv4's `jest --watchAll`. The demo then set the check to the repository's own `test:ci` script, as an owner would.
