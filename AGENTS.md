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
- See CLI commands and requirements: [CLI guide](docs/CLI.md).

The guides explain onboarding a repository into Refit. This file explains how coding agents should contribute to Refit itself.

## Release and verification notes

- Work on a feature branch, open a PR against `main`, wait for CI (Node 22 and 24), then merge with a `feat: merge …` merge commit. Release commits are `chore: release Refit X.Y.Z …` and bump `package.json` and `package-lock.json`, add a dated `docs/READINESS.md` checkpoint, and update the guides they touch.
- Publish milestones as GitHub pre-releases titled only `vX.Y.Z`, from an annotated tag on the merge commit. Attach `refit-X.Y.Z.tgz` from `npm run package:cli -- --output <new-directory>` and its `SHA256SUMS`. Smoke-install the archive before publishing.
- Many suites are gated by environment variables and skip by default. Docker and real-SDK cases need `REFIT_DOCKER_IMAGE=node:22-alpine` plus `REFIT_NPM_PREPARE=1`, `REFIT_STRIPE_SDK=1` or `REFIT_OPENAI_SDK=1`. Report gated results separately from the default count.
- Recorded lockfile fixtures must stay byte-exact; keep them in `.prettierignore` rather than reformatting them.
- Stripe's published OpenAPI documents are pinned by `stripe/openapi` tag in `docs/benchmarks/2026-10-14-stripe-repos.json`. A local Stripe lab for end-to-end checks lives at `/Users/pierceluu/Repos/refit-stripe-lab`; it uses simulated responses only.
- Open owner decision: `--full-diff` on real Stripe upgrades reports thousands of enum additions and reachable required-property removals, which block automation. Do not relax that gate without an explicit decision.
