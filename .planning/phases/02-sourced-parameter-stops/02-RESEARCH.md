# Phase 2: Sourced parameter stops - Research

**Researched:** 2026-10-21
**Domain:** Data-driven relaxation of the model-retirement rule's request-parameter stops (TypeScript, `pipeline/model-retirements.ts`) plus a sourced provider-parameter table
**Confidence:** HIGH for codebase and Anthropic facts; HIGH that OpenAI pages state almost nothing per model (so the OpenAI table is nearly empty)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** A new data file, `data/model-parameters.json` (format version 1), holds entries `{ provider, model, parameters: { <name>: { accepts: "any" | "default-only" | "none", default?: number, min?: number, max?: number, renamedTo?: string } }, source, checkedAt }`. `source` must be an HTTPS URL on an official provider documentation host: `developers.openai.com`, `platform.openai.com`, `platform.claude.com` or `docs.anthropic.com`. `checkedAt` must be an ISO date no later than today.
- **D-02:** Entries come only from official provider pages that someone actually read in this phase, through the browser or WebFetch, never from memory or search summaries. This mirrors the AGENTS.md rule for `data/meta-graph-changes.json`. A model or parameter that the pages do not state stays absent, and absence means "stop". Each entry cites the exact page it came from.
- **D-03:** A strict validator rejects the whole file on any error: a missing `source` or `checkedAt`, a non-official host, an unknown provider, a malformed range, or a duplicate model. It runs through a new `npm run model-parameters:check` script (a `refit deadlines --check-parameters` flag or a small dedicated command, following the existing `deadlines:check` pattern), is wired into `npm test` coverage, and is documented.
- **D-04:** The table covers only replacement models that the deadline registry names in `replacement`, whether directly or via a chain, e.g. `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-sol`, `gpt-6-luna`, `claude-sonnet-5-5`, `claude-opus-4-8` and `claude-haiku-4-5-20251001`. Non-text replacements (images, audio) are out of scope, because those calls always stop (Phase 1 D-11/D-16).
- **D-05:** For each sensitive parameter that a traced request sets, the rule continues only when the table entry for the final replacement model says the parameter is accepted with that value:
  - `accepts: "any"` requires a resolved numeric value inside `min`..`max` when those are given.
  - `"default-only"` requires the resolved value to equal `default` exactly.
  - `"none"`, a missing entry, or a missing parameter always stops.
  - A value that is not a numeric literal, or a literal that a constant or the Phase 1 resolver cannot resolve, always stops.
- **D-06:** A renamed parameter (for example `max_tokens` -> `max_completion_tokens`, if a page states it) is never rewritten automatically in this phase. The rule stops with a reason that names the new parameter. Rewriting parameters is a separate decision.
- **D-07:** Stop reasons name the parameter, the value, the replacement, and why: not proven, value out of range, non-default, not accepted, or renamed. They keep the existing ending: "...; change it by hand to <to>." The existing sentence stays for the cases it already covers when no table entry exists.
- **D-08:** Spread options, `n`/`logit_bias`-style parameters with no table entry, and requests to non-text calls keep stopping exactly as today.
- **D-09:** Owner decision. Delegated by the user on 2026-10-21; recorded as "made by Otabek Alimov, pending the repository owner's review on the phase PR". Goes in AGENTS.md next to the #120 and Phase 1 bullets, ends with "Do not widen without a new decision", and appears in docs/DEADLINES.md and the PROJECT.md Key Decisions. No AI attribution anywhere.
- **D-10:** Each provider has at least one test where the parameter is allowed and the request is edited, and one where it still stops: an out-of-range value, a non-default value, an unproven parameter, a non-literal value, and a renamed parameter. Validator tests cover each rejection reason. The tests use a small fixture table, so they never depend on the live data file's contents.

### Claude's Discretion
- How the table is loaded and cached, and whether `refit serve --model-fixes` and `refit deadlines --propose-model-fixes` share one loader. Both must use the table.
- Exact JSON field names, if research shows a cleaner shape. The semantics in D-01..D-08 still apply.

### Deferred Ideas (OUT OF SCOPE)
- Automatically renaming `max_tokens` -> `max_completion_tokens`. This needs its own decision and is tracked for after Phase 4 measurement.
- Parameter tables for non-text replacement models.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RULE-01 | Provider-parameter table (`source`, `checkedAt`) per replacement model, from official pages | Section "Provider facts" gives every entry with page URL and quote; proposed file below; validator pattern copied from `checkDeadlineRegistry` |
| RULE-02 | Rule proceeds past temperature/top_p/top_k/max_tokens stops only when the table proves acceptance with that value | Section "Codebase" pins the exact edit point (model-retirements.ts:1860-1865 and 1885) and the numeric-literal resolver design |
| RULE-03 | Owner decision recorded in AGENTS.md + guide; tests cover an allowed and a still-stopped parameter per provider | Test inventory below lists which expectations change and how a fixture table keeps OpenAI "allowed" testable although the live file has no OpenAI acceptance |
</phase_requirements>

## Summary

