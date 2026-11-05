# O7 measurement: does memory help?

Locked before any paid run. `LIST-TEST.md` found no gain from recipe text for breaks the list describes well, so this tests the two places it could matter, on more than 3 repos, and compares quality as well as pass or fail.

**Rule:** only repos that haven't fed this memory, and that the round-3 screen found green. `learning.ts` refuses a repo that fed the memory.

| Arm     | Question                                                 | Repos                                                                                                                              |
| ------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Proven  | Does a plain-code fix at $0 of model spend match Claude? | `proven-lock.json`, with memory from O2, O3 and `learn-lock.json`                                                                  |
| Recipes | Do notes help on a break the list describes poorly?      | `recipes-lock.json`, the Assistants API (OA-2), which needs real rework. Memory comes from the two OA-2 repos in `learn-lock.json` |

Each repo runs twice from the same commit, memory on and memory off. The order varies by repo. Diffs get shuffled labels, and a grader who hasn't seen the key compares them.

**Evidence:** every "merge" here is a locked-test stand-in, so `benchmark: true` is what lets these fixes run. None of them count as proven for customers.

**Locks are static:** Assistants locks check that the old calls are gone and a Responses or Conversations call is there, not that the new code works. That's why the blind read matters most for this arm.
