# Refit

Refit turns external API changes into repository-specific, validated draft pull requests. Engineers review and merge the result. The initial target is Stripe integrations in TypeScript/JavaScript repositories on GitHub.

## Product truth

The full specification is in `docs/PRD.md`. This implementation is a frontend: a landing page, interactive illustrative workflow, documentation, and a sample workspace. There is no connected GitHub App, live repository analysis, sandbox execution, or PR publishing yet. Examples must be labeled and must never impersonate actual work.

## Audience and task

Engineering teams maintaining third-party integrations. Visitors need to understand the migration workflow, inspect the evidence and review boundary, and explore the planned application.

## Brand commitments

Screenpipe and Nango are UI/UX references only. Light technical surfaces, strong typography, thin rules, a restrained blue accent, product-specific code artifacts, and purposeful text/object motion. No fabricated customers, metrics, or passing checks.

## Stack

React and TypeScript with Vite; React Router for navigable frontend routes; native CSS for visual design and animation; Phosphor icons; self-hosted Geist and Geist Mono. Vitest and Testing Library exercise behavior. No backend or database is introduced in this frontend scope.