The code change is small and local. Today the decision loop (`pipeline/model-retirements.ts:1860-1865`) builds `sensitive` as the request property names in `SENSITIVE_PARAMETERS[provider]` that pass `rejectsSampling(provider, resolved.to)`; a non-empty `sensitive` yields the stop at line 1884-1885. Phase 2 replaces that filter with a per-parameter verdict from a loaded table, and keeps the legacy sentence when no table entry exists for the final replacement. The numeric value of a property is NOT resolvable with `valuesOf`/`modelSites` (they return `ts.StringLiteralLike` terminals only, `Site.literal: ts.StringLiteralLike` at line 894, and `valuesOf` returns at line 1061 only for string literals). Add a tiny fail-closed helper that unwraps the property initializer (`unwrap`, line 142) and accepts only a `NumericLiteral`, or `-`/`+` applied to one; everything else (identifier, shorthand, const, expression) stops as "not a numeric literal".

The provider facts are the important finding. Official pages read today prove acceptance in exactly one family: Anthropic. The Messages API reference states that models released after Claude Opus 4.6 accept `temperature` only at 1.0, `top_p` only at >= 0.99, and reject every `top_k`. OpenAI's pages for every text replacement model (`gpt-5.6-sol/terra/luna`, `gpt-6-sol/luna`, `gpt-5`, `gpt-4.1`, `gpt-5.1-chat-latest`, `o3`) state NOTHING about temperature, top_p, penalties, logit_bias or logprobs per model, and the API reference says "Parameter support can differ depending on the model". So under D-02 the shipped OpenAI table has no acceptance entries and OpenAI requests keep stopping. The only provable OpenAI fact is that `max_tokens` is "not compatible with o-series models" (o3), which yields a "renamed" stop reason. The mechanism must still be built and tested with a fixture table (D-10). The owner should know that on real data this phase relaxes almost nothing for OpenAI.

**Primary recommendation:** Add `pipeline/model-parameters.ts` (types, `checkModelParameters`, `loadModelParameters`, `parameterVerdict`), ship the `data/model-parameters.json` below (3 Anthropic entries + 1 OpenAI `o3` entry), pass the table into `proposeModelReplacements` as an optional 4th argument, wire it in the three callers, and test with fixture tables.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Parameter table data + validation | Data file + pipeline module | CLI (`deadlines --check-parameters`) | Same shape as `data/deadlines.json` + `deadline-registry.ts` |
| Per-parameter verdict | Pure function in the new module | model-retirements.ts decision loop | Unit-testable without a repository |
| Numeric literal extraction | model-retirements.ts (TS AST) | - | Needs `unwrap` and `ts` helpers private to that file |
| Wiring into `--propose-model-fixes` / `serve --model-fixes` | deadlines-cli.ts, local-service.ts, ai-model-validation-cli.ts | model-fixes.ts | Callers load the table once; all reach `proposeModelReplacements` |

## Standard Stack

No new dependencies. TypeScript, `node:fs/promises`, `vitest ^4.1.11` (package.json), existing `parseObject`/`isObject` from `pipeline/specifications.ts`, `PipelineInputError` from `pipeline/types.ts`. Package Legitimacy Audit: not applicable, no packages installed. [VERIFIED: package.json scripts and devDependencies read this session]

## Architecture Patterns

### Data flow

```
data/model-parameters.json --loadModelParameters (validate whole file, throw PipelineInputError)--> ModelParameterTable
deadlines.json --finalReplacement(entry)--> resolved.to (model-retirements.ts:154)
request object literal --for each SENSITIVE name--> numericLiteral(propertyValue) --> parameterVerdict(table, provider, resolved.to, name, value)
   verdict.ok for all  -> no sensitive reason (edit continues, other stops still apply)
   any verdict not ok  -> stop reason with parameter, value, replacement, why, "; change it by hand to <to>."
no table entry for resolved.to -> legacy sentence (rejectsSampling logic unchanged)
```

### Recommended structure
```
pipeline/model-parameters.ts        # types, checkModelParameters, loadModelParameters, parameterVerdict
pipeline/model-parameters.test.ts   # validator rejection reasons, verdict table, shipped-file check
data/model-parameters.json
```
CLI: add `--check-parameters [--parameters <path>] [--json]` to `pipeline/deadlines-cli.ts` (copy the `--check-registry` branch at lines 107-126 and the USAGE/parseArgs entries at lines 33-58), and `"model-parameters:check": "node bin/refit.mjs deadlines --check-parameters"` next to `"deadlines:check"` (package.json:29). [VERIFIED: pipeline/deadlines-cli.ts:37,43,50,107; package.json:29-30]

### Validator pattern to copy (pipeline/deadline-registry.ts)
- `checkDeadlineRegistry(value: unknown, now: Date)` returns `{errors, ...}`; `loadDeadlineRegistry` parses with `parseObject`, throws `PipelineInputError('... is invalid: ' + errors.slice(0,5).join(' '))` if any error. Unknown keys rejected via an `ENTRY_KEYS` list; `validDate` (real calendar date) and `ISO_DATE`. [VERIFIED: pipeline/deadline-registry.ts:1-126, whole file read]
- Differences needed: `source` is REQUIRED (the registry only flags missing), host allow-list (`new URL(source).hostname` in `developers.openai.com`, `platform.openai.com`, `platform.claude.com`, `docs.anthropic.com`; require `protocol === 'https:'`; reject credentials/port), `checkedAt` not after `now` (the registry does not check this), duplicate `provider:model` key, provider in `openai|anthropic` only, parameter names restricted to the nine in scope, `accepts` enum, `default` required exactly when `accepts === 'default-only'` and must be finite, `min <= max` finite, `min/max` only with `accepts: 'any'`, `renamedTo` only with `accepts: 'none'` and a non-empty identifier different from the parameter name. Whole file rejected on any error (D-03).
- The meta-graph validator (`checkMetaGraphChanges`, pipeline/meta-graph-changes.ts:106; CLI branch pipeline/meta-graph-cli.ts:115-146) is the second analog; it prints `error` lines and sets `process.exitCode`. [VERIFIED: files read]

