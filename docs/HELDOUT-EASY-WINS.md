# Held-out easy wins

**Status: plan, 2026-10-28. Nothing here is built.** Requested by Otabek (founder) on 2026-10-28, after the dependency-blocker lanes in `docs/DEPENDENCY-BLOCKERS.md` turned out to reach few held-out rows.

## Goal

Raise heldout-30 from 10 production-validated toward 17 with three generic fixes. Each is built and tuned on l2-push-249 only, and measured on heldout-30 once, at the end. A fix that only works because someone looked at a held-out repository makes the number meaningless.

## Where it starts

All-blockers census (`scripts/validation-funnel.mjs --all-blockers`, from `feat/dependency-blockers-census`) of heldout-30 run 40552360621 (main `93e73d7c`, with AI). 20 rows are not validated:

| Blocker                                              |   Rows | Only blocker |
| ---------------------------------------------------- | -----: | -----------: |
| contract-change                                      |     11 |            1 |
| untraced-reads                                       |     10 |            5 |
| stripe-upgrade-refused-other                         |      4 |            0 |
| conflicting-dependency-files                         |      3 |            0 |
| non-registry-source                                  |      2 |            0 |
| no-runnable-check                                    |      2 |            2 |
| no-lockfile, lockfile-out-of-sync                    | 1 each |         0, 1 |
| baseline-failed, removed-request-parameter, no-patch | 1 each |            0 |

In the five untraced-read-only rows and the one contract-change-only row, the patch already passes the repository's checks. Only Refit's own gate holds it back.

That run predates #361 (D4 schema equivalence) and #362. D4 already lists the `address` `optional_fields_address` subschema change as `renamed-subschema` (`docs/SCHEMA-EQUIVALENCE.md`). So the contract-change-only row may already pass on main, and lane 2 starts by checking that.

## Lanes

| Lane | Work                                                          | Expected on heldout-30 | Base                            |
| ---- | ------------------------------------------------------------- | ---------------------- | ------------------------------- |
| 1    | Untraced reads Refit can prove are not Stripe                 | up to +5               | origin/main                     |
| 2    | Contract-change gate: confirm D4, then the next generic shape | +1 to +2               | origin/main                     |
| 3    | Two disagreeing lockfiles, on top of lane A's resolver        | +1 to +3               | origin/feat/lockfile-resolution |

They touch different files: lane 1 touches `stripe-type-evidence.ts`, `operation-reach.ts` and `review.ts`; lane 2 touches `schema-equivalence.ts`, `openapi-diff.ts` and the rules; lane 3 touches `dependency-preparation.ts` and `lockfile-resolution.ts`. Merge in any order. Lane 3 merges after lane A.

## Shared rules for every lane

- Tune only on l2-push-249 and subsets of it. Never open, list or name a heldout-30 repository while building. Run heldout-30 once, at the end, as the measurement.
- Before runs at main `89f1c0ed` already exist on refit-dev/refit-bench (lane B of the dependency plan): l2-push-249 no AI 40624345477, AI 40624353088; heldout-30 no AI 40624360669, AI 40624369322. Reuse them while origin/main is still `89f1c0ed`, rather than queueing duplicates; the queue is long.
- No repository-specific code (D5). A wrong edit is worse than a stop.

## Prompts

### Lane 1: untraced reads

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md first and follow it. Then read docs/HELDOUT-EASY-WINS.md (git show origin/docs/heldout-easy-wins:docs/HELDOUT-EASY-WINS.md).

Goal: patches that pass their checks but stay [Needs review] only because of untraced reads (a `.price`, `.subscription`, `.features` or `.type` read Refit cannot prove is or is not a Stripe field) publish validated where Refit can prove the receiver is not a Stripe object. On heldout-30 this is the only blocker in 5 rows.

Founder request (Otabek, 2026-10-28): widen how untraced reads are cleared where the proof is deterministic. Record it in AGENTS.md as a founder decision with your evidence. Today: owner decision (2026-10-21) counts untraced reads as unresolved; D2b (pipeline/stripe-type-evidence.ts, localReceiverReads) clears one only with AI on, where the type oracle passed and TypeScript resolves the receiver to a type the repository declares; "the AI's word alone never clears a stop" stays.

