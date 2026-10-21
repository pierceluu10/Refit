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
  critical: 0
  warning: 0
  info: 3
  total: 3
status: clean
---

# Phase 02: Code Review Report (iteration 2)

**Reviewed:** 2026-10-21
**Depth:** deep
**Files Reviewed:** 17
**Status:** clean

## Summary

All six iteration-1 fixes verified. Targeted suites pass (97 tests), `tsc --noEmit` is clean and `npm run model-parameters:check` reports the shipped table valid. No wrong edit was reproduced.

Scratch repos live outside the project, in the session scratchpad (`.../scratchpad/h/run.mts`, `v.mts`, `r.mts`). They called `proposeModelReplacements` against the shipped table, with `claude-3-opus` to `claude-sonnet-5-5` (`temperature` default-only 1, `top_k` none) and `gpt-4` to `o3` (`max_tokens` renamed).

**CR-01 (computed keys), re-verified.** These stop, in SDK calls and in raw `fetch`/`axios` bodies:
- `[k as 'temperature']` with 0.5 or 1.
- `[(k)]`, `[0]`, `[Symbol.for('x')]`, `['__proto__']`.
- A template-literal key.
- `[k as 'max_tokens']` on o3.

Every other way to set a parameter also stops:
- `req.temperature = …` after creation stops through the shared-object rule (`req` is used twice).
- `Object.assign(req, …)` on a const request object stops the same way.
- Getter, method and shorthand `temperature`, a string or bigint value, an angle-bracket cast, `NaN`, `Infinity` and `1e999` stop as "not a numeric literal".
- Duplicate `temperature` keys are each checked, in either order.
- Unicode-escaped identifier and string keys are read as `temperature` and compared.
- `top_p`, `top_k` and o3 `max_tokens` (including the quoted form) stop.
- A literal `...{temperature: 0.5}` spread stops.

Only literal `temperature` values that equal 1 continue (`1`, `1.0`, `1e0`, `0x1`, `+1`). `__proto__: {…}` as a literal prototype and a `constructor:` key continue. Both are inert: JSON serialisation sends only own properties of the request, and a `constructor` key is not a parameter.

**WR-01 (validator), re-verified.** Rejected as invalid: array, null and string specs; array `accepts`; string, `-Infinity` or null `min`; `default` of `1e999`; array parameters; a `__proto__` parameter key; provider `__proto__`, `constructor`, `toString` or an array; array model; null and array entries; non-object top level; Date and array `checkedAt`; URL object and array `source`; a duplicate model; a `defaultSource` without a default; an `any` spec with a `default`. `parameterVerdict` fails closed for unknown specs.

**IN-03, WR-02, IN-01 and IN-02 hold.** Docs match behaviour (heuristic for no-entry replacements, table for entries). The `runModelFixes` callers (`local-service.ts`, `ai-model-validation-cli.ts`) pass the table. A table that fails to load skips model fixes with a progress message, and `--propose-model-fixes` throws.

## Info

### IN-01: `parameterVerdict` treats `NaN` as in range

**File:** `pipeline/model-parameters.ts:197-201`
**Issue:** For an `any` spec with `min`/`max`, `NaN < min` and `NaN > max` are both false, so `parameterVerdict(..., NaN)` returns `{ ok: true }`. Reproduced in `v.mts`. It is not reachable today because `numericLiteral` (`model-retirements.ts:1668`) drops non-finite values to `undefined`, which stops. The exported function still fails open for a future caller.
**Fix:** Treat non-finite input as not numeric: `if (value === undefined || !Number.isFinite(value)) return { ok: false, why: 'not-numeric', spec };`

### IN-02: The table check covers only the named parameters

**File:** `pipeline/model-retirements.ts:1871-1873`
**Issue:** Only names in `MODEL_PARAMETER_NAMES` are checked, so a tabled replacement still edits requests that set parameters outside that list. Reproduced: `gpt-4` to `o3` with `n: 3, stop: [...], seed: 1`, and Anthropic `thinking: {budget_tokens}` on `claude-sonnet-5-5`, both produce an edit. Whether those models reject them is not proven here. The behaviour predates this phase and the docs scope the stops to the named list, so this is a known gap, not a regression.
**Fix:** If the owner wants the invariant to cover them, extend `MODEL_PARAMETER_NAMES` and the table. Keep it as a documented limit otherwise.

### IN-03: Unreviewed table sources and cosmetic validator gaps

**File:** `data/model-parameters.json:3-24`, `pipeline/model-parameters.ts:99, 130`
**Issue:** The URLs and the claims "Sonnet 5.5 accepts only `temperature` 1; `top_k` unsupported" and "o3 renames `max_tokens`" could not be verified offline. They must be re-read against the pages before release. The validator also accepts a zero-width character in `model` and `renamedTo: "__proto__"`. Both are cosmetic: a model with a zero-width character never matches, and `renamedTo` only appears in a stop sentence.
**Fix:** Re-read the two source pages. Optionally restrict `model` with `MODEL_ID`-style regex `/^[a-z0-9][a-z0-9.-]*$/`.

---

_Reviewed: 2026-10-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
