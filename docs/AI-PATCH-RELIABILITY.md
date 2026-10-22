# AI patch reliability

A repeatable eval of the AI patch path on real repositories where Refit's deterministic rules stop, and the changes it led to. AI stays a bounded assistant: every change here either gives the model a better-formed request or stops for review earlier. No guard was loosened.

## The eval

- **Cases.** [`docs/benchmarks/2026-10-22-ai-patch-cases.json`](benchmarks/2026-10-22-ai-patch-cases.json) was frozen before any AI run.
  - It holds 23 public Stripe repositories whose latest recorded outcome was a validation regression, a stop for review, an AI decline, the AI evidence limit, a validation error, or a validated AI repair.
  - It also holds the private `refit-billing-demo`, which regressed in the hosted worker on 2026-10-22.
  - Each case keeps the pinned commit and API version of its source list, and every case targets `2026-09-30.endive`. The file records why other candidates were excluded.
- **Run.** `scripts/ai-patch-eval.sh <pinned-refit-worktree> <cases-root> <output> <budget-directory> <env-file> <billing-demo-git-source>`.
  - It runs each Stripe case through `benchmark:stripe --ai --validate`, one repository at a time under the machine-wide Docker lock, then the billing demo with `refit run --ai-patch --repair-attempts 1`.
  - The model is `gpt-5.6-luna`. Checks run in offline Docker (`node:22-alpine`).
- **Score.** `npm run eval:ai-patch -- --cases docs/benchmarks/2026-10-22-ai-patch-cases.json --run before=<dir> --run after=<dir> --output scores.json`.
  - It reads each case's workflow bundle and reports one outcome per case: `pass`, `regression`, `guard-rejected` (a source guard refused the AI edit), `input-rejected` (the edit did not cover its cited finding), `review-stop` (a deterministic stop or AI policy stop ended it), `declined`, `evidence-limit`, `error`, `not-reached` (AI was never needed or allowed) or `missing`.
  - It also reports repairs requested and how they ended, and the recorded cost.

## What changed on the AI path

Each change has unit tests in the files named.

| Commit  | Change                                                                                                                                                                                                                                      | Tests                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 690c2c8 | AI requests reserved 4,096 output tokens, and a repair on Kanba-co/kanba ran out while reasoning. The reservation is now 25,000, OpenAI's documented reservation for reasoning models, and an incomplete response names its reason.         | `openai.test.ts`, `ai-budget.test.ts`         |
| 72562ff | After a mechanical edit rejection (an edit that does not apply or does not cover its finding), the model gets one corrected request that names the rejection, inside the same budget.                                                       | `ai-patches.test.ts`, `ai-patch-eval.test.ts` |
| 4fbf988 | Before an AI repair, the open-enum types the deterministic patch narrowed are restored. The model is then asked only about the errors that remain.                                                                                          | `stripe-open-enums.test.ts`, `review.test.ts` |
| e4882da | An AI fix that reads the billing period from a subscription item it picks itself stops for review. Choosing the item needs a reviewed policy.                                                                                               | `ai-patches.test.ts`                          |
| 50429c7 | When the upgraded types reject an object-literal request property (`trial_from_plan`), the run stops for review before any AI repair. Removing or replacing it changes what the code sends.                                                 | `type-error-checks.test.ts`                   |
| 29dbeba | The eval scores those AI policy stops as `review-stop` instead of `error`.                                                                                                                                                                  | `ai-patch-eval.test.ts`                       |
| 001fa3e | A type error reading a removed subscription billing period (`current_period_start`/`_end` on `Subscription`) stops for review before an AI repair. That is the same item-selection decision as e4882da, made without spending a model call. | `type-error-checks.test.ts`                   |

## Before and after

Both runs used the same cases, model, runner and offline Docker image.

- **Before** ran Refit at ee4305b (main plus the frozen list); **after** ran at 89e4df1, which includes every change above except 29dbeba and 001fa3e. The scores below come from the scorer at 001fa3e.
- **The after run is incomplete.** The machine's disk filled at about 08:53 UTC on 2026-10-22, mostly from other agents' work. Case 8 failed copying its dependency cache (`ENOSPC`) and case 9 failed extracting its archive. Docker Desktop then crashed at 08:58 and was still not responding at 15:10 UTC.
  - Cases 8 to 22 and the billing demo therefore have no valid after result. Docker is shared, so it was not restarted. See Blocked below.
  - The comparison covers cases 0 to 7, where both runs completed.

