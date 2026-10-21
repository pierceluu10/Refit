---
phase: 01-live-exposure-and-tracing
plan: 02
subsystem: model-retirement-tracer
tags: [typescript, model-retirements, openai, anthropic, axios, vitest]

requires: []
provides:
  - "A retiring model in any traced OpenAI or Anthropic SDK call outside MODEL_CALLS stops with a named reason and is never edited"
  - "Non-text raw JSON endpoints (OpenAI images/audio speech/embeddings/moderations/completions, Anthropic /v1/complete) stop the same way"
  - "axios request-config forms (axios({url,data}), axios.request, axios.create instances) traced like axios.post"
affects: [01-05-docs-and-readiness]

actuals:
  tokens: 7500 # chars/4 over the changes under pipeline/
  tasks: 3
  commits: 2
commits: 2
plan_head_before: b5dfee3de6c60df7cfd18f334edc089135b3434c
plan_head_after: 90f9fba

key-files:
  modified:
    - pipeline/model-retirements.ts
    - pipeline/model-retirements.test.ts

key-decisions:
  - "Catch-all (D-16): every traced call is kept with text=false unless it is in MODEL_CALLS / clientCalls; the reason is placed right after the registry-has-no-replacement check"
  - "axios binding is resolved syntactically (default import of 'axios', require('axios'), const initialized with either or with .create) via an un-aliased checker lookup, since axios is not installed in the analysed program"

requirements-completed: [TRAC-05, TRAC-07]

status: complete
completed: 2026-10-21
---

# Phase 1 Plan 2: Non-text calls and raw requests Summary

**A retiring model in an image, audio, embeddings, moderation, legacy-completion or other non-text OpenAI/Anthropic call (SDK or raw) now stops with "`<call>` is not a call Refit edits; <to> may change formats or parameters; change it by hand to <to>." and is never edited; axios request-config and `axios.create` forms are traced like `axios.post`.**

## Accomplishments

- `requests[].text` and `RAW_ENDPOINTS[].text`; the TRACERS loop no longer filters to the text allow-list. Calls with no object `model` still drop out, so `models.retrieve('gpt-4')` and `embeddings.create({ input })` stay silent.
- Non-text raw endpoints with `(?![\w/-])` lookaheads; `/v1/completed`, `/v1/embeddings-x`, multipart `formData.append` produce nothing.
- `axiosBinding` plus `rawRequest` extension: `axios({ url, data })` (label `axios <path>`), `.request` (label `request <path>`), on the module or an `axios.create` instance. An unrelated function named `request`/`axios` is not matched.
- A literal shared by a text and a non-text call stops (merged decision takes the first non-empty reason); patch stays null.

## Task Commits

1. Tasks 1 and 2 (tracer + all non-text cases, three intended expectation updates): `c9eaef1` (feat). Tracer CLI check printed PASS.
2. Task 3 (raw fetch/axios tests, request-config forms): `90f9fba` (test). The implementation of the axios forms landed in `c9eaef1`, so the Task 3 tests passed on first run (no separate RED).

## Deviations from Plan

**1. [Process] Tasks 1-3 implementation committed together.** The catch-all, raw endpoints and axios forms were written in one pass, so there are two commits rather than three or more; the Task 3 tests were added after. No behavior effect. Because the tests were not written first, no RED evidence exists for Task 3.

**2. [Comments] Three comment lines in existing tests were reworded** to match the new behavior (embeddings, legacy completions, other endpoint). No assertion other than the three intended ones changed (verified with `git diff b5dfee3`, removed lines are only those comments).

Stop sentences for existing text stops are unchanged.

## Verification

- `npx vitest run pipeline/model-retirements.test.ts pipeline/model-fixes.test.ts`: 10 passed.
- `npm test` (default, gated suites skipped): exit 0. 106 files passed, 8 skipped (114). 1594 tests passed, 79 skipped (1673). Before this plan: 1591 passed (after 01-01); +3 new tests.
- `npm run typecheck`: exit 0. `npm run format:check`: all files use Prettier code style.
- Task 1 CLI check printed `PASS` with the `images.generate` stop.
- Gated Docker/real-SDK suites not run (no code on their paths).
- Not done: no mutation checks on the new branches.

## Behavior note

In `refit serve --model-fixes`, a repository whose only retiring uses are non-text moves from `no-change` to `needs-review` (RESEARCH D-11).

## Known Stubs

None.

## Threat Flags

None. T-01-04 mitigated (`!request.text` always yields a blocking reason; shared-literal test asserts stop and null patch); T-01-05 mitigated (call name in backticks; call names come from identifier paths and `/v1/...` path characters only).

## Self-Check: PASSED

- `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts` exist and are modified.
- Commits `c9eaef1` and `90f9fba` are ancestors of HEAD.
- `grep -cF "is not a call Refit edits" pipeline/model-retirements.ts` is 1; `v1\/complete` is present.
