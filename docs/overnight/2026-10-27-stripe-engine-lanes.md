# Stripe engine lanes: handover (2026-10-27, stopped ~17:20Z)

Every lane was stopped mid-task when the owner ran out of usage. Each branch is pushed to origin and cut from main 5ba25c1e. No lane PR is open. Rules, decisions and benchmark commands are in the "Common brief" section below.

| Lane                   | Branch                                         | Pushed commit  | State                                                                                                                                                                                                                                                                                                         | Next step                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type oracle            | feat/stripe-type-oracle                        | ae35993b       | Built; the first no-AI run at b4b3c7c changed no outcome (4 changes moved to `reached`). Typecheck and its 10 tests pass. 4 tests fail locally in validation-untested (Docker), hosted-runner and npm-dependencies; not yet compared with main.                                                               | Read runs at e8f52e9 (l2 no-AI 40545715035, heldout no-AI 40545721985, heldout AI 40545751982, l2 AI 40545759381) against the baselines; fix reviews, READINESS/BENCHMARKS, benchmark-claims, open the PR.                                                                                                  |
| AI patch on stops (D2) | feat/ai-patch-on-stops (stacked on the oracle) | 6283cf61 (wip) | Traced-sites check, D2 check and coverage-context fitting are done. Stopped while rewriting the check for D2a/D2b; 6283cf61 holds that partial edit.                                                                                                                                                          | Implement D2a/D2b (below), record D1/D2/D2a/D2b in AGENTS.md, rebase on the oracle head, dispatch AI l2 ($200) and heldout ($30), hand-review every validated publish, open the PR. First AI runs at 48396177: l2 40547630923, heldout 40547636996; no-AI at 14b8c01e: l2 40545177251, heldout 40545182208. |
| Spec-noise filter (D4) | feat/spec-noise-filter                         | 3b5cb244 (wip) | pipeline/schema-equivalence.ts, wired into the contract diff and reach. Offline estimate on l2: clears 24 address and 167 currency/unix-time changes. Touched suites pass; 7 full-suite failures not yet looked at.                                                                                           | Fix the 7 failures, write docs (D4 in AGENTS.md, READINESS), confirm Stripe's monthly-release compatibility claim from a page read, run before/after, review diffs, open the PR.                                                                                                                            |
| Response-read tracing  | feat/response-read-tracing                     | c201d302 (wip) | oasdiff `items` segment fix (unnamed objects); array element/copy methods, local helper returns and parameters traced; writes and metadata reads not counted as reads. Most untraced receivers are not Stripe objects (DB rows, request bodies).                                                              | Read the local before/after untraced-read diff, add tests, prettier, run benchmarks, open the PR.                                                                                                                                                                                                           |
| API-version tracing    | feat/api-version-tracing                       | 4b5df449 (wip) | Triage done: `api-version-untraced` comes from client escape analysis (unsafe helpers, unmodelled imports, ambiguous `@/` imports, lazy getters), not from version values. Webhook-version rows (8) create no endpoint in code; their real blocker is untraced webhook reads. Helpers added but not used yet. | Use the helpers in pipeline/analyzer.ts so a client counts as untraced only when it reaches code Refit can't see; test; record failed pin-move errors on api-version-kept drafts; run benchmarks; open the PR.                                                                                              |
| Dependency preparation | feat/preparation-failures                      | 06f1305f (wip) | Triage of the untested l2 rows (docs commit df5726c2). Fixes: sha1 beside strong integrity, extraneous directory records, trailing workspace negations, a pnpm workspace bin no importer links to; pnpm 7 lockfiles named in their stop.                                                                      | Remove the scratch file `.probe/probe.ts` the wip commit picked up, read runs 40545239097, 40545244312, 40545292489, 40545300705, review newly validated diffs, open the PR.                                                                                                                                |

## Owner decisions to record (AI lane)

- D1: automatic Stripe edits are allowed again (supersedes the 2026-10-22 "no new automatic Stripe edits" decision) when they come from a generated rule or an AI patch that passes every gate.
- D2: an AI patch publishes as validated only if the target stripe SDK is installed, `tsc --noEmit` shows zero new errors versus baseline, the repo's own tests pass offline, and the diff touches only traced Stripe sites; otherwise [Needs review].
- D2a: a passing type check may stand in for the repo's own tests only when the change is type-visible (a removed or renamed field, a changed type, or a removed enum value; never a behavioural change), every touched site is in a typed TS file the oracle checked, and the oracle shows zero new errors. The draft is labelled "validated by type check, no tests".
- D2b: an AI "no change needed" answer clears a stop only for untraced reads, and only where the type oracle confirms the object read is not a Stripe type. The AI's word alone never clears a stop.

## Baselines (refit-bench, main 5ba25c1e)

- l2-push-249 no-AI 40448715209; heldout-30 no-AI 40448718890.
- l2-push-249 AI $200 40470122759: shard 2 (offset 50) was lost to a runner shutdown and was rerun as 40544895386.
- heldout-30 AI $30 40470125581.

## Common brief (given to every lane)

Repository: Refit (TypeScript). You work in your own git worktree (already created for you) on a new branch named in your task, cut from main 5ba25c1ed3a4e2feaef700b97b6402fffc6b7422. Run `npm ci` first.

