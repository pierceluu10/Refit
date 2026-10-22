# Launch checklist (overnight run, 2026-10-22)

PP10 keeps this file current through the night. It tracks what stands between `main` and the first customer, following the five launch steps in `OVERNIGHT-AGENTS.md`. Statuses:

- **On main**: verified behaviour, cited from [Readiness](READINESS.md).
- **In PR**: a lane PR claims it. The review column says what PP10 found at the reviewed commit; nothing in a PR is verified until its findings are fixed and CI (and, where gated, the author's Postgres or Docker run) passes.
- **No PR yet**: the lane has not pushed.
- **Blocked** or **Needs owner decision**: copied from the lane PR or found in review, with its reason.

Last pass: 2026-10-22 04:10 EDT (pass 2). Base: `main` at `7b2c86a`. Reviews are PR comments; each names the commit it reviewed.

## Landed on main during the night

- **#173** (Furqan, outside the overnight plan, merged by its author at 03:54 before PP10's review). Every live OpenAI and Anthropic model match now ends as a replacement, a stop or an `unresolved` entry. Review findings that now apply to `main`: the `paths` fallback widens what can be edited for every provider, unmeasured on Stripe and Shopify; per-platform model records (including the plain first-party ID) are now catalog, which removes them from `refit deadlines` and alerts; a second retiring model on an already-handled line gets no outcome. PP10 qualified the checkpoint and benchmark text accordingly. The follow-up fixes belong to FG9 or Furqan (see Requests).

## What blocks the first customer, in order

1. **Accepting a second account.** PG10 (#177) adds `REFIT_HOSTED_ACCOUNTS`, caps and fair claiming, but its claim and webhook paths can deadlock (review) and fairness has no concurrent test. Adding the first customer account stays an owner decision.
2. **Isolation between accounts.** Jobs share the worker's Fly Machine and Docker daemon. PG3 (#176) has only the Machines client so far (retry backoff and double-create bugs found); OG3 (#175) hardens the sandbox but changes owner-decided memory profiles; OG2 (#171) wrote the threat model.
3. **Inventory on install.** PG1 (#170) is built and tagged `ready/PG1`, but an unapproved repository can make the worker read files outside its checkout (review). Must merge after #177.
4. **Approval without the CLI.** PG2: no PR yet. Until it lands the owner runs `refit hosted approve` per repository.
5. **What the customer is told.** PP8: no PR yet. Review added two items it must cover: inventories store source excerpts from unapproved repositories, and Slack receives repository names once PP5's notices are on.
6. **Monitoring and the living report.** PG4, PG5: no PR yet.
7. **Operating the service.** PP5 (#178) built read-only `refit hosted` commands and a runbook, but the runbook leaves owner-only commands unmarked (review). PP7: no PR yet.
8. **Fix quality and benchmark trust.** Steps 4 and 5 improve what a customer receives; none blocks an install.

## 1. Install

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| An allowlisted account other than the owner can install | In PR #177 | Allowlist defaults to `REFIT_HOSTED_OWNER`; not-allowed installs clone nothing (test read, Postgres-gated, author-run) | PG10 fixes: lock-order deadlock, concurrent-claim test, `not-allowed` status on suspend/delete; owner decision: first customer account |
| One account's jobs cannot reach another's | In PR #176 (client only) and #175 | Machines client reviewed; runner, result channel, reaper not built | PG3, OG3; owner decision: turn on job machines |
| Per-installation caps, fair claiming, GitHub rate limits, per-installation AI ledger | In PR #177 | Rate-limit waits bounded (120 s, 2 retries) in `pipeline/github.test.ts` | PG10; owner decisions: default caps, no global AI cap |
| Approve from GitHub without the CLI | No PR yet | – | PG2; owner decision: App Issues permission |
| Every installation and repository webhook handled | On main: install, uninstall, suspend, repository removal | [Readiness: hosted enrollment](READINESS.md#october-21-checkpoint-single-tenant-hosted-enrollment-unreleased-after-0390) | PP6 (no PR yet) |
| The customer knows what happens after install and what data Refit keeps | No PR yet | – | PP8 |
| Threat model and security review of the hosted worker | In PR #171 | `docs/SECURITY.md`; constant-time status token check and secret redaction tested in CI | OG2 fix: replay refusal can never be recovered by redelivery; owner decisions T2, T4, T12 |

## 2. Detect

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| Read-only inventory of every installed repository, approved or not | In PR #170 (`ready/PG1`) | Postgres-gated tests author-run; 30-repository sample not committed yet | PG1 fix: reads outside the checkout; depends on #177 |
| JS/TS SDKs and locked versions for catalog providers | On main | [Readiness: provider detection](READINESS.md#october-15-checkpoint-provider-detection-and-agent-catalog-0340) | FG3, FG6, FG10, FP1, FP2, FP5, FP6, FP7 (no PRs yet) |
| AI model call sites | On main for OpenAI and Anthropic, now with an outcome for every live match (#173); Gemini report only | [Readiness: no silent model exposures](READINESS.md#october-22-checkpoint-no-silent-model-exposures-unreleased-after-0390) | FG9, FP3, FP4, FP10 (no PRs yet); owner decisions on #173 |
| Raw HTTP API hosts | No PR yet | – | FG4 |
| Python and Go | No PR yet | [Language goals](LANGUAGE-GOALS.md) | FG1, FG2 |
| Package manifests of other ecosystems, and monorepo attribution | No PR yet | – | FG5, FP8 |
| Review-only requests for Meta, PayPal and Shopify REST | On main for Meta Graph and PayPal; WhatsApp and Messenger changelogs unreviewed | [Meta Graph](META-GRAPH.md), [PayPal](PAYPAL.md) | FG7, FG8, FP9 (no PRs yet) |
| Inventory precision and recall against hand labels | In PR #172 (scripts only) | No frozen list, labels or results yet | OG1 fix: scorer drops missing repositories silently |

## 3. Monitor

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| Deadline alerts at 90, 30 and 7 days | On main locally (`refit serve --deadline-alerts`, enrolled repositories, off by default); not hosted | [Deadlines](DEADLINES.md) | PG4 (no PR yet); owner decision: enable hosted alerts |
| Re-check on push and on a schedule | No PR yet | – | PG4 |
| One living report per repository | No PR yet | – | PG5; owner decision: enable `REFIT_HOSTED_REPORTS` |
| Deadline registry maintains itself | On main for Anthropic (`--sync anthropic`) | [Readiness: Anthropic deadlines](READINESS.md#october-20-checkpoint-self-maintaining-anthropic-deadlines-unreleased-after-0390) | PG6 (no PR yet) |
| Runbook, health checks, failed-job notices | In PR #178 | `refit hosted jobs|receipt|targets|health` run only SELECTs (code read); notifier off by default (test) | PP5 fixes: mark owner actions, redact before truncating; owner decisions: Slack webhook, no drain switch |
| Schema migrations and data retention | No PR yet | – | PP7 |

## 4. Fix

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| Stripe: validated draft PRs | On main | [Benchmarks](BENCHMARKS.md) | OP5, OP3 (no PRs yet); #173's `paths` widening unmeasured on Stripe |
| Shopify: validated draft PRs | On main for pin moves only; SDK major upgrade blocks 44 of 200 frozen apps | [Benchmarks: Shopify](BENCHMARKS.md#shopify) | PG9 (no PR yet); owner decision: the default |
| OpenAI and Anthropic model retirements | On main (`refit serve --model-fixes`, off by default) | [Readiness: model fixes](READINESS.md#october-20-checkpoint-automatic-model-fixes-in-enrolled-repositories-unreleased-after-0390) | FG9 (no PR yet); pre-existing #150 (D-06 to D-08) |
| AI patches that pass validation | On main, but the live hosted job regressed on 2026-10-22 | [Readiness: hosted live check](READINESS.md#october-21-checkpoint-single-tenant-hosted-enrollment-unreleased-after-0390) | PG8 (#179): frozen set of 23 Stripe cases plus the billing demo checked against their sources; no before/after yet; AWS Blocked by the session's permission classifier |
| Validation sandbox and dependency preparation | In PR #175 (sandbox) | New `docker run` flags string-checked only; gated Docker suites not run | OG3 fixes: best-effort reaper, tests for SIGKILL and caps; OP9, OP4, OP6, OG10, PP2 (no PRs yet) |
| The whole customer journey in one test | No PR yet | – | PG7 (consumes PG1, PG2) |

## 5. Trust the numbers

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| Benchmarks from a pinned commit, reproducible on AWS | On main (#168 runner); hardening in PR #174 | New helper tests run ungated in CI; AWS smokes not done yet | PP4 fix: AWS stderr can carry the account ID into pasted errors |
| Same outcome when run twice | No PR yet | – | PP3 (needs PP4) |
| Hand labels behind precision and recall | Partial on main: 30 of the original 100 Stripe and 32 of 100 deadline repositories hand-labelled; AI-app labels AI-assisted. 120 fresh-set Stripe repositories labelled blind in PR #181: 10 of 40 that Refit called not affected are broken; precision and recall not measured yet | [Benchmarks](BENCHMARKS.md#what-these-benchmarks-do-not-show) | OG4, OG1, OG7, OG8 |
| Every claim in the docs matches its evidence | No PR yet | – | OP10 (needs OG5) |
| Self-describing, resumable benchmark runs | In PR #182 | Schemas and validator: all 24 committed results files validate at `d67fa6f` (reviewer ran the validator); harness record and `--resume` not built | OG5 |
| Upstream replay | No PR yet | [Upstream replay](UPSTREAM-REPLAY.md) | OG6 |
| Cheap stops run before expensive validation | No PR yet | – | PP2 |
| Capacity and cost per customer | No PR yet | – | PP9 (needs PP4) |
| Stable CI | In PR #180 | Order-dependence fix is strict; CI 1693 passed, 83 skipped, same as base | OP1: record the post-fix shuffle run; speed claims unbacked |
| Gated suites in CI, supply chain, public-repository readiness, first-run UX | No PR yet | – | OG9, OP7, OP8, OP2 |
| Post-merge rerun on the merged `main` | Morning only | – | PP1 |

## Lane PRs

| Lane | PR | Reviewed at | Review summary | Depends on |
|---|---|---|---|---|
| PG1 | #170 | `ea70fc7` | Reads outside the checkout via `.refit.json`/`providerConfig`; caps checked after checkout; missing "Depends on" line | #177 |
| OG2 | #171 | `3c41291` | Replay refusal is permanent; state-directory scan reads nothing; Postgres tests author-run | – |
| OG1 | #172 | `e69a776` | Scorer drops missing repositories and skips the list digest; doc drift; sampling bias | – |
| PP4 | #174 | `c67e145` | Raw AWS stderr can leak the account ID; torn shard results break `collect` | – |
| OG3 | #175 | `0dda480` | `--memory-swap` tightens owner profiles; reaper failure breaks checks; headline fixes untested | – |
| PG3 | #176 | `dc6c829` | No backoff on HTTP retries; retried create can start two machines | – |
| PG10 | #177 | `4969252` | Lock-order deadlock; no concurrent-claim test; wrong status for disallowed suspend/delete | – |
| PP5 | #178 | `83f9a42` | Owner-only commands unmarked in runbook; redaction after truncation | – |
| PG8 | #179 | `690c2c8` | Its scratch eval runner can delete another lane's Docker lock; spend not recorded; billing-demo case scores `missing`; AWS launch Blocked | – |
| OP1 | #180 | `a307cb4` | Correct and strict; post-fix shuffle run and speed numbers not recorded | – |
| OG4 | #181 | `1949a4b` | Labels look blind (120 repositories); scorer cannot read the committed fresh results; request-parameter recall unmeasured | – |
| OG5 | #182 | `d360a8d` | Harness-era runs can pass as "predates"; dirty-tree rule unenforced; resume needs uniqueness and coverage checks | – |
| OP8 | #183 | next pass | – | – |
| FP1 | #184 | next pass | – | – |
| FG9 | #185 | next pass | – | – |

No PR yet: PG2, PG4, PG5, PG6, PG7, PG9, PP2, PP3, PP6, PP7, PP8, PP9; every Furqan lane except FP1 and FG9; OG6 to OG10, OP2 to OP7, OP9, OP10.

## Needs owner decision

Ranked by what blocks the first customer.

1. **First customer account** (#177): add an account to `REFIT_HOSTED_ACCOUNTS` while the machine, Docker daemon, volume and secrets are shared (until PG3's job machines).
2. **#173's widening, now on `main`**: (a) the `paths` fallback in `pipeline/source-imports.ts` can make previously skipped calls editable for every provider, unmeasured on Stripe and Shopify; (b) per-platform model records, including the plain first-party ID, are catalog, which drops them from `refit deadlines`, `--fail-within` and alerts. Accept, or ask for a revert or a flag. AGENTS.md says not to widen replacements without a decision.
3. **Inventory data retention** (#170): inventories run by default on unapproved repositories and store trimmed source lines, which can contain hard-coded keys.
4. **Account data** (#177): logins and repository names of not-allowed accounts are now stored.
5. **AI exposure** (#177): there is no global AI cap; exposure is allowed installations times `REFIT_AI_BUDGET_USD`.
6. **Default caps** (#177): 1440 jobs and 500 inventories per installation per UTC day, not measured against real traffic; the jobs cap holds back more than 5 targets.
7. **Security residuals** (#171): T2 (an identical legitimate delivery is refused and cannot be redelivered), T4 (owner matched by login until PG10 keys on account ID), T12 (switch `REFIT_DATABASE_URL` to `sslmode=verify-full` with the Supabase CA; owner action). The next deploy adds the `refit_deliveries_hash` index.
8. **Sandbox memory** (#175): `--memory-swap` equal to `--memory` makes the 3 GiB and 5 GiB profiles strict on hosts with swap.
9. **Operations** (#178): enable `REFIT_SLACK_WEBHOOK_URL` (Slack then receives customer repository names and error text); there is no drain switch, so a deploy interrupts running jobs.
10. **Job machines** (#176, expected): create the job Fly app and its token.
11. **AI output reservation** (#179): 25,000 output tokens per request raises every AI caller's worst-case reservation (about $0.005 to $0.03 on `gpt-5.6-luna`), still capped by `REFIT_AI_BUDGET_USD`.
12. **AWS for runner sessions** (#179): `scripts/aws-benchmark.mjs launch` was refused by the session's permission classifier, so AWS lanes run locally or wait for the owner.
13. **Frozen Anthropic set** (#173): 12 of its 50 repositories are copies of a leaked proprietary source tree, named in public docs.

Known before the run:

- **#150**: merging it accepts the "Sourced parameter stops" bullet it adds to `AGENTS.md`. It now also conflicts with #173 in the stop-reason chain of `pipeline/model-retirements.ts`.
- **#140, #142, #144**: the AI agents phase 1 to 3 stack. #140 conflicts with `main`. Decide whether it is superseded.

## Requests for other lanes

| From | To | Request |
|---|---|---|
| #171 OG2 | PG10 | Key `REFIT_HOSTED_ACCOUNTS` on the numeric account ID (T4) |
| #171 OG2 | PP7 | Never prune `refit_deliveries.hash`; fold the `refit_deliveries_hash` index into migrations |
| #171 OG2 | Pierce | Load the App key once into a `KeyObject` and delete `/run/refit/app.pem` (T13) |
| #171 OG2 | OG3 | Spawn `docker` and `oasdiff` with a minimal environment (T6) |
| #171 OG2 | PG2, PG3 | Meet the numbered requirements in `docs/SECURITY.md` |
| #177 PG10 | PG1 | Reserve inventory through the store and read `refit_installations.allowed` |
| #177 PG10 | PG3 | Proxy AI budget reservations through the control process |
| #177 PG10 | PP7 | Fold `TENANCY_SCHEMA` into versioned migrations; add `ON DELETE` and usage pruning |
| #170 PG1 | FG9 | `MODEL_CALLS` in `pipeline/model-retirements.ts` is now exported |
| #178 PP5 | PP7 | Expose the applied schema version for `refit hosted health` |
| #170, #177, #178 | PP8 | Data handling must list stored source excerpts, other accounts' logins, and Slack as a recipient |
| PP10 review of #173 | FG9 | Key `covered` on the model as well as file:line; fix the custom-host wording for official-host paths; drop the dead WeakSet/WeakMap entries; update `docs/DEADLINES.md:235` |

## Morning merge order

Producers before consumers, from the three Dependencies tables and each PR's "Depends on" line. Merge only what has passed CI, been read, and had its review findings answered.

1. **OP1** (#180), so CI is reliable for every later merge.
2. **Pierce, hosted chain:** PG10 (#177) → PG1 (#170) → PG4 → PG5, then PG2 → PG7 and PP8. PG10 changes `runHostedService`'s `owner` option to `tenancy`; every hosted PR merged after it must adapt its tests.
3. **Other hosted lanes:** PG3 (#176), PP6, PP5 (#178), PP7, then OG2 (#171). OG2 asks to go before PG10; PP10 recommends after, because PG10's interface change is the larger one and OG2's fixes are small.
4. **AWS chain:** PP4 (#174) → PP3, PP9.
5. **Model detection:** decide #150 and the #140 stack first, then FG9 → FP3, FP4, FP10.
6. **Furqan, other chains:** FG1 → FP10, FG2; FG5 → FP8; FG4 → FG3; then FG10, FP5, FG6, FP7, FP1, FP2, FP6, FG7, FG8, FP9.
7. **Otabek:** OG5 (#182) → OP10, then OG9 (needs OG5, OP1); OG4 (#181) → OP5; OG3 (#175) → OP6 → OG10; OP9 → OP4; then OP3, OP2, OP7, OP8, OG1 (#172), OG7, OG8, OG6.
8. **Validation and fix lanes that touch the same files:** PP2 (after OP4, OP9 and OG3), then PG8 (#179), PG9, PG6.
9. **PP10** (#169), last, so the shared docs describe what merged.
10. Start **PP1** on the merged `main`.

### Conflicts to expect

- `pipeline/hosted-service.ts`, `pipeline/hosted-store.ts`, `pipeline/hosted-cli.ts`: #170, #171, #176, #177, #178, and later PG2, PG4, PG5, PP6, PP7. #177 and #178 collide around the installation check (~`hosted-service.ts:226`) and the CLI usage line. Rerun the Postgres suites after each merge.
- `docs/HOSTED-ONBOARDING.md`: #170, #177, #178.
- `scripts/hosted-entrypoint.sh`: #176, #178.
- `pipeline/validation.ts`, `pipeline/dependency-preparation.ts`: #175 moves `containerCheck` to an options object (~8 call sites) and makes `dockerSandboxArguments` require `timeoutMs`; OP4, OP6, OP9, OG10 and PP2 will conflict.
- `pipeline/model-retirements.ts`: #150 conflicts with `main` since #173; FG9, FP3, FP4, FP10 and #170 (one `export`) also touch it.
- `pipeline/agent-catalog.ts`, `data/deadlines.json`: FG3, FG6, FG10, FP5, FP7. Keep both sides' entries, then run `npm run deadlines:check`.
- `pipeline/cli.ts`: most lanes add a command or flag; keep both sides.
- `docs/benchmarks/schemas/files.json`: once #182 merges, every PR that adds a `docs/benchmarks/*-results.json` (likely OG6, OG7, OG8, PP1, PP3) must list it there, or `npm test` fails on `main`.
