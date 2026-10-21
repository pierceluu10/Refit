<!-- GSD:project-start source:PROJECT.md -->

## Project

**Refit — OpenAI and Anthropic agents to 90%**

Refit connects upstream API changes to customer code that may need updating: it monitors API contracts and deadlines, finds affected SDK usage, proposes a migration, validates it offline in Docker, and opens a human-reviewed draft pull request. This milestone brings its two AI-provider agents, OpenAI and Anthropic, from 70% to at least 90% on the ten-item progress checklist in `docs/PROVIDER-GOALS.md`, so both are close to production ready for retiring-model fixes.

**Core Value:** A retiring model ID in real application code is traced to the exact call and replaced with a validated, never-wrong draft fix, or stopped with a named reason.

### Constraints

- **Evidence**: no relaxing a stop without an owner decision; every relaxation cites a provider page with `checkedAt` — AGENTS.md
- **Honesty**: report gated and default test counts separately; never claim a simulated check exercised a live provider
- **Verification**: `npm test`, typecheck and formatting after every TypeScript change
- **Fixtures**: recorded lockfile fixtures stay byte-exact
- **Git**: conventional commits, no AI attribution, no pushes or PRs unless asked

<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->

## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-fast` for a trivial task inline, with no subagents and no PLAN.md
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