1. Branch feat/untraced-read-proof from origin/main in its own worktree; npm ci.
2. Count first. From the l2-push-249 runs 40624345477 (no AI) and 40624353088 (AI) on refit-dev/refit-bench (main 89f1c0ed; gh run download), list every row whose only blocker is untraced reads, and every read in them with its receiver's origin. Group by shape, for example: a property of a typed repository interface or class; a local object literal or exported const config (pricing plans); an imported JSON file; a database or ORM row (Prisma, Supabase, Drizzle generated types); a value in a JavaScript file with no types; any. Rank shapes by rows.
3. Fix the top shapes generically, each with a proof:
   - Run localReceiverReads without AI: a read whose receiver TypeScript resolves to a repository-declared type, never Stripe, any, unresolved or node_modules, stops counting even when AI is off.
   - Data flow: a receiver whose every assignment traces to a local object literal, a const config, an imported JSON file or a generated ORM type is not a Stripe object.
   - A read stays untraced if any path could carry a Stripe object, if the receiver is any or unresolved, or if the property is also read on a traced Stripe object in the same function.
4. Tests for each shape, including the cases that must still stop (a Stripe object passed through a helper, a union with a Stripe type, an any receiver).
5. Evidence on refit-bench (benchmark.yml, full pushed SHA): l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) without AI and with -f ai=true -f ai_budget=200, after; compare with the before runs above using scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then run heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30), without AI and with -f ai=true -f ai_budget=30, and compare with 40624360669 and 40624369322. AI spend is authorized up to those caps.
6. Update docs/BENCHMARKS.md (run ids, commits, commands), docs/READINESS.md and AGENTS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one draft PR to main as soon as the code and tests are in, with the benchmark section marked pending; fill it in and mark it ready when the runs finish. Never merge, never push to main. Never pass a key in a workflow input. Never tune on heldout-30.

Subagents that help: one to download the l2 artifacts and classify every untraced read by receiver origin; one per shape you fix; one to review newly validated patches.

Don't ask me questions; pick the best option, write down why, and keep going.
```

### Lane 2: contract-change gate

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md and docs/SCHEMA-EQUIVALENCE.md first and follow them. Then read docs/HELDOUT-EASY-WINS.md (git show origin/docs/heldout-easy-wins:docs/HELDOUT-EASY-WINS.md).

Goal: patches that pass their checks but are held at [Needs review] by the contract-changes gate ("Traced code reaches breaking changes in the target contract that no Refit rule migrates") publish validated where the change provably does not break the code, or get a rule where it does.

Today: D4 (#361, pipeline/schema-equivalence.ts) marks an oasdiff change compatible when both schemas accept the same values. It already lists POST /v1/customers `address` "removed subschema #1: optional_fields_address" as renamed-subschema. Heldout-30 run 40552360621 predates #361 and still showed that change blocking a customers.update (POST /v1/customers/{customer}) call.

1. Branch feat/contract-gate-shapes from origin/main in its own worktree; npm ci.
2. Confirm D4 first. In the l2-push-249 runs at main 89f1c0ed (40624345477 no AI, 40624353088 AI on refit-dev/refit-bench), find every row the contract-changes gate still holds and list each blocking change from the draft (pull-request.md) and report.json. If the address change still blocks anywhere, find why (another operation, a $ref the walk does not resolve, the node limit) and fix it generically, with a test.
3. Rank the remaining blocking changes by rows. For the top one or two, either prove them compatible for the way the traced code uses them (as D4 does, generic for any OpenAPI provider) or add a deterministic rule with Stripe's documented replacement, cited with a URL and read date (for example a removed enum value or an API path removed without deprecation). New automatic edits need a rule that passes every existing gate (D1); never guess a replacement Stripe does not document.
4. Tests, including changes that must still block.
5. Evidence on refit-bench (benchmark.yml, full pushed SHA): l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) after, compared with 40624345477 using scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then run heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30) and compare with 40624360669.
6. Update docs/SCHEMA-EQUIVALENCE.md, docs/BENCHMARKS.md (run ids, commits, commands), docs/READINESS.md, and AGENTS.md for any new rule or equivalence class (as a founder decision, Otabek, 2026-10-28, with your evidence). Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one draft PR to main as soon as the code and tests are in, with the benchmark section marked pending; fill it in and mark it ready when the runs finish. Never merge, never push to main. Never pass a key in a workflow input. Never tune on heldout-30.

Subagents that help: one to collect every blocking contract change from the l2 artifacts; one to read Stripe's changelog and API reference for each top shape; one to review newly validated patches.

Don't ask me questions; pick the best option, write down why, and keep going.
```

