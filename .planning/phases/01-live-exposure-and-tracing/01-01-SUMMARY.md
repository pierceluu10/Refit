---
phase: 01-live-exposure-and-tracing
plan: 01
subsystem: deadline-scan
tags: [typescript, deadline-scan, model-catalogs, prose-classification, benchmark, vitest]

requires: []
provides:
  - "Model-keyed map entries wrapped in satisfies, as, parentheses, a <T> assertion or ! are catalog, with every model ID inside them"
  - "Values of id, name, displayName, label, title and slug keys, and every element of a versions array, are catalog; model, modelName, modelId, version, default and value stay live"
  - "For OpenAI and Anthropic, a model ID inside a longer plain string or no-substitution template is a comment (prose), with a guard that keeps JSON model keys, template pieces, JSX text and + or += operands live"
  - "nonLiveCounts: the exact non-live count by use on every exposure and mention, taken before the 20-item cap"
  - "Per-use counts on the Not live lines of refit deadlines"
  - "scripts/ai-model-benchmark-summary.mjs: tested repositoryNonLive and benchmarkSummary; benchmark results gain nonLive, nonLiveTotal and mentionedOnly"
affects: [01-05-docs-and-readiness, 04-measurement]

actuals:
  tokens: 5983 # chars/4 over the 23,932 characters added under pipeline/ and scripts/
  tasks: 3
  commits: 6
commits: 6
plan_head_before: 24995ddd078a436b6f2400d2129e326557608c30
plan_head_after: 12c79865dc761847463768cd1f29f80d3eff2dca

tech-stack:
  added: []
  patterns:
    - "New literalUse rules sit after the `if (!model) return 'live'` guard, so Meta and Shopify never reach them"
    - "The prose rule runs last in the tokenUses callback and only on a match that is otherwise live"
    - "Benchmark logic that needs a test lives in a plain-JavaScript ESM module beside the script, with a .d.mts so a pipeline test can import it under strict TypeScript"

key-files:
  created:
    - scripts/ai-model-benchmark-summary.mjs
    - scripts/ai-model-benchmark-summary.d.mts
    - pipeline/ai-model-benchmark-summary.test.ts
  modified:
    - pipeline/deadline-exposure.ts
    - pipeline/deadlines-cli.ts
    - pipeline/deadlines.test.ts
    - scripts/ai-model-benchmark.mjs

key-decisions:
  - "nonLiveCounts counts distinct file:line:version non-live entries by use, the same unit as nonLive and nonLiveMore, after a live match of the same version on a line hides the non-live ones"
  - "The terminal prints a count line for every use that has a count, even when all of its matches fall past the 20-item listing limit"
  - "+= operands are treated as concatenation, like +, so they stay live"
  - "mentionedOnly excludes repositories with an error, because a failed scan says nothing about what the repository contains"
  - "benchmarkSummary keeps the nine summary keys the benchmark script wrote inline, in the same order, and appends mentionedOnly"

patterns-established:
  - "A table-driven classification test: [model, source line, expected use] rows written to one file, one match per line, compared with Object.fromEntries"

requirements-completed: [EXPO-01, EXPO-02, EXPO-03]

