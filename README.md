# Refit

The agent that keeps your API integrations up to date.

Refit is being built to turn external API changes into repository-specific, validated draft pull requests. Engineers retain the final review and merge decision.

## Current release

A working frontend with:

- A responsive landing page with text entrances and an animated migration diagram.
- An interactive walkthrough with affected, unaffected, and failed-validation scenarios.
- Product documentation and a downloadable full specification.
- A sample workspace with repository search, URL-backed filters, impact evidence, and migration-run details.
- A configuration builder that copies or downloads a valid example `refit.yml`.
- Keyboard-accessible mobile navigation and reduced-motion support.

**The workspace is a frontend preview.** Its data remains illustrative. A separate local Stripe pipeline now analyzes repositories and supplied OpenAPI snapshots; it is not connected to the UI. There is no live GitHub installation, provider monitoring, AI integration, sandbox execution, patch generation or PR publication. The configuration builder produces a file locally; it does not apply settings to a remote repository.

## Stripe pipeline

```sh
npm run stripe:replay
npm run stripe:scan -- --repository /path/to/repo --before /path/to/before.json --after /path/to/after.json
```

The replay uses curated fixtures for Stripe's historical `PaymentIntent.charges` removal. The scan accepts real local repositories and OpenAPI 3 JSON snapshots, detects direct schema-property removals, traces supported Stripe calls, and produces JSON evidence with source locations and input hashes. It requires no API key and does not execute or change the scanned repository. Use `--output /path/to/new-report.json` to save a report without overwriting existing files.

This is a bounded impact analyzer, not a complete OpenAPI differ or migration agent. Unresolved code requires review; absence of a match never proves safety. See [the architecture and capability inventory](docs/ARCHITECTURE.md) for exact coverage, the full AI architecture and delivery order.

## Develop

Use Node.js 22.12+ or a newer supported Node.js release.

```sh
npm ci
npm run dev
```

Vite prints the local address, normally `http://127.0.0.1:5173`. No environment variables or API keys are required for the frontend.

```sh
npm test          # Behavior tests with verbose output
npm run typecheck
npm run build    # Typecheck and generate dist/
npm run preview  # Inspect the production build locally
npm run format
npm run format:check
```

## Routes

| Route | Surface |
| --- | --- |
| `/` | Landing page |
| `/demo` | Interactive workflow; accepts `?scenario=affected`, `unaffected`, or `failed` |
| `/docs` | Product documentation |
| `/app` | Sample workspace overview |
| `/app/repositories` | Searchable and filterable sample repositories |
| `/app/repositories/:id` | Repository-specific impact evidence |
| `/app/changes` | Sample provider change |
| `/app/changes/:id` | Change detail and repository impact |
| `/app/runs` | Successful and failed sample runs |
| `/app/runs/:id` | Timeline, diff, validation, and review; selected view is stored in `?tab=` |
| `/app/settings` | Repository configuration builder |

Deploy `dist/` to a static host with SPA fallback to `index.html` for application routes. Do not rewrite asset requests. The development and preview servers provide this routing behavior locally.

## Project structure

```text
src/
  components/       Shared branding, navigation, walkthrough, and controls
  pages/            Landing, demo, docs, workspace, activity, and settings
  configuration.ts  Validated configuration generation
  data.ts           Explicitly illustrative frontend data
  test/             Browser API mocks and test setup
pipeline/           Local Stripe scanner, CLI, fixtures and integration tests
docs/ARCHITECTURE.md Current implementation and full target architecture
docs/PRD.md         Full product and UI/UX requirements
PRODUCT.md          Product truth and scope
DESIGN.md           Implemented design tokens and visual guidance
```

The frontend uses React, TypeScript, Vite, React Router, native CSS animation, Phosphor icons, and locally bundled Geist fonts. Screenpipe and Nango informed the UI/UX only; their code and assets were not copied.

See the [product requirements document](docs/PRD.md) for the planned migration pipeline and [verification notes](docs/VERIFICATION.md) for the checks performed on this frontend.