### Lane 3: two disagreeing lockfiles

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md, docs/DEPENDENCIES.md and docs/PREPARATION-FAILURES.md first and follow them. Then read docs/HELDOUT-EASY-WINS.md (git show origin/docs/heldout-easy-wins:docs/HELDOUT-EASY-WINS.md) and docs/DEPENDENCY-BLOCKERS.md (git show origin/docs/dependency-blockers:docs/DEPENDENCY-BLOCKERS.md).

Goal: repositories that commit two lockfiles (for example package-lock.json and yarn.lock or pnpm-lock.yaml) and today stop with "Tracked node_modules, conflicting lockfiles, shrinkwrap or pnpm hooks" (conflicting-dependency-files in pipeline/preparation-stops.ts) get their dependencies prepared and their patch validated, and the stripe-node upgrade stops refusing on them.

Founders' decision (2026-10-27, docs/DEPENDENCY-BLOCKERS.md): a networked lockfile-resolution step separate from offline validation is allowed. Lane A of that plan built it on feat/lockfile-resolution (pipeline/lockfile-resolution.ts, flag --resolve-lockfiles, env REFIT_LOCKFILE_RESOLUTION); its PR is not merged yet. Build on its branch and keep your diff separate.

1. Branch feat/conflicting-lockfiles from origin/feat/lockfile-resolution in its own worktree; npm ci.
2. Count first. From the l2-push-249 runs at main 89f1c0ed (40624345477 no AI on refit-dev/refit-bench), list every row stopped by conflicting lockfiles, with which files it commits, which package manager its packageManager field, CI config and scripts point to, and whether the lockfiles agree on stripe's version.
3. Pick one lockfile by a documented rule: the packageManager field; else the lockfile the repository's CI installs with; else the newest by last commit that matches package.json. Prepare from that one, ignore the others for installation, and say which one and why in the draft. Where no rule picks one, keep stopping. Tracked node_modules, shrinkwrap and pnpm hooks keep stopping.
4. Make the stripe-node upgrade edit the chosen lockfile, and leave the others unchanged with a line in the draft that names them; or, if the upgrade would leave the repository with lockfiles that disagree on stripe, keep the patch [Needs review] and say so. Lane A's peer bump (@types/node) applies unchanged.
5. Confirm lane A covers a lone out-of-sync npm lockfile (its scope); add a test if one is missing, nothing more.
6. Tests with recorded fixtures, byte-exact and listed in .prettierignore.
7. Evidence on refit-bench (benchmark.yml, full pushed SHA, -f flags=--resolve-lockfiles): a subset of the rows this reaches chosen by rule (commit it under docs/benchmarks/subsets/), and l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249), compared with 40624345477 and with lane A's own after run using scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost. Only then run heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30, same flag) and compare with 40624360669.
8. Update docs/DEPENDENCIES.md, docs/PREPARATION-FAILURES.md, docs/BENCHMARKS.md (run ids, commits, commands), docs/READINESS.md and AGENTS.md (as a founder decision, Otabek, 2026-10-28, with your evidence). Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one draft PR to main as soon as the code and tests are in, based on main with lane A's commits included and a note that it merges after lane A; fill in the benchmark section and mark it ready when the runs finish. Never merge, never push to main. Never pass a key in a workflow input. Never tune on heldout-30.

Subagents that help: one to classify the conflicting-lockfile rows from the artifacts; one for fixtures and tests; one to review newly validated patches.

Don't ask me questions; pick the best option, write down why, and keep going.
```

## Open decisions

- Lane 1 clears untraced reads without AI. That widens D2b, which says not to widen without a new decision; a founder signs it off with the lane's evidence.
- Lane 3 validates against one of two committed lockfiles. A founder confirms the selection rule.
- The two rows with no runnable check can only validate if Refit writes a check for them, which needs its own decision. Not planned here.