coverage:
  - id: D1
    description: "A model-keyed map entry wrapped in satisfies, as, parentheses, a <T> assertion or ! is catalog, with every model ID inside it; a non-model key stays live"
    requirement: "EXPO-03"
    verification:
      - kind: unit
        ref: "pipeline/deadlines.test.ts#classifies model-keyed map entries wrapped in satisfies, as, parentheses or assertions as catalog"
        status: pass
    human_judgment: false
  - id: D2
    description: "Descriptor keys and every element of a versions array are catalog; model, modelName, modelId, version, default, value, a non-array versions value and a conditional stay live"
    requirement: "EXPO-01"
    verification:
      - kind: unit
        ref: "pipeline/deadlines.test.ts#classifies descriptor keys and versions arrays as catalog and keeps request keys live"
        status: pass
    human_judgment: false
  - id: D3
    description: "A model ID inside a longer plain string is prose for OpenAI and Anthropic; exact IDs, template pieces, JSX text, concatenation operands and strings that set a model key stay live; Meta and Shopify are unchanged"
    requirement: "EXPO-03"
    verification:
      - kind: unit
        ref: "pipeline/deadlines.test.ts#classifies model IDs inside longer plain strings as prose, but keeps templates, concatenations and JSON model keys live"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every exposure and mention carries the exact non-live count by use, taken before the evidence cap; a live match on a line hides non-live matches of its own version; a repository with no match has no entries"
    requirement: "EXPO-02"
    verification:
      - kind: unit
        ref: "pipeline/deadlines.test.ts#counts every non-live match by use before the evidence cap"
        status: pass
      - kind: unit
        ref: "pipeline/deadlines.test.ts#classifies each of two matches on one line, and a live match hides non-live ones of its own version"
        status: pass
    human_judgment: false
  - id: D5
    description: "refit deadlines prints the exact non-live count for each use, including a use whose matches are all past the listing limit, and the count for a mention"
    requirement: "EXPO-02"
    verification:
      - kind: integration
        ref: "pipeline/deadlines.test.ts#prints the exact non-live count for each use on the terminal"
        status: pass
      - kind: other
        ref: "D=$(mktemp -d) with a satisfies-wrapped gpt-4 entry; node bin/refit.mjs deadlines --repository $D --json (the plan's tracer check) prints PASS {\"catalog\":1}"
        status: pass
    human_judgment: false
  - id: D6
    description: "repositoryNonLive and benchmarkSummary are pure functions: nonLive by use, nonLiveTotal, the nine earlier summary keys unchanged, and mentionedOnly without errored repositories"
    requirement: "EXPO-02"
    verification:
      - kind: unit
        ref: "pipeline/ai-model-benchmark-summary.test.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "scripts/ai-model-benchmark.mjs spreads the per-repository nonLive and nonLiveTotal and writes the summary from benchmarkSummary; no committed test runs the script"
    requirement: "EXPO-02"
    verification: []
    human_judgment: true
    rationale: "The script is top-level code with no test harness. It was checked once by a network-free smoke run on three local checkouts (not committed), so a verifier should re-run it or accept that evidence."
  - id: D8
    description: "EXPO-02 reading: 'comparable to the 2026-10-20 runs' means the earlier keys are unchanged and the new by-use counts are additive"
    requirement: "EXPO-02"
    verification: []
    human_judgment: true
    rationale: "The plan flags this reading as unresolved for the verifier. See the observation about the committed OpenAI results file under Issues Encountered."

duration: 20min
completed: 2026-10-21
status: complete
---

# Phase 1 Plan 1: Exposure classification and counts Summary

**The deadline scan now treats satisfies-wrapped model tables, descriptor-keyed and `versions` catalogs and quoted-in-prose model IDs as non-live, reports exact non-live counts by use on every exposure and mention (JSON, terminal and a tested benchmark summary), and leaves every request key, template piece and the 2026-10-20 result keys alone.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-10-21T11:18:15Z
- **Completed:** 2026-10-21T11:38:00Z
- **Tasks:** 3 (one tracer, two TDD)
- **Files modified:** 7 (3 created, 4 modified)

## Accomplishments

