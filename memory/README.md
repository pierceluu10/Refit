# memory

Refit's self-learning (Otabek, O3 and O6). Memory is guidance the agent reads, never a rule that blocks it.

| Piece             | Entry point                                       | What it does                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run store         | `MemoryStore`, `JsonMemoryStore`                  | Every `RunRecord`, its transcript, the recipes it was shown, the commit it read and the human verdict, as local JSON under `REFIT_MEMORY_DIR`. Async, so Postgres can replace it.                                                                                                                                                  |
| Recipe extraction | `extractRecipe(run, deps)`                        | After a successful run (verified, or its PR merged or edited by a human), one AI pass distils the trajectory into a recipe (preconditions, steps, pitfalls, diff sketch) linked to the run, or merges it into the same recipe from an earlier run. A failed or needs-review run can only add pitfalls to a recipe the model names. |
| Retrieval         | `retrieveRecipes(task)`, `createRetriever(deps)`  | Up to 50 recipes, the model reads them all and picks and orders the ones that would help; above that, embeddings shortlist the top 10 first. Without a model, embedding order is used. `renderMemoryForPrompt(recipes)` gives the harness a prompt block.                                                                          |
| Skills            | `promoteSkills`, `recordRecipeOutcome`            | A recipe verified on 3+ repos becomes a skill (a reusable prompt block). A skill whose PRs a human closes twice after its promotion is demoted back to an ordinary recipe. Every closed PR also counts against the plain recipes its run was shown, and the retrieval judge sees that count.                                       |
| Human verdicts    | `recordVerdict(prUrl, verdict)`                   | What a person did with an Refit PR: merged, closed or edited. See [Verdicts](#verdicts).                                                                                                                                                                                                                                           |
| Dashboard runs    | `listRunViews(filter?)`                           | Stored runs as the shared `RunView`, newest first, each with a one-line summary. See [Runs for the dashboard](#runs-for-the-dashboard).                                                                                                                                                                                            |
| Self-eval         | `runSelfEval(deps)`, `memory/scripts/selfeval.ts` | Reruns a fixed set of past tasks with today's memory and reports whether the verified rate moved. See [Self-eval](#self-eval).                                                                                                                                                                                                     |

`harness/prompt.ts` renders recipes itself today, from the shared `Recipe` fields, so the agent sees neither an active skill's prompt, a diff sketch nor the closed-PR count. It sees them once it renders recipes with `renderMemoryForPrompt` (the harness's to change).

If the model's answer is degraded (a safety classifier interrupted it, it refused, or it left a field blank), extraction retries once. If the retry is degraded too, no recipe is saved or merged, and the run is marked `extraction: { status: 'failed', reason }` so it can be re-extracted later. The migration itself is never blocked.

The orchestrator calls `learnFromRun({ task, record, transcript, usedRecipeIds, commit })` after each run. `commit` is the commit the run's checkout was at (`git rev-parse HEAD` in it); it is optional, but without it the self-eval reruns that task on today's code.

`learnFromRun` and `recordVerdict` store the run or the verdict at once, then learn one at a time within a process, because learning reads recipes, may ask the model and writes them back: runs from parallel tasks or repos would otherwise overwrite each other's counts. Two processes must not write one store at the same time until it moves to a database with row locks.

## Where memory lives

Memory is one folder, `REFIT_MEMORY_DIR`. Unset, it is `.refit/memory` under the directory the process was started in, which the root `.gitignore` ignores (`.refit/`).

```text
$REFIT_MEMORY_DIR/
  runs/<run id>.json         one StoredRun per run: task, RunRecord, transcript, recipes shown, commit, verdict
  recipes/<recipe id>.json   one MemoryRecipe per recipe, with its skill state and failure count
  selfevals/<id>.json        one SelfEvalReport per self-eval
  selfeval-tasks.json        the fixed task set the self-eval reruns
```

Every file is written atomically (a temp file, then a rename). Ids are escaped, so a file name never leaves its folder.

Runs hold transcripts, which quote the target repo's code and the model's output. Keep the folder private: never commit it, and never put it inside a repo Refit migrates. In production, set `REFIT_MEMORY_DIR` to an absolute path on a persistent volume. The loop and the verdicts must use the same store, since a verdict finds its run by PR URL, and one process must own it: run the loop inside the app, through `runRepoJob`, not as a separate CLI process while the app serves webhooks.

## Verdicts

The GitHub App calls `recordVerdict(prUrl, verdict)` from its `pull_request` webhook. It sends a verdict only for PRs whose head branch starts with `refit/`, and `prUrl` is always `pull_request.html_url`, the URL the loop stored as `RunRecord.pr`.

| `pull_request` action                                                                                  | Condition                                                  | The app calls                                    |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------ |
| `closed`                                                                                               | `pull_request.merged` is `true`                            | `recordVerdict(pull_request.html_url, 'merged')` |
| `closed`                                                                                               | `pull_request.merged` is `false`                           | `recordVerdict(pull_request.html_url, 'closed')` |
| `synchronize`                                                                                          | a person's own commit was pushed to the branch (see below) | `recordVerdict(pull_request.html_url, 'edited')` |
| anything else (`opened`, `edited`, `reopened`, `labeled`, `review_requested`, `ready_for_review`, ...) |                                                            | nothing                                          |

A person's own commit means: `sender.type` is not `Bot`, and comparing `before...after` shows at least one new commit that is not a merge commit and whose author is not a `Bot`. The **Update branch** button also fires `synchronize` from the person who clicked it, but it only adds a merge commit, or with rebase rewrites Refit's own commits, so it sends nothing. Refit's own pushes and other bots' pushes come from a `Bot` sender and send nothing.

GitHub's `edited` action means the title, body or base branch changed, not the code, so it sends nothing. `reopened` sends nothing either: the run counts as closed until the PR is closed or merged again.

What memory does with each verdict:

- **merged** or **edited**: the run counts as a success. A needs-review run that wasn't distilled yet becomes a recipe now, or is merged into the recipe the model names, and adds its repo to that recipe's verified repos. A recipe that reaches 3 repos is promoted to a skill.
- **closed**: the run counts against every recipe it was shown (`failedRunIds`; the retrieval judge sees the count, and so does `renderMemoryForPrompt`) and against every active skill it was shown after that skill's promotion (2 such closes demote the skill). If the run was verified and already distilled, its repo comes back off that recipe's verified repos, unless another successful run from the same repo, distilled into the same recipe, backs it.

A run whose harness outcome is `failed` counts against nothing: it means nothing was attempted (the model was down, the budget ran out) or the PR couldn't be opened, which says nothing about the guidance.

Verdicts are safe to repeat and to reverse. A redelivered event changes nothing. `merged` is final, since a merged PR can't be reopened, so even a replayed old `closed` doesn't undo it. A PR closed, reopened and merged ends up merged, and its close is taken back off the recipes it used (a skill it already demoted stays demoted). A late `edited` never replaces `closed`, since GitHub can deliver a push's event after the close.

`recordVerdict` returns `undefined` when no stored run has that PR URL (a PR from before memory stored runs, or from another store); log it and move on. A failed AI pass never makes it throw (the result carries `error`); it throws only when the store can't be read or written. It returns what it learned, so wrap it to match the app's `RecordVerdict` type: `async (pr, verdict) => { await recordVerdict(pr, verdict); }`.

A verdict can take a minute or more: a merge can trigger a model call, and it waits for any learning already running. GitHub gives a webhook delivery 10 seconds, so answer the delivery first and record the verdict after it (or on the app's queue).

## Runs for the dashboard

`listRunViews({ repo?, limit? })` returns stored runs as the shared `RunView`, newest first, for the app to serve at `GET /api/runs`. `repo` is `owner/name`; `limit` is a positive whole number, and the app should validate both before passing them on. It returns every installation's runs: serve a viewer only their own installation's repos, filtering by repo before applying a limit.

`summary` is one line of at most 200 characters, in the agent's own words where it left any:

1. the summary from the harness's finish report (the PR body's Change section);
2. the loop's note: the match agent's not-affected reasoning, or why the run failed (first, when the run failed);
3. a harness message such as a sandbox failure;
4. otherwise, how many files changed, or that nothing changed and no reason was recorded.

Then, when there is one, what a human did with the PR ("A human merged the PR."). Secrets are redacted.

## Self-eval

```bash
REFIT_AI_BUDGET_USD=8 node memory/scripts/selfeval.ts --size 5
```

Run it from the repo root, with `ANTHROPIC_API_KEY` set and Docker running; it refuses to run without any of the three, and it forces the harness's Docker sandbox (`REFIT_SANDBOX=docker`), never the fallback to the host. It reruns the fixed task set (the oldest `--size` tasks the harness attempted, picked on the first run and kept) through the loop's own task path: today's recipes, the harness and the provider tool packs. Each rerun gets a fresh checkout of `github.com/<repo>` at the run's recorded commit, or at today's default branch when none was recorded, which the summary says. A rerun on today's code means little once the PR was merged, since that code already has the fix, so the orchestrator should pass `commit`. Fetching runs no repo code; only the harness runs it, in its sandbox.

Reruns open no PR and are not recorded as runs. The report is saved under `selfevals/` and printed: the verified rate before and after, each task's outcome, the change since the previous self-eval and what it spent. Reruns stop once less than the $2 a task needs is left of the cap, or when a harness throws (what it spent is then unknown), and the tasks left over are excluded from both rates.

## Keys and budget

- `ANTHROPIC_API_KEY`: extraction, retrieval judgement and skill writing use `claude-opus-5-5`. Without it, runs are still stored and retrieval falls back to embedding order.
- `VOYAGE_API_KEY`: `voyage-code-3` embeddings. Without it, a free local hashed embedder is used (lexical, not semantic).
- `REFIT_AI_BUDGET_USD`: every model and embedding call in memory/ reserves its worst case against this cap first. Unset, memory/ spends nothing: runs and verdicts are still stored, but nothing is distilled (AGENTS.md: a run without a cap refuses to spend). The orchestrator passes each call its own share of the run's cap. With the default deps, which the app gets when it calls `recordVerdict(pr, verdict)`, every call shares one cap for the life of the process, so give each verdict its own instead: `recordVerdict(pr, verdict, { ...defaultMemory(), ...defaultAi(process.env, new Budget(1)) })`. The self-eval command spends through the loop's run budget, which refuses to start without it.

## Tests

`npm test` runs the fixture tests, with fake models: no test spends money. `extract.real.test.ts` makes 3 real extraction calls and runs only with `REFIT_REAL_AI=1` and a cap in `REFIT_AI_BUDGET_USD`: through `ANTHROPIC_API_KEY` when set, otherwise through the logged-in Claude Code credentials via the Agent SDK (`AgentSdkModel`, charged at the SDK's `total_cost_usd` estimate).
