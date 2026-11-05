# O9 runbook: score it once

**Not run.** O9 needs Furqan's approval and its own dollar cap. Nothing here has opened a sealed set. Every step below is ready for when that approval comes.

## Before anything opens

1. **Get the approval and a cap** in writing. A cap of about $60 covers the estimate below, which assumes the rebuild's measured $0.17 a repo and allows for Claude Code on both prompts.
2. **Freeze the code.** Run from one commit of `rebuild/integration`, on Pierce's scanner. Nothing gets tuned after step 4.
3. **Check for overlap.** Some of the `LIST-TEST.md` repos came from a GitHub code search, so they may be in a sealed set. Compare them with the sealed lists when the set opens, in code, without printing names, and drop any overlap.

## The run

| Step | What | How |
| --- | --- | --- |
| 1 | Fresh repos, picked by a written rule | Same rule as `evals/rounds/o2/README.md`, with a new seed, from repos no round has used |
| 2 | Lock required changes and tests | `evals/scoring/required.ts` for name changes. Add behaviour tests for field changes, which a static lock can't show. Commit the lock before any run |
| 3 | Screen | `node evals/runner/cli.ts screen --sets sealed:stripe,sealed:openai,sealed:anthropic,sealed:gemini` opens the sets once and writes the `OPENED.json` marker |
| 4 | The sealed set, once | `evals/runner/sealed-run.ts` refuses a second open unless it's resuming the same run. It's wired to the old pipeline today, so it needs pointing at `runProductRepo` first. That's a small change, and it's the one thing here that isn't ready |
| 5 | Refit with empty memory | Point `APTITUDE_MEMORY_DIR` at a new folder for this row, so the gap to the row with memory shows what learning adds |
| 6 | Claude Code, independent | Same repos and commits, in the same containers. Once with the bare prompt from `TEST-2026-11-04.md`, and once with a detailed prompt a smart customer would write. `evals/runner/baseline.ts` runs plain Claude, but its prompt must be swapped for each of these |
| 7 | Grade blind | Shuffled labels, as `evals/runner/learning.ts` writes them. A fresh grader, with the key kept apart |
| 8 | Hand-check | At least 10 results, or all if there are fewer. Report how often the grader and the hand-check agree |

## The write-up

Plain language, including everywhere Refit loses. Report:

- required changes fixed, per side
- cost per required change fixed
- time per repo
- unneeded major upgrades
- what each side did on repos with nothing to fix

Say what wasn't checked against live providers. Costs in this lane so far are the Agent SDK's estimate, so a real API key should be used for O9 and the bill compared.
