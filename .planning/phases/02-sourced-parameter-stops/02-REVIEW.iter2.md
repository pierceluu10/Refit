---
phase: 02-sourced-parameter-stops
reviewed: 2026-10-21T00:00:00Z
depth: deep
files_reviewed: 17
files_reviewed_list:
  - AGENTS.md
  - data/model-parameters.json
  - docs/CLI.md
  - docs/DEADLINES.md
  - docs/READINESS.md
  - package.json
  - pipeline/ai-model-validation-cli.ts
  - pipeline/deadline-registry.ts
  - pipeline/deadlines-cli.ts
  - pipeline/local-service.ts
  - pipeline/model-fixes-service.test.ts
  - pipeline/model-fixes.test.ts
  - pipeline/model-fixes.ts
  - pipeline/model-parameters.test.ts
  - pipeline/model-parameters.ts
  - pipeline/model-retirements.test.ts
  - pipeline/model-retirements.ts
findings:
  critical: 1
  warning: 2
  info: 3
  total: 6
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-10-21
**Depth:** deep
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Probed on scratch repos outside the project (probe scripts in the session scratchpad), against the phase code and a worktree of `feat/ai-agents-phase-1`. The four touched test files pass (86 tests) and `npm run model-parameters:check` passes. The no-entry legacy path is byte-for-byte unchanged (11 cases compared against the base branch). Table-load failure fails closed in `serve --model-fixes`, `deadlines --propose-model-fixes` and `ai-model-validation-cli`. The table loader, however, accepts malformed `accepts` values, and one request shape slips past the parameter check.

Held up: string keys, duplicate keys in either order, spreads, shorthand, getters and methods, `0x1`, `1e0`, `+1`, `-0`, `- -1`, constants, `.stream`, `top_p`/`top_k` on `claude-sonnet-5-5`, `max_tokens` on `o3`, and a request object mutated after creation. URL validation rejected http, userinfo in both positions, look-alike and sub-domains, backslash tricks, other ports and a trailing dot. `__proto__`, `toString` and `constructor` keys were rejected. `checkedAt` rejected datetimes, unpadded dates and future dates.

## Critical Issues

### CR-01: A computed property key bypasses every parameter stop, so a request the table disproves is edited

**File:** `pipeline/model-retirements.ts:1870-1872` (also `propertyName`, line 163-165)
**Issue:** `sensitiveProperties` keeps a property only if `propertyName(item.name)` returns a name in the provider's set. `propertyName` returns `undefined` for a `ComputedPropertyName`, so `['temperature']: 0.5` and `` [`top_k`]: 5 `` are never seen. Reproduced with replacement `claude-sonnet-5-5`:

- `{model:'claude-3-5-sonnet-20241022', ['temperature']: 0.5}` gives EDIT with no stop. The table says `claude-sonnet-5-5` accepts only `temperature: 1`, so the edited request returns a 400.
- `{..., [`top_k`]: 5}` gives EDIT. The table says `top_k` is not accepted.
- With no table entry the same pattern edits `gpt-5.6-luna` for `['max_tokens']: 5`.

The base branch behaves identically, so this predates the phase. But the phase's claim is that the rule continues only when every parameter is proven by the table. An unreadable key is the same class of unproven input as shorthand, which this phase made a stop, so it breaks the zero-wrong-edits invariant.

**Fix:** Stop on any property whose name cannot be read, in both the tabled and the legacy path. For example, in the `reason` chain, after the spread check:

```ts
found.object.properties.some(
  (item) => item.name && ts.isComputedPropertyName(item.name),
)
  ? 'The request uses a computed property name, which may set parameters the replacement rejects.'
  : ...
```

Add a fixture for `['temperature']: 0.5` and a template-literal key.

## Warnings

### WR-01: `accepts` is validated through `String()`, so an array such as `["none"]` passes and then proves every value

