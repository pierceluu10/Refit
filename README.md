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

**This is a frontend preview.** All workspace and migration data is explicitly illustrative. There is no live GitHub installation, provider monitoring, repository analysis, sandbox execution, or PR publication. The configuration builder produces a file locally; it does not apply settings to a remote repository.

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
docs/PRD.md         Full product and UI/UX requirements
PRODUCT.md          Product truth and scope
DESIGN.md           Implemented design tokens and visual guidance
```

The frontend uses React, TypeScript, Vite, React Router, native CSS animation, Phosphor icons, and locally bundled Geist fonts. Screenpipe and Nango informed the UI/UX only; their code and assets were not copied.

See the [product requirements document](docs/PRD.md) for the planned migration pipeline and [verification notes](docs/VERIFICATION.md) for the checks performed on this frontend.
