# Push 279 results

Final measurements for the push tracked on #300 (October 25). Per-repository rows are in [STATUS.md](STATUS.md); run commands and earlier runs are in [BENCHMARKS.md](../BENCHMARKS.md).

## Headline: heldout-30

The 30 held-out repositories were not opened by any lane and nothing was tuned on them. They were measured once, at the end.

- Run: refit-bench 40227099900 at `783b2ecc` (main after #335), `size=5 count=30 ai=true ai_budget=5 model=gpt-6.1-sol`.
- Production mode (full diff on):

| Outcome                              | Repositories |
| ------------------------------------ | -----------: |
| Validated (checks pass, no blockers) |        9 / 30 |
| Checks pass, findings unresolved     |       19 / 30 |
| No Stripe change to make             |        2 / 30 |
| Errors                               |            0 |

- The same 30 repositories in the 0.38.0 run (40211544936, no AI): 0 validated, 24 needs review, 1 validation failed, 1 error, 4 no change (workflow mode; 0.38.0 has no production field).
- The no-AI run at main (40181262435) gives the same 9 / 19 / 2. On this set, every gain came from deterministic rules and the gate changes, not from AI.

## AI on heldout-30

- Spend: $0.135 of the $5 cap.
- Asked: 9 repositories.
  - 6 calls returned no proposal: scrapmatic, Turbo-Gestor, ecommerce-react, tunehub-next, bistro-boss and Safari.
  - 3 were refused before any spend, because the target was outside the bounded edit scope: DigitalMali, SaaS-CV-Creation and inboxradarai.
- Edits written by AI: 0. No AI edit reached a draft on this set, so the 9 validated drafts are entirely deterministic.

## Live drafts on refit-dev forks (hosted, Fly)

- heldout-30: 24 of 30 repositories have an open Refit Agent draft. 9 are validated (grade A/B) and 15 are `[Needs review]` (grade C/D).
  - The hosted and benchmark grades differ on two repositories. Hosted published web-scraping-course-app as validated (the benchmark says needs review) and what-now-chaos as `[Needs review]` (the benchmark says validated).
  - 2 have no Stripe change.
  - 4 have no draft yet: Backend-AlphaAnimica, DigitalMali, Open-Magiviz (queued) and bistro-boss.
- Whole push-279 list: 209 open drafts across 188 forks at the end of the push, of which 114 were `[Needs review]`.
- 20 forks had more than one open draft, 21 extras in all. Each had a draft from before 05c50197 (one branch per target version) and a second on the new branch for the same `2026-09-30.endive` target. The older drafts carry no provider or target marker, so `--supersede-drafts` would not have closed them either. The 21 older drafts were closed by hand with a comment that links the one kept, leaving 189 open drafts on 189 forks.
- Hosted AI spend: $0.64 of $7. AI was involved in 40 of the 190 hosted targets with reports (21%), and 2 patches were written by OpenAI.

## Push-279 list: 0.38.0 vs main (no AI)

| Measure                  | 0.38.0 (40211544936) | main (40181262435) |
| ------------------------ | -------------------: | -----------------: |
| Confirmed breaking usage |                  243 |                273 |
| Possible only            |                   36 |                  6 |
| Validated                |                    0 |                 78 |
| Review drafts            |                    0 |                167 |
| Stops and errors         |         189 + 12 + 9 |                  6 |
| Not run (no checks)      |                   69 |                 28 |

- The 6 errors at main all exceed the 50 MiB dependency archive limit.
- #335 (built-in Stripe adapter generated from Stripe's SDK spec) left production outcomes unchanged (run 40216180920). The built-in adapter gained 21 confirmed findings in 7 repositories and lost none. Each was checked by hand.

## Evidence limits

- "Validated" means the repository's own configured checks passed offline in Docker after the patch. It does not prove complete API or code coverage, and no live Stripe call was made.
- These are single runs. Two repositories graded differently between hosted and benchmark, so treat ±2 on 30 as noise.
- AI produced no accepted edit on heldout-30. The only AI edit seen in this push that was correct and accepted was FlowCraft on dev-30 (run 40166116141).

## State after the push

- A later target version still opens a new draft beside the old one, because hosted runs without `--supersede-drafts` (off by default, owner decision 2026-10-24).
- Fly `refit-hosted` is back on shared-cpu-2x with 4 GB, running `--publish-draft --ai-patch --repair-attempts 2` (v28).
- The refit-docker EC2 instance was terminated, so no billable EC2 resources remain.
