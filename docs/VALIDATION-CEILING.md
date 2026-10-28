# Validation ceiling

**Status: plan, 2026-10-28. Nothing here is built.** Requested by Otabek (founder) on 2026-10-28.

## Goal

When Refit runs on the fresh, unseen 30 (`docs/STRIPE-TEST-MODE.md`, "Final measurement"), the report should say "validated X of the Y that can be validated", and the gap between X and Y should be zero or named. Agent 1 defines Y and finds the failure reasons no lane covers. Agents 2 to 5 close the known gaps.

| Agent | Work                                                                                            | Starts                                  |
| ----- | ----------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1     | Ceiling audit: classify every unvalidated row, and a classifier for any run                     | now; reads runs only                    |
| 2     | Runtime stand-ins: Prisma client, env vars, auth and database, so code reaches its Stripe lines | now                                     |
| 3     | Documented-replacement rules: finish and measure PR #357                                        | now                                     |
| 4     | Upgrade fallout: AI behaviour fixes for stripe-node 23 errors, proven by lane T                 | diagnose now, build after lane T merges |
| 5     | Webhooks: signed test events for both versions, sent to the handler                             | now                                     |

Shared rules, as in the other plans:

- Tune on l2-push-249 only, and never on heldout-30 or the fresh 30.
- Reuse the before runs at main `89f1c0ed`: l2-push-249 no AI 40624345477 and AI 40624353088; heldout-30 no AI 40624360669 and AI 40624369322.
- No repository-specific code (D5).
- Open a draft PR as soon as the code and tests are in.
- Never merge or push to main.
- Customers do nothing beyond installing Refit and approving PRs.

## Prompts

### Agent 1: ceiling audit

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md first and follow it. Then read docs/VALIDATION-CEILING.md, docs/STRIPE-TEST-MODE.md and docs/HELDOUT-EASY-WINS.md (git show origin/docs/heldout-easy-wins:docs/<name>), and docs/DEPENDENCY-BLOCKERS.md (git show origin/docs/dependency-blockers:docs/DEPENDENCY-BLOCKERS.md).

Goal: for any benchmark run, Refit can say how many rows could be validated at all, and why each other row cannot. The fresh-30 final measurement must report "validated X of Y validatable" with every gap named.

1. Branch feat/validation-ceiling from origin/main in its own worktree; npm ci. Start from scripts/validation-funnel.mjs --all-blockers on feat/dependency-blockers-census (merge or cherry-pick it if that PR has not merged; keep your diff separate).
2. For every unvalidated row in l2-push-249 runs 40624345477 and 40624353088 and heldout-30 runs 40624360669 and 40624369322 on refit-dev/refit-bench (gh run download), record every blocker. Read each row's report and draft where results.json is not enough.
3. Classify each blocker with a written rule:
   - fixable, and by which lane: name the lane from the plans above, or "none".
   - not validatable: only these four reasons. No code path can run without the customer's own secrets or services; there is no check of any kind and none can be generated; Stripe documents no replacement for the removed behaviour; the change needs a product decision only a person can make.
   Each "not validatable" row needs its evidence quoted. When unsure, mark it fixable with lane "none". The ceiling must never hide a Refit gap.
4. Commit scripts/validation-ceiling.mjs, which classifies any run directory the same way (tests with recorded fixtures), and docs/benchmarks/2026-10-28-validation-ceiling.json with the per-row result. Add a table to docs/VALIDATION-CEILING.md, for each set: validated, validatable, not validatable by reason, and fixable by lane, with "none" broken down by cause.
5. The "none" rows are the deliverable: rank their causes and write, for each of the top causes, one paragraph a founder can turn into the next lane.
6. Make the fresh-30 prompt in docs/STRIPE-TEST-MODE.md call scripts/validation-ceiling.mjs, on your branch.
7. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one draft PR to main. Never merge, never push to main. Do not dispatch benchmark runs; this agent only reads existing runs.

Subagents that help: one per set to download and tag rows; one to write the classifier and its tests; one to challenge every "not validatable" call.

