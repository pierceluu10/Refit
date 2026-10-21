---
phase: 01-live-exposure-and-tracing
fixed_at: 2026-10-21T08:35:00Z
review_path: /Users/otabekalimov/OalimovProj/Refit/.planning/phases/01-live-exposure-and-tracing/01-REVIEW.md
iteration: 2
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 1: Code Review Fix Report (iteration 2)

**Fixed at:** 2026-10-21
**Source review:** /Users/otabekalimov/OalimovProj/Refit/.planning/phases/01-live-exposure-and-tracing/01-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 5 (CR-01, WR-01..WR-04; Info out of scope)
- Fixed: 5
- Skipped: 0

Verification ran in the main checkout (`workflow.use_worktrees` is `false`) on `feat/ai-agents-phase-1`, after the last commit:
- `npm test`: 106 files passed, 8 skipped; 1613 tests passed, 79 skipped by environment gates.
- `npm run typecheck`: clean.
- `npm run format:check`: clean.

All fixes only add stops, so none can add a wrong edit. They are logic changes, so they are marked requires human verification beyond the regression tests. Over-stopping is intended.

## Fixed Issues

### CR-01: Uses through `import()`, `require()` or computed namespace access are not attributed

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** 96aab3e
**Status:** fixed: requires human verification
**Applied fix:** The program now builds an index of opaque modules: targets of `import()`, `require()` (any file type, and `import x = require()`), `export *` and `export * as`, and any `import * as ns` whose identifier is used for anything but `ns.name`. A load with a non-literal specifier, `import.meta.glob*` or `require.context` makes every module opaque. A module that re-exports an opaque module's names is opaque too. `sharedUse` stops on any pass whose declaring module is opaque with the reason "The module that declares this model is also loaded dynamically or through a namespace the tracer cannot follow; change it by hand to <to>." Tests cover dynamic import (await and `.then`), TypeScript and JavaScript `require`, computed namespace key, namespace passed along, `export *`, glob, an unreadable specifier and a barrel namespace, plus a control that `ns.NAME` is still followed.
**Behavior change:** CommonJS modules that other files `require` are no longer edited. Two older tests used `require`/`module.exports` fixtures to show editing; they now use static ESM imports (`lib/ai.js`, `lib/commands.js`, `lib/models.js`, `lib/chat.js` in `model-retirements.test.ts`).

### WR-01: Custom base URL stop bypassed by common shapes

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** df318ca
**Status:** fixed: requires human verification
**Applied fix:** `customEndpoint` is now a repository-wide, case-insensitive text check over all source files and over `.env*`, `*.json`, `*.yaml`, `*.yml` outside `node_modules` (and `.git`), for `baseURL`, `baseUrl`, `base_url`, `basePath`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_API_BASE`, `withOptions(`, `AzureOpenAI`. A match stops every SDK request with the existing reason; raw HTTP requests are unaffected. An oversized or unreadable file, or more than 5,000 config files, counts as a match. Tests: options object, spread, assignment, `.withOptions`, `process.env` variable, `.env` file, YAML file.
**Deviation to confirm:** `tsconfig*.json`, `jsconfig*.json`, `package-lock.json`, `npm-shrinkwrap.json` and `pnpm-lock.yaml` are skipped, because a compiler `baseUrl` is in most TypeScript repositories and would disable the feature everywhere. This is a literal narrowing of the instruction "`*.json`"; a client endpoint set only in a tsconfig is not possible. Source files named `tsconfig` are not an issue.

### WR-02: Inheritance detection misses mixins, class expressions, aliased bases; accessor models silent

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`
**Commit:** 08fc060
**Status:** fixed: requires human verification
**Applied fix:** If any class extends something that is not a plain identifier naming a class declaration and not an external or global name (mixin call, class expression, alias, parameter), every class field, method and constructor default stops, and the same-named members of those classes are followed to their literals and stop too. Getters (including object-literal getters and abstract ones) are followed through their returns and stop; a setter or getter beside a field of the same name, and method overloads, also stop. The reason text was widened to name accessors and unresolved class trees (tests and docs updated). Tests: mixin, class expression, aliased base, getter, abstract getter, object getter, setter beside field.

### WR-03: JSON strings with a model key hid other retiring IDs

**Files modified:** `pipeline/deadline-exposure.ts`, `pipeline/deadlines.test.ts`
**Commit:** 9905d7e
**Applied fix:** A string whose trimmed text starts with `{` or `[`, or that contains a quoted key such as `"engine":`, is data and never prose. Tests for the three reviewer shapes (`{"model": "x", "fallback": "gpt-4"}`, `{"list": ["gpt-4"]}`, `JSON.parse('{"engine":"gpt-4"}')`). The tests use `gpt-4` because the scan registry used by that test has no `gpt-3.5-turbo`.

### WR-04: Silent statically resolvable shapes

**Files modified:** `pipeline/model-retirements.ts`, `pipeline/model-retirements.test.ts`, `docs/DEADLINES.md`, `docs/READINESS.md`, `AGENTS.md`
**Commits:** a4a4bb9, 94af3b5 (test fixture fix), da89d8f (docs)
**Status:** fixed: requires human verification
**Applied fix:** `export default 'literal'` and `export default { ... }` are followed like constants (with the shared-use check). String-literal element access (`MODELS['fast']`, `MODELS['slow']['id']`) is followed like property access; an enum member or class field read that way stops through the shared-use check. `let`, array iteration and callbacks, computed non-literal keys stay untraced and silent, and docs/DEADLINES.md Limits now lists them exactly. The same docs commit covers every other iteration 2 change (module escape, inheritance, endpoint text, JSON rule) and AGENTS.md and READINESS.md wording.
Note: commit a4a4bb9 was made with one fixture mistake in its test (a syntax error in the untraced case); 94af3b5 corrects it. The tree is green at 94af3b5 and after.

## Skipped Issues

None.

---

_Fixed: 2026-10-21_
_Fixer: gsd-code-fixer_
_Iteration: 2_
