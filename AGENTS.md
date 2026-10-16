# Refit agent guide

## What Refit is building

Refit connects upstream API changes to the customer code that may need updating. The product goal is to monitor API contracts and selected documentation, find affected SDK usage, propose a migration, run the repository's checks in isolation, and open a human-reviewed draft pull request as Refit Agent.

Build toward a reliable agent for many API providers, with separate integrations and reviewable changes. Breaking changes are the first priority. Record other changes for review rather than generating speculative code updates. Prefer deterministic, explicitly configured migration rules; use AI only as a bounded assistant behind the existing evidence, budget, validation, and review gates.

## Product boundaries

- Read [READINESS.md](docs/READINESS.md) before describing support or choosing a feature. It records verified behavior and known gaps.
- Refit currently analyzes supported TypeScript and JavaScript SDK patterns. Provider support depends on observed SDK mappings and migration rules; OpenAPI compatibility alone does not mean a provider is ready for automatic fixes.
- Automatic edits must be limited to supported, evidence-backed migrations. Ambiguous code, API versions, request/response semantics, or webhook policies must stop for review.
- Validate changes in the existing isolated workflow. A passing command is evidence about that command, not proof of complete API or code coverage.
- App installation does not activate arbitrary repositories. Configuration and approval are explicit; workers, AI, and draft publication have separate settings. Refit never auto-merges.
- Keep credentials out of repository files and browser code. Never run a live vendor operation or paid model evaluation unless the task explicitly authorizes it and the configured budget allows it.

## Repository workflow

- Read the code and relevant tests before changing behavior. Follow existing architecture and keep changes focused.
- Preserve honest evidence boundaries in CLI output, reports, documentation, and pull requests. Do not claim a simulated test exercised a live provider.
- Run `npm test` after JavaScript or TypeScript changes, and run the relevant typecheck, formatting, and build checks for the touched code. Report what actually passed.
- Use conventional commit messages when committing requested project changes. Do not add co-author trailers.
- Update the relevant user-facing guide and readiness checkpoint when a feature changes supported behavior. Keep the root README short; put detailed setup and limitations in `docs/`.

## Onboarding references

- Start here for a local repository: [Repository setup](docs/REPOSITORY-SETUP.md).
- Review and approve a committed `.refit.json`: [App onboarding](docs/APP-ONBOARDING.md).
- Configure the GitHub App and local worker: [GitHub App](docs/GITHUB-APP.md) and [local service](docs/LOCAL-SERVICE.md).
- Configure several APIs in one repository: [Multiple integrations](docs/MULTIPLE-INTEGRATIONS.md).
- Check SDK dependency preparation: [Dependencies](docs/DEPENDENCIES.md), [npm workspaces](docs/NPM-WORKSPACES.md), and [pnpm workspaces](docs/PNPM-WORKSPACES.md).
- Detect provider SDKs and add agents: [Provider agents](docs/PROVIDER-AGENTS.md).
- See CLI commands and requirements: [CLI guide](docs/CLI.md).

The guides explain onboarding a repository into Refit. This file explains how coding agents should contribute to Refit itself.

## Release and verification notes

- Work on a feature branch, open a PR against `main`, wait for CI (Node 22 and 24), then merge with a `feat: merge …` merge commit. Release commits are `chore: release Refit X.Y.Z …` and bump `package.json` and `package-lock.json`, add a dated `docs/READINESS.md` checkpoint, and update the guides they touch.
- Publish milestones as GitHub pre-releases titled only `vX.Y.Z`, from an annotated tag on the merge commit. Attach `refit-X.Y.Z.tgz` from `npm run package:cli -- --output <new-directory>` and its `SHA256SUMS`. Smoke-install the archive before publishing.
- Many suites are gated by environment variables and skip by default. Docker and real-SDK cases need `REFIT_DOCKER_IMAGE=node:22-alpine` plus `REFIT_NPM_PREPARE=1`, `REFIT_STRIPE_SDK=1` or `REFIT_OPENAI_SDK=1`. Report gated results separately from the default count.
- Recorded lockfile fixtures must stay byte-exact; keep them in `.prettierignore` rather than reformatting them.
- Stripe's published OpenAPI documents are pinned by `stripe/openapi` tag in `docs/benchmarks/2026-10-14-stripe-repos.json`. A local Stripe lab for end-to-end checks lives at `/Users/pierceluu/Repos/refit-stripe-lab`; it uses simulated responses only.
- Open owner decision: `--full-diff` on real Stripe upgrades reports thousands of enum additions and reachable required-property removals, which block automation. The enum part was relaxed on explicit instruction in the self-maintaining pipeline PR: Stripe response enum additions block only where the code switches over the field. That change needs owner sign-off. Removals inside unexpanded Stripe objects stopped blocking with owner sign-off in 0.25.0. Direct removals the code never reads still block; do not relax the rest of the gate without an explicit decision.
- Yarn 1 root projects are prepared like npm and pnpm; the shared tool installer is `pipeline/manager-install.ts`. `REFIT_DEPENDENCY_TIMEOUT_SECONDS` (60–1800) extends the install deadline. Preparation runs with a 2 GiB workspace and 3 GiB memory (owner decision, 0.28.0); validation defaults to a 2 GiB workspace, 3 GiB memory and 1 GiB archive (owner decision, 0.33.0), always offline; `REFIT_VALIDATION_WORKSPACE=1g|512m` selects smaller profiles.
- The agent catalog lives in `pipeline/agent-catalog.ts`. Add a provider there with `adapter: null` until a reviewed adapter and rules exist; only entries with an adapter are suggested or addable.
- The API deadline registry lives in `data/deadlines.json`. Every entry needs its provider page as `source` and the day it was checked as `checkedAt`; run `npm run deadlines:check` after editing. `refit serve --deadline-alerts` is off by default and needs the App's Issues write permission; each installation's owner accepts it. `refit deadlines --fail-within` exits 2 for CI. Its exceptions in `.refit-deadlines-ignore.json` must keep requiring a reason and an expiry within a year, and must reject the whole file on any error. Do not loosen these checks without an explicit decision. See `docs/DEADLINES.md`.
- AI patches default to `gpt-5.6-luna` (OpenAI has no `gpt-5.6-mini`); the price table in `pipeline/ai-budget.ts` accepts dated snapshots. Run benchmarks from a pinned `git worktree`, never the working tree: each `refit run` subprocess loads current source files. `node scripts/stripe-benchmark-setup.mjs --held-out` rebuilds the frozen 50-repository set; `scripts/stripe-benchmark-compare.mjs` compares runs.
- A traced SDK call that still sends a request parameter the target contract removed stops for review (`pipeline/request-removals.ts`). Owner decision (2026-10-16): Stripe endive's removed `payment_method_types` keeps stopping for review; do not add an automatic replacement without a new decision.
- Shopify is a built-in provider: `pipeline/shopify-*.ts`. Its contracts are GraphQL introspection snapshots (`refit shopify-snapshot`), not OpenAPI; `runPipeline` hands them to `runShopifyPipeline`, whose report fills every report field (OpenAPI-only ones empty). The only automatic edit is moving pins when every document validates on the target; an enum pin also needs the locked SDK to define the member (`SHOPIFY_API_ENUM_SINCE`). The frozen benchmark is `docs/benchmarks/2026-10-16-shopify-repos.json`; the lab is `~/Repos/refit-shopify-lab` (simulated responses only; its tests replace the SDK fetch with `setAbstractFetchFunc`).