### Edit point (pipeline/model-retirements.ts)
Quoted verbatim, lines 1859-1865:
```ts
      const resolved = finalReplacement(entry, models) ?? { to: '', via: [entry.id] };
      const sensitive = found.object.properties
        .map((item) => (item.name ? propertyName(item.name) : undefined))
        .filter((name): name is string =>
          Boolean(name && SENSITIVE_PARAMETERS[request.provider].has(name)),
        )
        .filter(() => rejectsSampling(request.provider, resolved.to));
```
and 1884-1885: `: sensitive.length ? \`The request sets ${sensitive.join(', ')}, which ${resolved.to} may reject or treat differently.\``. [VERIFIED: model-retirements.ts:1859-1865,1884-1886]

Suggested shape: keep the names list; replace the last `.filter` by a map to reasons: if the table has an entry for `(provider, resolved.to)`, produce one clause per parameter that does not pass `parameterVerdict` (parameters that pass are dropped); if no entry exists, keep `rejectsSampling` + the legacy sentence exactly. Property values: `item` is `ts.ObjectLiteralElementLike`; only a `PropertyAssignment` has a literal initializer (use `propertyValue(item)` at line 796 for `PropertyAssignment | ShorthandPropertyAssignment`); methods, getters and spreads: not provable. Spreads already stop earlier in the chain (line ~1881).

Important facts for the planner:
- `SENSITIVE_PARAMETERS.anthropic` is only `temperature, top_p, top_k`; `max_tokens` is NOT sensitive for Anthropic. `max_output_tokens`/`max_completion_tokens` are not in either set, so Responses API calls and renamed-chat calls already pass silently today. Do not widen. [VERIFIED: model-retirements.ts:87-100]
- `rejectsSampling` returns false for Anthropic replacements before 4.7 (e.g. `claude-haiku-4-5-20251001`), so those continue today; the `claude-haiku-4-5-20251001` table entry is documentation/consistency, with no behavior change. [VERIFIED: model-retirements.ts:106-112]
- `CLAUDE_VERSIONED` does not match `claude-sonnet-5-5`? It matches `^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?...$`: major 5, minor 5, so `rejectsSampling` is true. [VERIFIED: regex at model-retirements.ts:102]
- Raw `fetch`/axios bodies go through the same `found.object` path (tests at model-retirements.test.ts:376, 624), so the table applies there too.
- The table argument: add `parameters: ModelParameterTable = EMPTY_TABLE` as the 4th parameter of `proposeModelReplacements` (model-retirements.ts:1680). Default-empty keeps every existing test unchanged and is fail-closed (legacy behavior). Callers: `pipeline/deadlines-cli.ts:129` (loads `registry` at 128), `pipeline/model-fixes.ts:157` (`runModelFixes` options gets `parameters?`), and its callers `pipeline/local-service.ts` (imports `loadDeadlineRegistry` line 26, option `modelFixes?: { registry?: string | URL }` line 124) and `pipeline/ai-model-validation-cli.ts:30,59`. The risk of the default is a caller forgetting to load it; add one test that asserts the shipped table is consulted via each caller path, or make the default load the shipped file and pass `EMPTY` explicitly in legacy tests. Planner's choice (CONTEXT delegates this). [VERIFIED: grep results this session]

### Numeric literal helper (fail closed)
```ts
// Value of a request property the table can judge: a plain numeric literal, optionally signed.
function numericLiteral(expression: ts.Expression): number | undefined {
  const value = unwrap(expression);
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(value.operand)
  )
    return value.operator === ts.SyntaxKind.MinusToken ? -Number(value.operand.text) : Number(value.operand.text);
  return undefined;
}
```
`Number('0x10')`/`1e3`/`1_000` parse fine; `NaN` must be treated as unresolved. No constant following in this phase: D-05 says a value "a constant or the Phase 1 resolver cannot resolve always stops", and the Phase 1 resolver terminal is string-only. [ASSUMED: this is the intended reading of D-05; if the owner wants `const T = 0.2` followed, `valuesOf` needs a numeric terminal type, a larger change.]

### Verdict function (pure)
```ts
type Verdict = { ok: true } | { ok: false; why: 'unproven' | 'not-numeric' | 'out-of-range' | 'non-default' | 'not-accepted' | 'renamed'; detail?: string };
```
Rules from D-05/D-06: no entry/param -> unproven; value undefined -> not-numeric; `none` with `renamedTo` -> renamed (reason names the new parameter), `none` without -> not-accepted; `default-only` and value !== default -> non-default; `any` with min/max and outside -> out-of-range; else ok. Use `Object.hasOwn` on the parameters map (names come from user source code, e.g. `__proto__`/`constructor` must not hit prototype members). [ASSUMED: security hygiene]