- **D-01 (EXPO-03).** `literalUse` tested the object under a model-named key with `ts.isObjectLiteralExpression(current)`, but `current` is the `satisfies`, `as`, parenthesized or `<T>` wrapper. It now tests `unwrapDown(current)`, so every model ID inside the entry is catalog. This is the bug behind the pi-derived model registries named in the research.
- **D-02 (EXPO-01).** Values of `id`, `name`, `displayName`, `label`, `title` and `slug` keys, and every element of a `versions` array (a single element too), are catalog. The rule sits after the `if (!model) return 'live'` guard, so Meta and Shopify never reach it. `model`, `modelName`, `modelId`, `version`, `default` and `value` stay live (D-15), and so does `versions: 'gpt-4'` and `id: flag ? 'gpt-4' : 'o1-mini'`.
- **D-03, D-18, D-20 (EXPO-03).** For OpenAI and Anthropic, a model ID quoted inside a longer plain string or no-substitution template is a `comment`. The rule runs last and only on a match that is live so far, so the `<option>` fixture keeps its `catalog` class. An exact ID, template head, middle and tail pieces, JSX text, and `+` or `+=` operands stay live, and so does a string with a `model`, `modelId` or `modelName` key just before the ID, as in `'{"model":"gpt-4"}'`.
- **D-05 (EXPO-02).** `DeadlineExposure.nonLiveCounts` holds the exact non-live count by use for every exposure and mention, taken before the 20-item cap and `{}` when there is none. `refit deadlines` prints it beside each `Not live` line.
- **D-05 benchmark.** `repositoryNonLive(result, provider)` and `benchmarkSummary(results)` moved into `scripts/ai-model-benchmark-summary.mjs` with type declarations and tests. Results gain `nonLive` (by use), `nonLiveTotal` and `mentionedOnly`; the nine earlier summary keys keep their meaning and order.
- D-04 is untouched: `CATALOG_SIZE` is still 3 and the two-model `pair` fixture stays live.

## Task Commits

1. **Task 1 (tracer): satisfies-wrapped catalog entry through scan, JSON and terminal output** - `f2b2433` (feat). The tracer feedback gate ran with auto mode off and `human_verify_mode` at `end-of-phase`: the automated `<verify>` was re-run after the commit and passed, so expansion continued with no checkpoint.
2. **Task 2: benchmark summary as a tested pure function**
   - RED `e5a347b` (test): tests, `.d.mts` and an interface stub
   - GREEN `ed8bff9` (feat): the module and the script wiring
3. **Task 3: descriptor keys, versions arrays and plain-string prose**
   - RED `1f5b1e4` (test)
   - GREEN `94dea57` (feat)
   - Follow-up `12c7986` (test): Anthropic prose, template middle and tail pieces, and every `versions` element

**Plan metadata:** the `docs(01-01)` commits that add this file and update STATE.md, ROADMAP.md and REQUIREMENTS.md.

## Files Created/Modified

- `pipeline/deadline-exposure.ts` - `unwrapDown`, `unwrapUp`, `DESCRIPTOR_KEYS`, `descriptor`, `concatenated`, `MODEL_KEY`, `isProse`, the `version` argument of the `tokenUses` callback, `nonLiveCounts`
- `pipeline/deadlines-cli.ts` - `printNonLive` takes the counts and prints one count per use
- `pipeline/deadlines.test.ts` - 6 new tests; `classifying` gained `dall-e-3` and `claude-3-opus-20240229`
- `scripts/ai-model-benchmark-summary.mjs`, `.d.mts` - the two exported functions and their types
- `pipeline/ai-model-benchmark-summary.test.ts` - 4 tests on fixture results
- `scripts/ai-model-benchmark.mjs` - imports both functions instead of computing inline

## Decisions Made

