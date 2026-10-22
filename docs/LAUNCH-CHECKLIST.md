# Launch checklist (overnight run, 2026-10-22)

PP10 keeps this file current through the night. It tracks what stands between `main` and the first customer, following the five launch steps in `OVERNIGHT-AGENTS.md`. Statuses:

- **On main**: verified behaviour, cited from [Readiness](READINESS.md).
- **In PR**: a lane PR claims it; the evidence column says what PP10 checked.
- **No PR yet**: the lane has not pushed.
- **Blocked** or **Needs owner decision**: copied from the lane PR, with its reason.

Last pass: 2026-10-22 03:45 EDT (pass 1). Base: `main` at `fb0143a`. No lane PR had been pushed at this pass.

## What blocks the first customer, in order

1. **Accepting a second account.** Hosted mode enrolls only `REFIT_HOSTED_OWNER`'s installations. PG10 adds `REFIT_HOSTED_ACCOUNTS`; adding the first customer account is an owner decision.
2. **Isolation between accounts.** Jobs share the worker's Fly Machine and its in-VM Docker daemon. PG3 (one machine per job, off by default), OG3 (sandbox hardening) and OG2 (security review) together decide whether a second account is safe.
3. **Inventory on install.** Without PG1 an installed repository without an approval shows the customer nothing.
4. **Approval without the CLI.** Without PG2 the owner must run `refit hosted approve` for every customer repository.
5. **What the customer is told.** PP8's install guide and data-handling page.
6. **Monitoring and the living report.** PG4 and PG5; both post to customer repositories, so each is off by default and needs an owner decision.
7. **Operating the service.** PP5 (runbook) and PP7 (migrations and retention).
8. **Fix quality and benchmark trust.** Everything in steps 4 and 5 improves what a customer receives, but none of it blocks an install.