Don't ask me questions; pick the best option, write down why, and keep going.
```

### Agent 2: runtime stand-ins

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md, docs/DEPENDENCIES.md and docs/PREPARATION-FAILURES.md first and follow them. Then read docs/VALIDATION-CEILING.md and docs/STRIPE-TEST-MODE.md (git show origin/docs/heldout-easy-wins:docs/<name>).

Goal: application code reaches its Stripe lines inside validation even when it needs a generated database client, environment variables, a logged-in user or a database, so the repository's checks and lane T's behaviour tests can prove the patch. The customer provides nothing.

Today: 49 l2 baselines fail because the Prisma client is never generated, and the owners removed the generators fix on 2026-10-22 (AGENTS.md). Code that reads process.env, a session or a database before calling Stripe never reaches the call in a test.

1. Branch feat/runtime-stand-ins from origin/main in its own worktree; npm ci.
2. Count first, from l2-push-249 runs 40624345477 and 40624353088 on refit-dev/refit-bench: for each row whose baseline fails or whose Stripe lines no check reaches, record what stops it (Prisma or another generated client, a missing env var, auth, a database call, a network call, other). Rank by rows.
3. Prisma and generated clients: build generation (prisma generate and its equivalents, offline, from the committed schema and the prepared node_modules) behind a flag, off by default, because it reverses the 2026-10-22 owner decision. Write the before/after evidence and a one-paragraph decision request in the PR for a founder to sign off.
4. Stand-ins, generic and never repository-specific (D5): env vars the code reads get placeholder values (never real secrets, never a key format a provider would accept as live); a session or auth helper gets a stand-in user; a database call gets an in-memory or stubbed client with the shape the code uses. Use them only in Refit's checks and behaviour tests, never in the patch. A check that passes only because a stand-in hides the Stripe call proves nothing: the stand-ins must not touch Stripe code paths.
5. Tests, including that a stand-in never replaces a Stripe client and that a repository's own failing test still fails.
6. Evidence on refit-bench (benchmark.yml, full pushed SHA, your flags): l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249), compared with 40624345477 using scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30), compared with 40624360669.
7. Update docs/DEPENDENCIES.md, docs/PREPARATION-FAILURES.md, docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one draft PR to main as soon as the code and tests are in; fill in the evidence and mark it ready when the runs finish. Never merge, never push to main. Never pass a key in a workflow input. Never tune on heldout-30.

Subagents that help: one to classify what stops each row; one for generated clients; one for stand-ins and their tests; one to review newly validated patches.

Don't ask me questions; pick the best option, write down why, and keep going.
```

### Agent 3: documented-replacement rules

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md first and follow it. Then read docs/VALIDATION-CEILING.md (git show origin/docs/heldout-easy-wins:docs/VALIDATION-CEILING.md).

Goal: Stripe removals with a documented replacement get a deterministic rule, so they stop blocking at the contract-changes gate. PR #357 (feat/stripe-generated-rules, "generate Stripe rules from docs and pinned contracts (D3, D5)") is open and unmerged. Finish and measure it rather than starting over.

1. Check out feat/stripe-generated-rules in its own worktree, rebase it on origin/main, and resolve conflicts; npm ci. Read #357's description and every comment on it, and finish what it lists as left.
2. Count, from l2-push-249 runs 40624345477 and 40624353088 on refit-dev/refit-bench: every change the contract-changes gate still holds, with Stripe's documented replacement (URL and read date) or "none documented". Rank by rows. Make sure the generator covers the top shapes, for example a removed enum value with a documented successor or an API path removed with a documented replacement call.
3. A rule edits only where Stripe documents the replacement and every existing gate passes (D1). Never guess a replacement. Where the replacement changes behaviour, the draft says what to check.
4. Tests for each generated rule shape, including what must still stop.
5. Evidence on refit-bench (benchmark.yml, full pushed SHA): l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249), compared with 40624345477 using scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30), compared with 40624360669.
6. Update #357's docs, docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push to the same branch and update #357's description; keep it draft until the evidence is in. Never merge, never push to main. Never pass a key in a workflow input. Never tune on heldout-30.

Subagents that help: one to list blocking changes and their documented replacements; one per rule shape; one to review newly validated patches.