- **Count unit.** `nonLiveCounts` counts distinct `file:line:version` non-live entries, the unit `nonLive` and `nonLiveMore` already use. Two matches of one version on a line collapse to one, and a non-live match hidden by a live match of the same version on its line is not counted (as today).
- **Uses with no listed place still print.** The listing cap is 20 matches in scan order, so with 25 catalog lines before one comment line the comment never reaches the list. `printNonLive` adds a count-only line for any use in `nonLiveCounts` that has no listed place, so the printed counts add up to the listed places plus `…and N more`.
- **`+=` is concatenation.** D-20 names `+` operands. `message += 'Model "gpt-4" '` builds a value in the same way, and the safe direction is live.
- **Guard window.** D-18's 40 characters are taken from the string literal's own source text, ending just before the ID's opening quote. The key must sit right before that quote, so for a single-line string this gives the same answer as the line text before the quote. A multi-line template also sees a `model:` key on the previous line, which is the more conservative result.
- **`mentionedOnly` excludes errored repositories.** The plan's behavior section states this. The script cannot produce a non-zero `nonLiveTotal` with an error today, but the function does not rely on that.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Count-only terminal lines for uses past the listing limit**
- **Found during:** Task 1 (writing the terminal test)
- **Issue:** The plan says to print the count "next to each collapsed Not live line". A use whose matches all fall past the 20-item cap has no such line, so its exact count would be missing from the terminal while present in JSON.
- **Fix:** `printNonLive` adds a line with the use and its count and no places for such a use.
- **Files modified:** `pipeline/deadlines-cli.ts`
- **Verification:** `pipeline/deadlines.test.ts#prints the exact non-live count for each use on the terminal` (25 catalog lines list 20 places, and the comment in a later file still prints with count 1)
- **Committed in:** `f2b2433`

**2. [Rule 2 - Missing critical functionality] `+=` operands stay live**
- **Found during:** Task 3 (reading D-20)
- **Issue:** The plan's prose rule excludes `+` operands. `+=` builds a string the same way, and classifying it as prose could hide a pin.
- **Fix:** `concatenated()` treats `PlusEqualsToken` like `PlusToken`.
- **Files modified:** `pipeline/deadline-exposure.ts`
- **Verification:** the `message += 'Model "gpt-4" ';` row of the prose test
- **Committed in:** `94dea57`

---

**Total deviations:** 2 auto-fixed (both Rule 2, both in the conservative direction)
**Impact on plan:** Neither changes a named truth or prohibition. No scope creep.

## Issues Encountered

- **RED evidence for Task 2.** `gsd_run check tdd-red-evidence` rejected both Vitest TAP reporters with `invalid_record` ("Non-TAP data in report"), because the multi-line assertion diagnostics are not valid TAP lines. A rerun with the JUnit reporter returned `RED_EVIDENCE_OK` for the target test, and the same was done for Task 3. The throwaway record and XML files were deleted and never committed. This plan has `type: execute` and `workflow.tdd_mode` is false, so the plan-level gate sequence was not required; the checks were run anyway.
- **Observation for the verifier (EXPO-02).** The committed `docs/benchmarks/2026-10-20-openai-results.json` summary uses older key names (`repos`, `stoppedOnly`, `silent`), while the Anthropic file and the script's inline code use `repositories`, `exposedStoppedOnly` and `exposedSilent`. The "nine 2026-10-20 keys" kept here are the script's own. Nothing in the committed results files was edited.

## Verification

- `npx vitest run pipeline/deadlines.test.ts pipeline/ai-model-benchmark-summary.test.ts`: 27 passed.
- **`npm test` (default, gated suites skipped):** exit 0. 106 test files passed and 8 skipped (114). 1591 tests passed and 79 skipped (1670). Baseline before this plan: 105 files passed, 8 skipped (113); 1581 passed, 79 skipped (1660). The difference is +1 file and +10 tests, all new in this plan; the skipped count is unchanged.
- **Gated suites** (`REFIT_DOCKER_IMAGE`, `REFIT_NPM_PREPARE`, `REFIT_STRIPE_SDK`, `REFIT_OPENAI_SDK`) were not run: this plan changes no code on their paths.
- `npm run typecheck`: exit 0. `npm run format:check`: all matched files use Prettier code style.
- The tracer's end-to-end command prints `PASS {"catalog":1}`; at the baseline the `gpt-4` deadline was a live exposure and `nonLiveCounts` did not exist.
- Acceptance greps: `nonLiveCounts` appears 2 times in `deadline-exposure.ts` and 4 in `deadlines-cli.ts`; `DESCRIPTOR_KEYS` 2; `const CATALOG_SIZE = 3` still matches; `mentionedOnly`, `exposedSilent`, `exposedStoppedOnly`, `exposedWithReplacement` and `timedOut` are all in the summary module. No line of an existing test was removed or changed (`git diff b44b124 -- pipeline/deadlines.test.ts` has no deleted lines).
- **Mutation checks** (temporary edits, each reverted; `deadline-exposure.ts` verified identical to HEAD afterwards): dropping the `+` guard, the model-key guard or the `unwrapDown` call, adding `value` or `model` as a descriptor key, leaving the `versions` wrapper un-unwrapped, and running prose before the `<option>` rule each made at least one test fail.
- **Benchmark script smoke run** (network-free, three local checkouts with a `.git` directory, not committed): summary `{"repositories":3,...,"exposed":1,"exposedWithReplacement":1,...,"mentionedOnly":1}`; the repositories carried `nonLive` `{"catalog":1}`, `{"catalog":1}` and `{}`.

