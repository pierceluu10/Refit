---
phase: 03-application-benchmark-sets
reviewed: 2026-10-21T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - scripts/ai-app-helpers.mjs
  - scripts/ai-app-helpers.d.mts
  - scripts/ai-app-select.mjs
  - scripts/ai-app-label-candidates.mjs
  - scripts/ai-app-labels.mjs
  - pipeline/ai-app-helpers.test.ts
  - pipeline/ai-app-labels.test.ts
  - docs/BENCHMARKS.md
  - AGENTS.md
findings:
  critical: 0
  warning: 5
  info: 4
  total: 9
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-10-21
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Security posture is good. Repo names, SHAs and workspace paths are validated before they reach git, gh or the filesystem, and every subprocess call uses argv arrays. Nothing inside a fetched repo is executed or installed. Symlinks are skipped, and no token is read or logged. The committed labels file carries only the `COMMITTED_KEYS` fields, and no raw code lines are in it. The numbers I rechecked in docs/BENCHMARKS.md match the committed JSON: 150 repos, 4,679 candidates, 374 live, 370 JS/TS, 95/45 hasChecks, 9 overlapping repos, no shortfall, 468 sampled, 460/456 agreement. The docs say "not hand labelling" and do not overclaim. Both test files pass (25 tests).

The defects are in the merge and validation path, where a label can be silently lost or loosened, and in the selector's resilience. No critical findings.

## Warnings

### WR-01: The merge never checks that every candidate received a label

**File:** `scripts/ai-app-labels.mjs:261-269`
**Issue:** Labels are validated per batch against that batch's candidates, but the final merge walks `candidates.json` and does `{ ...candidate, ...labelByKey.get(key(candidate)) }`. If `candidates.json` and the batch files are out of sync (for example the candidates script was rerun, or a batch was removed), a candidate with no label is committed without `live`, `via`, `reason` or `notes`, and no error is raised. `summarize` then counts it as `notLive` and does `bump(byReason, undefined)`, which creates an `"undefined"` reason key. A batch candidate that is not in `candidates.json` is dropped without a message. This is the silent drop or duplicate class of bug.
**Fix:**
```js
const labelled = repos.reduce((n, r) => n + r.labels.filter((l) => 'live' in l).length, 0);
const total = candidates.repos.reduce((n, r) => n + r.candidates.length, 0);
if (labelled !== total || labelByKey.size !== total) {
  console.error(`label/candidate mismatch: ${labelled} labelled, ${labelByKey.size} labels, ${total} candidates`);
  process.exit(1);
}
```

### WR-02: Label identity fields can override the candidate's and change type

**File:** `scripts/ai-app-helpers.mjs:324,336`, `scripts/ai-app-labels.mjs:266-267`
**Issue:** `labelId` joins fields into a string, so a label with `"line": "12"` or `"column": "5"` matches the candidate with numeric 12 and 5. `{ ...candidate, ...label }` lets the label's string value win, and `file`, `line`, `column` and `model` are all in `COMMITTED_KEYS`. The committed file can then hold string line numbers and break downstream consumers. Today the committed file has 0 such cases, but nothing prevents it. A null label element also throws a TypeError in `validateLabels` (`label.file`) instead of reporting a validation error.
**Fix:** In `validateLabels`, require `Number.isInteger(label.line)` and `Number.isInteger(label.column)` and `typeof label.file === 'string'`, and reject null or non-object labels. In the merge, take the identity fields from the candidate: `{ ...label, ...candidate }`.

### WR-03: The notes leak guard only matches the exact full source line

**File:** `scripts/ai-app-helpers.mjs:356-359`
**Issue:** The "no code text in committed JSON" guard is `notes.includes(line.trim())` against the single matched line. Notes that quote part of the line, quote a neighbouring context line, or quote a URL or token near the model ID pass. The labels are committed publicly and come from agents that read arbitrary third-party code, so this is the only barrier against leaking code or secrets. `contextLines` also holds only `context.line`, not `before` or `after`. The check on committed notes only tested a few patterns (no `sk-`, `key` or `secret` hits in the 591 notes that I spot-checked), so no leak is present now.
**Fix:** Also reject notes containing a long substring of any context line. A cheap version is any 12-character window of the matched line or its neighbours. Add a deny pattern for secret-like strings (`/sk-[A-Za-z0-9]{10,}|AKIA|Bearer /`). Pass `before`, `after` and `line` into `validateLabels`.

### WR-04: Adjudication changes `live`, `via` and `reason` but leaves the first label's `notes`

