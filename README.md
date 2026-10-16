<p align="center">
  <img src="public/refit-agent-avatar.png" alt="Refit logo" width="96" height="96" />
</p>
<h1 align="center">Refit</h1>
<p align="center"><strong>Turn upstream API changes into reviewed code updates.</strong></p>
<p align="center">
  <a href="https://github.com/pierceluu10/Refit/releases"><img src="https://img.shields.io/badge/releases-early_access-2563eb" alt="Early access releases" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb" alt="MIT license" /></a>
</p>
<p align="center">
  <a href="docs/CLI.md">Documentation</a> ·
  <a href="docs/GITHUB-APP.md">GitHub App</a> ·
  <a href="https://github.com/pierceluu10/Refit/releases">Releases</a>
</p>

API changes should arrive with a fix. Refit watches configured API contracts, finds affected code, proposes a migration, runs your checks in isolation and can open a draft PR as **Refit Agent**. You review and merge.

## How it works

1. **Watch** OpenAPI specifications and selected changelogs.
2. **Find** affected API usage in your TypeScript or JavaScript repository.
3. **Fix** supported changes with a migration rule or an optional AI proposal.
4. **Check** the patch in offline Docker before opening a draft PR.

## Try it locally

Requires Node.js 22.12+ or a supported newer release.

```sh
git clone https://github.com/pierceluu10/Refit.git
cd Refit
npm ci
npm run refit -- replay --propose-patch --human
```

This scans a bundled Stripe example and shows a proposed patch. No credentials, Docker or AI required. Your files stay unchanged.

For the complete migration demo, start Docker, pull `node:22-alpine`, then run:

```sh
npm run refit -- demo --image node:22-alpine --output /tmp/refit-demo-001
```

The demo uses the real Stripe SDK against a **simulated API**, demonstrates the original failure and validates the fix. Choose a new output directory each time. Dependency preparation needs npm access or cache.

## Use it on your repository

Start with [repository setup](docs/REPOSITORY-SETUP.md), then [approve your configuration](docs/APP-ONBOARDING.md). Run locally or use the [GitHub App service](docs/LOCAL-SERVICE.md). One repository can monitor [multiple APIs](docs/MULTIPLE-INTEGRATIONS.md), with a separate draft PR for each integration.

From a configured repository root:

```sh
refit doctor
refit run
```

The evidence path is printed after the run. Add `--integration <id>` for a multi-API configuration or `--output <new-directory>` to choose where evidence stays.

To see which API versions or models in a repository are about to be retired, run `refit deadlines`. See [API deadlines](docs/DEADLINES.md).

**Early access:** Stripe is the best-tested integration. Other providers need reviewed SDK mappings and migration rules. Installing the App also requires approved configuration and a running worker. AI and PR publication are explicit opt-ins; Refit never auto-merges. The website's workspace is an illustrative preview.

See [current capabilities and verification](docs/READINESS.md), [architecture](docs/ARCHITECTURE.md), [class-client support](docs/CLASS-CLIENTS.md), [helper-client support](docs/HELPER-CLIENTS.md) and [pnpm preparation](docs/PNPM-WORKSPACES.md) for the exact boundaries.