**File:** `pipeline/model-parameters.ts:86` (consumer at `:193-202`)
**Issue:** `['any','default-only','none'].includes(String(spec.accepts))` coerces its input. `accepts: ["none"]` becomes `'none'` and passes, and `checkModelParameters` returns no errors. In `parameterVerdict` none of `spec.accepts === 'none' | 'default-only' | 'any'` match, so execution reaches `return { ok: true }`. Reproduced: `parameterVerdict(table, 'anthropic', 'm1', 'top_k', 5)` returns `{ ok: true }` for a table that validates cleanly. The loader's whole-file-rejection guarantee does not cover this shape, and the consumer fails open on it. The same `String()` coercion on `entry.provider` (line 125) accepts `provider: ["anthropic"]`; that entry never matches, so it fails closed, but it is wrong.
**Fix:** Compare strictly and make the verdict exhaustive:

```ts
if (spec.accepts !== 'any' && spec.accepts !== 'default-only' && spec.accepts !== 'none')
  errors.push(`${at}: accepts must be any, default-only or none.`);
```

Use `typeof entry.provider === 'string'` for the provider check. End `parameterVerdict` with an explicit `if (spec.accepts !== 'any') return { ok: false, why: 'unproven', spec };` before `return { ok: true }`, so an unexpected shape stops.

### WR-02: Docs say Anthropic `top_p` and `top_k` keep stopping on any model, but no-entry replacements still edit them

**File:** `AGENTS.md` (Sourced parameter stops bullet), `docs/DEADLINES.md` (Sourced model parameters section), `docs/READINESS.md` (October 21 checkpoint, "What keeps stopping")
**Issue:** Each lists "`top_p` on any Anthropic model" and "`top_k`" under "everything else keeps stopping". Reproduced with the replacement `claude-haiku-4-5-20251001`, which has no table entry: `{temperature: 0.5}` and `{top_k: 5}` are both EDIT, by the unchanged legacy `rejectsSampling` rule (Claude below 4.7). The following sentence ("replacements with no entry keep the earlier behavior") only half-corrects this, and READINESS never names Haiku. A reader will conclude parameter stops are now universal. The AGENTS wording "table entry accepts that parameter" is also loose, since `rejectsSampling` stays the gate for untabled models.
**Fix:** Scope each statement to "on tabled replacements" and name Haiku 4.5 as an unproven edit path. Say explicitly that for models with no entry the 4.7-and-later heuristic still decides.

## Info

### IN-01: `runModelFixes` silently falls back to an empty table when `parameters` is omitted

**File:** `pipeline/model-fixes.ts:159-163`
**Issue:** `options.parameters ?? EMPTY_MODEL_PARAMETERS` contradicts the docs' "stops instead of falling back to an empty table". Today every caller passes a loaded table, and the fallback only reduces edits (legacy stops), so it is not a hole. A future caller that forgets the argument loses the table without notice.
**Fix:** Make `parameters` required in `runModelFixes`.

### IN-02: Redundant and partly dead computation in the reason chain

**File:** `pipeline/model-retirements.ts:1877-1880`
**Issue:** `sensitive` is built with `.filter(() => tabled || rejectsSampling(...))`, but it is read only in the `!tabled` branch, so the `tabled ||` term is dead. `name!` and `propertyName(...)!` assertions are repeated across three passes.
**Fix:** Compute `sensitive` only for the untabled branch and derive names once.

### IN-03: URL host check accepts any path on an official host, and `model` is not trimmed

**File:** `pipeline/model-parameters.ts:54-68`, `:130`
**Issue:** `https://platform.claude.com` with no path and `https://PLATFORM.CLAUDE.COM/a` validate. `model: " m1 "` and a duplicate `"m1 "` also validate, and never match at lookup, so they fail closed. These are harmless but weaken the sourcing guarantee: a `source` need not point at a documentation page that names the model.
**Fix:** Require a non-root path, and require `entry.model === entry.model.trim()`.

---

_Reviewed: 2026-10-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
