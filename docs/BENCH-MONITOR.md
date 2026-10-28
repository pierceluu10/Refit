# Watching Refit run, and how we score it

Written 2026-10-28. Founders watch what Refit does on each benchmark run (why it stops, what it changes, what the AI did) and step in between runs. Every run is scored the same way, so a gain can't come from doing more edits.

## The monitor

[Refit Bench Monitor](https://claude.ai/artifact/L4m2RVvtLTb6nbaePPN5NG) is a private dashboard. Share it from its page to give the other founders access.

- **Latest results:** validated, passed checks, refused at setup and AI spend for progress-30 and heldout-30.
- **Needs a founder:** the selected run's repos grouped by the decision only a founder can make:
  - a policy to lift or keep;
  - AI patches to hand-check;
  - repos held for review notes;
  - setup gaps;
  - patches that break the build;
  - repos with no runnable check.
- **What Refit did on each repo:** where it ended, its grade, AI repair and AI review outcomes, the behaviour test, AI cost and the reason Refit gave. It can be filtered by outcome and searched.
- **Benchmark runs:** every recent run with its set, code, AI setting, status, shards and totals. Stray and cancelled runs show up here.

The data comes from [`scripts/bench-monitor.mjs`](../scripts/bench-monitor.mjs), which reads refit-bench through the GitHub CLI. After a run:

```
node scripts/bench-monitor.mjs <out-dir> <refit-checkout> --runs 25 --detail <run-id> ...
```

Then upload `runs.json` and `repos.json` to the dashboard. Claude does this when asked to "refresh the monitor".

**progress-30 is shown as totals only.** Its per-repo rows are never collected, so watching the monitor can't tune Refit to the unseen set.

**What "its thoughts" means here.** The monitor shows:

- every rule Refit applied and the reason it gave;
- what each AI step returned, and whether Refit accepted or refused it;
- the cost of each AI step.

The model returns no hidden reasoning, so none is shown.

## After every run (about 30 minutes)

1. Read **Needs a founder** for the run.
2. Hand-check 10 repo rows. Take every AI patch first, then a mix of validated and held rows.
3. Record each verdict in `docs/benchmarks/fix-reviews.json`: correct, partly correct, wrong or unsure, with "should have done X" where it applies.
4. Policy decisions go in AGENTS.md with the date.
5. Pick the next fix from the most common stop reason across the run, never from a single repo.

## How a run is scored

Each repo scores one outcome, and only hand-reviewed or merged outcomes count. Refit's own claim that a fix is right never scores.

| Outcome                                                 |   Score | Why                                              |
| ------------------------------------------------------- | ------: | ------------------------------------------------ |
| Correct fix, merged or validated                        |      +1 | The goal                                         |
| Correct fix with a clear "please check X"               |    +0.7 | Useful, less automatic                           |
| Honest stop naming the reason and the next step         |       0 | Safe, but no progress                            |
| Silent stop, or "no usage found" that was really a miss |    −0.5 | A hidden failure, worse than an honest stop      |
| **Wrong fix**, one that would break the customer's code | **−10** | One wrong fix costs more than ten good ones earn |

Report the score next to the validated count. A change that raises validated but lowers the score is a regression.

## Charging customers

Charge for merged PRs, not opened ones. A merge is the strongest proof a fix was right, so the customer pays only for fixes a developer accepted. A small monthly fee for watching repos can sit beside it.
