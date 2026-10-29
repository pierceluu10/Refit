# Learning loop

Founder decision (Otabek, 2026-10-28): Refit runs as an autonomous loop (`docs/AUTONOMOUS-LOOP.md`). Fixing, proving and opening PRs already existed. This guide covers the other four steps: spot, learn, promote and roll back. They live in `pipeline/learning.ts` and run through `refit learn`. Each one is a commit to `data/learning/`, so you can audit everything afterwards without approving it first.

## Spot: failure signatures

Every row that did not pass gets a signature: its status, its stage, the first sentence of its reason, its error codes (`TS2353`, `ERR_PNPM_…`) and its oasdiff change ids. Infrastructure rows count too. File paths, line numbers, counts, hashes and URLs are replaced before hashing, so one cause in two repositories gets one id. `data/learning/signatures.json` records each signature's first and last run and its run and row counts. It also records, per run, which ids were new.

Every Stripe benchmark summary (`summary.md`) ends with a **Failure signatures** section. It lists the signatures the committed store has not seen. The benchmark itself never writes the store.

## Learn: candidate rules

An AI fix becomes evidence when all of these hold:

- It came from `patch.generator === 'openai'` or a kept coverage AI patch.
- Its workflow passed.
- It is proven: grade A or B, or its PR was merged without edits.

Its diff is read line by line. A line whose only change is a request key (`old: value` becomes `new: value`) is a `request-rename` pattern. A line whose only change is a string value (`parameter: 'old'` becomes `parameter: 'new'`) is a `request-enum-value` pattern. Each pattern is a candidate in `data/learning/candidates.json`, with the repository, run, grade, PR and the traced operations the AI was asked to resolve.

Some patterns are never learned:

- patterns a shipped rule already makes;
- `payment_method_types`, which owner policies govern in code;
- field moves and anything else.

## Promote

A candidate is promoted when every one of these holds:

1. It was proven on at least 3 distinct repositories.
2. There is no contrary evidence: no check failure, revert, closed-unmerged or CI-failed PR, and no `wrong` verdict for one of its repositories in `docs/benchmarks/fix-reviews.json`.
3. Its rule passes the verification `npm run rules:check` runs. That means a line quoted verbatim from a saved changelog page of the version that made the change, the oasdiff entry between that version's two pinned contracts, and both contracts agreeing with the move on every operation. The operations are the ones the evidence touched. When the run did not record them, they are every operation that removed the value.

The rule is written `auto`, with `origin: "learned"`, `learnedFrom` (at least 3 repositories) and a `benchmark` line naming its repositories and runs. It goes to `data/learning/rules/stripe/<version>.json`. That is its own pack: the loader refuses a name that is already in `data/rules/stripe`. `STRIPE_PACK` applies it deterministically, with no AI, through the existing request-move families. `rules:check` verifies it with the hand-written tables.

## Roll back

One failure demotes a promoted rule:

- a PR it produced is reverted, closed unmerged, or fails CI after merge (`refit learn demote --events`);
- a later run's patch holds the rule's edits (the row's `workflow.rules`) and its checks fail (`refit learn record`, then promotion's demotion pass).

The rule stays in its table as `review-only`, with `demoted: { at, reason }`. Its candidate becomes `demoted` and lists every PR its patches opened, to flag. A demoted candidate is never promoted again from its old evidence.

## Blind sets

`refit learn record` refuses a blind list: `progress-30`, any frozen `*final*` list, or a list with `"blind": true`. It also skips rows of any repository named on a blind list under `docs/benchmarks/`.

## Commands

```bash
refit learn record --run <run-id> --list <frozen.json> --results <results.json> [--results ...]
```

```bash
refit learn promote [--contracts <directory>] [--dry-run]
```

```bash
refit learn demote --events <events.json>
```

```bash
refit learn replay --run <run-id> --list <frozen.json> --results <results.json>
```

`replay` runs `record` and `promote` without writing anything. Promotion needs oasdiff and the pinned contracts (downloaded to `--contracts` when missing). Events are `[{ "kind": "reverted" | "closed-unmerged" | "post-merge-ci-failed" | "check-failed", "rule" | "pullRequest": "…", "repo"?, "detail"? }]`.

## Offline replay (2026-10-28)

The saved results of eight AI-enabled refit-bench runs were replayed with `refit learn replay` and chained `recordSignatures` and `recordCandidates`, with nothing written. No benchmark was started, and no progress-30 run was downloaded.

| Run         | List               |
| ----------- | ------------------ |
| 40624062726 | l2-push-249        |
| 40624075884 | heldout-30         |
| 40687146881 | l2-push-249        |
| 40753185102 | p-repair-loop      |
| 40764807844 | repair-policy      |
| 40772802488 | behaviour-tests-20 |
| 40772830155 | version-bump       |
| 40772950934 | heldout-30         |

- **Signatures:** 59 distinct. The first run had 53. Each later run added at most 1 new one, and the rest were already seen.
- **Candidates:** none. The 6 AI rows are grades C (4) and D (2), none A or B. Their patterns are:
  - `payment_method_types` renames, which are never learned;
  - an `apiVersion` constructor value. Grounding would refuse it, because no oasdiff request entry backs it.
- **Promotions:** none.
- **Grounding:** a synthetic `ui_mode` `hosted` → `hosted_page` candidate with 3 grade-B repositories was grounded against the real pinned contracts. It rebuilt the shipped dahlia rule: `PostCheckoutSessions`, the same changelog page and a verbatim quote. Endive refused it.

## Limits

- PR outcomes are recorded by the hosted worker (`refit_pull_outcomes`), but nothing feeds them to `refit learn demote` automatically yet. The hosted worker cannot commit to this repository, so a scheduled job or an operator passes the events. Flagged PRs are listed, not commented on.
- Only one-line request renames and enum-value replacements are learned. AI fixes that move response reads, restructure a body or span several lines produce no candidate.
- heldout-30 is not marked blind, so `record` would learn from it. Mark it `"blind": true` if it must stay a clean measurement.
- `closed-unmerged` demotes even when the customer closed the PR for an unrelated reason. Over-demoting is intended.