Don't ask me questions; pick the best option, write down why, and keep going.
```

### Agent 4: upgrade fallout

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md and docs/AI-PATCH-GUARD.md first and follow them. Then read docs/VALIDATION-CEILING.md and docs/STRIPE-TEST-MODE.md (git show origin/docs/heldout-easy-wins:docs/<name>).

Goal: when the stripe-node upgrade introduces type errors in application code that need a real behaviour change (a removed field, changed arguments, a widened null), the AI writes that change and Stripe's test mode (lane T) proves it, so these rows stop failing as regressions. Lane B (claude/stripe-type-repair-gate-6ad48e) handles only type-only repairs; do not duplicate it.

1. Branch feat/upgrade-fallout from origin/main in its own worktree; npm ci.
2. Diagnose now: from l2-push-249 runs 40624345477 and 40624353088 on refit-dev/refit-bench, list every introduced type error the type oracle records (validation.typeOracle), grouped by shape, and mark which lane B's type-only repair covers. Rank the rest by rows. For each top shape, find Stripe's documented replacement (URL and read date).
3. Build only after lane T (feat/stripe-test-mode) has merged to main. Until then, write the design and the tests, push, open a draft PR, and stop.
4. Once lane T is on main: AI repairs for the top shapes. Each repair touches only statements with an introduced error and follows the documented replacement. It counts as validated only when the type oracle shows zero new errors, the repository's checks pass and lane T's behaviour tests reach every changed line with Stripe accepting both sides (grade A). Otherwise it ships [Needs review] (decision 8).
5. Tests, including a repair that changes behaviour without Stripe's proof (must stay [Needs review]).
6. Evidence on refit-bench (benchmark.yml, full pushed SHA, lane T's flags, -f ai=true -f ai_budget=200): l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249), compared with 40624353088 using scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30, -f ai_budget=30), compared with 40624369322. AI spend is authorized up to those caps.
7. Update docs/AI-PATCH-GUARD.md, docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Never merge, never push to main. Never pass a key in a workflow input. Never tune on heldout-30.

Subagents that help: one to group the introduced errors; one to read Stripe's docs for each shape; one to review patches.

Don't ask me questions; pick the best option, write down why, and keep going.
```

### Agent 5: webhooks

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md first and follow it, especially the webhook decisions (pipeline/stripe-subscription-periods.ts, the incoming-version gate). Then read docs/VALIDATION-CEILING.md and docs/STRIPE-TEST-MODE.md (git show origin/docs/heldout-easy-wins:docs/<name>).

Goal: webhook handlers that changed in a patch are exercised. Refit builds Stripe event payloads for both API versions from each version's spec and fixtures, signs them with a secret it generates for the run, and sends them to the handler on the original code and on the patched code, offline. The handler must behave the same way on events of either version. The customer provides nothing.

1. Branch feat/webhook-checks from origin/main in its own worktree; npm ci.
2. Count first, from l2-push-249 runs 40624345477 and 40624353088 on refit-dev/refit-bench: rows where a changed line sits in a webhook handler that no check reached, and rows held by the incoming-webhook-version gate. Rank by rows.
3. Build it provider-neutral, as lane T's pipeline/provider-sandbox.ts is: a generic signed-event harness with a Stripe adapter. Find the handler from the existing webhook detection (webhookHandlers in results), substitute the run's signing secret for the one the code reads (an env var stand-in, never a real secret), send events of the types the handler switches on, and record the response and what the handler called. Generate payloads from the pinned spec and fixtures for each version. No network.
4. What counts: a handler that completes on both versions' events on the patched code, and completed on the original, covers its changed lines. That evidence can raise the grade only as far as docs/STRIPE-TEST-MODE.md allows for offline evidence; it never alone grants grade A. It can clear the incoming-version gate only where AGENTS.md's webhook decisions allow; record any widening as a founder decision (Otabek, 2026-10-28) with evidence.
5. Tests: signature construction, a handler that breaks on the new version (must fail), and one that never reaches Stripe code.
6. Evidence on refit-bench (benchmark.yml, full pushed SHA, your flag): l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249), compared with 40624345477 using scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30), compared with 40624360669.
7. Update docs/GENERATED-CHECKS.md, docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one draft PR to main as soon as the code and tests are in; fill in the evidence and mark it ready when the runs finish. Never merge, never push to main. Never pass a key in a workflow input. Never tune on heldout-30.

Subagents that help: one to count webhook rows; one for the signed-event harness and payload generation; one to review newly validated patches.

Don't ask me questions; pick the best option, write down why, and keep going.
```
