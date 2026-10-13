# Refit

Refit turns external API changes into repository-specific, validated draft pull requests. Engineers review and merge the result. The initial target is Stripe integrations in TypeScript/JavaScript repositories on GitHub.

## Product truth

The full specification is in `docs/PRD.md`. Refit 0.3 includes a frontend preview and an independently installed local agent. The local worker can fetch and refresh an App-managed repository and captures Stripe or public HTTPS/file OpenAPI sources, compares JSON/YAML contracts with oasdiff, scans configured SDK usage, retains job receipts, and performs bounded migrations with offline Docker checks. Provider ingestion, analysis, AI spending, validation and publication share one core; adapters still require verified mappings and application-specific checks.

Live OpenAI generation, GitHub draft publication and Refit Agent bot identity have been verified on the independent billing demo. A second real-SDK evaluation uses OpenAI against an explicitly simulated field removal, without inventing replacement semantics. The worker avoids repeated generation, tests the baseline before AI, and enforces a durable spending allowance. Human CLI summaries and PR prose retain detailed JSON evidence for inspection.

The workspace still uses illustrative data and is not connected to the CLI. Installing the GitHub App does not yet enroll a repository into a hosted service. Monitoring requires a configured local worker; installation-driven enrollment, tenant orchestration, arbitrary provider/codebase migration, and live Stripe-account behavior remain unverified or unimplemented. Examples must be labeled and must never impersonate actual work. See `docs/ARCHITECTURE.md` and `docs/AUTOMATION.md` for current capabilities, evaluated behavior and the hosted target.

## Audience and task

Engineering teams maintaining third-party integrations. Visitors need to understand the migration workflow, inspect the evidence and review boundary, and explore the planned application.

## Brand commitments

Screenpipe and Nango are UI/UX references only. Light technical surfaces, strong typography, thin rules, a restrained blue accent, product-specific code artifacts, and purposeful text/object motion. No fabricated customers, metrics, or passing checks.

## Stack

React and TypeScript with Vite; React Router for navigable frontend routes; native CSS for visual design and animation; Phosphor icons; self-hosted Geist and Geist Mono. The local pipeline runs with tsx and the TypeScript compiler API. Vitest exercises the pipeline and Testing Library exercises the UI. There is no server or database yet.
