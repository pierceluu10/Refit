# Refit — OpenAI and Anthropic agents to 90%

## What This Is

Refit connects upstream API changes to customer code that may need updating: it monitors API contracts and deadlines, finds affected SDK usage, proposes a migration, validates it offline in Docker, and opens a human-reviewed draft pull request. This milestone brings its two AI-provider agents, OpenAI and Anthropic, from 70% to at least 90% on the ten-item progress checklist in `docs/PROVIDER-GOALS.md`, so both are close to production ready for retiring-model fixes.

## Core Value

A retiring model ID in real application code is traced to the exact call and replaced with a validated, never-wrong draft fix, or stopped with a named reason.

## Requirements

### Validated

- ✓ Catalog entries for `openai` and `@anthropic-ai/sdk` — existing (`pipeline/agent-catalog.ts`)
- ✓ Reviewed adapters: OpenAI `chat.completions`, `responses`, `embeddings`; Anthropic `messages` — existing (`examples/*.provider.json`)
- ✓ Deadline registry entries with `source` and `checkedAt` — existing (`data/deadlines.json`)
- ✓ Deterministic model-replacement rule with named stops — existing (`refit deadlines --propose-model-fixes`)
- ✓ Validated draft PRs via `refit serve --model-fixes` — existing
- ✓ Frozen npm-sourced sets: OpenAI 100, Anthropic 50 — existing (`docs/benchmarks/2026-10-20-*-results.json`)
- ✓ No wrong fix on hand review: OpenAI 1/1, Anthropic 6/6 — existing

### Active

- [ ] Object-shaped model catalogs (metadata lists, `versions: [...]`) are classified non-live, so exposure counts only requests
- [ ] `model: this.model` is traced to the class field default (and constructor default) that feeds it
- [ ] Wider tracing: cross-module constants, enum members, helper parameters with their callers, raw `fetch` to `api.openai.com` / `api.anthropic.com`
- [ ] Sampling and length parameter stops are lifted only where the provider's model page proves the replacement accepts the parameter (recorded with `source` and `checkedAt`)
- [ ] New frozen application sets from GitHub code search: 100 OpenAI, 50 Anthropic; npm sets kept as library baselines
- [ ] Live pins on the new sets labelled (single AI-assisted pass, documented as such)
- [ ] ≥ 90% of labelled live pins traced to a call argument, per provider
- [ ] ≥ 70% of affected repositories with runnable checks end in a validated fix, per provider
- [ ] Zero wrong fixes on review of every validated fix
- [ ] READINESS checkpoint, PROVIDER-GOALS checklist and BENCHMARKS updated with measured numbers

### Out of Scope

- Paid model calls in the benchmark — the model-replacement rule is deterministic; spend would not change the score
- Live provider calls in validation — validation stays offline (AGENTS.md)
- Wiring the rule into `refit run` — owner decision keeps it in `deadlines` and `serve --model-fixes`
- Replacing models in catalogs, tests or comparisons — the rule's scope is fixed by owner decision #120
- Hand labelling by a person — labels are a single AI-assisted pass, stated as such
- Other providers (Gemini, Meta, PayPal…) — separate milestones

## Context

- Stack: TypeScript/Node 22–24, `npm test`, typecheck, prettier; pipeline in `pipeline/`, React app in `src/`.
- Prior numbers (2026-10-20): OpenAI 47 exposed, 45 untraced, 0 validated (only candidate over the 50 MiB archive); Anthropic 17 exposed, 14 untraced, 1 validated. Untraced exposures are mostly model catalogs and class-field defaults.
- npm-sourced sets are libraries, so the 70% fix-rate target cannot be measured on them; application sets are needed.
- GitHub code search is available through the `gh` login (checked 2026-10-21).
- Benchmarks run from a pinned `git worktree`, never the working tree (AGENTS.md).

## Constraints

- **Evidence**: no relaxing a stop without an owner decision; every relaxation cites a provider page with `checkedAt` — AGENTS.md
- **Honesty**: report gated and default test counts separately; never claim a simulated check exercised a live provider
- **Verification**: `npm test`, typecheck and formatting after every TypeScript change
- **Fixtures**: recorded lockfile fixtures stay byte-exact
- **Git**: conventional commits, no AI attribution, no pushes or PRs unless asked

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Labels are a single AI-assisted pass | User choice 2026-10-21; matches the Meta label precedent | — Pending |
| Parameter stops lift only with a provider page proving the replacement accepts the parameter | Owner delegated the call 2026-10-21; keeps the never-wrong bar while unblocking most stops | — Pending |
| New application sets from GitHub code search; npm sets kept as library baselines | Fix-rate target needs applications; keeping old sets preserves comparable history | — Pending |
| Deterministic only, no paid AI calls in the benchmark | The rule makes no AI calls; spend would not change the score | — Pending |
| Skipped codebase mapping | AGENTS.md, READINESS.md and PROVIDER-GOALS.md already document the architecture | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-21 after initialization*