| Case                               | Before                                                     | After (89e4df1)                                                                    |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Kanba-co/kanba                     | error: the repair's response ran out of output tokens      | review-stop: the repair chose a subscription item for the billing period (e4882da) |
| iggy-tech/product-hunt-clone-final | pass, 1 repair, $0.0016 (labelled **partial**)             | review-stop: the repair chose a subscription item (e4882da)                        |
| mrwebwork/spotify                  | input-rejected: the repair did not cover its cited finding | review-stop before AI: the upgraded types reject `trial_from_plan` (50429c7)       |
| nicitaacom/19_spotify-clone        | regression after 1 repair, $0.0074                         | review-stop before AI: `trial_from_plan` (50429c7)                                 |
| kpirabaharan/Spotify-Clone         | input-rejected                                             | review-stop before AI: `trial_from_plan` (50429c7)                                 |
| siavashsk/spotify-clone            | not reached (deterministic patch validated)                | not reached (same)                                                                 |
| abressiddique/AbresStore-Admin     | not reached (findings left for review)                     | not reached (same)                                                                 |
| samarbadriddin0v/notion-clone      | not reached (findings left for review)                     | not reached (same)                                                                 |

On cases 0 to 7:

| Run    | Pass        | Regression | Guard or input rejection | Error | Review stop | Model cost       |
| ------ | ----------- | ---------- | ------------------------ | ----- | ----------- | ---------------- |
| Before | 1 (partial) | 1          | 2                        | 1     | 0           | $0.0090 recorded |
| After  | 0           | 0          | 0                        | 0     | 5           | $0.0050 ledger   |

In short, every case that reached AI now ends in a named stop for review, not a regression, an error or a rejected edit. No case gained a pass. The one before pass, iggy-tech, was only partial: the model picked the subscription item itself. With 001fa3e, Kanba-co/kanba and iggy-tech should stop before the model call. That needs a rerun in Docker to confirm and has not been measured.

The full before run (24 cases) gave 3 passes, 1 regression, 1 guard rejection, 5 input rejections, 1 evidence limit, 1 error and 12 not reached. It made 9 repair requests and recorded $0.0156 in bundles; the budget ledger, which also counts failed requests, recorded $0.058.

## Every passing patch, read and labelled

| Run    | Case                                          | Label   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Before | iggy-tech/product-hunt-clone-final            | partial | `subscription.items.data[0].current_period_end` matches the app's own `items.data[0]` use, but the model chose the item itself, which owner policy reserves for a reviewed rule. Its other changes, the API version bump and `allowed_payment_method_types`, came from rules.                                                                                                                                                                                                        |
| Before | ABHINAVJINDAL26/VANTAGE-Golf-Charity-Platform | correct | The model only routed both webhook `current_period_end` reads through the deterministic `getSubscriptionPeriodEnd` wrapper, with no item choice. The app's checkout creates single-price subscriptions, so the wrapper reads that item's period. The patch warns that the wrapper returns nothing when items have different periods. The rest (`allowed_payment_method_types: ["card"]`, the invoice subscription move, the API version and stripe-node 23 upgrade) came from rules. |
| Before | refit-billing-demo                            | correct | It passed where the hosted job had regressed. The edit is confined to the cited finding and validated.                                                                                                                                                                                                                                                                                                                                                                               |
| After  | (none)                                        |         | No after case passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Remaining failures by cause

1. **Request property the upgraded types reject** (`trial_from_plan`; 3 of 8): now a deterministic stop (50429c7). A replacement rule needs an owner decision on what to send instead.
2. **The model chooses a subscription item for the billing period** (2 of 8): now a deterministic stop, both after the model answers (e4882da) and before a repair is requested (001fa3e). A rule needs an owner decision on item selection.
3. **AI replacement does not cover its cited finding** (5 of 24 before): three were the `trial_from_plan` cases above. adityayaduvanshi, afdon and AlefeSk8 were not measured after (Blocked); 72562ff gives such cases one corrected request.
4. **AI evidence limit** (cyberdreadx; 64 KiB): unchanged, and correctly stops.
5. **Guard rejection** (brendansudol; a pre-existing field substituted for a removed one): the guard is working as intended.

## Spend

The budget ledgers recorded $0.058 (before) and $0.005 (after), $0.063 in all against the lane's $15.

## Blocked

- **Docker.** Validation of after cases 8 to 22 and the billing demo. The disk filled about 08:53 UTC, Docker Desktop crashed at 08:58 and was still not responding at 15:10 UTC. It was not restarted because other agents share it.
  - To finish: with Docker healthy, delete those case directories under the after output and rerun `scripts/ai-patch-eval.sh` from a worktree at 001fa3e or later (it resumes). Then score with `npm run eval:ai-patch`.
- **AWS.** `node scripts/aws-benchmark.mjs launch` was first refused by this session's permission classifier. A later launch from lane PG9 on 2026-10-22 got `UnauthorizedOperation`: `ec2:RunInstances` is explicitly denied by an organization service control policy. Validation on AWS needs that policy changed.
