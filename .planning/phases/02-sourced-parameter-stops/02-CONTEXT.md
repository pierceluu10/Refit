# Phase 2: Sourced parameter stops - Context

**Gathered:** 2026-10-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Today `pipeline/model-retirements.ts` stops every OpenAI request that sets `temperature`, `top_p`, `max_tokens`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs` or `top_logprobs` (`SENSITIVE_PARAMETERS` plus `rejectsSampling`, which always returns true for OpenAI). For Anthropic, it stops on `temperature`/`top_p`/`top_k` when the replacement is Claude 4.7 or later. On the 2026-10-20 sets this was the main reason fixes stopped. This phase adds a sourced provider-parameter table, so the rule continues past such a stop only when an official provider page proves that the replacement model accepts that parameter with that value. Everything else keeps stopping with a named reason. No other stop is relaxed.

</domain>

<decisions>
## Implementation Decisions

### Table format and evidence
- **D-01:** A new data file, `data/model-parameters.json` (format version 1), holds entries `{ provider, model, parameters: { <name>: { accepts: "any" | "default-only" | "none", default?: number, min?: number, max?: number, renamedTo?: string } }, source, checkedAt }`. `source` must be an HTTPS URL on an official provider documentation host: `developers.openai.com`, `platform.openai.com`, `platform.claude.com` or `docs.anthropic.com`. `checkedAt` must be an ISO date no later than today.
- **D-02:** Entries come only from official provider pages that someone actually read in this phase, through the browser or WebFetch, never from memory or search summaries. This mirrors the AGENTS.md rule for `data/meta-graph-changes.json`. A model or parameter that the pages do not state stays absent, and absence means "stop". Each entry cites the exact page it came from.
- **D-03:** A strict validator rejects the whole file on any error: a missing `source` or `checkedAt`, a non-official host, an unknown provider, a malformed range, or a duplicate model. It runs through a new `npm run model-parameters:check` script (a `refit deadlines --check-parameters` flag or a small dedicated command, following the existing `deadlines:check` pattern), is wired into `npm test` coverage, and is documented.
- **D-04:** The table covers only replacement models that the deadline registry names in `replacement`, whether directly or via a chain, e.g. `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-sol`, `gpt-6-luna`, `claude-sonnet-5-5`, `claude-opus-4-8` and `claude-haiku-4-5-20251001`. Non-text replacements (images, audio) are out of scope, because those calls always stop (Phase 1 D-11/D-16).

### Rule
- **D-05:** For each sensitive parameter that a traced request sets, the rule continues only when the table entry for the final replacement model says the parameter is accepted with that value:
  - `accepts: "any"` requires a resolved numeric value inside `min`..`max` when those are given.
  - `"default-only"` requires the resolved value to equal `default` exactly.
  - `"none"`, a missing entry, or a missing parameter always stops.
  - A value that is not a numeric literal, or a literal that a constant or the Phase 1 resolver cannot resolve, always stops.
- **D-06:** A renamed parameter (for example `max_tokens` → `max_completion_tokens`, if a page states it) is never rewritten automatically in this phase. The rule stops with a reason that names the new parameter. Rewriting parameters is a separate decision.
- **D-07:** Stop reasons name the parameter, the value, the replacement, and why: not proven, value out of range, non-default, not accepted, or renamed. They keep the existing ending: "…; change it by hand to <to>." The existing sentence stays for the cases it already covers when no table entry exists.
- **D-08:** Spread options, `n`/`logit_bias`-style parameters with no table entry, and requests to non-text calls keep stopping exactly as today.

### Decision record
- **D-09:** Owner decision. It was delegated by the user on 2026-10-21 and is recorded as "made by Otabek Alimov, pending the repository owner's review on the phase PR". It goes in AGENTS.md next to the #120 and Phase 1 bullets, ends with "Do not widen without a new decision", and appears in docs/DEADLINES.md and the PROJECT.md Key Decisions. No AI attribution anywhere.

### Tests
- **D-10:** Each provider has at least one test where the parameter is allowed and the request is edited, and one where it still stops: an out-of-range value, a non-default value, an unproven parameter, a non-literal value, and a renamed parameter. Validator tests cover each rejection reason. The tests use a small fixture table, so they never depend on the live data file's contents.

### Resolutions after research (2026-10-21)
- **D-11:** GPT-6 replacements get no table entry, because acceptance depends on `reasoning_effort: none`, which the table cannot express. Those requests keep stopping.
- **D-12:** One `source` per entry. Where a fact needs two pages, split it into separate entries or use the stricter page. Sources are never merged.
- **D-13:** `proposeModelReplacements` takes the table as an optional argument that defaults to an empty table, so library callers and existing tests are unchanged. `refit deadlines --propose-model-fixes` and `refit serve --model-fixes` load the shipped `data/model-parameters.json`.
- **D-14 (superseded in part by D-16 and D-19, which govern):** The decision text (AGENTS.md, DEADLINES.md) states plainly that on the official pages read on 2026-10-21, only Anthropic literal `temperature: 1` and `top_p >= 0.99` (Claude 4.7-and-later replacements) and the Haiku 4.5 parameters continue. OpenAI requests that set sampling or length parameters keep stopping, because no OpenAI page states support. `o3` `max_tokens` gets a renamed-parameter stop reason.
- **D-15:** Numeric values: only a signed numeric literal written directly in the request counts. Constants, shorthand properties, string numerals and expressions stop with "not a numeric literal".

- **D-16 (plan check, 2026-10-21):** No `top_p` entry for any Anthropic model. Official pages conflict (the Messages reference says `>= 0.99` is accepted; the Sonnet 5.5 overview and the deprecations page say a non-default value returns 400), and the stricter page governs.
- **D-17:** A cited page must name the model. Only `claude-sonnet-5-5` gets an entry: `temperature` is `default-only` with default 1, sourced from the Sonnet 5.5 overview. The entry has an extra `defaultSource` field for the official page that states the default value, which the validator requires when a `default` is given. `claude-opus-4-8` has no entry and keeps stopping.
- **D-18:** No Haiku 4.5 entry. Legacy behaviour for pre-4.7 replacements is preserved byte-for-byte.
- **D-19:** Renamed parameters apply to OpenAI only (`o3` `max_tokens`). Each parameter is verified separately. On shipped data, only a literal `temperature: 1` on a `claude-sonnet-5-5` replacement continues; everything else keeps stopping.

### Claude's Discretion
- How the table is loaded and cached, and whether `refit serve --model-fixes` and `refit deadlines --propose-model-fixes` share one loader. Both must use the table.
- Exact JSON field names, if research shows a cleaner shape. The semantics in D-01..D-08 still apply.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `pipeline/model-retirements.ts`: `SENSITIVE_PARAMETERS`, `rejectsSampling`, `CLAUDE_VERSIONED`, the decision loop where `sensitive` is computed (around line 1863), `finalReplacement`, and the Phase 1 resolver `valuesOf`/`modelSites` for resolving numeric literals.
- `pipeline/deadline-registry.ts` (`loadDeadlineRegistry`, validation with `source`/`checkedAt`), `refit deadlines --check-registry` and `npm run deadlines:check`: the validator pattern to copy.
- The `data/meta-graph-changes.json` validator (`npm run meta-graph:check`) is a second strict-validator analog.

### Integration Points
- `pipeline/deadlines-cli.ts` (`--propose-model-fixes`) and `pipeline/model-fixes.ts` (`serve --model-fixes`), which both call `proposeModelReplacements`.
- Docs: `docs/DEADLINES.md`, AGENTS.md, `docs/READINESS.md` (a dated checkpoint with no numbers).

</code_context>

<specifics>
## Specific Ideas

- The current comment in model-retirements.ts cites the Anthropic deprecations page (2026-10-20): Claude 4.7+ returns 400 for non-default `temperature`/`top_p`/`top_k`. Re-read that page, and the model or parameter pages it links, to fill the Anthropic entries with their stated defaults.
- For OpenAI, read the models pages for each replacement model and the reasoning-model parameter guidance: which sampling and length parameters each accepts, and whether `max_tokens` is replaced by `max_completion_tokens`.

</specifics>

<deferred>
## Deferred Ideas

- Automatically renaming `max_tokens` → `max_completion_tokens`. This needs its own decision and is tracked for after Phase 4 measurement.
- Parameter tables for non-text replacement models.

</deferred>
