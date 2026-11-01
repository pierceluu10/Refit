# memory

Aptitude's self-learning (Otabek, O3). Memory is guidance the agent reads, never a rule that blocks it.

| Piece             | Entry point                                      | What it does                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run store         | `MemoryStore`, `JsonMemoryStore`                 | Every `RunRecord`, its transcript, the recipes it was shown and the human verdict, as local JSON under `APTITUDE_MEMORY_DIR` (default `.aptitude/memory`). Async, so Postgres can replace it.  |
| Recipe extraction | `extractRecipe(run, deps)`                       | After a verified run, one AI pass distils the trajectory into a recipe (preconditions, steps, pitfalls, diff sketch) linked to the run, or merges it into the same recipe from an earlier run. |
| Retrieval         | `retrieveRecipes(task)`, `createRetriever(deps)` | Embeddings rank every recipe against the task; the model then picks and orders the ones that would help. `renderMemoryForPrompt(recipes)` gives the harness a prompt block.                    |
| Skills            | `promoteSkills`, `recordSkillOutcome`            | A recipe verified on 3+ repos becomes a skill (a reusable prompt block). A skill that fails twice after promotion is demoted back to an ordinary recipe.                                       |
| Self-eval         | `runSelfEval(deps)`                              | Reruns a fixed set of past tasks with today's memory through the harness's `RunTask` and reports whether the verified rate moved.                                                              |

The orchestrator calls `learnFromRun({ task, record, transcript, usedRecipeIds })` after each run, and the GitHub App calls `recordVerdict(prUrl, verdict)` when a PR is merged, closed or edited.

## Keys and budget

- `ANTHROPIC_API_KEY`: extraction, retrieval judgement and skill writing use `claude-opus-5-5`. Without it, runs are still stored and retrieval falls back to embedding order.
- `VOYAGE_API_KEY`: `voyage-code-3` embeddings. Without it, a free local hashed embedder is used (lexical, not semantic).
- `APTITUDE_AI_BUDGET_USD` (default 3): every model and embedding call in memory/ reserves its worst case against this cap first.

## Tests

`npm test` runs the fixture tests. `extract.real.test.ts` makes 3 real extraction calls and runs only with `APTITUDE_REAL_AI=1`: through `ANTHROPIC_API_KEY` when set, otherwise through the logged-in Claude Code credentials via the Agent SDK (`AgentSdkModel`, charged at the SDK's `total_cost_usd` estimate).