## 1. Install

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| An allowlisted account other than the owner can install | Not on main: owner-only enrollment | [Readiness: hosted enrollment](READINESS.md#october-21-checkpoint-single-tenant-hosted-enrollment-unreleased-after-0390) | PG10; owner decision: add the first customer account |
| One account's jobs cannot reach another's | Not on main: jobs share one Fly Machine and Docker daemon | Same checkpoint | PG3 (`--job-machines`, off by default), OG3, OG2; owner decision: turn on job machines |
| Per-installation caps, fair claiming, GitHub rate limits, per-installation AI ledger | Not on main | – | PG10 |
| Approve from GitHub without the CLI | Not on main: `refit hosted approve` only | Same checkpoint | PG2 (`REFIT_HOSTED_APPROVAL_ISSUES`, off by default); owner decision: App Issues permission |
| Every installation and repository webhook handled | On main: install, uninstall, suspend, repository removal | Same checkpoint | PP6 widens coverage |
| The customer knows what happens after install and what data Refit keeps | Not on main | – | PP8 |
| Threat model and security review of the hosted worker | Not on main | – | OG2 |

## 2. Detect

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| Read-only inventory of every installed repository, approved or not | Not on main: repositories are recorded, not scanned | Same checkpoint (26 repositories recorded live) | PG1 (consumes PG10's allowlist) |
| JS/TS SDKs and locked versions for catalog providers | On main: `detectProviders` and the agent catalog | [Readiness: provider detection](READINESS.md#october-15-checkpoint-provider-detection-and-agent-catalog-0340) | FG3, FG6, FG10, FP1, FP2, FP5, FP6, FP7 widen the catalog |
| AI model call sites | On main for OpenAI and Anthropic; Gemini report only | [Readiness: Gemini](READINESS.md#october-21-checkpoint-gemini-detection-report-only-unreleased-after-0390) | FG9, FP3, FP4, FP10 |
| Raw HTTP API hosts | Not on main | – | FG4 |
| Python and Go | Not on main | [Language goals](LANGUAGE-GOALS.md) | FG1, FG2 |
| Package manifests of other ecosystems, and monorepo attribution | Not on main | – | FG5, FP8 |
| Review-only requests for Meta, PayPal and Shopify REST | On main for Meta Graph and PayPal; WhatsApp and Messenger changelogs unreviewed | [Meta Graph](META-GRAPH.md), [PayPal](PAYPAL.md) | FG7, FG8, FP9 |
| Inventory precision and recall against hand labels | Not measured | – | OG1 |

## 3. Monitor

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| Deadline alerts at 90, 30 and 7 days | On main locally (`refit serve --deadline-alerts`, enrolled repositories, off by default); not hosted | [Deadlines](DEADLINES.md) | PG4; owner decision: enable hosted alerts |
| Re-check on push and on a schedule | Not on main for hosted | – | PG4 |
| One living report per repository | Not on main | – | PG5 (`REFIT_HOSTED_REPORTS`, off by default); owner decision: enable |
| Deadline registry maintains itself | On main for Anthropic (`--sync anthropic`) | [Readiness: Anthropic deadlines](READINESS.md#october-20-checkpoint-self-maintaining-anthropic-deadlines-unreleased-after-0390) | PG6 (OpenAI, Gemini, daily workflow) |
| Runbook, backups, alerts on the worker | Not on main | – | PP5 |
| Schema migrations and data retention | Not on main | – | PP7 |

## 4. Fix

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| Stripe: validated draft PRs | On main | [Benchmarks](BENCHMARKS.md) | OP5 (mined rules), OP3 (PR body) |
| Shopify: validated draft PRs | On main for pin moves only; SDK major upgrade blocks 44 of 200 frozen apps | [Benchmarks: Shopify](BENCHMARKS.md#shopify) | PG9 (flag off by default); owner decision: the default |
| OpenAI and Anthropic model retirements | On main (`refit serve --model-fixes`, off by default) | [Readiness: model fixes](READINESS.md#october-20-checkpoint-automatic-model-fixes-in-enrolled-repositories-unreleased-after-0390) | FG9; pre-existing #150 (D-06 to D-08) |
| AI patches that pass validation | On main, but the live hosted job regressed on 2026-10-22 | [Readiness: hosted live check](READINESS.md#october-21-checkpoint-single-tenant-hosted-enrollment-unreleased-after-0390) | PG8 |
| Dependency preparation and validation on more repositories | On main for npm, pnpm, Yarn 1 | [Dependencies](DEPENDENCIES.md) | OP9, OP4, OP6, OG10, PP2 |
| The whole customer journey in one test | Not on main | – | PG7 (consumes PG1, PG2) |

## 5. Trust the numbers

| Requirement | Status | Evidence | Blocking lane or decision |
|---|---|---|---|
| Benchmarks from a pinned commit, reproducible on AWS | On main (#168 runner) | [AWS benchmarks](AWS-BENCHMARKS.md) | PP4 hardens the runner |
| Same outcome when run twice | Not measured | – | PP3 |
| Hand labels behind precision and recall | Partial: 30 of the original 100 Stripe repositories and 32 of 100 deadline repositories hand-labelled; AI-app labels are AI-assisted; fresh sets unlabelled | [Benchmarks](BENCHMARKS.md#what-these-benchmarks-do-not-show) | OG1, OG4, OG7, OG8 |
| Every claim in the docs matches its evidence | Not checked automatically | – | OP10 |
| Harness reliability and upstream replay | – | [Upstream replay](UPSTREAM-REPLAY.md) | OG5, OG6 |
| Cheap stops run before expensive validation | – | – | PP2 |
| Capacity and cost per customer | Not measured | – | PP9 |
| Post-merge rerun on the merged `main` | Morning only | – | PP1 |
| Stable CI, gated suites, supply chain, public-repository readiness, first-run UX | – | – | OP1, OG9, OP7, OP8, OP2 |

## Needs owner decision

Collected from lane PRs. Each entry names its PR.

- *(none yet)*

Known before the run:

- **#150** (outside the overnight plan): merging it accepts the "Sourced parameter stops" bullet it adds to `AGENTS.md`, marked pending the owner's review.
- **#140, #142, #144** (outside the overnight plan): the AI agents phase 1 to 3 stack. #140 conflicts with `main`; #150's description says the widening it carries was approved on #140. Decide whether the stack is still needed or superseded before merging FG9, FP3 or FP4, which edit the same model-detection files.

## Requests for other lanes

Collected from lane PRs. Each entry names the requesting and the receiving lane.

- *(none yet)*

## Morning merge order

Producers before consumers, from the three Dependencies tables. PR numbers are filled in as lanes open them. Merge only what has passed CI and been read.

1. **OP1** (test-suite flakes), so CI is reliable for every later merge.
2. **Pierce, hosted chain:** PG10 → PG1 → PG4 → PG5, then PG2 → PG7 (needs PG1, PG2) and PP8 (needs PG1, PG5).
3. **Pierce, other hosted lanes:** PG3, PP6, PP5, PP7, then OG2's hosted fixes on top of them.
4. **Pierce, AWS chain:** PP4 → PP3, PP9.
5. **Furqan:** FG1 → FP10, FG2; FG5 → FP8; FG4 → FG3; FG9 → FP3, FP4; then FG10, FP5, FG6, FP7, FP1, FP2, FP6, FG7, FG8, FP9.
6. **Otabek:** OG5 → OP10, then OG9 (needs OG5, OP1); OG4 → OP5; OP9 → OP4; OP6 → OG10; then OG3, OP3, OP2, OP7, OP8, OG1, OG7, OG8, OG6.
7. **Validation and fix lanes that touch the same files as step 6:** PP2 (after OP4 and OP9), then PG8, PG9, PG6.
8. **PP10** (this branch), last, so the shared docs describe what merged.
9. Start **PP1** on the merged `main`.

### Conflicts to expect

- `pipeline/hosted-service.ts` and `pipeline/hosted-store.ts`: PG1, PG2, PG3, PG4, PG5, PG10, PP5, PP6, PP7 and OG2. Merge the hosted chain in order and rerun the Postgres suites after each.
- `pipeline/agent-catalog.ts` and `data/deadlines.json`: FG3, FG6, FG10, FP5, FP7. Keep both sides' entries, then run `npm run deadlines:check`.
- `pipeline/cli.ts`: most lanes add a command or flag. Additive conflicts only; keep both.
- `pipeline/model-retirements.ts`: FG9, FP3, FP4, FP10, and the pre-existing #150.
- `pipeline/validation*.ts`, `pipeline/dependency-preparation.ts`, `pipeline/manager-install.ts`: OP4, OP6, OP9, OG10, PP2, and OG3 for the sandbox flags.