**File:** `scripts/ai-app-labels.mjs:120-124`
**Issue:** After an adjudication, the committed label gets the new `live`, `via` and `reason`, but its `notes` still holds the first agent's justification. The label can therefore say "price table entry, never sent" while holding `live: true`. The adjudication `note` only goes into `reread.disagreements`. A reader of the labels file sees contradictory evidence. The second pass also has the second reader's `notes` in `secondById`, which is not used.
**Fix:** Set `label.notes = note` (already validated for length and newlines) when the adjudication changes the label. The merge only validates `note` in the adjudication, so validate it against the context line too.

### WR-05: The selector aborts on one bad repo and caches transient failures permanently

**File:** `scripts/ai-app-select.mjs:85-116,299,346-349,369-373`
**Issue:**
1. `gh()` retries any 403 or 429 or 5xx for up to 5 attempts with 60 to 960 second waits (about 31 minutes) before throwing. A permanent 403 (access blocked) therefore stalls for half an hour.
2. A 404, an empty repo (409) or a blocked repo (451) from the trees or contents calls throws out of `check()`. Nothing catches it, so the whole selection run crashes, and the rerun resumes at the same repo and crashes again.
3. `checkoutFailed` is returned for any `shallowCheckout` error (network blip, timeout) and `cached()` writes the verdict to disk. A transient error then permanently rejects the repo on every rerun.
4. An existing `<root>/<owner>__<name>/.git` is returned as is by `shallowCheckout` without checking that HEAD equals the frozen SHA. `findModelCall` in the selector can therefore scan a stale checkout. (The candidates script does check with `rev-parse`.)

**Fix:** Catch per-repo `gh` errors in `check` and return `{ verdict: 'unreachable' }`. Do not cache `checkoutFailed` (return it outside `cached`, or add a retry). Narrow the retry regex to rate-limit messages. Verify `rev-parse HEAD` in `shallowCheckout` when the directory already exists.

## Info

### IN-01: Checkout directory names can collide

**File:** `scripts/ai-app-helpers.mjs:149-151`
**Issue:** `repo.replace('/', '__')` maps `a__b/c` and `a/b__c` to the same directory, and the check cache key in `ai-app-select.mjs:370` has the same problem. The result is a wrong checkout reused for a different repo. It is unlikely, but names validate as legal.
**Fix:** Use a separator that validRepoName cannot produce (for example `owner@@name`), or reject `__` in names.

### IN-02: `modelPattern` builds a regex that matches empty quotes when the registry has no models for the provider

**File:** `scripts/ai-app-helpers.mjs:235-236`, `scripts/ai-app-label-candidates.mjs:96`
**Issue:** With zero ids the pattern becomes `(["'`])()\1`, which matches `""`. `pattern.byId.get('')` is then undefined and `.deadline` throws. This happens with a typo in `entry.provider` of a frozen list (the value is not validated against the two known providers).
**Fix:** Throw if `byId.size === 0`, and validate `entry.provider` against `openai` and `anthropic`.

### IN-03: The `|` delimiter is ambiguous in adjudication keys

**File:** `scripts/ai-app-helpers.mjs:396`, `scripts/ai-app-labels.mjs:30,104`
**Issue:** Disagreement keys join fields with `|`, and the merge turns them back with `replaceAll('|', '\u0000')`. A file path containing `|` makes the lookup fail and the script crashes on `brief(undefined)`. Adjudication entries whose key matches no disagreement are silently ignored. Rerunning `--reread-merge` with `--labels` equal to `--output` loses the earlier adjudications, because the first labels already hold the adjudicated values and there is nothing left to disagree on. The 4-slice reader text is also hardcoded instead of taken from the input.
**Fix:** Carry the real id alongside the display key, warn on unused adjudications, and refuse `--labels` equal to `--output`.

### IN-04: Selector heuristics worth a note in the docs

**File:** `scripts/ai-app-helpers.mjs:121-125,36`, `docs/BENCHMARKS.md:187`
**Issue:** The `openai` model-call regex also accepts `.messages.` (Anthropic style) calls. `EXCLUDED_NAME` is a substring test, so repos named `...clientele` or `...pluginless-app` are dropped. The docs list the name filter but not its substring behaviour, and mention "Phase 4 / BENCH-04", an internal planning reference, in a public doc. None of this changes the results here.
**Fix:** Optional. Add a short caveat or word-boundary the regex, and replace the internal phase reference with a plain description.

---

_Reviewed: 2026-10-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
