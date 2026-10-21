# Roadmap: Refit — OpenAI and Anthropic agents to 90%

## Overview

The OpenAI and Anthropic agents score 70% on the ten-item checklist in `docs/PROVIDER-GOALS.md`. This milestone closes the gap in four steps. First, the deadline scan stops counting model catalogs as live, and the tracer follows the common indirect model sources: class fields, cross-module constants, enums, helper parameters and raw HTTP requests. Second, a sourced provider-parameter table lets the replacement rule continue past sampling and length stops only where a provider page proves the replacement model accepts the parameter. Third, new frozen sets of application repositories from GitHub code search get their live pins labelled in one AI-assisted pass. Last, a pinned-worktree benchmark measures tracing, validated fixes and wrong fixes on those sets, and the readiness docs record the measured numbers, including any shortfall.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Live exposure and tracing** - Catalogs stop counting as live; indirect model sources trace to the call argument (completed 2026-10-21)
- [ ] **Phase 2: Sourced parameter stops** - Provider-page table lets the rule continue past sampling and length stops it can prove are safe
- [ ] **Phase 3: Application benchmark sets** - Frozen OpenAI (100) and Anthropic (50) application sets from GitHub code search, with labelled live pins
- [ ] **Phase 4: Measurement and readiness** - Pinned-worktree benchmark on the new sets, reviewed fixes, and docs updated with the measured numbers

## Phase Details

### Phase 1: Live exposure and tracing
**Goal**: A retiring model ID that reaches an OpenAI or Anthropic request, directly or through common indirection, is traced to the exact call argument, and catalog entries no longer count as live exposure
**Depends on**: Nothing (first phase)
**Requirements**: EXPO-01, EXPO-02, EXPO-03, TRAC-01, TRAC-02, TRAC-03, TRAC-04, TRAC-05, TRAC-06, TRAC-07
**Success Criteria** (what must be TRUE):
  1. Running the deadline scan on fixtures of model metadata objects, `versions: [...]` lists and model option arrays reports them as catalog matches, not live exposures, and each shape has a passing test
  2. Deadline reports and benchmark results files show catalog matches in a separate count, so totals can still be compared with the 2026-10-20 results
  3. Fixtures that use `model: this.model` (field initializer and constructor default), a constant imported from another module, an enum or `as const` member, and a helper parameter all resolve to the literal model ID. A helper parameter reports each caller site.
  4. A raw `fetch` or `axios` request to `api.openai.com` or `api.anthropic.com` with a literal `model` in the body is reported at its exact line and gets the same proposal and stops as an SDK call
  5. A model ID quoted inside a plain prose string (not a template with substitutions or a concatenation), and a model-keyed map entry wrapped in `satisfies`, are reported as non-live; an env-fallback constant, a function returning a literal and a destructuring default resolve to the literal; image, audio, embedding, moderation and legacy-completion calls stop with a named reason
  6. `npm test`, typecheck and formatting pass. Gated suite results are reported separately from the default count.
**Plans**: 5/5 plans complete

Plans:
**Wave 1**
- [x] 01-01-PLAN.md — Scan: satisfies-wrapped maps, descriptor keys and plain-string prose are non-live; exact non-live counts by use in CLI and a tested benchmark summary (wave 1)
- [x] 01-02-PLAN.md — Non-text SDK and raw calls stop with a named reason; raw fetch/axios shapes, including axios request-config forms, traced and tested (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-03-PLAN.md — Memoized resolver core: fields, members, fallbacks, returns, destructuring, imports (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 01-04-PLAN.md — D-09 every-use check (own commit), helper/method/default-export callers, D-17 fixes, never-silent limit stop (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 01-05-PLAN.md — AGENTS.md D-14 decision, docs/DEADLINES.md, READINESS checkpoint, PROJECT.md, full verification (wave 4)

### Phase 2: Sourced parameter stops
**Goal**: The replacement rule continues past a `temperature`/`top_p`/`top_k`/`max_tokens` stop only when an official provider page proves the replacement model accepts that parameter and value. Every other case keeps stopping with a named reason.
**Depends on**: Nothing (independent of Phase 1)
**Requirements**: RULE-01, RULE-02, RULE-03
**Success Criteria** (what must be TRUE):
  1. A provider-parameter table lists each replacement model's accepted sampling and length parameters. Every entry has a `source` URL on the official OpenAI or Anthropic model pages and a `checkedAt` date, and a check script rejects entries that lack either.
  2. `refit deadlines --propose-model-fixes` proposes a fix for a call whose parameter and value the table allows, and still stops with a named reason when the parameter or value is not proven
  3. Tests cover one allowed and one still-stopped parameter for each provider
  4. AGENTS.md and the relevant guide record the owner decision for this narrower stop, with its scope and date
**Plans**: TBD

### Phase 3: Application benchmark sets
**Goal**: Frozen sets of real application repositories, plus a labelled list of their live model pins, exist so tracing and fix rates can be measured on code that actually makes requests
**Depends on**: Nothing (can run alongside Phases 1 and 2; labels must not be derived from the new tracer's output)
**Requirements**: BENCH-01, BENCH-02
**Success Criteria** (what must be TRUE):
  1. A selection script built on GitHub code search reproduces a frozen list of 100 OpenAI and 50 Anthropic application repositories under `docs/benchmarks/`, with the query, date and pinned commits recorded
  2. The 2026-10-20 npm sets stay unchanged and are labelled as library baselines
  3. A labels file records every live model pin in the new sets with file, line and correct replacement, and states that it comes from a single AI-assisted pass, not hand labelling
**Plans**: TBD

### Phase 4: Measurement and readiness
**Goal**: Both agents' tracing, fix rate and correctness are measured on the application sets, and the readiness docs report the measured numbers, with any shortfall stated
**Depends on**: Phase 1, Phase 2, Phase 3
**Requirements**: BENCH-03, BENCH-04, BENCH-05, BENCH-06, DOCS-01
**Success Criteria** (what must be TRUE):
  1. A benchmark run from a pinned `git worktree` writes results files under `docs/benchmarks/` with, per provider, labelled pins traced, affected repositories, validated fixes, and stops with their reasons
  2. The results show at least 90% of labelled live pins traced to a call argument for OpenAI and for Anthropic, or the shortfall is reported with the untraced cases listed
  3. The results show at least 70% of affected repositories with runnable checks ending in a validated fix in offline Docker, per provider, or the shortfall is reported with the reasons
  4. Every validated fix has been reviewed, and the review records zero wrong fixes
  5. `docs/READINESS.md` has a dated checkpoint, and the `docs/PROVIDER-GOALS.md` checklist and `docs/BENCHMARKS.md` show the measured numbers without rounding up
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4. Phases 1, 2 and 3 do not depend on each other.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Live exposure and tracing | 5/5 | Complete    | 2026-10-21 |
| 2. Sourced parameter stops | 0/TBD | Not started | - |
| 3. Application benchmark sets | 0/TBD | Not started | - |
| 4. Measurement and readiness | 0/TBD | Not started | - |
