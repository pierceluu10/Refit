# L2: match and memory (Otabek, 5x account, a quarter of the work)

Read [`README.md`](README.md) first.

- **Branch:** `r3/match-memory`.
- **Folders:** `orchestrator/match.ts`, `orchestrator/match-real.ts` and their tests, plus `memory/`.
- **No benchmarks.** Test with the recorded match inputs in `evals/reports/2026-11-03/` and with fixtures.
- Push every commit, because L1 merges your branch at the start of each iteration.
- Open your draft PR into `main` early, and read L1's comments on it.

## Deliverables

1. **One task per upgrade.**
   - When one SDK or API-version upgrade resolves several changes, the match agent makes a single task for the upgrade and lists the other changes inside it.
   - Example: jiro's stripe-node 14 → 23 had four tasks, which led to three overlapping PRs. It should have been one.
   - This is prompt guidance and task shape, not an `if` rule.
   - Test it on jiro's and the three Stripe repos' recorded match results.
   - Independent changes stay separate, like lobe-chat's 12 model retirements.
2. **Memory recipes.**
   - After a verified fix, save a recipe: the change, the files and pattern touched, the codegen and checks run, and the test written.
   - Before the next repo with the same change, retrieve the recipe into the harness prompt.
   - The agent still reads the repo and may ignore the recipe. A recipe is a head start, not a codemod.
   - Recipes must survive across runs in the benchmark's `APTITUDE_MEMORY_DIR`. L1 keeps that folder between iterations.
   - Stale or wrong recipes must lose: a recipe that led to a failed task is marked down.
3. **Wiring:** keep `orchestrator/deps.ts` edits to your own lines.

## Ending

By 12:00:

- push;
- update your draft PR body with what works, what was tested and what's left;
- answer every L1 comment, either with the fix or with why it isn't fixed.
