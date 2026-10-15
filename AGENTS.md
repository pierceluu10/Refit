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