Reason sentences (D-07), keep the ending: `The request sets temperature 0.2, which claude-opus-4-8 accepts only at 1 (non-default); change it by hand to claude-opus-4-8.` Planner finalizes wording; the legacy sentence ends with "may reject or treat differently." and has no "change it by hand" ending today, the D-07 "existing ending" refers to other stops. Keep legacy text byte-identical when no entry exists.

### Anti-patterns
- Do not read the live `data/model-parameters.json` in rule tests (D-10): pass a fixture table.
- Do not derive acceptance from `rejectsSampling` for models that have a table entry; the table is the single source once an entry exists.
- Do not add a rewrite of `max_tokens` (D-06, deferred).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON parse with the repo's error style | custom parser | `parseObject`, `isObject` (pipeline/specifications.ts) | Same errors as registry |
| Calendar-valid ISO dates | regex only | copy `validDate` (deadline-registry.ts:41-44) | Rejects 2026-02-31 |
| URL host check | string `startsWith` | `new URL()` hostname allow-list | `https://developers.openai.com.evil.test` passes a prefix check |
| Terminal-safe printing | raw console.log of file text | `terminalText` (workflow-presentation.ts) as in the CLI | File content reaches the terminal |

## Runtime State Inventory

Not a rename/refactor phase: omitted.

## Common Pitfalls

1. **Reading the table for a replacement chain's intermediate model.** Use `resolved.to` (the final replacement), not `entry.replacement`. `finalReplacement` already follows chains (model-retirements.ts:154-170). Example: `o4-mini` retires, so `o1-mini` resolves to `gpt-5.6-terra`, not `o4-mini`.
2. **Shorthand/identifier values.** `{ temperature }` or `temperature: T` are not literals: stop "not a numeric literal".
3. **String numerals.** `temperature: '0.2'` is a string literal, not numeric: stop.
4. **Anthropic top_p/temperature simultaneously.** Not verified on any page read; no rule added.
5. **Anthropic Python SDK.** The deprecations page says the Python SDK (v1.0 and later) removes `temperature`, `top_p`, `top_k`; irrelevant to the TS/JS analyzer.
6. **GPT-6 conditional acceptance cannot be encoded.** See Open Questions Q1.
7. **Existing tests that depend on legacy text.** With a default-empty table nothing changes; see test inventory.

## Code Examples

