# Refit

Refit turns external API changes into repository-specific, validated draft pull requests. Engineers review and merge the result. The initial target is Stripe integrations in TypeScript/JavaScript repositories on GitHub.

## Product truth

The full specification is in `docs/PRD.md`. The implementation includes the frontend preview and standalone local Stripe CLIs. They download pinned upstream specifications, scan local source for impact evidence, propose a narrow migration patch, and run explicit baseline/patched checks in restricted Docker containers. Optional AI assessment is implemented with controlled-response tests; a live model run remains unverified. The workspace still uses illustrative data; it is not connected to the CLI. There is no GitHub App, live monitoring, AI patch agent or PR publishing yet. Examples must be labeled and must never impersonate actual work. See `docs/ARCHITECTURE.md` for current capabilities and the target system.

## Audience and task

Engineering teams maintaining third-party integrations. Visitors need to understand the migration workflow, inspect the evidence and review boundary, and explore the planned application.

## Brand commitments

Screenpipe and Nango are UI/UX references only. Light technical surfaces, strong typography, thin rules, a restrained blue accent, product-specific code artifacts, and purposeful text/object motion. No fabricated customers, metrics, or passing checks.

## Stack

React and TypeScript with Vite; React Router for navigable frontend routes; native CSS for visual design and animation; Phosphor icons; self-hosted Geist and Geist Mono. The local pipeline runs with tsx and the TypeScript compiler API. Vitest exercises the pipeline and Testing Library exercises the UI. There is no server or database yet.