Read first: AGENTS.md, docs/READINESS.md, docs/ARCHITECTURE.md, docs/AI-PATCH-GUARD.md, docs/FIX-REVIEW.md, and the code your lane touches with its tests. Extend existing modules; never duplicate a helper.

Owner decisions tonight (Pierce, 2026-10-27):

- D1: automatic Stripe edits are allowed again (supersedes 2026-10-22 "no new automatic Stripe edits") when they come from a generated rule or an AI patch that passes every gate.
- D2: AI may propose the patch for any reached Stripe change. It publishes as a validated draft only if: the new stripe SDK is installed in the isolated workspace; `tsc --noEmit` passes with zero new errors versus baseline; the repo's own tests pass offline; the diff touches only Stripe call sites Refit traced. Otherwise [Needs review]. Never auto-merge.
- D4: a change whose old and new schemas are structurally identical (renamed subschema with the same shape; format-only annotation such as `format: currency` on a string) is not breaking. Generic for any OpenAPI provider; record each filtered class with evidence.
- D5: no repository-specific code anywhere (never branch on a repo name, path or fixture from the benchmark).

Hard rules:

- Zero wrong patches is the hard bar. Over-stopping beats a wrong edit.
- Stay out of the docs-rules session's files: pipeline/stripe-field-moves.ts, pipeline/stripe-request-moves.ts, pipeline/request-removals.ts (and docs it owns for D3/D5).
- Never touch Fly, AWS or Supabase.
- Conventional commits. NO Co-Authored-By trailer. PR body: a few bullets (what, why, how tested, benchmark run ids and numbers), no "Generated with" line. Push your branch and open a PR against main in pierceluu10/Refit (`gh pr create`). Never merge.
- Actions never start on pierceluu10/Refit: run locally `npm test`, `npm run typecheck` (or the repo's typecheck script), and prettier check (`npx prettier --check` on touched files). Report what actually passed.
- Update docs/READINESS.md (dated checkpoint) and the relevant guide for any change in supported behavior; record benchmark outcomes in docs/BENCHMARKS.md with run id, commit, command. `node scripts/benchmark-claims.mjs` must not gain problems (compare with main).

Benchmarks (only on refit-dev/refit-bench GitHub Actions, checkout ~/Repos/refit-bench):

- Push your branch first; dispatch with the full 40-char SHA of a pushed commit.
- l2-push-249: `gh workflow run benchmark.yml -R refit-dev/refit-bench -f commit=<sha> -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249`
- heldout-30: `... -f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30`
- AI: add `-f ai=true -f ai_budget=<USD>` (pre-authorized, up to 1000; use l2 $200, heldout $30 to match the baselines).
- Baselines at main: l2 no-AI 40448715209, heldout no-AI 40448718890, l2 AI 40470122759, heldout AI 40470125581 (the AI ones were dispatched 07:56Z on 2026-10-27; wait for them).
- Get results: `gh run download <id> -R refit-dev/refit-bench`, merge with `jq -s add shard-*/run/results.json`. Compare with `scripts/stripe-benchmark-compare.mjs`.
- A full l2 run takes ~2h20m. Wait with a background `gh run watch <id> -R refit-dev/refit-bench --exit-status` (run_in_background), never foreground sleep.
- Run no-AI before/after for every lane; AI before/after too where your change can affect AI outcomes (the AI baselines exist, so only the after run is new).
- The OSS benchmark list (branch feat/oss-stripe-benchmark, session oss-benchmark) may land later; if its frozen list is on main/pushed by the time you measure, run it too, otherwise say it was not available.
- Read every diff that changes between before and after; record verdicts in docs/benchmarks/fix-reviews.json (format in docs/FIX-REVIEW.md) for every newly published or changed patch. Any `wrong` verdict means fix the code before opening the PR.

Done = PR open. Final message (first 400 chars matter): PR URL, before/after run ids, the numbers (validated, stops by blocker, rows changed), fix-review verdicts, what still stops and why. Also append the same summary to stripe-engine-lanes.md in the shared notes folder: /Users/pierceluu/Library/Application Support/Claude/side-session-notes/local_f93408fa-9782-463b-a83b-93535d9e155d

## Update (coordinator, 2026-10-27 ~08:10Z)

- PRs are merged into main as they land; the bar is good results, not a finished PR.
- When your PR is ready, end your turn with a report holding: PR URL, before/after numbers on l2-push-249 and heldout-30 (no-AI and AI) with run ids, fix-review verdicts, local npm test/typecheck/prettier results. The stripe-engine session relays it to the coordinator, who merges. Never merge yourself.
- After any merge to main, sync your branch with main (`git fetch && git merge origin/main`, no force-push of shared history).
- Don't stop on flat numbers: dig into the rows and iterate. Zero wrong patches stays the hard bar.
- Spend real AI budget on the 81-row measurement.

## Update (stripe-engine, 2026-10-27 16:55Z)

- Every lane agent died at ~08:2xZ on an expired-auth error and is being resumed now. Check your worktree and `git status`, commit WIP, carry on.
- l2 AI baseline 40470122759: shard 2 (offset 50, 25 repos) was killed by a runner shutdown and the merge job failed. Use the shard artifacts of the other 9 shards, plus rerun 40544895386 (same commit, offset=50 count=25 ai=true $20) for that slice.
- heldout AI baseline 40470125581 succeeded.