## Corpus smoke check (informative only; Phase 4 is the measurement)

The scan was run on the 50 repositories fetched for the research (files read only, nothing installed or run, the default registry, the current clock). It did not crash on any of them; the slowest scan took 1.6 s.

- Of the 842 recorded silent evidence lines, 759 are still found in the scan's capped lists: 335 live, 419 catalog and 5 comment. The other 83 fall past the per-deadline cap of 20 and cannot be classified from the lists.
- Of the 59 recorded repository-provider pairs, 10 no longer have any live exposure: base-context (OpenAI and Anthropic), scramjet, dreb, lunR, omk, fleetagent/pi, hoocode-ts, multi-llm-ts and n8n-nodes-openai-langfuse. These are the same 10 the research prototype named.
- The 5 matches classified as prose among those lines were read: descriptions (`Image model to use (e.g. "dall-e-3", "dall-e-2")`), a generated markdown docs index and an n8n expression string. Each is prose.
- This says little about application repositories (research assumption A5).

## Known Stubs

None. The interface stub committed with the Task 2 RED tests was replaced in `ed8bff9`.

## Threat Flags

None. The plan adds no endpoint, authentication path or new file access. Threat mitigations T-01-01 and T-01-03 are in place: the new rules run after the `!model` guard on a published key list, each kept-live shape has a test, and file places on the terminal still pass through `terminalText()`. Nothing was installed (T-01-SC).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 01-02 (non-text and raw calls) is independent of this plan and can run next. Plans 01-03 and 01-04 build the tracing resolver and do not touch the files changed here.
- Plan 01-05 must document `nonLiveCounts`, the prose rule with its `model` key guard, the descriptor keys, and the benchmark fields `nonLive`, `nonLiveTotal` and `mentionedOnly`. `docs/DEADLINES.md` and `docs/READINESS.md` were not touched here.
- EXPO-01, EXPO-02 and EXPO-03 stay pending in REQUIREMENTS.md until plan 01-05 finishes: all three IDs are also declared there, and `requirements.ready-ids` reports them as blocked.
- The tracer (`pipeline/model-retirements.ts`) is unchanged and independent of the scan's classification. A catalog entry that a traced request reads is still found there.

## Self-Check: PASSED

- Created files exist: `scripts/ai-model-benchmark-summary.mjs`, `scripts/ai-model-benchmark-summary.d.mts`, `pipeline/ai-model-benchmark-summary.test.ts`, this file.
- Commits `f2b2433`, `e5a347b`, `ed8bff9`, `1f5b1e4`, `94dea57` and `12c7986` are ancestors of HEAD, and the evaluation scope for plan 01-01 resolves all six.
- Every task's acceptance criteria were re-run after the last code commit and pass; so do the plan-level `<verification>` commands (see Verification).
- `pipeline/deadline-alerts.ts` and `pipeline/model-retirements.ts` have no diff since the plan started.

---
*Phase: 01-live-exposure-and-tracing*
*Completed: 2026-10-21*