Fixture table for tests (never the live file):
```ts
const TABLE = {
  formatVersion: 1,
  models: [
    { provider: 'openai', model: 'gpt-5.6-sol', parameters: { temperature: { accepts: 'any', min: 0, max: 2 }, max_tokens: { accepts: 'none', renamedTo: 'max_completion_tokens' }, top_p: { accepts: 'default-only', default: 1 } }, source: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol', checkedAt: '2026-10-21' },
  ],
};
```
(Top-level key name is the planner's choice: the registry uses `deadlines`; suggest `models`.)

## Test inventory: today's parameter-stop expectations (pipeline/model-retirements.test.ts, model-fixes.test.ts)

With the default-empty table argument, none of these change. If instead the shipped table is loaded by default, only the Anthropic ones below change. [VERIFIED: grep + reads this session]

| Test location | Expectation today | Changes with shipped table? |
|---|---|---|
| model-retirements.test.ts:176,199 | `gpt-4` + `max_tokens: 100` -> "The request sets max_tokens, which gpt-5.6-sol may reject or treat differently." | No (no gpt-5.6-sol entry) |
| model-retirements.test.ts:177,219 | claude-3-opus + `temperature: 0.2` -> same sentence for `claude-opus-4-8` | YES: entry exists, 0.2 != default 1 -> new "non-default" sentence |
| model-retirements.test.ts:284,308 | `gpt-4` + temperature 0.7 -> sentence for gpt-5.6-sol | No |
| model-retirements.test.ts:372-376,414 | raw fetch temperature 0 -> gpt-5.6-sol sentence | No |
| model-retirements.test.ts:453-485 | Claude 3 Haiku temperature 0 continues (replacement pre-4.7); claude-3-opus `top_k: 5` stops for claude-opus-4-8 | `top_k` line 485 YES (entry `none` -> "not accepted"); haiku one stays continuing |
| model-retirements.test.ts:624,645 | raw fetch temperature 0.2 -> claude-opus-4-8 sentence | YES (non-default) |
| model-retirements.test.ts:969-973,999 | `responses.create({ temperature: 0.2 })` -> gpt-5.6-sol sentence | No |
| model-fixes.test.ts:94,127 | `temperature: 0` gpt-4 -> "The request sets temperature" in PR body | No |
| docs/DEADLINES.md:205 | documents the OpenAI/Anthropic sensitive list as unverified | Must be rewritten |

New tests needed (D-10, RULE-03): per provider one allowed-and-edited case (Anthropic with the shipped-like fixture `temperature: 1` on claude-opus-4-8, `top_p: 0.99`; OpenAI with a fixture entry), and still-stopped cases: out-of-range, non-default, unproven param (`presence_penalty` with no entry), non-literal (`temperature: T`, shorthand), renamed (`max_tokens` -> `max_completion_tokens`), plus: no entry -> legacy sentence unchanged; mixed (one allowed, one not) still stops naming only the failing parameter. Validator tests: each rejection reason (missing source, missing checkedAt, bad host incl. look-alike host, http scheme, unknown provider, bad range min>max, default missing for default-only, duplicate model, unknown field, future checkedAt, unknown parameter name). Plus a test loading the shipped `data/model-parameters.json` through the checker (pattern: deadline-sync.test.ts:125) so `npm test` covers it (D-03). `nyquist_validation` is false in .planning/config.json, so no separate Validation Architecture section. [VERIFIED: .planning/config.json:24]

## PROVIDER FACTS (all read 2026-10-21 from official pages; WebFetch or curl of the official URL's markdown)

Legend: accepted = accepts any (with range if stated); default-only(v); none; renamed. "not stated" means no entry (stop).

### Anthropic

Pages read:
- P-A1 https://platform.claude.com/docs/en/api/messages (Messages API reference, 1.2 MB, parameters read from the raw page)
- P-A2 https://platform.claude.com/docs/en/about-claude/model-deprecations
- P-A3 https://platform.claude.com/docs/en/models/sonnet-5-5/overview
- P-A4 https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
- P-A5 https://platform.claude.com/docs/en/models/opus-4-8/overview
- P-A6 https://platform.claude.com/docs/en/models/haiku-4-5/overview
- P-A7 https://platform.claude.com/docs/en/about-claude/models/overview (and /migration-guide index page, which only links the 5.x guides)

Verbatim quotes (P-A1):
- temperature: "Models released after Claude Opus 4.6 do not support setting temperature. A value of 1.0 will be accepted for backwards compatibility, all other values will be rejected with a 400 error." Also "Defaults to `1.0`. Ranges from `0.0` to `1.0`." and "minimum: 0, maximum: 1".
- top_k: "Models released after Claude Opus 4.6 do not accept top_k; any value will be rejected with a 400 error." Also "minimum: 0".
- top_p: "Models released after Claude Opus 4.6 do not support setting top_p. A value >= 0.99 will be accepted for backwards compatibility, all other values will be rejected with a 400 error." Also "minimum: 0, maximum: 1".
- max_tokens: "The maximum number of tokens to generate before stopping." "Different models have different maximum values for this parameter." "minimum: 0".
- presence_penalty, frequency_penalty, logit_bias, logprobs, top_logprobs: not present anywhere in the Messages API page (grep over the full raw page returned no match): not stated / do not exist. Not in the Anthropic SENSITIVE set anyway.

Cross-checks:
- P-A2: "Returns a 400 error when set to a non-default value on Claude 4.7 and later models and Claude Mythos Preview." Model status table lists `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-haiku-4-5-20251001` all "Active".
- P-A3 (Sonnet 5.5 "Good to know"): "Setting `temperature`, `top_p`, or `top_k` to a non-default value returns a 400 error." Release: "Released September 28, 2026."
- P-A4 (line "Sampling parameters return an error."): "Claude Sonnet 4.6 and earlier models and Claude Haiku 4.5 accept `temperature`, `top_p`, and `top_k`. On Claude Sonnet 5.5, a non-default value returns a 400 error."
- P-A5: Opus 4.8 page says "Released May 28, 2026." and states nothing about sampling parameters. Applicability to Opus 4.8 rests on P-A1's "released after Claude Opus 4.6" and P-A2's "Claude 4.7 and later models".
- P-A6: Haiku 4.5 page says nothing about sampling; "Max output: 64K tokens", "Released October 15, 2025.", retirement "Not sooner than October 15, 2026" (retires in 6 days; it is the final replacement for several Claude 3 models per registry).

Per model:

| Model | temperature | top_p | top_k | max_tokens (not consulted by the rule) | Sources |
|---|---|---|---|---|---|
| claude-opus-4-8 | default-only, default 1.0 | accepted only >= 0.99 (to 1) | none | accepted; model cap 128K output per P-A5 | P-A1 (+P-A2) |
| claude-sonnet-5-5 | default-only, default 1.0 | accepted only >= 0.99 (to 1) | none | accepted; 128K per P-A3 | P-A1 (+P-A3) |
| claude-haiku-4-5-20251001 | accepted (P-A4); range 0..1 per P-A1 generic | accepted; range 0..1 per P-A1 generic | accepted; min 0 per P-A1 generic | accepted; 64K cap per P-A6 | P-A4 |

Note the difference between the deprecation text ("non-default value") and the API reference: `top_k` rejects EVERY value and `top_p` accepts >= 0.99, not only a single default. The API reference is the more specific statement; encode `top_k: none`, `top_p: any min 0.99 max 1`, `temperature: default-only 1`. A request `top_p: 1` therefore continues; this is stated by the page ("A value >= 0.99 will be accepted"). [VERIFIED: raw page lines read]

### OpenAI

Pages read (all https://developers.openai.com/api/docs/...):
- P-O1 models/gpt-5.6-sol, models/gpt-5.6-terra, models/gpt-5.6-luna (WebFetch + raw markdown): only "Reasoning.effort supports: none, low, medium (default), high, xhigh, and max.", "128,000 max output tokens", "Reasoning token support", Chat Completions and Responses "Supported". NO statement on temperature, top_p, max_tokens, max_completion_tokens, penalties, logit_bias, logprobs, top_logprobs.
- P-O2 models/gpt-6-sol, models/gpt-6-luna: "`reasoning.effort` supports `none`, `low`, `medium` (default), `high`, `xhigh`, and `max`." and "Chat Completions supports function calling only with `reasoning_effort` set to `none`." Nothing on sampling.
- P-O3 guides/latest-model/gpt-6-astra (covers GPT-6 Astra, 6.1 Sol, 6 Sol, 6 Luna): "**Unsupported parameters:** When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`. For Chat Completions, also remove `logprobs`. For Responses, remove `message.output_text.logprobs` from `include`."
- P-O4 guides/latest-model/gpt-5.6 and guides/upgrading-to-gpt-5p6-sol: no mention of temperature/top_p/max_tokens/penalties/logit_bias/logprobs (grep over raw pages: none; WebFetch: "None"). Only: "If omitted, GPT-5.6 defaults to `medium`."
- P-O5 guides/reasoning: only `max_output_tokens` ("limit the total number of tokens the model generates, including reasoning tokens"); no unsupported-parameter list. (The Chat reference says "For the current state of unsupported parameters in reasoning models, refer to the reasoning guide": the guide, as fetched, does not contain it.)
- P-O6 guides/latest-model/gpt-5, gpt-5.1, gpt-4.1: grep for the nine parameters: no statement (one `temperature` hit is example prose about weather).
- P-O7 api/reference/resources/chat (Chat Completions reference; URL https://developers.openai.com/api/reference/resources/chat): generic, not per model. "Parameter support can differ depending on the model used to generate the response, particularly for newer reasoning models." temperature "between 0 and 2"; top_p (no range); max_tokens: "This value is now deprecated in favor of `max_completion_tokens`, and is not compatible with [o-series models]"; max_completion_tokens: "An upper bound for the number of tokens that can be generated for a completion, including visible output tokens and reasoning tokens."; presence_penalty and frequency_penalty "Number between -2.0 and 2.0"; logit_bias "bias value from -100 to 100"; logprobs boolean; top_logprobs "integer between 0 and 20"; `stop`: "Not supported with latest reasoning models `o3` and `o4-mini`."
- P-O8 api/reference/resources/responses/methods/create (Responses reference): temperature "between 0 and 2"; top_p; `max_output_tokens` ("An upper bound for the number of tokens that can be generated for a response, including visible output tokens and reasoning tokens."); `top_logprobs` "between 0 and 20". There is no `max_tokens`, `presence_penalty`, `frequency_penalty`, `logit_bias` or `logprobs` body parameter on the Responses reference (grep over the raw page found none; logprobs appear only through `include`).
- Model page for `gpt-5-codex-mini`: HTTP 404 on both `https://developers.openai.com/api/docs/models/gpt-5-codex-mini` and its `.md` form. Could not be read.
- Model pages `gpt-5`, `gpt-4.1` (32,768 max output tokens), `o3`, `o4-mini`, `gpt-5.1-chat-latest`: fetched as raw markdown; no sampling/length parameter statements (only max output tokens for gpt-4.1 and endpoint/feature lists).

Per final text replacement (from `data/deadlines.json` chains, computed with `finalReplacement` semantics: o4-mini is itself retiring on 2026-10-23, so `o1-mini` -> `gpt-5.6-terra`):

| Final replacement | temperature | top_p | max_tokens (Chat) / max_output_tokens (Responses) | presence_penalty | frequency_penalty | logit_bias | logprobs | top_logprobs | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| gpt-5.6-sol | not stated | not stated | not stated (model max 128,000 output tokens) | not stated | not stated | not stated | not stated | not stated | P-O1, P-O4 |
| gpt-5.6-terra | not stated | not stated | not stated (128,000) | not stated | not stated | not stated | not stated | not stated | P-O1 |
| gpt-5.6-luna | not stated | not stated | not stated (128,000) | not stated | not stated | not stated | not stated | not stated | P-O1 |
| gpt-6-sol | not stated per model; conditional: removed "when reasoning effort is not none" (default effort medium) | same | not stated | not stated | not stated | not stated | conditional: Chat remove logprobs when effort not none | conditional: remove when effort not none | P-O2, P-O3 |
| gpt-6-luna | same as gpt-6-sol | same | not stated | not stated | not stated | not stated | same | same | P-O2, P-O3 |
| gpt-5 | not stated | not stated | not stated | not stated | not stated | not stated | not stated | not stated | model page + P-O6 |
| gpt-4.1 | not stated | not stated | not stated (32,768 max output) | not stated | not stated | not stated | not stated | not stated | model page |
| gpt-5.1-chat-latest | not stated | not stated | not stated | not stated | not stated | not stated | not stated | not stated | model page |
| o3 | not stated | not stated | Chat: max_tokens renamed to max_completion_tokens, quote "not compatible with o-series models"; Responses: n/a (`max_output_tokens`) | not stated | not stated | not stated | not stated | not stated | P-O7 (generic o-series statement, o3 named only under `stop`) |
| gpt-5-codex-mini | page 404, not readable | | | | | | | | none |

Generic OpenAI API-reference ranges (P-O7/P-O8; NOT model-specific, so they do not prove acceptance and are not copied into the table): temperature 0..2, penalties -2..2, logit_bias -100..100, top_logprobs 0..20.

Out of scope, not read: gpt-image-*, gpt-realtime-*, gpt-audio-mini, gpt-transcribe, omni-moderation (D-04).

### Proposed `data/model-parameters.json` (only what a read page states; every entry sourced)

```json
{
  "formatVersion": 1,
  "models": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "parameters": {
        "temperature": { "accepts": "default-only", "default": 1 },
        "top_p": { "accepts": "any", "min": 0.99, "max": 1 },
        "top_k": { "accepts": "none" }
      },
      "source": "https://platform.claude.com/docs/en/api/messages",
      "checkedAt": "2026-10-21"
    },
    {
      "provider": "anthropic",
      "model": "claude-sonnet-5-5",
      "parameters": {
        "temperature": { "accepts": "default-only", "default": 1 },
        "top_p": { "accepts": "any", "min": 0.99, "max": 1 },
        "top_k": { "accepts": "none" }
      },
      "source": "https://platform.claude.com/docs/en/api/messages",
      "checkedAt": "2026-10-21"
    },
    {
      "provider": "anthropic",
      "model": "claude-haiku-4-5-20251001",
      "parameters": {
        "temperature": { "accepts": "any" },
        "top_p": { "accepts": "any" },
        "top_k": { "accepts": "any" }
      },
      "source": "https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide",
      "checkedAt": "2026-10-21"
    },
    {
      "provider": "openai",
      "model": "o3",
      "parameters": {
        "max_tokens": { "accepts": "none", "renamedTo": "max_completion_tokens" }
      },
      "source": "https://developers.openai.com/api/reference/resources/chat",
      "checkedAt": "2026-10-21"
    }
  ]
}
```

Per-entry provenance and caveats:
- Opus 4.8 / Sonnet 5.5: `temperature` default-only 1 ("A value of 1.0 will be accepted ... all other values will be rejected"), `top_p` >= 0.99 (max 1 from "maximum: 1"), `top_k` none ("any value will be rejected"). Source P-A1; "released after Claude Opus 4.6" is applied to these two models using release dates read on P-A5 (May 28, 2026) and P-A3 (September 28, 2026).
- Haiku 4.5: acceptance stated only in P-A4 ("Claude Haiku 4.5 accept `temperature`, `top_p`, and `top_k`"). Ranges (0..1, top_k >= 0) are on P-A1 but are generic, so they are omitted to keep one source per entry. Behavior is unchanged because `rejectsSampling` already lets pre-4.7 replacements through. Option for the planner: allow `source` to be an array and add the ranges.
- `o3`: only `max_tokens` is stated, generically for o-series. It produces a "renamed" stop naming `max_completion_tokens`; it never relaxes anything.
- No `max_tokens` entry for Anthropic (not sensitive; "not stated" per-model cap handling is out of scope; the caps 128K/128K/64K are on P-A5/P-A3/P-A6 if a later phase wants them).
- No OpenAI acceptance entries exist because no read page states one. This is the honest result, not a gap in effort.

### What could not be verified
1. Any OpenAI per-model statement for temperature, top_p, penalties, logit_bias, logprobs, top_logprobs on gpt-5.6-sol/terra/luna, gpt-5, gpt-4.1, gpt-5.1-chat-latest, o3 (model pages and guides silent).
2. gpt-5-codex-mini: page 404 (both URL forms).
3. Whether the `guides/reasoning` page in this environment lists unsupported parameters: fetched, it does not (the Chat reference points to it for that).
4. GPT-6 Sol/Luna: sampling parameters are unsupported only when effort is not `none`; the default effort is `medium`; effort is a separate request field, so acceptance depends on a second parameter the table cannot express (Q1).
5. Anthropic: whether a request may set both `temperature` and `top_p` (not stated on read pages); the Opus 4.8 overview page itself says nothing on sampling (applicability inferred from the API reference rule); no page was read for Claude Opus 4.7.
6. Responses vs Chat differences for Anthropic: not applicable (Messages API only).
7. Provider-served behavior was not tested live (no vendor call made; AGENTS.md forbids unauthorized live calls).

## State of the Art

| Old approach | Current | Impact |
|---|---|---|
| Anthropic: any temperature/top_p/top_k | Models released after Opus 4.6: temperature 1.0 only, top_p >= 0.99, no top_k | Legacy `rejectsSampling` (4.7+ = reject) matches; the table adds the exact values that still pass |
| OpenAI `max_tokens` in Chat Completions | Deprecated for `max_completion_tokens`, not compatible with o-series | Renamed stops; no rewrite (D-06) |
| OpenAI reasoning defaults | GPT-5.6 default effort `medium`; GPT-6 sampling params unsupported unless effort `none` | OpenAI sampling stops stay |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | D-05's "constant ... cannot resolve" means constants are NOT followed this phase (direct numeric literals only) | Numeric literal helper | If owner wants constants followed, a numeric-capable resolver is more work |
| A2 | `Object.hasOwn` guard against prototype keys is wanted hygiene | Verdict function | None |
| A3 | Applying "models released after Claude Opus 4.6" to claude-opus-4-8 and claude-sonnet-5-5 from their overview-page release dates and the deprecations page's "Claude 4.7 and later" wording | Provider facts | If wrong, `top_p`/`temperature` would continue where Anthropic rejects: low, values are the narrowest stated |
| A4 | Using the generic Chat reference's o-series note as proof for `o3` renamed | Proposed JSON | Only yields a stop with a better reason; no relaxation |

## Open Questions (RESOLVED)

1. **GPT-6 conditional acceptance.** gpt-6-sol/luna drop temperature/top_p/top_logprobs/logprobs when reasoning effort is not `none`, and the default effort is `medium`. D-01 cannot encode "only when `reasoning_effort: none` is set literally in the same request". **RESOLVED: D-11: no GPT-6 entry; requests keep stopping (02-CONTEXT.md).**
   - Recommendation: no entry (stop). Revisit only with a new decision that adds a conditional field.
2. **Single `source` per entry vs two pages (Haiku ranges).** **RESOLVED: D-12: one `source` per entry; when two pages are needed, split into two entries or use the stricter page; never merge sources (02-CONTEXT.md).**
   - Recommendation: keep one `source`; omit ranges (done above).
3. **Loader default (empty vs shipped).** **RESOLVED: D-13: library default is an empty table; CLI and serve load the shipped file (02-CONTEXT.md).**
   - Recommendation: optional 4th arg defaulting to empty; callers load the shipped table; add a wiring test for the three callers.
4. **Owner expectation.** On shipped data, OpenAI requests keep stopping and only Anthropic literal `temperature: 1` / `top_p >= 0.99` continue. The decision text in AGENTS.md/DEADLINES.md should state this plainly. **RESOLVED: D-14: the decision text states this plainly (02-CONTEXT.md).**

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| node | tests, CLI | yes | v24.14.0 | - |
| vitest | tests | yes | ^4.1.11 (package.json) | - |
| Official provider pages | data entry | yes, fetched | - | - |

## Security Domain

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V5 Input Validation | yes | Strict whole-file validator; URL host allow-list via `new URL`, https only; finite-number checks; reject unknown keys |
| V6 Cryptography / V2 / V3 / V4 | no | - |

Threat patterns: look-alike host in `source` (Spoofing) -> exact hostname allow-list; prototype-key parameter names in analyzed user code such as `__proto__` (Tampering) -> `Object.hasOwn`; terminal escape in printed errors -> `terminalText`; a data-file edit silently widening automation -> validator + `checkedAt` not in the future + AGENTS.md "Do not widen without a new decision".

## Project Constraints (from CLAUDE.md / AGENTS.md)

- Run `npm test`, typecheck (`npm run typecheck`), `npm run format:check` after changes; report what passed; gated suites reported separately.
- Conventional commits; no co-author trailers; no AI attribution anywhere (global rule).
- Update the relevant guide (`docs/DEADLINES.md:205` currently documents the old sensitive-parameter stop) and add a dated `docs/READINESS.md` checkpoint (no numbers); keep the README short.
- Owner decision text goes in AGENTS.md next to the #120 and Phase 1 bullets and ends "Do not widen without a new decision".
- Data files carrying `source` + `checkedAt` take entries only from pages someone read (mirror of the meta-graph rule); run the new `npm run model-parameters:check` after editing.
- Never run live vendor operations or paid evaluations; none were needed.

## Sources

### Primary (official pages read 2026-10-21)
- https://platform.claude.com/docs/en/api/messages
- https://platform.claude.com/docs/en/about-claude/model-deprecations
- https://platform.claude.com/docs/en/models/sonnet-5-5/overview
- https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
- https://platform.claude.com/docs/en/models/opus-4-8/overview
- https://platform.claude.com/docs/en/models/haiku-4-5/overview
- https://platform.claude.com/docs/en/about-claude/models/overview
- https://developers.openai.com/api/docs/models/{gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-6-sol,gpt-6-luna,gpt-5,gpt-4.1,o3,o4-mini,gpt-5.1-chat-latest}
- https://developers.openai.com/api/docs/guides/latest-model/{gpt-5.6,gpt-6-astra,gpt-5,gpt-5.1,gpt-4.1}, guides/upgrading-to-gpt-5p6-sol, guides/reasoning, guides/advanced-usage
- https://developers.openai.com/api/reference/resources/chat and .../resources/responses/methods/create

### Codebase (read this session)
- pipeline/model-retirements.ts (lines 75-112, 142-170, 893-945, 1040-1075, 1515-1535, 1676-1700, 1810-1942), pipeline/deadline-registry.ts (all), pipeline/deadlines-cli.ts (28-130), pipeline/meta-graph-cli.ts (115-146), package.json scripts, model-retirements.test.ts and model-fixes.test.ts expectations listed above, docs/DEADLINES.md:205.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, no new deps
- Architecture / edit points: HIGH, read at exact lines
- Anthropic facts: HIGH (API reference quoted verbatim), model applicability MEDIUM (A3)
- OpenAI facts: HIGH that pages are silent; table consequently minimal

**Research date:** 2026-10-21
**Valid until:** 7 days (provider pages and model lineup move fast)
