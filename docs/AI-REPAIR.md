# AI repair on patches that break the build

Written 2026-10-28.

**Founder decision (Otabek, 2026-10-28):** when a patch breaks the build, AI repair must run and offer a solution. It must not stop first. Approved in chat: "AI NEEDs to repar and run on patches that break the build and provide solutions."

Decision 8 still holds: an AI-repaired patch ships as **[Needs review]**, and the PR explains what was changed and why. D2b also still holds: the AI's word alone never turns a row "validated". What changes is that the AI now tries, instead of Refit stopping before it.

## What happened

On progress-30 (refit-bench 40744621973, `bench/all-feats-2026-10-28` at `bf81624d`, AI on), AI spend was $0.04. Neither patch that broke the build was repaired:

| Repo (row) | Build error after the patch                                                                                                     | Repair record                                 | Cause                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A          | `TS2322: '"2026-02-25.clover"' is not assignable to '"2026-09-30.endive"'` in a second file that pins its own API version       | `requested: 1, stopReason: repeated-proposal` | The deterministic pin move missed a second `apiVersion` literal. One AI attempt returned the same patch, and the loop stopped. |
| B          | `TS2561: 'payment_method_types' does not exist in 'PaymentIntentCreateParams'` and `TS2554: Expected 1-3 arguments` in a script | `requested: 0, stopReason: review-required`   | Policy: a removed request parameter with no reviewed replacement stops automatic migration and AI before repair runs.          |

These two rows are from progress-30, the unseen set. Nobody opened their code. Only Refit's own records were read. Fixes must be general, and they are judged on other rows.

## Agent P: make the repair loop actually repair

Fix the two loop failures, and anything else of the same kind found in past results:

1. **Every pin.** The version move updates every `apiVersion` string literal in the repository that pins the old version, not only the traced client's. When a pin is written in a form the move can't handle, the type checker's error is handed to repair as an explicit task.
2. **No dead stop on a repeated proposal.** When the AI returns the same patch, retry with more context, up to the attempt limit:
   - the full type-checker errors with file and line;
   - the source around each error;
   - the stripe-node type definition the error names;
   - an explicit note that the last proposal didn't change anything.

   Stop only once the attempt limit is reached.

3. **Repair sees the errors the patch introduced.** It gets only the errors that are new compared with the baseline, never the repository's existing errors.

## Agent Q: repair where policy used to stop

Under the founder decision, a `review-required` stop that comes from a type error the upgrade introduced no longer prevents repair:

- **Removed request parameter with no reviewed replacement,** for example `payment_method_types` on PaymentIntents. The AI proposes the replacement Stripe documents, citing the documentation page. The replacement must keep the request's behaviour or say exactly what changes, and it must pass checks. The PR explains the choice. Never silently drop a parameter. If no documented replacement exists, propose the change and say clearly that it alters behaviour.
- **Changed call signatures,** such as `Expected 1-3 arguments`. The AI fixes the call to the new signature.
- Webhook payload reads and the other policy stops: the AI writes the repair, and the PR says which policy would have stopped it.

Every such patch ships as [Needs review], with a "What the AI changed and why" section listing each edit, its build error and its source.

## Rules for both agents

- **The unseen set stays blind.** Never open the code, diffs or rows of `docs/benchmarks/subsets/progress-30.json` repositories. These two rows are known only by the error types above.
- **No full l2-push-249 runs** (founder instruction). Build a small subset from rows of **past** l2-push-249 and heldout-30 results that ended `patched-failed`, `regression` or `review-required`, and run only that subset.
- No repository-specific code. Tests are written from scratch.
- Hand-check every AI-repaired patch in the subset and record the verdict: correct, partly correct or wrong. A wrong patch blocks the merge.
- Report:
  - patches that break the build, before and after;
  - repairs requested and accepted;
  - the AI's spend;
  - hand-review verdicts.
- Typecheck, format check, tests and build must pass. Draft PR only. Never merge, never push to main.

## Then

Merge P and Q into `bench/all-feats-2026-10-28` and rerun progress-30 once, with AI and test mode. The question is whether its two build-breaking patches come back repaired, as [Needs review] PRs with passing checks.
