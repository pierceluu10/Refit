# Requirements: Refit — OpenAI and Anthropic agents to 90%

**Defined:** 2026-10-21
**Core Value:** A retiring model ID in real application code is traced to the exact call and replaced with a validated, never-wrong draft fix, or stopped with a named reason.

## v1 Requirements

### Exposure (what counts as live)

- [ ] **EXPO-01**: Deadline scan classifies object-shaped model catalogs (model metadata objects, `versions: [...]` lists, model option arrays) as non-live, with a test per shape
- [ ] **EXPO-03**: A model ID quoted inside a longer string (descriptions, error messages, embedded docs) is not live, and a model-keyed map entry stays a catalog when its object is wrapped in `satisfies`/`as`
- [ ] **EXPO-02**: Reports and benchmark results show catalog matches separately from live exposures, so counts stay comparable to the 2026-10-20 runs

### Tracing (live pin → call argument)

- [ ] **TRAC-01**: `model: this.model` in a traced OpenAI or Anthropic call resolves to the class field initializer or constructor parameter default that sets it
- [ ] **TRAC-02**: A model constant exported from one module and used in a traced call in another resolves to its literal
- [ ] **TRAC-03**: An enum member or `as const` object member used as `model` resolves to its literal
- [ ] **TRAC-04**: A helper function's `model` parameter used in a traced call resolves to the literal its callers pass (each caller site reported)
- [ ] **TRAC-05**: Raw `fetch`/`axios` requests to `api.openai.com` and `api.anthropic.com` with a literal `model` in the body are reported at the exact line and eligible for the same replacement rule

- [ ] **TRAC-06**: A `const` whose initializer is an env fallback (`process.env.X ?? 'gpt-4'`), a function whose body returns a literal, and a destructuring default (`{ model = 'gpt-4' } = options`) resolve to the literal they hold
- [ ] **TRAC-07**: Non-text OpenAI and Anthropic model calls (images, audio, embeddings, moderation, legacy completions) are traced and stop with a named reason instead of staying silent

### Rule (replacement stops)

- [ ] **RULE-01**: A provider-parameter table (`source`, `checkedAt`) records, per replacement model, which sampling and length parameters it accepts, read from the official OpenAI and Anthropic model pages
- [ ] **RULE-02**: The replacement rule proceeds past `temperature`/`top_p`/`top_k`/`max_tokens` stops only when the table shows the replacement accepts that parameter with that value; every other case keeps stopping with a named reason
- [ ] **RULE-03**: The owner decision for RULE-02 is recorded in AGENTS.md and the relevant guide, and tests cover both an allowed and a still-stopped parameter for each provider

### Benchmark

- [ ] **BENCH-01**: A new frozen set of 100 OpenAI application repositories and 50 Anthropic application repositories is built from GitHub code search with a documented, reproducible selection script; npm sets are kept as library baselines
- [ ] **BENCH-02**: Every live model pin on the new sets is labelled in a single AI-assisted pass with file, line and correct replacement, and documented as AI-assisted
- [ ] **BENCH-03**: Benchmark runs from a pinned worktree report, per provider, labelled pins traced, affected repositories, validated fixes and stops with reasons, published as `docs/benchmarks/` results files
- [ ] **BENCH-04**: ≥ 90% of labelled live pins are traced to a call argument, per provider
- [ ] **BENCH-05**: ≥ 70% of affected repositories with runnable checks end in a validated fix in offline Docker, per provider
- [ ] **BENCH-06**: Every validated fix is reviewed; zero wrong fixes

### Docs

- [ ] **DOCS-01**: `docs/READINESS.md` gets a dated checkpoint; `docs/PROVIDER-GOALS.md` checklist and `docs/BENCHMARKS.md` reflect measured numbers, with any shortfall stated rather than rounded up

## v2 Requirements

- **V2-01**: Settings objects, UI state and CLI option defaults traced as model sources (currently review-only by design)
- **V2-02**: Anthropic `anthropic-version` header and SDK major-version migration
- **V2-03**: `refit agents --add anthropic` without a published contract (needs owner decision)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Paid model calls in the benchmark | Rule is deterministic; spend would not change the score |
| Live provider calls in validation | Validation stays offline (AGENTS.md) |
| Model replacement in catalogs, tests, comparisons | Fixed scope by owner decision #120 |
| Wiring the rule into `refit run` | Owner decision keeps it in `deadlines` / `serve --model-fixes` |
| Human hand labelling | Labels are a single AI-assisted pass, stated as such |
| Other providers | Separate milestones |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXPO-01 | Phase 1 | Pending |
| EXPO-02 | Phase 1 | Pending |
| TRAC-01 | Phase 1 | Pending |
| TRAC-02 | Phase 1 | Pending |
| TRAC-03 | Phase 1 | Pending |
| TRAC-04 | Phase 1 | Pending |
| TRAC-05 | Phase 1 | Pending |
| TRAC-06 | Phase 1 | Pending |
| TRAC-07 | Phase 1 | Pending |
| EXPO-03 | Phase 1 | Pending |
| RULE-01 | Phase 2 | Pending |
| RULE-02 | Phase 2 | Pending |
| RULE-03 | Phase 2 | Pending |
| BENCH-01 | Phase 3 | Pending |
| BENCH-02 | Phase 3 | Pending |
| BENCH-03 | Phase 4 | Pending |
| BENCH-04 | Phase 4 | Pending |
| BENCH-05 | Phase 4 | Pending |
| BENCH-06 | Phase 4 | Pending |
| DOCS-01 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0

---
*Requirements defined: 2026-10-21*
*Last updated: 2026-10-21 after Phase 1 scouting of the 2026-10-20 silent exposures*
