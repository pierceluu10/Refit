# Dependency blockers

**Status: plan, 2026-10-27. Nothing here is built.** The founders agreed on 2026-10-27 that Refit must get past the dependency problems below so more Stripe fixes are tested and validated. Each lane records that decision in `AGENTS.md` together with its own before and after evidence, as every earlier owner decision did.

## Goal

Every affected Stripe repository whose only blocker is a dependency problem gets a tested fix, and no patch is wrong.

- **Score:** production validated rises on `subsets/l2-push-249.json` and `subsets/heldout-30.json`, measured before and after each lane on refit-bench.
- **Correctness:** every newly validated patch is read in full and labelled in [`fix-reviews.json`](benchmarks/fix-reviews.json); none is `wrong`.
- **The problems shrink:** fewer untested drafts caused by lockfiles, and fewer patches whose stripe-node upgrade adds type errors.
- **Honest final number:** the night set ([`2026-10-24-stripe-night-repos.json`](benchmarks/2026-10-24-stripe-night-repos.json), 104 repositories, frozen and unopened) is run once, after every lane has merged.

## Where it starts

These counts come from different runs and sets and overlap. Lane 0 replaces them with one census of main.

| Problem                                                                   | Count       | Source                                                                                                     |
| ------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| No lockfile, so the draft ships untested                                  | 17          | [push-279 status](push-279/STATUS.md)                                                                      |
| Lockfile out of sync with `package.json`                                  | 8           | push-279 status                                                                                            |
| Lockfile without integrity hashes                                         | 3           | push-279 status                                                                                            |
| Committed source over the 50 MiB validation archive                       | 6           | [push-279 results](push-279/RESULTS.md)                                                                    |
| Patch whose stripe-node upgrade adds type errors                          | 12 of 146   | [Type oracle](BENCHMARKS.md#type-oracle-october-27), l2-push-249                                           |
| stripe-node upgrade refused for an optional peer (`@types/node` below 20) | not counted | `peerConflicts` in `pipeline/stripe-package-upgrade.ts`                                                    |
| Untraced API version                                                      | 16          | [BENCHMARKS.md](BENCHMARKS.md#api-versions-untraced-only-where-the-client-escapes-october-27), l2-push-249 |
| Baseline fails because the Prisma client is never generated               | 49          | [Preparation failures](PREPARATION-FAILURES.md), October 22                                                |

`@types/node` 20 depends on `undici-types ~6.21.0` (https://registry.npmjs.org/@types/node/20.19.0, read 2026-10-27), so raising it changes a second package. The upgrade refuses that today (`dependencyChanges`), which is why lane A does the peer bump and the lockfile resolver together.

## Lanes

Every lane starts from `origin/main` in its own worktree, as `AGENTS.md` says, and opens one PR. Merge in the order below; a later lane rebases on the earlier ones.

| Lane | Work                                                            | Main files                                                                                                | Can start          | Merge |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------ | ----- |
| 0    | Census of every blocker on main; raise the source archive limit | `scripts/validation-funnel.mjs`, `pipeline/validation.ts`                                                 | Now                | 1st   |
| A    | Lockfile resolver and types-only peer bump                      | `pipeline/stripe-package-upgrade.ts`, new `pipeline/lockfile-resolution.ts`, `pipeline/docker-sandbox.ts` | Now                | 2nd   |
| B    | Type-only repairs for errors the upgrade introduces             | `pipeline/stripe-type-evidence.ts`, `pipeline/stripe-open-enums.ts`, `pipeline/ai-patch-policies.ts`      | Now                | 3rd   |
| C    | Leftover `payment_method_types` rename gates                    | `pipeline/request-removals.ts`, `pipeline/request-migration.ts`, `pipeline/run.ts`                        | Now                | 4th   |
| D    | Product: validate in the customer's own environment             | `pipeline/dependency-preparation.ts`, `.refit.json` schema, onboarding docs                               | Now (design)       | 5th   |
| F    | Final measurement                                               | `docs/BENCHMARKS.md`, this page                                                                           | After A to D merge | —     |

Lanes A and D both touch `pipeline/docker-sandbox.ts` and `pipeline/dependency-preparation.ts`; D keeps to new files where it can and rebases on A. Lanes 0 and B may both touch `pipeline/validation.ts`; 0's change is one limit.

Not in any lane: running declared generators such as `prisma generate` before checks (49 baselines). It was built and removed on 2026-10-22 by owner decision, so it needs the founders to reverse that decision first.

## Prompts

Each prompt stands alone, so it can go to an agent that has not seen this page.

### Lane 0: blocker census and source limit

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md first and follow it.

Goal: one census of every blocker on today's main, so each dependency lane knows how many repositories it can unlock, then raise the committed-source archive limit.

Founders' decision (2026-10-27): Refit must get past dependency blockers so more fixes are tested and validated. Raising the source limit is part of it; record the decision in AGENTS.md with your evidence.

1. Branch feat/dependency-blockers-census from origin/main in its own worktree; run npm ci.
2. Baseline runs at the origin/main SHA on refit-dev/refit-bench (benchmark.yml, full pushed SHA). Reuse runs at that exact SHA if they already exist (gh run list -R refit-dev/refit-bench --workflow benchmark.yml).
   - l2-push-249: -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249
   - heldout-30: -f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30
   - Each set twice: without AI, and with -f ai=true and -f ai_budget=200 (l2-push-249) or 30 (heldout-30). AI spend is authorized up to those caps.
3. Download the artifacts (gh run download) and list every blocker on every affected row, not only the first one validation-funnel.mjs places it at. Extend scripts/validation-funnel.mjs (for example --all-blockers) rather than writing a new script. Categories at least: source over the archive limit; dependency tree too large; no lockfile; lockfile out of sync; lockfile without integrity; non-registry dependency; conflicting dependency files; unsupported lockfile or workspace; stripe-node upgrade refused for a peer (such as @types/node), for dependency changes, or other; new type errors after the upgrade (validation.typeOracle); failing baseline by cause (Prisma client not generated, next-env.d.ts missing, other); payment_method_types rename dropped, by the gate text Refit appends to the finding; payment_method_types set outside the creation call; untraced API version; contract-change stop; untraced reads; webhook version. Where a cause is not in results.json, read the row's report in the artifacts; where neither has it, say "not recorded" rather than guess.
4. Commit the per-row census as docs/benchmarks/2026-10-27-blocker-census.json and a table in docs/DEPENDENCY-BLOCKERS.md (create it if it is not on main): for each blocker, the rows that have it and the rows where it is the only blocker, per set. The "only blocker" column is what each lane can unlock.
5. Raise the committed-source limit (the "Committed source exceeds the N MiB validation archive limit" check in pipeline/validation.ts). Pick the new limit from the sizes of the rows it stops and the 4 GiB sandbox profile; keep a limit. Add a test. Before/after on the rows it reaches and on both sets; read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json.
6. Record every run id, commit and command in docs/BENCHMARKS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one PR to main; never merge, never push to main. Never pass a key in a workflow input.

Do not open or run the night set (docs/benchmarks/2026-10-24-stripe-night-repos.json); it is kept for the final measurement.

Subagents that help: one per set to download artifacts and tag rows; one to review newly validated patches.
```

### Lane A: lockfile resolver and types-only peer bump

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md, docs/DEPENDENCIES.md and docs/PREPARATION-FAILURES.md first and follow them.

Goal: drafts that ship untested because of the lockfile get tested, and the stripe-node upgrade stops refusing when only a types-only peer such as @types/node is too old.

Founders' decisions (2026-10-27), record both in AGENTS.md with your evidence:
- A networked lockfile-resolution step is allowed. It runs before, and separate from, the offline validation, which stays offline.
- Raising a types-only peer (an @types/* devDependency) together with stripe-node is allowed.

Today:
- With no lockfile, the upgrade edits package.json only and the patch is never validated (pipeline/stripe-package-upgrade.ts, the "commits no lockfile" warning).
- An out-of-sync lockfile or one without integrity hashes refuses preparation (pipeline/preparation-stops.ts, pipeline/dependency-preparation.ts).
- peerConflicts refuses with "upgrade it first" when an installed optional peer is outside the release's range (stripe 23.0.0 needs @types/node >=20).
- dependencyChanges refuses with "regenerate the lockfile instead".
- @types/node 20 depends on undici-types ~6.21.0 while 18 uses ~5.26 (registry.npmjs.org, read 2026-10-27), so the peer bump changes a second package and needs the resolver.
- Push-279 counts: no lockfile 17, out of sync 8, without integrity 3.

Build, behind a flag first:
1. pipeline/lockfile-resolution.ts: resolve a lockfile in its own container.
   - Lifecycle scripts off; no repository .npmrc, .env or credentials; registry pinned to https://registry.npmjs.org; no repository code runs.
   - Resolve as of the repository's last commit date (npm install --package-lock-only --before=<date>). For pnpm and Yarn 1, check their own docs for an equivalent; refuse where there is none.
   - Every resolved package must pass the existing registry and integrity checks; then the existing offline preparation installs it frozen.
   - Scope: no lockfile, out-of-sync lockfile, missing integrity. Git, local and private-registry dependencies keep their named stops.
   - A resolved lockfile is used to validate only. It is not added to the PR, and the draft says the checks ran against a lockfile Refit resolved, as of which date.
2. Peer bump in pipeline/stripe-package-upgrade.ts. When the only refusal is an @types/* devDependency outside stripe's optional peer range, raise it to the lowest version in range, using the resolver on the committed lockfile. Accept only if the lockfile diff touches nothing outside stripe, the raised peer and the packages only they reach. The type oracle must show no new errors. The draft names the bump.
3. Tests with recorded lockfile fixtures, kept byte-exact and listed in .prettierignore.
4. Evidence on refit-bench (benchmark.yml, full pushed SHA, -f flags=<your flag>):
   - A subset of the rows these changes can reach, chosen by rule from main's latest runs (as docs/benchmarks/subsets/l2-prep-3.json was).
   - l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) and heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30), before at origin/main and after.
   - Compare with scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost.
   - If no patch is wrong, make the flag the default in the same PR.
5. Update docs/DEPENDENCIES.md, docs/PREPARATION-FAILURES.md, docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one PR to main; never merge, never push to main. Never pass a key in a workflow input. No repository-specific code (owner decision D5).

Another lane (D) also edits pipeline/docker-sandbox.ts and pipeline/dependency-preparation.ts later; keep your changes there small and self-contained.

Subagents that help: one to read the npm, pnpm and Yarn 1 docs for script-free, date-limited lockfile resolution; one for fixtures and tests; one to review newly validated patches.
```

### Lane B: type-only repairs for errors the upgrade introduces

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md and docs/AI-PATCH-GUARD.md first and follow them.

Goal: patches whose stripe-node upgrade adds type errors in application code (for example stripe-node 23's widened enums, Price.Type and Interval gaining OtherString, assigned to narrower database types) get a repair that provably changes no runtime behaviour, so they stop failing as regressions.

Founders' decision (2026-10-27): type-only repairs of errors the stripe-node upgrade introduces are allowed. Record it in AGENTS.md with your evidence.

Today:
- The type oracle (pipeline/stripe-type-evidence.ts, validation.typeOracle) records the type errors the upgrade introduces on the original code. On l2-push-249 it compared 146 rows, and 12 had new type errors after the patch (docs/BENCHMARKS.md, "Type oracle").
- pipeline/stripe-open-enums.ts is the precedent: a deterministic type restore for Checkout trial_from_plan, kept only when every introduced error is a shape it handles and the checks then pass.
- The AI patch gate (D2) accepts AI edits only on traced Stripe call sites, so it cannot fix these errors in app code. AI patches ship as [Needs review] (decision 8).

Build:
1. A type-only gate in pipeline/ai-patch-policies.ts that any repair must pass:
   - It edits only statements that contain an error the oracle lists as introduced by the upgrade.
   - Every changed file compiles to identical JavaScript before and after (TypeScript's transpileModule with the repository's compiler options; compare the output per file). Enums, decorators and namespaces change the output, so the gate refuses them, as intended.
   - The oracle shows zero new errors on the repaired code, and the repository's checks pass.
2. A deterministic repair first, generic and not tied to any repository (owner decision D5): a Stripe type widened by the upgrade, assigned to a narrower type, gets a type assertion at that site. Extend stripe-open-enums.ts rather than adding a parallel mechanism. A deterministic repair that passes the gate may publish validated, like any rules' patch that passes its checks.
3. An AI fallback for introduced errors the deterministic repair does not cover, under the same gate. It ships [Needs review] with the AI lines marked (decision 8).
4. Tests: the gate refuses a runtime change dressed as a type fix; it accepts a pure assertion; deterministic and AI paths.
5. Evidence on refit-bench (benchmark.yml, full pushed SHA). Run l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) and heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30), before at origin/main and after, each without AI and with -f ai=true and -f ai_budget=200 (l2-push-249) or 30 (heldout-30). AI spend is authorized up to those caps. Compare with scripts/stripe-benchmark-compare.mjs. Read every newly validated or newly drafted migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost.
6. Update docs/AI-PATCH-GUARD.md, docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one PR to main; never merge, never push to main. Never pass a key in a workflow input.

Subagents that help: one to collect the 12 rows' introduced errors from the run artifacts and group them by shape; one for the transpile-equivalence gate and its tests; one to review patches.
```

### Lane C: leftover payment_method_types rename gates

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md and docs/STRIPE-PAYMENT-METHOD-TYPES.md first and follow them.

Goal: more calls that still send payment_method_types get the owner-approved move to allowed_payment_method_types, by clearing the gates that drop it where Refit can prove every path.

Founders' decision (2026-10-27): widen the rename where every path the value takes is proven. Record it in AGENTS.md with your evidence. The rest stays as decided: never drop the parameter; card_present and interac_present still stop; an empty or repeated list still stops; no repository-specific code (owner decision D5).

Today:
- The rename is dropped when Refit cannot resolve every client's API version, no client pins a literal version it can move, or the stripe-node upgrade fails. pipeline/run.ts appends the gate to the finding ("The owner-approved rename to allowed_payment_method_types applies to this value, but …").
- It also stops where the value is set outside the creation call's object literal: a body a helper returns, an exported body, a body that reaches another call, a var, a parameter assigned onto a body (pipeline/request-migration.ts, untracedRemovedParameters).
- 16 l2-push-249 rows still have an untraced API version after #362.

Build:
1. Count first. From the latest main runs of l2-push-249 and heldout-30 on refit-dev/refit-bench (gh run list -R refit-dev/refit-bench --workflow benchmark.yml; dispatch them at the origin/main SHA if none exist), list every row where payment_method_types is still sent, with its gate or stop shape. Rank the shapes by rows.
2. Fix the top one or two shapes generically. For example, a body a local helper returns, when every caller of that helper is a confirmed Checkout Session, PaymentIntent or SetupIntent creation call, counts as the call's own body. Or narrow the untraced-version cases further, as #362 did. Each new shape gets tests, including the cases that must still stop.
3. Evidence on refit-bench (benchmark.yml, full pushed SHA): a subset of the rows the change can reach, chosen by rule; l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) and heldout-30 (-f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30), before at origin/main and after. Compare with scripts/stripe-benchmark-compare.mjs. Read every newly validated migration.patch in full and label it in docs/benchmarks/fix-reviews.json. Nothing validated before may be lost.
4. Update docs/STRIPE-PAYMENT-METHOD-TYPES.md, docs/BENCHMARKS.md (run ids, commits, commands) and docs/READINESS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one PR to main; never merge, never push to main. Never pass a key in a workflow input.

Subagents that help: one to tag each row's gate from the run artifacts; one per shape you fix; one to review patches.
```

### Lane D: validate in the customer's own environment

```text
You are working on Refit (github.com/pierceluu10/Refit), a TypeScript pipeline that finds code affected by upstream API changes (Stripe first), writes a migration patch, validates it with the repository's own checks in offline Docker, and opens a draft PR. Read AGENTS.md, docs/DEPENDENCIES.md, docs/APP-ONBOARDING.md and docs/PREPARATION-FAILURES.md first and follow them.

Goal: for a real customer, Refit validates in an environment that already installs their dependencies, so private registries, Git dependencies and unusual workspaces stop blocking validation. This is the product path; it is not expected to move the public benchmark, which has no customer environments.

Founders' decision (2026-10-27): dependency blockers must be resolved for customers too. Anything that handles customer secrets (registry tokens) or runs customer build steps still needs its own owner decision: design it, do not build it.

Today:
- The custom-image path exists but is manual. Every named preparation stop tells the owner to set "image" in .refit.json and prefix "command" with a node_modules symlink (CUSTOM_IMAGE in pipeline/preparation-stops.ts).
- Validation always runs offline (pipeline/docker-sandbox.ts).

Build:
1. A design doc, docs/CUSTOMER-ENVIRONMENT.md. Cover: what the customer provides (a prebuilt validation image they publish; a build from their own Dockerfile or CI install steps; registry credentials); where each runs; what stays offline; how secrets would be stored and never logged; and what each needs from the founders. Read the code and docs before proposing; cite file paths.
2. Implement only the part that needs no secrets and runs no customer build: make a customer-provided image a first-class .refit.json setting that refit enroll, refit doctor and the hosted worker understand, without hand-written symlink commands. Validation inside it stays offline and keeps every existing gate.
3. Tests, and one end-to-end demo on a refit-dev fork whose dependencies Refit cannot prepare today. Use a public image you build from that fork's committed lockfile; put no credentials anywhere.
4. Do not change benchmark outcomes: run l2-push-249 (-f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249) on refit-dev/refit-bench before at origin/main and after, and show they match (scripts/stripe-benchmark-compare.mjs).
5. Lane A is changing pipeline/docker-sandbox.ts and pipeline/dependency-preparation.ts. Keep your changes in new files where you can, and rebase on its PR once it merges.
6. Update docs/DEPENDENCIES.md, docs/APP-ONBOARDING.md and docs/READINESS.md. Run npm test, tsc -b and the format check. Conventional commits, no co-author or AI attribution. Push and open one PR to main; never merge, never push to main. Never print or commit secret values.

Subagents that help: one to map every place that reads "image" and the preparation stops; one to write the design doc's options; one for the fork demo.
```

### Lane F: final measurement

```text
You are working on Refit (github.com/pierceluu10/Refit). Read AGENTS.md first and follow it. Start only after the dependency-blocker lanes (census and source limit, lockfile resolver and peer bump, type-only repairs, payment_method_types gates, customer environment) have merged to main.

Goal: one honest measurement of the combined result.

1. Branch docs/dependency-blockers-results from origin/main in its own worktree.
2. On refit-dev/refit-bench (benchmark.yml, the full origin/main SHA), run:
   - l2-push-249: -f list=subsets/l2-push-249.json -f offset=0 -f size=25 -f count=249
   - heldout-30: -f list=subsets/heldout-30.json -f offset=0 -f size=3 -f count=30
   - Each without AI, and with -f ai=true and -f ai_budget=200 or 30. AI spend is authorized up to those caps.
   - The night set (docs/benchmarks/2026-10-24-stripe-night-repos.json, 104 repositories) once, without AI. Check how benchmark.yml takes a list outside subsets/ first. It has never been opened; do not tune anything on it.
3. Compare against the census baseline in docs/benchmarks/2026-10-27-blocker-census.json with scripts/stripe-benchmark-compare.mjs and the blocker census. Report production validated, untested drafts, regressions, and how many rows each blocker still stops.
4. Read every patch that validates in these runs but did not in the baseline, in full, and label it in docs/benchmarks/fix-reviews.json.
5. Record the runs in docs/BENCHMARKS.md (run ids, commits, commands) and the results in docs/DEPENDENCY-BLOCKERS.md. Conventional commits, no co-author or AI attribution. Push and open one PR to main; never merge, never push to main. Never pass a key in a workflow input.
```

## Open decisions

1. Whether a resolved lockfile ever goes into the customer's PR. Lane A keeps it out.
2. Running declared generators (`prisma generate`, `next-env.d.ts`) before checks: reverses the 2026-10-22 decision.
3. Customer registry credentials and building from a customer's Dockerfile or CI steps: lane D designs them.
4. Whether type-only AI repairs that pass the gate may publish validated rather than `[Needs review]` (decision 8 keeps them `[Needs review]`).
