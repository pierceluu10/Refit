# memory

Aptitude's self-learning (Otabek, O3 and O6). Memory is guidance the agent reads, never a rule that blocks it.

| Piece             | Entry point                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run store         | `MemoryStore`, `SqliteMemoryStore`               | Every `RunRecord`, its transcript, the recipes it was shown, the commit it read and what happened to its PR, one SQLite file per customer under `APTITUDE_MEMORY_DIR`                                                                                                                                                                                                                                                                                                                                |
| Recipe extraction | `extractRecipe(run, deps)`, `learnPending(deps)` | After a fix, in a batch, one AI pass distils the run into a recipe. See [What memory learns from](#what-memory-learns-from)                                                                                                                                                                                                                                                                                                                                                                          |
| Retrieval         | `retrieveRecipes(task)`, `createRetriever(deps)` | Up to 50 recipes, the model reads them all and picks and orders the ones that would help; above that, embeddings shortlist the top 10 first. Without a model, that order is used: recipes made from the task's own change first, recipes that failed more often than they verified last, then by embedding similarity. The judge is told which recipes came from the same change and how each has fared. Nothing is filtered out. `renderMemoryForPrompt(recipes)` gives the harness a prompt block. |
| Skills            | `promoteSkills`, `recordRecipeOutcome`           | A recipe verified on 3+ repos becomes a skill (a reusable prompt block). A skill that fails twice after its promotion is demoted back to an ordinary recipe. Every failure also counts against the plain recipes its run was shown, and the retrieval judge sees that count. A failure is a PR a human closed, or a needs-review run on a repo whose checks all passed before the edit (see [Verdicts](#verdicts)).                                                                                  |
| Human verdicts    | `recordVerdict(prUrl, verdict)`                  | What a person did with an Aptitude PR: merged, closed or edited. See [Verdicts](#verdicts).                                                                                                                                                                                                                                                                                                                                                                                                          |
| Dashboard runs    | `listRunViews(filter?)`                          | Stored runs as the shared `RunView`, newest first, each with a one-line summary. See [Runs for the dashboard](#runs-for-the-dashboard).                                                                                                                                                                                                                                                                                                                                                              |

`harness/prompt.ts` renders recipes itself today, from the shared `Recipe` fields, so the agent sees neither an active skill's prompt, a diff sketch nor the closed-PR count. It sees them once it renders recipes with `renderMemoryForPrompt` (the harness's to change).

If the model's answer is degraded (a safety classifier interrupted it, it refused, or it left a field blank), extraction retries once. If the retry is degraded too, no recipe is saved or merged, and the run is marked `extraction: { status: 'failed', reason }` so it can be re-extracted later. The migration itself is never blocked.

The orchestrator calls `learnFromRun({ task, record, transcript, usedRecipeIds, commit })` after each run. `commit` is the commit the run's checkout was at (`git rev-parse HEAD` in it); it is optional, but without it the self-eval reruns that task on today's code.

`learnFromRun` and `recordVerdict` store the run or the verdict at once, then learn one at a time within a process, because learning reads recipes, may ask the model and writes them back: runs from parallel tasks or repos would otherwise overwrite each other's counts. Two processes must not write one store at the same time until it moves to a database with row locks.

## Verdicts

The GitHub App calls `recordVerdict(prUrl, verdict)` from its `pull_request` webhook. It sends a verdict only for PRs whose head branch starts with `aptitude/`, and `prUrl` is always `pull_request.html_url`, the URL the loop stored as `RunRecord.pr`.

| `pull_request` action                                                                                  | Condition                                                  | The app calls                                    |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------ |
| `closed`                                                                                               | `pull_request.merged` is `true`                            | `recordVerdict(pull_request.html_url, 'merged')` |
| `closed`                                                                                               | `pull_request.merged` is `false`                           | `recordVerdict(pull_request.html_url, 'closed')` |
| `synchronize`                                                                                          | a person's own commit was pushed to the branch (see below) | `recordVerdict(pull_request.html_url, 'edited')` |
| anything else (`opened`, `edited`, `reopened`, `labeled`, `review_requested`, `ready_for_review`, ...) |                                                            | nothing                                          |

A person's own commit means: `sender.type` is not `Bot`, and comparing `before...after` shows at least one new commit that is not a merge commit and whose author is not a `Bot`. The **Update branch** button also fires `synchronize` from the person who clicked it, but it only adds a merge commit, or with rebase rewrites Aptitude's own commits, so it sends nothing. Aptitude's own pushes and other bots' pushes come from a `Bot` sender and send nothing.

GitHub's `edited` action means the title, body or base branch changed, not the code, so it sends nothing. `reopened` sends nothing either: the run counts as closed until the PR is closed or merged again.

What memory does with each verdict:

- **merged** or **edited**: the run counts as a success. A needs-review run that wasn't distilled yet becomes a recipe now, or is merged into the recipe the model names, and adds its repo to that recipe's verified repos. A recipe that reaches 3 repos is promoted to a skill.
- **closed**: the run counts against every recipe it was shown (`failedRunIds`; the retrieval judge sees the count, and so does `renderMemoryForPrompt`) and against every active skill it was shown after that skill's promotion (2 such closes demote the skill). If the run was verified and already distilled, its repo comes back off that recipe's verified repos, unless another successful run from the same repo, distilled into the same recipe, backs it.

Without a human verdict, a run counts against the recipes it was shown when it ended needs-review on a repo whose checks all passed before the edit: the repo could verify, and the run still couldn't. That is how a stale or wrong recipe loses during a benchmark, where no person reviews the PRs. A needs-review run on a red baseline counts against nothing, since the environment, not the guidance, kept it from verifying, and a later merged or edited verdict takes the failure back. A run whose harness outcome is `failed` counts against nothing: it means nothing was attempted (the model was down, the budget ran out) or the PR couldn't be opened, which says nothing about the guidance.

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

## What memory learns from

A fix counts as a success only if its PR was merged and the rescan was clean. "Verified" alone creates and promotes nothing.

| Standing | Needs                                                          | Can do                                                                                                                      |
| -------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Merged   | Merged PR and a clean rescan                                   | Make or grow a recipe, and count its repo                                                                                   |
| Low      | A clean rescan with no merge yet, or a benchmark's locked test | Make a low-confidence recipe, marked as such. A locked test also marks it `benchmarkOnly`, so it never counts for customers |
| Against  | Closed or reverted                                             | Counts against the recipes it used, and takes its repo off the recipe it made                                               |

`recordEvidence(runIdOrPr, evidence)` takes what the GitHub App sees (P7). A person's edits and closing comments reach the recipe's pitfalls the next time learning runs. Detection lessons (`lessons.ts`) go to the scanner as rules and fixtures. Repo habits (`habits.ts`) give the next run its proven setup and what the team rejected.

Learning is off the fix path. Fix runs only store. `memory/scripts/learn.ts` reads stored runs later in half-price batches on Haiku, on its own budget, `APTITUDE_MEMORY_BUDGET_USD`:

```sh
APTITUDE_MEMORY_BUDGET_USD=0.50 node memory/scripts/learn.ts
```

## The ladder

`ladder.ts` gives each list entry a level, replayed from its evidence in date order, so a late or repeated webhook can't skew it: **new**, **recipe** (a merged fix), **proven** (at least 3 merged fixes on different repos, few edits, no reverts) and **dropped**. A close or revert moves it down a level, and the evidence stays. A locked test moves only `benchmarkLevel`.

A proven fix is plain code in `providers/<provider>/proven.ts`, with tests built from real fixes. It runs first, with no model, and still has to pass the rescan and the checks. If it breaks a check it's rolled back, and what it can't finish goes to Claude, so it can never block an attempt. At most `ROLLOUT_REPOS` repos may wait on a person at once.

## Where it lives

Each customer has one SQLite file, `customers/<owner>.sqlite`, so two processes can write at once and one customer's runs never reach another's file. `shared.sqlite` holds only scrubbed patterns and hashed evidence, and only from customers who agreed (`shared.ts`). The default is no. `shared.test.ts` proves the scrubbing.

## Is it helping?

`evals/runner/learning.ts` replaces the old self-eval, which reran past tasks on recipes they may have made. It runs fresh repos from the same commits with memory on and off, varies the order, labels each diff for a blind grader, and refuses a repo that fed the memory under test. `learningMetrics` tracks the share of fixes needing no model, PRs merged without edits, reverts and scanner misses.

## Keys and budget

- `ANTHROPIC_API_KEY`: extraction, retrieval judgement and skill writing use `claude-opus-5-5`. Without it, runs are still stored and retrieval falls back to embedding order.
- `VOYAGE_API_KEY`: `voyage-code-3` embeddings. Without it, a free local hashed embedder is used (lexical, not semantic).
- `APTITUDE_AI_BUDGET_USD`: every model and embedding call in memory/ reserves its worst case against this cap first. Unset, memory/ spends nothing: runs and verdicts are still stored, but nothing is distilled (AGENTS.md: a run without a cap refuses to spend). The orchestrator passes each call its own share of the run's cap. The app gives each verdict up to $1 of the run's cap and never waits for it (`verdictWith` in `app/runner.ts`). With nothing free, the verdict is still stored and memory spends nothing. The self-eval command spends through the loop's run budget, which refuses to start without it.

## Tests

`npm test` runs the fixture tests, with fake models: no test spends money. `extract.real.test.ts` makes 3 real extraction calls and runs only with `APTITUDE_REAL_AI=1` and a cap in `APTITUDE_AI_BUDGET_USD`: through `ANTHROPIC_API_KEY` when set, otherwise through the logged-in Claude Code credentials via the Agent SDK (`AgentSdkModel`, charged at the SDK's `total_cost_usd` estimate).
