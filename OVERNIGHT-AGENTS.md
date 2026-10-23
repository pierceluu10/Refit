# Refit overnight: 30 goals and 30 prompts

Sixty lanes, split evenly across **Pierce**, **Furqan** and **Otabek** (10 goals and 10 prompts each). Every lane is real launch work, meant to run **at least 3 hours** with no questions. Each one commits regularly and ends in an open PR against `main` with a short summary.

**How it runs overnight without anyone.** Nobody starts lanes by hand. Each person starts **7 sessions** at bedtime: 7 runners (Pierce: 6 runners plus the PP10 integrator). Each runner works through a queue of 2–3 lanes in order and starts the next lane by itself, so the night never stalls waiting for a person.
- A goal lane's `/goal` block is that lane's spec and completion condition. A prompt lane's "Done when" plus "Keep going" is its spec.
- The runner's own `/goal` (in "Runner queues" below) covers the whole queue.

Before starting, do the [preflight](#preflight-each-person-at-bedtime).

## What "launch-ready" means after this run

A customer installs the Refit Agent GitHub App, and then:

1. **Install.** An allowlisted account can install the App safely. Its jobs are isolated from other accounts, and it can approve Refit from GitHub without the CLI. (PG2, PG3, PG10, PP6, PP8, OG2, OG3)
2. **Detect.** Within minutes, Refit takes a read-only inventory of every installed repository: which APIs, SDKs, versions, AI models and raw HTTP hosts it uses, across JS/TS, Python, Go and package manifests of the other major ecosystems. (PG1; all Furqan lanes)
3. **Monitor.** Refit keeps one living report per repository and alerts before deadlines (90, 30 and 7 days). It re-checks on push and on a schedule, and its deadline registry maintains itself from provider pages. (PG4, PG5, PG6, PP5, PP7)
4. **Fix.** For supported cases (Stripe, Shopify, OpenAI and Anthropic model retirements), Refit opens a validated draft PR. (PG8, PG9, FG9, OP5, OP6, OP9, OG10)
5. **Trust the numbers.** Every benchmark claim comes from a pinned commit, is reproducible on AWS, has hand labels behind its precision and recall, and gives the same outcome when run twice. (PP2–PP4, PP9, OG1, OG4–OG8, OP10, then PP1 after the morning merge)

**Building lanes benchmark themselves.** A lane that changes behaviour measures its own branch before and after. Overnight, AWS goes only to lanes that build something or make benchmarks trustworthy. The full-set rerun (PP1) runs once, in the morning, on merged `main`, because that is the run that tells you whether the night's work helped and how the PRs interact.

## Assumptions (stated, so nobody has to ask)

1. **Base.** [#166](https://github.com/pierceluu10/Refit/pull/166) (hosted enrollment) and [#168](https://github.com/pierceluu10/Refit/pull/168) (AWS benchmark runner) are merged. Every lane branches from `origin/main`.
2. **Three people, three machines.** Each person runs their own 20 lanes on their own laptop, through **7 sessions at once**, using the runner queues in their section. Each person needs Docker running and push access to `pierceluu10/Refit`. If you lack push access, every lane is Blocked: fix that first.
3. **Access differs.**
   - **Only Pierce has AWS and an AI budget.** The OpenAI key is in Pierce's `.env`.
   - **Furqan and Otabek make no AWS calls and no model requests.** Their lanes are written so they never need either.
   - Nobody uses Fly or Supabase tonight.
4. **AWS (Pierce only).**
   - Profile `refit`, region `us-east-2`, free plan (on-demand only; spot is denied).
   - 16 on-demand vCPUs, of which the teammate's `refit-docker` instance uses 4, leaving **at most 3 `c7i.xlarge` shards running at once across all of Pierce's lanes**.
   - Raise the spend limit to about $100 before starting; $120 of credits are available. Each AWS lane stays under **$10 of compute**.
5. **AI budget (Pierce only).** PG8 may spend $15 under `REFIT_AI_BUDGET_USD=15`. No other lane may make a model request.
6. **Owner decisions** recorded in `AGENTS.md` stay as they are.
   - A lane that finds a gate worth relaxing builds the change behind a flag that is off by default, measures it, and writes "Needs owner decision" with the evidence in the PR.
   - A lane never flips a default and never widens what Refit edits without a recorded decision.
7. **Customer-facing behaviour is off by default.** Anything that posts to a customer's repository (issues, check runs, comments, PRs) sits behind a flag that is off by default, and enabling it is listed as "Needs owner decision". The same applies to anything that would need a GitHub App setting changed, such as new permissions, new events or a Setup URL. The owner changes App settings by hand in the morning.
8. **Web facts.** Lanes may read vendor documentation, changelogs and the npm registry. Facts added to registries or catalogs come only from pages the agent actually read, recorded with `source` and `checkedAt`, never from memory or search snippets. A page that is blocked or unreachable is recorded as Blocked, not guessed.
9. **Where this file lives.** It is committed at the root of `main` as `OVERNIGHT-AGENTS.md`. Every person links it into their home folder with `ln -sf "$REFIT/OVERNIGHT-AGENTS.md" ~/OVERNIGHT-AGENTS.md`, and every lane refers to it there. Lanes never edit it.

## Shared rules (every goal and prompt includes these by reference)

Every lane must follow these. Read them before anything else.

- **Read first.** Read `AGENTS.md`, `docs/READINESS.md`, `docs/ARCHITECTURE.md` and the docs and code your lane touches before writing anything. Reuse existing modules and follow existing patterns. Add no new dependency unless the lane says so.
- **Isolation.** `$REFIT` is your main clone of `pierceluu10/Refit` (Pierce: `~/Repos/Refit-hosted`). Work in your own worktree:
  - Run `git -C "$REFIT" fetch origin && git -C "$REFIT" worktree add -b <branch> "$REFIT-<lane>" origin/main`, then `npm ci` inside the worktree.
  - Never touch another lane's worktree, branch or PR. Never touch Pierce's website checkout `~/Repos/Refit`.
- **Owned files.** Each lane lists what it owns.
  - Lanes owned by another person are off limits. If you need something changed there, describe it in your PR under "Requests for other lanes".
  - Shared docs (`docs/READINESS.md`, `docs/BENCHMARKS.md`, `AGENTS.md`, `README.md`, `docs/CLI.md`) are edited only by PP10. Put your findings in your own doc and your PR summary; PP10 folds them in.
  - If you must touch a shared code file (`pipeline/cli.ts`, `pipeline/agent-catalog.ts`, `data/deadlines.json`, `pipeline/deadline-exposure.ts`, `pipeline/hosted-service.ts`, `pipeline/hosted-store.ts`), keep the edit small and additive. Put the logic in your own new module, and say so in the PR.
- **Staying current.**
  - Before every push, run `git fetch origin && git merge origin/main`. Never rebase a pushed branch.
  - Resolve conflicts in JSON lists by keeping both sides' entries, then rerun the checks.
- **Commits.** Commit at every working checkpoint, at least hourly. Use Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `perf:`, `ci:`) with no co-author trailers and no "Generated with" lines. Push after each commit.
- **PR.**
  - Open a PR against `main` as soon as the first real commit exists, and keep it updated.
  - The description is a few bullets: what changed and why, how it was tested (exact commands and counts), what was not verified, "Needs owner decision" items, "Requests for other lanes", and Blocked items.
  - Never merge, never force-push, never push to `main`.
- **Checks before each push.** Run `npm run typecheck`, `npm run format:check`, `npm test -- --maxWorkers=2` and `npm run build`. Always pass `--maxWorkers=2` to vitest: seven sessions share one laptop. OP1 alone may use other worker counts, and only for its measurements.
  - Report gated suites (Docker, Postgres, oasdiff, SDK) separately and honestly.
  - A lane is not done while any of these fail because of its changes.
- **Minimum time.** A lane runs at least 3 hours of real work.
  - A goal is not met until the branch's first and last commits are at least 3 hours apart, unless every "Keep going" item is also done.
  - A prompt that reaches its "Done when" early continues down its "Keep going" list, in order.
  - Padding, cosmetic churn and prose-only commits do not count.
- **Honesty.**
  - Label simulations as simulations. Never claim a live provider, repository or AI result you did not observe. No invented customers, metrics or passing checks.
  - Benchmark numbers come only from a clean, pinned Refit commit (state it), never from a dirty tree.
  - Gated suites that did not run are reported as skipped, never as passing.
- **Tests stay strict.** Never loosen an assertion, skip or delete a test, raise a timeout or add a retry to make something pass. Fix the cause, or leave the failure in place and report it.
- **Validated is not correct.**
  - A rule or patch that passes a repository's checks can still change behaviour. Every new deterministic rule needs tests on real snippets that show the behaviour is preserved.
  - Every diff you count as fixed must be read in full and labelled correct, partial or wrong. Report the wrong ones too.
- **Detection claims need labels.** Precision and recall come from hand labels made *before* looking at Refit's output on that repository (blind), committed as JSON next to the frozen list, with a scorer script and its test. Report "not measured" rather than guessing.
- **No bloat.** No speculative abstraction, option or "for later" code. Finish what you start or delete it. No TODOs or half-built features in the PR.
- **Secrets.**
  - Never commit, print, log or paste secrets or account identifiers: `.env` contents, API keys, tokens, database URLs, the AWS account ID or bucket name, the Supabase project ref. The repository will become public.
  - Read `.env` only by passing its path to a tool (`--env`); never `cat` it. Redact before printing while debugging.
- **No live hosted access.**
  - Never run any Fly command that changes state (`deploy`, `secrets`, `ssh`, `scale`, `machine`).
  - Never connect to Supabase. Never run `refit hosted approve`, `retry` or `serve` against anything but your local Postgres.
  - Hosted code is tested only against a local Postgres container, each test in its own schema. If none exists, create it with the command in `docs/HOSTED-ONBOARDING.md`. Pierce's is `refit-hosted-pg`.
- **No publishing.**
  - Never use `--publish`, `--publish-draft` or `gh pr create` against any repository except `pierceluu10/Refit`.
  - Never push to, open issues on, or comment on third-party repositories or `refit-dev` forks.
  - Never change GitHub App settings.
- **Untrusted code stays in the sandbox.**
  - Benchmark repositories are strangers' code. Never run their install scripts, tests or binaries on your machine outside Refit's offline Docker sandbox. Read them, scan them, and let Refit's validation run them.
  - Clone with `--depth 1` or at the pinned commit, never with submodules, and never run `npm install` in them.
  - Keep clones under your worktree's ignored directories or your own temp directory, and delete them when you finish.
- **Shared machine.** Your lanes share your Docker daemon and Postgres container: use your own schema or database, and bind test servers to port 0. Never stop, prune or recreate shared containers, images or volumes.
- **Paid calls.** Never make a live call to a vendor API (Stripe, OpenAI, Shopify, and so on). Reading public documentation pages is fine. Only PG8 may make model requests, within its budget.
- **AWS (Pierce's lanes only).**
  - Use `node scripts/aws-benchmark.mjs` only, with a unique `--run <lane>-<yyyymmdd>-<n>` id and `--market on-demand --instance-type c7i.xlarge`.
  - Run at most 1 shard per lane at a time unless the lane says otherwise, with `--hours` no higher than needed (3 at most).
  - Always `collect` or `stop` your runs. If `launch` reports the quota full, do static work and retry every 15 minutes.
  - Never raise quotas, limits or plans. Only PP4 edits `scripts/aws-benchmark*`; the others record runner bugs under "Requests for other lanes".
- **Minimal asks.** Do not stop to ask. Make the reasonable choice, write it in the PR as an assumption, and keep going. Stop only for something irreversible or outward-facing that the lane does not authorize.
- **Blocked is a valid ending, not a loop.** If a step needs the owner (expired `aws login` or GitHub credentials, a quota, an owner decision, an App setting, a page you cannot reach):
  - Retry once, then record it under **Blocked** in the PR with the exact error and what would unblock it.
  - Finish everything else and end. Never retry in a loop or wait for the owner.
- **Timebox.** Spend at most 45 minutes on any single blocker, flaky test or repository, then record it and move on.
- **Real work, not summaries.** "Done" means the lane's deliverables exist with evidence: code with tests, committed data, measured numbers. A PR that is mostly prose, or that claims completion without the listed evidence, is not done.
- **Wrap up.** Before ending, merge `origin/main`, rerun the checks, push, update the PR summary, and state what is left as the PR's last bullet.
- **One local Docker validation at a time per machine.** All sessions on a laptop share one Docker VM, and each validation container may use up to 3 GiB. Before any local step that runs repository code in Docker (`--validate`, gated Docker tests, dependency preparation), take the machine-wide lock:
  - Take it with `mkdir /tmp/refit-docker.lock 2>/dev/null && echo "<lane> $(date -u +%FT%TZ)" > /tmp/refit-docker.lock/owner`. `mkdir` is atomic, so only one session gets it.
  - If `mkdir` fails, another lane holds it. Do non-Docker work and try again every 5 minutes.
  - If the owner file is more than 2 hours old, its holder died. Remove it with `rm -rf /tmp/refit-docker.lock` and take it.
  - Release it with `rm -rf /tmp/refit-docker.lock` as soon as that step ends, including on failure. Never hold it across unrelated work.
  - Validate one repository per lock hold, so lanes take turns. The Postgres test container and AWS runs need no lock.
- **Disk.** Before each lane, check free disk with `df -h ~`.
  - If it is below 20 GB, delete your own finished worktrees' ignored clone directories and your own temp directories, then check again.
  - If it is still below 20 GB, record Blocked ("disk") and move to the next lane. Never prune Docker.

## Preflight (each person, at bedtime)

Do these once, in order, before starting the runners. A runner that hits a missing item records it as Blocked and moves on, so a skipped step costs whole lanes.

1. **Plugged in, awake.** Plug the laptop in. Keep it awake with the lid open: run `caffeinate -dimsu` in a terminal tab and leave it running, or use the app's keep-awake setting.
2. **Permissions.** Start each session in a permission mode that does not stop for approvals (for example bypass permissions), with your main clone (`$REFIT`) as its working folder. Runners never edit the main clone itself; they only create worktrees from it. A session waiting on a permission prompt makes no progress all night.
3. **Credentials still valid in 12 hours.**
   - `gh auth status` shows push access to `pierceluu10/Refit` (`gh repo view pierceluu10/Refit --json viewerPermission` says WRITE or ADMIN).
   - Pierce only: `aws sts get-caller-identity --profile refit` succeeds. Run `aws login --region us-east-2 --profile refit` right before bed, because credentials last 12 hours.
4. **Docker.** Docker is running with about 8 GB of memory for its VM, and the Mac has at least 60 GB of free disk (`df -h ~`). `docker image inspect node:22-alpine postgres:17-alpine` succeeds; pull them if not.
5. **Postgres.** The local test container exists and is running. Pierce's is `refit-hosted-pg`; others create theirs with the command in `docs/HOSTED-ONBOARDING.md`.
6. **This file.** In your main clone, `git checkout main && git pull`. Then run `ln -sf "$REFIT/OVERNIGHT-AGENTS.md" ~/OVERNIGHT-AGENTS.md`, and confirm with `head -1 ~/OVERNIGHT-AGENTS.md`.
7. **Base merged.** `git -C "$REFIT" fetch origin && git -C "$REFIT" log --oneline -1 origin/main` shows #168's merge or later.
8. **Usage.** Seven concurrent sessions per person use a lot of the Claude plan's capacity. If a session stops on a usage limit, it resumes where its runner `/goal` left off when restarted in the morning. Nothing is lost, because every lane pushes at least hourly.
9. **Pierce only.** Raise the AWS spend limit to about $100 and confirm no old runs: `node scripts/aws-benchmark.mjs status --run smoke-2` shows nothing running.

## How a runner works

Each runner session gets one `/goal`, from the "Runner queues" table in its person's section:

```
/goal Complete lanes <A>, <B>, <C> from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

- No lane waits for another lane's PR to **merge**. A lane that needs another lane's unmerged work uses the handoff below.
- Queues are ordered so that a later lane's "Keep going" can use an earlier lane's branch for reading only (for example FG1 before FP10).
- A runner never starts a lane from another runner's queue, even if its own queue is finished early.

## Handoffs: building on another lane's unmerged work

Each person's section has a **Dependencies** table listing which lanes build on which. Handoffs work within one founder's lanes. Across founders, a lane may only read another branch, never build on it.

**The producer** (the lane others build on):
1. As soon as the part others need is stable and tested, push the tag `ready/<lane>` (for example `git tag ready/PG10 && git push origin ready/PG10`). Do this early in the lane, not at the end: as soon as the interface (exported functions, table names, CLI flags) will not change.
2. Put an **Interface** section at the top of the PR description: exported functions with signatures, tables and columns, flags, files. Keep it current.
3. After tagging, change that interface only additively. Never move or force-push the tag.

**The consumer** (the lane that builds on it):
1. Start from `origin/main` and do every part of the lane that does not need the producer first.
2. When you need it, run `git fetch origin --tags` and check for `ready/<producer>`.
   - **Found:** run `git merge origin/<producer branch>` (the branch head, which is newer than the tag) and build on the documented interface. Merge the producer's branch again before each push so you stay current.
   - **Not found:** keep working on other parts, and check again every 20 minutes, for at most 60 minutes in total. Never sit idle waiting.
   - **Still not found after 60 minutes:** build against `main` only, using the lane's fallback (cover enrolled repositories only, or skip that part), and record "Waited for ready/<producer>; not available" under "Requests for other lanes".
3. Open the PR against `main` and put **"Depends on #<producer PR>: merge after it"** as its first line. GitHub shows the producer's commits in the diff until the producer merges; then the diff shrinks to yours.
4. Never edit the producer's files to unblock yourself. Ask in "Requests for other lanes".

**The owner, in the morning:** merge producers before consumers (PP10's merge order lists the chains), then delete the `ready/*` tags with `git push origin --delete ready/<lane>`.

---

# Pierce: hosted platform, monitoring, AWS benchmarks

Pierce owns the hosted worker (`pipeline/hosted-*`, `pipeline/github-webhooks.ts`, `pipeline/github-app.ts`, new `pipeline/inventory*`, `pipeline/monitoring*` and `pipeline/customer-*`), `scripts/aws-benchmark*`, `scripts/hosted-entrypoint.sh`, `fly.toml`, `pipeline/deadline-sync.ts`, `pipeline/ai-patches.ts`, the `pipeline/shopify-*` upgrade path, and the shared docs (PP10). Pierce's lanes are the only ones with AWS or an AI budget.

| Lane | Area it owns | Runner | AWS | AI |
|---|---|---|---|---|
| PG1 | Inventory on install (`pipeline/inventory*.ts`, inventory tables) | R1 | – | – |
| PG2 | Approve from GitHub (`pipeline/hosted-approval*.ts`) | R2 | – | – |
| PG3 | One machine per job (`pipeline/hosted-runner*.ts`, `pipeline/fly-machines*.ts`) | R3 | – | – |
| PG4 | Monitoring loop and alerts (`pipeline/monitoring*.ts`) | R1 | – | – |
| PG5 | Living repository report (`pipeline/customer-report*.ts`, `refit report`) | R1 | – | – |
| PG6 | Self-maintaining deadline registry (`pipeline/deadline-sync.ts`, `.github/workflows/registry-sync.yml`) | R5 | – | – |
| PG7 | Customer journey acceptance suite (`pipeline/customer-journey*.test.ts`, `pipeline/fixtures/fake-github*`) | R3 | – | – |
| PG8 | AI patch reliability (`pipeline/ai-patches.ts`, `pipeline/ai-patch-eval*`) | R5 | 1 shard | $15 |
| PG9 | Shopify SDK upgrade path (`pipeline/shopify-sdk-upgrade*.ts`) | R5 | 1 shard | – |
| PG10 | Customer allowlist and multi-tenant guardrails (`pipeline/hosted-tenancy*.ts`) | R2 | – | – |
| PP1 | Post-merge benchmark, **morning only** (`docs/benchmarks/<date>-post-merge*`) | morning | 3 shards | – |
| PP2 | Validation order: cheap stops before expensive validation | R6 | – | – |
| PP3 | Benchmark determinism on AWS (`docs/BENCHMARK-DETERMINISM.md`, determinism fixes) | R4 | 1 shard | – |
| PP4 | AWS runner hardening (`scripts/aws-benchmark*`, `scripts/shopify-benchmark-setup.mjs`) | R4 | smoke only | – |
| PP5 | Hosted operations (`pipeline/hosted-ops*.ts`, `docs/HOSTED-RUNBOOK.md`) | R6 | – | – |
| PP6 | Webhook lifecycle coverage (`pipeline/github-webhooks.ts`, `pipeline/hosted-lifecycle*.ts`) | R3 | – | – |
| PP7 | Store robustness and data retention (`pipeline/hosted-migrations*.ts`) | R6 | – | – |
| PP8 | Post-install experience and customer docs (`pipeline/hosted-setup*.ts`, `docs/INSTALL.md`, `docs/DATA-HANDLING.md`) | R2 | – | – |
| PP9 | Capacity and cost model (`docs/CAPACITY.md`) | R4 | 1 shard | – |
| PP10 | Integrator, shared docs, launch checklist | R7 | – | – |


**Runner queues (Pierce)**

| Session | Queue (in order) | Why this order |
|---|---|---|
| R1 | PG1 → PG4 → PG5 | Connects detection and deadlines to the hosted worker: inventory, then monitoring on that inventory, then the report. Each lane builds on the previous one through a handoff |
| R2 | PG10 → PG2 → PP8 | Allowlist first, so PG1 can pick up `ready/PG10` early; then approval, then what the customer sees |
| R3 | PG3 → PP6 → PG7 | Isolation and lifecycle first; the journey test last exercises them |
| R4 | PP4 → PP3 → PP9 | AWS runner first, so the AWS lanes after it use a hardened runner |
| R5 | PG8 → PG9 → PG6 | Both AI/AWS validation lanes, one at a time, then registry sync |
| R6 | PP5 → PP7 → PP2 | Operations, then the store, then validation order |
| R7 | PP10 under `/loop 45m` | Reviews every PR all night; see PP10 |

- **AWS:** only R4 and R5 use AWS, one lane each at a time, at most 1 shard per lane, plus PP4's short smokes. That stays within the 3-shard cap without coordination.
- **Hosted files:** R1, R2, R3 and R6 all touch hosted files. Keep core edits to small wiring and merge `origin/main` often.
- **PP1 is not in any queue.** Start it in the morning after merging (see PP1).

**Dependencies (Pierce)**

| Consumer | Producer | What it needs | Fallback without it |
|---|---|---|---|
| PG1 | PG10 | The allowed-account check (`REFIT_HOSTED_ACCOUNTS`) | Owner-only check from `main` |
| PG4 | PG1 | Inventory tables and the function that refreshes one repository | Enrolled repositories only |
| PG5 | PG1, PG4 | Inventory rows and the monitoring pass that triggers the report | Enrolled repositories only |
| PG7 | PG1, PG2 | Inventory on install and issue-comment approval, as journey steps | Today's journey (install → enroll → validate → uninstall) |
| PP8 | PG1, PG5 | What the setup page says happens after install | Describe only what `main` does; mark the rest "planned" |
| PP3, PP9 | PP4 | Incremental upload and infrastructure exit codes in the AWS runner | The runner on `main` (shorter shards) |

## Pierce: goals

### PG1: Inventory on install

```
/goal On branch feat/install-inventory (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): installing the Refit GitHub App makes the hosted worker take a read-only inventory of every installed repository of an allowed account, approved or not, with no code execution, no Docker and no AI. A new module pipeline/inventory.ts builds the inventory from a fresh App-managed checkout by reusing what exists: detectProviders from pipeline/agent-catalog.ts (packages, locked versions, hostname evidence), configuredIntegrations and scanDeadlines/findDeadlineExposures from pipeline/deadline-exposure.ts (deadline id, days left, evidence lines, live vs test/comment use), pinned API versions from pipeline/declared-api-versions.ts, and AI model call sites. The checkout is size-, file-count- and time-capped, with named stops. PostgreSQL stores each inventory with its revision SHA in new tables created by the new module. An unchanged revision is not re-scanned. Installation created, installation_repositories added and a new `refit hosted inventory --repository <owner/name>` trigger it; /status and that command show it. Removal and uninstall delete the inventory rows, and execution still requires approval. Done when: an end-to-end test against local Postgres (signed install webhook → inventory rows → status → second install of an unchanged revision skipped → uninstall deletes rows) passes; unit tests cover each fixture repository (Stripe plus OpenAI, an empty repository, a pnpm monorepo, a repository over the size cap, a repository with only test-file model strings); docs/INVENTORY.md documents fields, caps and stops; checks pass; and a PR against main is open. Keep going: inventory 30 repositories from the frozen OpenAI, Anthropic and Stripe sets locally through the same function, and report timing and what was found in docs/INVENTORY.md. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG2: Approve from GitHub

```
/goal On branch feat/github-approval (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): a repository owner can approve Refit without the CLI. When an installed repository of an allowed account has a committed root .refit.json and no stored approval, the hosted worker opens one issue, behind REFIT_HOSTED_APPROVAL_ISSUES (off by default). The issue shows exactly what `refit enroll` shows (settings, image, commands, files, fingerprint), reusing the fingerprint logic in pipeline/repository-enrollment.ts without duplicating it. An issue comment `/refit approve <fingerprint-prefix>` from a user whose repository permission is admin or maintain (checked through the API) stores the same approval `refit hosted approve` stores and enrolls the repository. A wrong or stale prefix, a changed config, a user without permission, an edited comment, and a forged or replayed delivery are refused with a reply naming the reason. When the repository has no .refit.json, the issue instead shows a proposed config generated by the existing `refit prepare` logic for the user to commit. Done when: Postgres-backed tests with simulated GitHub calls cover approve, every refusal, config change after approval (approval invalidated) and the no-config path; docs/HOSTED-ONBOARDING-APPROVAL.md explains the flow; every App permission or event it needs (issues and issue_comment) is listed as Needs owner decision after checking docs/GITHUB-APP.md for what the App has today; checks pass; and a PR against main is open. Keep going: add `/refit revoke`, which removes the approval and cancels the target, with tests. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG3: One machine per job

```
/goal On branch feat/job-machines (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): the hosted worker can run each job on its own short-lived Fly Machine instead of its own in-VM Docker daemon, behind `--job-machines` (off by default). The control process keeps the lease, webhooks and database. Each job machine gets only that job's checkout inputs, approval, allowed images and budget, and has no database credentials and no App private key. It runs the existing pollServiceTarget path and returns its receipt and evidence to the control process over an authenticated, size-capped channel. It is destroyed when the job ends, fails, is cancelled or times out, and a reaper destroys orphans after a control crash. The Machines API client is a small module with timeouts, bounded retries on 429/5xx and no retries on 4xx. Done when: unit tests against a simulated Machines API (a local HTTP server on port 0) cover create → run → collect → destroy, destroy on cancel, timeout and control crash, a forged receipt being rejected, and an evidence size cap; docs/HOSTED-ISOLATION.md explains the model and the REFIT_HOSTED_OWNER restriction it would let the owner lift (Needs owner decision); checks pass; and a PR against main is open. Do not deploy and do not create Fly resources. Keep going: measure the added latency per job from the simulated flow and document the Fly Machine size and region the job image needs. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG4: Monitoring loop and deadline alerts

```
/goal On branch feat/hosted-monitoring (base: origin/main, building on PG1 through the handoff (ready/PG1); without it, monitor enrolled repositories only; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): the hosted worker monitors every repository PG1 inventories (installed by an allowed account, approved or not) the way `refit serve --deadline-alerts` does locally for enrolled ones, with state in Postgres instead of the local state file. It reads exposures from PG1's inventory tables rather than re-scanning. A new pipeline/monitoring.ts reuses pipeline/deadline-alerts.ts (alertStage, alertDue, syncDeadlineIssue, deadlineTitle, deadlineBody), pipeline/deadline-ignores.ts and loadDeadlineRegistry rather than copying local-service code; extract any shared piece from pipeline/local-service.ts into a function both call. Each scheduled pass recomputes days left for every stored exposure without a new checkout. A push to the default branch, a registry change or a 24-hour age triggers a re-scan, debounced to once per 10 minutes per repository. Alerts follow the 90/30/7 lead days with exactly one update per stage, ignores are honoured, and nothing is sent after uninstall. All of this sits behind REFIT_HOSTED_ALERTS (off by default). Done when: Postgres tests with a fake clock and simulated GitHub prove 91 → 30 → 7 days gives exactly three issue writes, a restart mid-pass sends no duplicates, an ignored deadline sends none, an uninstalled repository sends none, and a push re-scan picks up a newly added model; local-service still passes its existing tests after any extraction; docs/MONITORING.md documents behaviour and the push event subscription as Needs owner decision; checks pass; and a PR against main is open. Keep going: add a weekly digest option that is off by default and a /status section listing upcoming deadlines per installation. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG5: The living repository report

```
/goal On branch feat/customer-report (base: origin/main, building on PG1 and PG4 through the handoff (ready/PG1, ready/PG4); without them, report on enrolled repositories only; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): Refit can show a customer one clear report of what their repository depends on and what is coming. A new `refit report --repository <path> [--format markdown|json]` prints, from existing scanners only (detectProviders, configuredIntegrations, scanDeadlines, declared API versions):
  - each integration (provider, package, declared and locked version, what Refit can do: migrate, propose model fixes or report only, from agentStatus);
  - each deadline with its date, days left and evidence lines;
  - AI model call sites grouped by model;
  - hosts Refit saw but does not track;
  - the next step.
The markdown fits GitHub's issue limits with a hard length budget and truncation notes. The hosted worker keeps one marker-identified issue per inventoried repository up to date with that markdown, updating only when its content hash changes, behind REFIT_HOSTED_REPORTS (off by default). Done when: snapshot tests cover at least six real shapes taken from frozen benchmark repositories (Stripe affected, OpenAI app near the 2026-10-23 shutdown, Anthropic app, Shopify app, monorepo, a repository with nothing found); a Postgres test proves create-once, update-on-change and no-op-on-same-content; the JSON form has a documented, versioned schema in docs/REPORT.md; checks pass; and a PR against main is open. Keep going: generate the report for 10 frozen repositories and commit the outputs as docs/report-examples/ (labelled as generated from public repositories at pinned commits). If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG6: Self-maintaining deadline registry

```
/goal On branch feat/registry-sync (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): data/deadlines.json keeps itself current for the AI providers. `refit deadlines --sync openai` reads OpenAI's official deprecations page and updates the OpenAI entries the same way `--sync anthropic` does (grouped per shutdown date and replacement, matched by model, nothing deleted, any unparseable row failing the sync, the registry check run before writing). If ai.google.dev's Gemini deprecations page is reachable, `--sync gemini` does the same, report-only as AGENTS.md requires. The parsers live in pipeline/deadline-sync.ts beside the Anthropic one and are tested against saved copies of the real pages committed as fixtures. A scheduled GitHub Actions workflow .github/workflows/registry-sync.yml runs daily: it runs every sync and `npm run deadlines:check`, and opens or updates one PR from a fixed branch when the registry changes, using only GITHUB_TOKEN with the minimum permissions and pinned action SHAs. `deadlines:check` also warns on any entry whose checkedAt is older than 30 days. Done when: the parsers and the stale-entry check have tests; a local dry run of each sync against the live pages is recorded in the PR (changes or "no change"); the workflow passes actionlint (run in Docker); docs/REGISTRY-SYNC.md documents it; checks pass; and a PR against main is open. A page behind bot protection is recorded as Blocked with the HTTP status. Keep going: add a sync for any other provider in the registry that publishes a machine-readable or tabular deprecation page, with the same tests. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG7: Customer journey acceptance suite

```
/goal On branch test/customer-journey (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): one gated acceptance test drives the hosted worker exactly as a customer's install would, over real HTTP. It starts runHostedService on port 0 against local Postgres, with a reusable fake GitHub in pipeline/fixtures/fake-github.ts: a local HTTP server issuing installation tokens, serving repository metadata and a local bare git remote, and recording every write. Signed webhook deliveries go over HTTP. The journey is: install (approved repository plus unapproved repository) → enroll only the approved one → doctor → scan → offline Docker validation of a Stripe fixture repository → receipt → duplicate delivery ignored → repository removed → target cancelled → reinstall → uninstall → nothing queued. Existing hosted tests that hand-roll GitHub simulations are moved onto the shared fake where that shortens them, and their assertions stay unchanged. Every bug the journey exposes is fixed with a focused regression test. Done when: the journey test passes with REFIT_TEST_DATABASE_URL and REFIT_DOCKER_IMAGE=node:22-alpine set, and is skipped with a clear reason otherwise; docs/ACCEPTANCE.md lists each step, what it proves and how to run it; checks pass; and a PR against main is open. Keep going: extend the journey with `refit hosted retry` after a failed validation, and with a lease expiry mid-job reclaimed by a second worker process. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG8: AI patch reliability

```
/goal On branch feat/ai-patch-reliability (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule; AI budget REFIT_AI_BUDGET_USD=15 in total; AWS at most 1 c7i.xlarge shard at a time): there is a repeatable eval of Refit's AI patch path on cases where deterministic rules stop. It covers at least 20 frozen cases drawn from existing benchmark results, plus the refit-billing-demo case that regressed on 2026-10-22, and reports pass, regression, guard rejection, repair use and cost per case. Then improve the AI path (prompt construction, the context given, how the repair loop uses failing check output, guard feedback) without loosening any guard, the substitution check or validation. Done when: docs/AI-PATCH-RELIABILITY.md records a before and after on the same frozen cases with the same model, each validated in offline Docker on AWS through scripts/aws-benchmark.mjs; every passing patch is read in full and labelled correct, partial or wrong; the AI path changes ship with unit tests; spend stays under $15 (stop and report if the budget runs out); checks pass; and a PR against main is open. Keep going: rank the remaining failures by cause and add a deterministic stop or rule for any mechanical cause, with tests. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG9: Shopify SDK upgrade path

```
/goal On branch feat/shopify-sdk-upgrade (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule; AWS at most 1 c7i.xlarge shard at a time): Refit can propose the Shopify SDK major upgrade that blocks 44 of the 200 frozen Shopify apps, behind a flag that is off by default (the default stays an owner decision). It moves @shopify/shopify-api or @shopify/shopify-app-* to the oldest major that serves a supported Admin API version, applies the documented breaking renames its tracer can confirm (from the official changelogs and migration guides, read and cited), updates the lockfile the way the Stripe package upgrade does, and stops for review on everything else. Done when: the 44 apps are rerun with the flag on AWS through scripts/aws-benchmark.mjs; docs/SHOPIFY-SDK-UPGRADE.md reports validated, regressed and stopped counts, with every validated diff read and labelled; default-off behaviour is unchanged on the full 200 (outcomes identical to the frozen run, or every difference explained); tests cover each rename and stop; checks pass; and a PR against main is open with "Needs owner decision: enable by default". Keep going: for each stopped app, record the exact missing rename or blocker so the next rule is obvious. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### PG10: Customer allowlist and multi-tenant guardrails

```
/goal On branch feat/hosted-tenancy (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): the hosted worker can safely accept a first customer account. REFIT_HOSTED_ACCOUNTS (a list of GitHub account logins; its default is REFIT_HOSTED_OWNER alone, so today's behaviour is unchanged) replaces the owner-only check. Installations from other accounts are recorded as not allowed, with nothing cloned. On top of that:
  - Per installation: at most one running job, a daily job cap and a daily inventory cap, each with a named refusal in status.
  - Claiming is fair across installations (no starvation, proven by a test with one noisy installation).
  - The GitHub client honours x-ratelimit-remaining, x-ratelimit-reset and retry-after for primary and secondary limits, with bounded waits.
  - The AI budget ledger (pipeline/ai-budget.ts) is keyed per installation in Postgres, so one customer cannot spend another's budget.
Done when: Postgres tests cover the allowlist (allowed, not allowed, later allowed and backfilled), each cap, fairness, the rate-limit handling against a fake GitHub returning 403/429 with headers, and ledger isolation; docs/HOSTED-TENANCY.md explains what isolation exists with and without PG3's job machines, and lists "add the first customer account" as Needs owner decision; checks pass; and a PR against main is open. Keep going: add `refit hosted accounts` to list installations, their allow state and today's usage. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

## Pierce: prompts

### PP1: Post-merge benchmark (morning, after merging)

> **Start this in the morning, after the owner has merged the night's PRs. Not overnight.**
>
> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `bench/post-merge-<yyyymmdd>` from `origin/main`. AWS: up to 3 `c7i.xlarge` shards at once, `--hours 3` at most, under $15 total. Use PP4's hardened runner if it has merged.
>
> **Steps**
> 1. Pin merged `main` and list every PR merged since the previous benchmark commit.
> 2. Size the shards so none runs past about 2 hours. Use PP3's and PP9's measured per-repository times if they merged. Otherwise run a 20-repository calibration shard first. Heavy repositories that reach validation can take close to an hour each: on 2026-10-22, `hackerai-tech/hackerai` took 55 minutes on a `c7i.large`.
> 3. Rerun these with `--validate` and no `--ai`:
>    - Stripe fresh (`docs/benchmarks/2026-10-16-stripe-fresh-repos.json`, 381);
>    - Shopify fresh (`docs/benchmarks/2026-10-16-shopify-fresh-repos.json`, 200);
>    - OpenAI (100) and Anthropic (50) AI-app sets through their benchmark scripts.
> 4. Compare each with its latest committed results (`scripts/stripe-benchmark-compare.mjs` for Stripe). Attribute every changed outcome to the merged PR that caused it, or to flakiness, using PP3's classification if merged.
> 5. Look for PRs that each looked good alone but interact badly once merged, and report them first.
>
> **Deliverables:** `docs/benchmarks/<date>-post-merge.md` (outcome tables, per-PR attribution, wall time and cost per shard) and the merged results JSON for each set.
>
> **Done when** every repository in the four sets has a result or a recorded infrastructure failure, and every changed outcome is attributed.
>
> **Keep going:** rerun only the repositories whose outcome changed, at the same commit, to separate flakiness from real change.

### PP2: Validation order: cheap stops before expensive validation

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `fix/validation-order` from `origin/main`. No AWS: reproduce locally.
>
> **Evidence.** On the 2026-10-22 AWS smoke run (commit `87a33d7`, `c7i.large`), `hackerai-tech/hackerai` at `49c12ea` spent 3090 of its 3317 seconds in validation, then ended as `workflow missing-manifest`. If that stop could be known before validation, the 51 minutes were wasted.
>
> **Steps**
> 1. Reproduce it locally: the Stripe benchmark CLI on just that repository, with Docker and `--validate`. Time each stage.
> 2. Find where `missing-manifest` is decided and why it is decided after validation. Explain it in the PR, with file and line.
> 3. Scan every committed results file under `docs/benchmarks/` for other repositories whose outcome is a stop but whose `validationSeconds` is large. Quantify the wasted validation time per set.
> 4. Move every check that can stop a repository without running code ahead of dependency preparation and validation. Outcomes must not change: prove identical outcomes on 20 repositories from the frozen sets, including hackerai, before and after.
> 5. Ownership:
>    - The fix belongs in the workflow ordering.
>    - If the cause is in `pipeline/*benchmark*.ts` (owned by Otabek's OG5), keep the edit minimal and say so in the PR.
>    - Do not touch `pipeline/validation.ts` internals (OP4).
>
> **Deliverables:** `docs/VALIDATION-ORDER.md` with the cause, the waste found per set, and the before and after timings.
>
> **Done when** hackerai stops before validation (or the PR proves the order is necessary), tests cover the reordering, and outcomes are identical on the 20 repositories.
>
> **Keep going:** add a per-stage time budget to the benchmark results (stage name and seconds) so future waste is visible. This needs a small, additive field, coordinated through "Requests for other lanes" with OG5.

### PP3: Benchmark determinism on AWS

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `fix/benchmark-determinism` from `origin/main`. AWS: 1 shard at a time, under $10.
>
> Benchmarks must give the same outcome twice.
>
> **Steps**
> 1. At one pinned commit, run the 66-repository Stripe active set (`docs/benchmarks/2026-10-16-stripe-active-repos.json`) with `--validate` **twice**, as two separate AWS runs.
> 2. Also run the 50-repository held-out set (`docs/benchmarks/2026-10-15-stripe-heldout-repos.json`) twice.
> 3. Diff outcome, stop reasons, check results and patch hashes per repository.
> 4. Root-cause every difference. Candidates: dependency preparation fetching a different version, time- or order-dependent checks inside a repository, Docker resource pressure, Refit nondeterminism such as unordered iteration, timestamps in patches or race conditions.
> 5. Fix every cause that is Refit's, at its root, each with a test that fails before the fix. Mark causes that belong to the repository as such in the results so benchmark summaries can exclude them by rule rather than by hand.
>
> **Deliverables:** `docs/BENCHMARK-DETERMINISM.md` with the two-run tables, every difference and its cause, and the fixes.
>
> **Done when** both sets are run twice and every difference is explained or fixed.
>
> **Keep going:** run a third pass on the repositories that differed, after the fixes, to show they are now stable.

### PP4: AWS runner hardening

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/aws-runner-hardening` from `origin/main`. You are the only lane that edits `scripts/aws-benchmark*` and `scripts/shopify-benchmark-setup.mjs`. AWS: smoke runs only, at most 2 shards, `--hours 1`.
>
> `collect` and the merge are already verified: on 2026-10-22 they merged both `smoke-2` shards. The gaps that run exposed:
> - shard output reaches S3 only at the end of the command;
> - a heavy repository took 55 minutes on `c7i.large`;
> - a stopped instance looks "still running" to `collect` for a while.
>
> **Steps**
> 1. Add `--offset` to `scripts/shopify-benchmark-setup.mjs` the way #168 did for `scripts/stripe-benchmark-setup.mjs`, with a test, so PP1 can shard Shopify.
> 2. Add these to the runner, each with a unit test where it is pure logic:
>    - **Incremental upload.** Upload `/work/out` every 10 minutes during the command, so a deadman shutdown loses at most 10 minutes of results.
>    - **Infrastructure failure codes.** Distinct exit codes for boot failures (dnf, Node download or checksum, `npm ci`, image pull) versus the benchmark command, surfaced by `status`.
>    - **`retry --run <id> --shard <n>`.** Relaunch one failed shard with the same slice and commit, refused while it is running.
>    - **`cost --run <id>`.** Instance-hours times a price table (named constants citing the AWS pricing page and date).
>    - **`list`.** Recent runs with state.
>    - **Source checksum.** Record a checksum of the source tarball in `run.json` and verify it on boot.
>    - **Expired credentials.** A clear error when `aws login` credentials expire mid-command.
> 3. Run a 2-shard smoke with a trivial command to prove each path, including a forced boot failure.
> 4. Update `docs/AWS-BENCHMARKS.md`. You own that doc.
>
> **Done when** every feature has a test or a recorded smoke result, and every smoke run is stopped or collected.
>
> **Keep going:** fold in every runner bug the other AWS lanes reported in their PRs' "Requests for other lanes".

### PP5: Hosted operations

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/hosted-ops` from `origin/main`.
>
> Make the hosted worker operable by a teammate at 3 a.m.
>
> **Steps**
> 1. Add commands that read Postgres:
>    - `refit hosted jobs [--target <id>] [--status <s>] [--since <iso>]`;
>    - `refit hosted receipt <job>` (stored receipt and evidence paths);
>    - `refit hosted targets` (state, last job, last receipt).
> 2. Make every log line structured JSON with job, target and installation ids and no secrets. A test feeds a known secret through each log path and asserts it never appears.
> 3. Add a failed-job notifier that reuses the existing Slack notice path (`pipeline/slack.ts`) when `REFIT_SLACK_WEBHOOK_URL` is set, rate-limited to one message per target per hour.
> 4. Add a `/status?target=` filter.
> 5. Write `docs/HOSTED-RUNBOOK.md`: deploy, roll back to the previous image, retry, read logs, rotate each secret, drain the worker, restore after a crash, and what each alert means.
>
> Test against local Postgres and do not deploy. Keep store changes in new functions.
>
> **Done when** each command, the redaction test and the notifier have tests, and the runbook covers every operation listed.
>
> **Keep going:** add `refit hosted health` that checks Postgres reachability, schema version, Docker daemon and image presence locally and exits non-zero on any failure.

### PP6: Webhook lifecycle coverage

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/webhook-lifecycle` from `origin/main`.
>
> **Steps**
> 1. Audit every GitHub App event Refit receives today against the ones a real install produces. Read GitHub's webhook events documentation and cite it.
> 2. Handle each lifecycle case correctly, with a Postgres test per case:
>    - `installation_repositories` added (enroll if approved), and removed;
>    - `installation` suspend and unsuspend (resume targets), and `new_permissions_accepted`;
>    - `repository` renamed and transferred (targets follow the repository id, not its name), and deleted;
>    - account login renamed;
>    - deliveries that arrive out of order (deleted before created) or are redelivered after hours;
>    - an unknown event (acknowledged and ignored, never 500).
> 3. Prune stored delivery ids after 30 days.
> 4. List every event subscription the App needs that it may not have as Needs owner decision.
>
> **Deliverables:** `docs/WEBHOOK-LIFECYCLE.md`, a table of event, action, handling and test name.
>
> **Done when** every row has a passing test.
>
> **Keep going:** fuzz the webhook parser with malformed and oversized payloads, asserting a 4xx and no state change for each.

### PP7: Store robustness and data retention

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/hosted-migrations` from `origin/main`.
>
> **Steps**
> 1. Replace ad hoc `ALTER ... IF NOT EXISTS` schema setup with ordered, versioned migrations (a `refit_schema_migrations` table, one function per version, each run in a transaction under an advisory lock). Two workers starting at once must not race.
> 2. Prove it upgrades the **current live schema** safely: in a test, create the schema exactly as today's `main` creates it, insert rows, migrate, and assert nothing is lost.
> 3. Make the worker survive Postgres outages. Use your own throwaway container, never `refit-hosted-pg`. Stop it mid-job, start it again, and assert the lease is either renewed or the job is aborted cleanly, with no duplicate claim.
> 4. Add pool error handlers, a statement timeout and a connection timeout, as named constants.
> 5. Data retention: uninstall deletes the installation's targets, jobs, receipts and inventory rows after a 7-day grace period (a named constant, so a reinstall restores them), and evidence on the volume is pruned with them. Test both.
> 6. Write `docs/HOSTED-DATA.md`: tables, what each stores, retention, and backup and restore with Supabase.
>
> **Done when** migrations, the outage test and retention have tests.
>
> **Keep going:** add `refit hosted migrate --dry-run`, which prints pending migrations without applying them.

### PP8: Post-install experience and customer docs

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/post-install` from `origin/main`.
>
> **Steps**
> 1. Add a `GET /github/setup` route on the worker for the App's Setup URL. It renders a small static HTML page, with no scripts and no secrets, that says what Refit will do next: inventory, report issue (if enabled), how to approve, how to uninstall.
>    - It must not trust the `installation_id` query parameter: confirm the installation exists through the App API before naming the account, and show generic text otherwise.
>    - Test it with a fake GitHub.
> 2. Write customer-facing docs, reading the code to make every statement true today:
>    - `docs/INSTALL.md`: the permissions the App requests and why each is needed, what Refit reads, what it stores and for how long, how approval works, how to uninstall and have data deleted.
>    - `docs/DATA-HANDLING.md`: where data lives (Fly `iad`, Supabase US), subprocessors, AI usage (only with approval, the owner's key, never training), and what never leaves the sandbox.
> 3. Flag every statement that depends on an unmerged lane as "planned", with the lane id.
> 4. List the Setup URL change as Needs owner decision.
>
> **Done when** the route has tests and both docs exist with every claim traced to code or marked planned.
>
> **Keep going:** add an uninstall feedback route (`/github/uninstalled`, static, no data collection) and a plain-text `/security.txt`.

### PP9: Capacity and cost model

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `docs/capacity` from `origin/main`. AWS: 1 shard, under $5.
>
> Pricing and hosting need real numbers.
>
> **Steps**
> 1. Profile 20 repositories on one AWS `c7i.xlarge`: 8 Stripe affected, 4 Shopify, 4 OpenAI apps, 4 monorepos from the frozen sets. Use one shard that wraps each repository's `refit run --validate` in `/usr/bin/time -v` plus Docker stats sampling.
> 2. Record per stage (checkout, doctor, preparation, baseline checks, patched checks): wall time, peak RSS, CPU seconds, disk, network bytes during preparation.
> 3. Also time the static inventory (`refit deadlines` plus provider detection) on 100 repositories locally.
> 4. From the measurements, derive: jobs per hour per Fly VM size, memory headroom, recommended job timeout, cost per inventory and per validated migration, and the number of machines for 10, 50 and 200 customers at stated assumptions.
>
> **Deliverables:** `docs/CAPACITY.md`, with every number traced to the raw measurements committed as JSON.
>
> **Done when** all 20 profiles and the 100 inventories are measured and the model is written.
>
> **Keep going:** compare the Fly VM size currently in `fly.toml` against the measured peak, and write the recommendation as Needs owner decision.

### PP10: Integrator, shared docs and launch checklist

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `docs/launch-readiness` from `origin/main` (create the worktree once; later iterations reuse it). This lane is the only one that edits `docs/READINESS.md`, `docs/BENCHMARKS.md`, `AGENTS.md`, `README.md` and `docs/CLI.md`.
>
> **Start it as `/loop 45m <this prompt>`** in its own session (R7), so it wakes itself all night. Each iteration does one pass, then ends. When the other six runners have finished (no lane branch has been pushed for 90 minutes), make a final pass and stop the loop.
>
> **Each iteration:**
> 1. Run `gh pr list --state open` and review every new or updated lane PR from all three people. Check correctness, honesty of claims, evidence for each number, scope creep, secrets or identifiers, conflicts with AGENTS.md owner decisions, and file-ownership violations.
> 2. Leave one concise review comment per PR update: comment only. Never approve, merge or push to another branch.
> 3. Fold verified results into the shared docs on your branch, citing PR numbers, and only what each PR's evidence supports.
> 4. Collect every "Requests for other lanes" item and every "Needs owner decision" into `docs/LAUNCH-CHECKLIST.md`.
>
> **The checklist** follows the five launch steps at the top of this file. For each requirement, give its status, evidence link and blocking lane or decision, ranked by what blocks the first customer most. Add a "morning merge order" that lists PRs in the order they should merge (producers before consumers, from the Dependencies tables and each PR's "Depends on" line), with the conflicts to expect.
>
> **Done when** every lane PR has a review comment, the checklist covers all five steps, and the merge order exists.
>
> **Keep going** until every runner has finished. Your PR summary is the overnight report: what landed, what is blocked, what needs the owner, and the merge order.

---

# Furqan: detection breadth (integrations)

Furqan owns what Refit can **detect**:
- `pipeline/agent-catalog.ts` entries;
- new provider entries in `data/deadlines.json` and their matchers in `pipeline/deadline-exposure.ts`;
- new `pipeline/<provider>-calls.ts` modules;
- the language tracers (`pipeline/python/`, `pipeline/go/`);
- package manifests (`pipeline/package-manifests*.ts`) and the API host list (`data/api-hosts.json`, `pipeline/api-hosts*.ts`);
- `pipeline/model-retirements.ts`, `data/meta-graph-changes.json` and `pipeline/paypal-*`.

Everything Furqan adds flows into the hosted inventory automatically, because PG1 builds the inventory from `detectProviders` and the deadline scanners. So every lane must expose its detection through those (or through one exported function named in its PR), never through a separate CLI only.

No AWS and no AI. Detection is static: lanes clone public repositories at pinned commits and read them, never install or run them.

| Lane | Area it owns | Runner |
|---|---|---|
| FG1 | Python tracer for AI models (`pipeline/python/`) | R1 |
| FG2 | Go tracer for Stripe and OpenAI (`pipeline/go/`) | R1 |
| FG3 | Data and productivity APIs: catalog and deadlines (list B below) | R3 |
| FG4 | Raw HTTP API inventory (`data/api-hosts.json`, `pipeline/api-hosts*.ts`) | R3 |
| FG5 | Multi-ecosystem package inventory (`pipeline/package-manifests*.ts`) | R2 |
| FG6 | Messaging APIs: Twilio, SendGrid, Resend, Postmark, Mailgun | R6 |
| FG7 | Meta WhatsApp and Messenger changelogs (`data/meta-graph-changes.json`) | R4 |
| FG8 | PayPal next checklist items (`pipeline/paypal-*`) | R3 |
| FG9 | Model-retirement wedge and Anthropic parity (`pipeline/model-retirements.ts`) | R7 |
| FG10 | Payments and commerce APIs: catalog and deadlines (list A below) | R4 |
| FP1 | Slack review-only detection (`pipeline/slack-calls.ts`) | R5 |
| FP2 | Cloudflare review-only detection (`pipeline/cloudflare-calls.ts`) | R5 |
| FP3 | AI wrapper SDKs: Vercel AI SDK, LangChain, LlamaIndex (`pipeline/model-wrappers.ts`) | R7 |
| FP4 | Cloud-hosted models: Bedrock, Azure OpenAI, OpenRouter (`pipeline/model-hosts.ts`) | R2 |
| FP5 | Auth and backend SDKs: Auth0, Clerk, Firebase, Supabase JS | R4 |
| FP6 | GitHub API and Octokit (`pipeline/github-api-calls.ts`) | R5 |
| FP7 | Cloud SDK end of support: AWS SDK for JavaScript v2, Azure legacy SDKs | R6 |
| FP8 | Monorepo and workspace attribution (`pipeline/workspace-attribution*.ts`) | R2 |
| FP9 | Shopify REST deprecation detection (`pipeline/shopify-rest-deprecations*.ts`) | R6 |
| FP10 | Gemini and Vertex AI | R1 |

**Runner queues (Furqan)**

| Session | Queue (in order) | Why this order |
|---|---|---|
| R1 | FG1 → FP10 → FG2 | Python tracer first, so FP10 can read its branch; Go reuses the design |
| R2 | FG5 → FP8 → FP4 | Manifests, then monorepo attribution on top, then cloud-hosted models |
| R3 | FG4 → FG3 → FG8 | API hosts first, so FG3 sees which list-B hosts are untracked |
| R4 | FP5 → FG10 → FG7 | Catalog-and-registry lanes, kept apart from R3's at any moment |
| R5 | FP1 → FP2 → FP6 | The three review-only call detectors, in the same style |
| R6 | FP7 → FG6 → FP9 | SDK end of support, messaging, then Shopify REST |
| R7 | FG9 → FP3 | Both touch model detection; sequential, to avoid conflicts |

- **Shared files:** R3 and R4 both edit `agent-catalog.ts` and `data/deadlines.json`. Merge `origin/main` before every push and keep both sides' entries.

**Dependencies (Furqan)**

| Consumer | Producer | What it needs | Fallback without it |
|---|---|---|---|
| FP10 | FG1 | The Python parser and call record, for `google-genai` patterns | JS/TS only; record the Python part as a request |
| FG2 | FG1 | The neutral call record and the parser decisions in `docs/ARCHITECTURE.md` | Record its own decisions, flagged for reconciliation |
| FP8 | FG5 | Manifest parsers, for Python and other monorepos | JS/TS workspaces only |
| FG3 | FG4 | `detectApiHosts` and `data/api-hosts.json`, so list-B hosts are not duplicated | Catalog hostnames only; FG4 deduplicates on merge |
| FP3, FP4 | FG9 | Any hook FG9 adds in `pipeline/model-retirements.ts` for report-only sources | Feed `scanDeadlines` directly |
- **Provider lists** (each provider belongs to exactly one lane):
  - **List A (FG10):** Plaid, Square, Braintree, Adyen, Paddle, Lemon Squeezy, Shippo, EasyPost, Lob, Coinbase Commerce.
  - **List B (FG3):** Google Maps Platform, Mapbox, Algolia, HubSpot, Intercom, Mailchimp, Zoom, Dropbox, Notion, Airtable, Segment, Sentry, Discord, Contentful, Cloudinary.

**Rules every Furqan lane adds:**
- **Registry entries.** Every `data/deadlines.json` entry passes `npm run deadlines:check` and has `source` and `checkedAt` from a page you read.
- **Catalog entries.** Every catalog entry's package names are checked against the npm registry (or the ecosystem's registry) and its hostnames against the provider's API reference.
- **Benchmark sample.** Every provider gets a frozen sample of real public repositories, committed under `docs/benchmarks/` with pinned commits and the exact search query and date used to find them. At least 20 repositories, or the number stated, labelled blind.

## Furqan: goals

### FG1: Python tracer for AI models

```
/goal On branch feat/python-models (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): Refit finds OpenAI and Anthropic model names sent from Python code and reports each against data/deadlines.json the way the TypeScript model-retirement rule does, with the same stop reasons for anything it cannot trace. It covers the openai and anthropic SDKs (client.chat.completions.create, client.responses.create, client.messages.create, sync and async, module-level and class-held clients, string literals, module constants, simple os.getenv and os.environ.get fallbacks). The google-genai SDK is covered too, report only. Follow docs/LANGUAGE-GOALS.md: record the syntax-toolkit and neutral-call-record decisions in docs/ARCHITECTURE.md first, choose a parser that needs no network or Python interpreter at scan time, and justify any new dependency in the PR. Detection only; no Python edits. `refit deadlines` and scanDeadlines report Python call sites, so the hosted inventory gets them. Done when: a frozen list of at least 40 public Python repositories using these SDKs is committed under docs/benchmarks/ with pinned commits; blind hand labels for at least 20 are committed with a scorer and its test; measured line precision is at least 95% and recall is reported honestly; tests cover every pattern and every stop; checks pass; and a PR against main is open. Keep going: add LangChain Python ChatOpenAI and ChatAnthropic model arguments as a named, report-only pattern, with labels. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG2: Go tracer for Stripe and OpenAI

```
/goal On branch feat/go-tracer (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): Refit traces calls to stripe-go (v7x and later) and the official openai-go SDK in Go repositories, from go.mod and go.sum versions to typed client calls (client.V1PaymentIntents.Create, sc.PaymentIntents.New, openai.ChatModel constants and string models). It produces the neutral call record from docs/LANGUAGE-GOALS.md, with a stop reason for anything untraced. OpenAI models are reported against data/deadlines.json, and the Stripe API version Refit sees (stripe-go's pinned version per major) is reported in the inventory. Detection and reporting only. Tracing runs offline without executing go, or with an operator-supplied local toolchain that is never required. Done when: a frozen list of at least 30 public Go repositories is committed with pinned commits; blind labels for at least 15 are committed with a scorer and its test; line precision is at least 95% with recall reported; docs/LANGUAGE-GOALS.md records the decisions taken (in a new dated subsection, not by editing shared docs' existing text); checks pass; and a PR against main is open. Keep going: add the official anthropic-sdk-go with the same labels and measurement. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG3: Data and productivity APIs

```
/goal On branch feat/data-apis (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): Refit detects and monitors the list-B providers (Google Maps Platform, Mapbox, Algolia, HubSpot, Intercom, Mailchimp, Zoom, Dropbox, Notion, Airtable, Segment, Sentry, Discord, Contentful, Cloudinary). Each provider gets an agent-catalog entry with adapter: null (npm package names verified on the npm registry, API hostnames from its API reference). Each provider with a retirement, sunset, API version end-of-life or SDK end of support announced on an official page you read gets registry entries in data/deadlines.json with source and checkedAt, plus matchers the existing deadline benchmark can score. Providers with nothing announced are recorded as "checked, nothing announced" with the pages read. Done when: `npm run deadlines:check` passes; each provider has a fixture-based test for detection and for each matcher; a frozen sample of at least 150 public JS/TS application repositories (at least 10 per provider, query and date recorded) is scanned and docs/DATA-APIS.md reports detection and exposure per provider, with at least 40 hits checked blind by hand for precision; checks pass; and a PR against main is open. Keep going: add raw-HTTP hostname evidence for every provider whose SDK is commonly bypassed (fetch to the API host), with labels. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG4: Raw HTTP API inventory

```
/goal On branch feat/api-hosts (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): Refit reports every external HTTP API a JS/TS repository calls, not only providers with an SDK. data/api-hosts.json lists at least 150 widely used API hosts, each with provider name, API docs URL, source and checkedAt, and with no host overlapping existing catalog hostnames. Hosts are chosen from a documented, reproducible procedure, such as the most common hosts found in the frozen benchmark repositories plus each top provider's documented API base URL. A new exported detectApiHosts(directory) in pipeline/api-hosts.ts finds calls through fetch, axios (including create({ baseURL })), got, ky, undici, node:http(s) and superagent with literal, template, constant and env-default base URLs, and reports host, path prefix, file and line. Known hosts map to providers; other hosts are "untracked". It excludes tests, fixtures, localhost, private ranges, docs, image and CDN asset URLs, and schema or namespace URLs, each exclusion named. It is wired into scanDeadlines output or the inventory input so PG1 picks it up. Done when: tests cover each client form and each exclusion with real snippets; a frozen 60-repository sample is committed, and 30 of its repositories are labelled blind; host-level precision is at least 95% and recall is reported; docs/API-HOSTS.md documents the format and results; checks pass; and a PR against main is open. Keep going: rank the most common untracked hosts in the sample as candidates for catalog entries, under "Requests for other lanes". If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG5: Multi-ecosystem package inventory

```
/goal On branch feat/package-manifests (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): Refit lists the SDKs and versions a repository depends on in every major ecosystem, from manifests and lockfiles only, with no execution. New parsers in pipeline/package-manifests.ts cover:
  - Python: requirements*.txt with -r includes, pyproject.toml [project] and Poetry, uv.lock, poetry.lock, Pipfile and Pipfile.lock;
  - Go: go.mod and go.sum;
  - Ruby: Gemfile and Gemfile.lock;
  - PHP: composer.json and composer.lock;
  - Java and Kotlin: pom.xml with literal versions, and build.gradle or build.gradle.kts literal dependencies;
  - .NET: *.csproj PackageReference;
  - Rust: Cargo.toml and Cargo.lock.
Each yields name, declared range, locked version and file. Agent-catalog entries gain per-ecosystem package names, each verified on that ecosystem's registry (record the shape decision in docs/ARCHITECTURE.md), so detectProviders reports Stripe, OpenAI, Anthropic, Twilio and the other catalog providers in non-JS repositories. Done when: each parser has tests on real manifests copied from public repositories (with attribution and pinned commit in the fixture header); malformed files produce a named stop, never a crash; a frozen 100-repository multi-language sample (at least 10 per ecosystem) is scanned and docs/PACKAGE-INVENTORY.md reports per-ecosystem detection, with 30 repositories labelled blind for precision and recall; checks pass; and a PR against main is open. Keep going: report SDK versions that are past the provider's announced end of support, where a registry entry exists. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG6: Messaging APIs

```
/goal On branch feat/messaging-apis (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): Refit detects and monitors Twilio, SendGrid, Resend, Postmark and Mailgun. Twilio, SendGrid and Resend are already in the catalog with adapter: null; verify and complete their entries, and add Postmark and Mailgun. Read each provider's official changelog, deprecation and library end-of-life pages (for example Twilio's API and helper-library support policy, SendGrid legacy API and template deprecations, Mailgun API version notices). Add registry entries with source and checkedAt, plus matchers. Build review-only call detection in pipeline/messaging-calls.ts for deprecated SDK methods and raw endpoints that the pages name, in the style of pipeline/paypal-calls.ts, reporting file, line and the deadline. Done when: `npm run deadlines:check` passes; each provider has tests for detection, each matcher and each deprecated call form; a frozen sample of at least 60 public repositories (at least 10 per provider) is committed with 25 labelled blind; precision is at least 95% with recall reported in docs/MESSAGING-APIS.md; no customer code is edited; checks pass; and a PR against main is open. Keep going: generate the deprecated-method list from a downloaded, never-installed SDK tarball with a script, as PayPal does, instead of hand-typing it. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG7: Meta WhatsApp and Messenger changelogs

```
/goal On branch feat/meta-platform-changelogs (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): the WhatsApp Business Platform and Messenger Platform changelogs on developers.facebook.com are reviewed version by version from v14.0 to the current version. Their changes go into data/meta-graph-changes.json with source and checkedAt, following the existing entry rules in AGENTS.md and docs/META-GRAPH.md, so WhatsApp and Messenger requests stop being blanket stops. Done when: `npm run meta-graph:check` passes; scripts/meta-graph-benchmark.mjs is rerun and docs/META-PLATFORM-CHANGELOGS.md lists which previously stopped requests now resolve and which still stop, and why; at least 20 public repositories using the WhatsApp Cloud API or Messenger Send API are added as a frozen list, with 10 labelled blind and precision reported; `--propose-version-moves` is not widened; checks pass; and a PR against main is open. A changelog page you cannot read is recorded as Blocked, and its versions stay stopping. Keep going: add the Instagram Graph API changelog the same way. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG8: PayPal next items

```
/goal On branch feat/paypal-next (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): every unchecked item in "PayPal: progress checklist (2026-10-21)" in docs/PROVIDER-GOALS.md that needs no owner decision is done or recorded as Blocked with evidence. Retry developer.paypal.com for deprecation and end-of-support dates (unreachable on 2026-10-21) and add registry entries only from pages read. Close the "Not read" gaps in docs/READINESS.md's PayPal checkpoint: PayPal bases from environment variables and object literals, axios instances with a PayPal baseURL, and controllers passed between files, each with tests. The old-to-new SDK replacement stays review-only. Done when: the frozen PayPal list (docs/benchmarks/2026-10-21-paypal-repos.json) is extended to at least 40 repositories with 20 labelled blind; docs/PAYPAL-PROGRESS.md shows before and after precision and recall; data/paypal-requests.json is regenerated by its script, never hand-edited; checks pass; and a PR against main is open. Progress percentages go in your doc for PP10 to fold into PROVIDER-GOALS.md. Keep going: add Braintree-via-PayPal detection only if it shares hosts, otherwise record it under "Requests for other lanes" for FG10. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG9: Model-retirement wedge and Anthropic parity

```
/goal On branch feat/model-wedge (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): the TypeScript and JavaScript model-retirement path is launch quality. Every unchecked Anthropic item in "OpenAI and Anthropic: progress checklist (2026-10-21)" in docs/PROVIDER-GOALS.md that needs no owner decision is done: Messages API patterns the tracer misses (streaming, messages.stream, beta.messages, tool-use loops), and Bedrock and Vertex Anthropic clients as named stops. Do not edit the OpenAI registry entries; PG6 owns their sync. Then rerun the 100-repository OpenAI and 50-repository Anthropic frozen sets locally. Report exposure, proposed fixes and stops in docs/MODEL-WEDGE.md, rank stop reasons by repositories blocked, and validate at least 15 proposed fixes with offline Docker checks (REFIT_DOCKER_IMAGE=node:22-alpine), reading each diff in full and labelling it. Any widening of what is replaced goes behind a flag that is off by default, with Needs owner decision. Done when: those numbers are recorded with a before and after for the tracer changes; tests cover every new pattern and stop; checks pass; and a PR against main is open. Keep going: implement detection for the top two stop reasons that are reporting gaps (not edit gaps), with tests and re-measurement. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### FG10: Payments and commerce APIs

```
/goal On branch feat/commerce-apis (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): Refit detects and monitors the list-A providers (Plaid, Square, Braintree, Adyen, Paddle, Lemon Squeezy, Shippo, EasyPost, Lob, Coinbase Commerce). Each gets an agent-catalog entry with adapter: null, with packages verified on npm and hostnames from the API reference. Pinned API versions are reported where the provider versions its API (for example Plaid-Version, Square-Version and Adyen's versioned endpoints), with the version and file and line. Registry entries cover each announced version end-of-life, sunset or SDK end of support from official pages read, with source and checkedAt, plus matchers. Done when: `npm run deadlines:check` passes; tests cover detection, each version-pin form and each matcher; a frozen sample of at least 100 public repositories (at least 8 per provider) is committed with 30 labelled blind; docs/COMMERCE-APIS.md reports per-provider detection, pinned versions found, exposure and precision; checks pass; and a PR against main is open. Keep going: for providers that publish an OpenAPI document (check each; Square and Adyen are candidates), pin the document's URL and digest in docs/COMMERCE-APIS.md as groundwork for a future agent, without building one. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

## Furqan: prompts

### FP1: Slack review-only detection

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/slack-detection` from `origin/main`.
>
> **Steps**
> 1. Read `docs/PAYPAL.md` and `pipeline/paypal-calls.ts`, and build Slack detection in the same review-only style in `pipeline/slack-calls.ts`. Cover:
>    - `@slack/web-api` `client.<group>.<method>` calls;
>    - `@slack/bolt` `app.client` and handler `client` calls;
>    - raw `https://slack.com/api/<method>` requests.
> 2. Match them against Slack's method list and its announced deprecations and retirements. Read the api.slack.com changelog and deprecation pages, and cite them with `checkedAt`.
> 3. Generate the method data with a script from a downloaded, never-installed SDK tarball, as `scripts/paypal-requests.mjs` does.
> 4. Add an agent-catalog entry with `adapter: null`, and registry entries for announced retirements.
>
> **Deliverables:** a frozen list of at least 50 public repositories with 20 labelled blind, measured precision and recall, and `docs/SLACK-DETECTION.md`. Do not edit `docs/SLACK.md`, which covers Refit's own Slack notices. No edits to customer code.
>
> **Done when** labels, scorer, tests and doc exist and `deadlines:check` passes.
>
> **Keep going:** detect legacy incoming-webhook and RTM usage as named, report-only findings, with labels.

### FP2: Cloudflare review-only detection

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/cloudflare-detection` from `origin/main`.
>
> **Steps**
> 1. Establish the facts first, in `docs/CLOUDFLARE.md`:
>    - whether Cloudflare publishes an OpenAPI document (find it, and pin its URL and digest);
>    - how the `cloudflare` npm SDK maps resources to endpoints;
>    - Cloudflare's API deprecation announcements (read the pages and cite them).
> 2. Build review-only detection in `pipeline/cloudflare-calls.ts` for SDK calls and raw `api.cloudflare.com/client/v4` requests against deprecated endpoints, with generated data.
> 3. Add a catalog entry with `adapter: null` and registry entries.
> 4. Workers code (`wrangler.toml` compatibility dates) counts too: report the compatibility date and flags as inventory facts.
>
> **Deliverables:** a frozen list of at least 40 repositories with 15 labelled blind, and measured precision. If no machine-readable contract exists, say so and stop at detection from the deprecation pages.
>
> **Done when** the doc, detection, labels and tests exist.
>
> **Keep going:** report `wrangler.toml` compatibility dates older than a year as an inventory fact (no alert), with tests.

### FP3: AI wrapper SDKs

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/model-wrappers` from `origin/main`.
>
> Many AI apps never import `openai` directly. They use the Vercel AI SDK (`ai` with `@ai-sdk/openai`, `@ai-sdk/anthropic` and `@ai-sdk/google`: `openai('gpt-4o')`, `anthropic('claude-…')`, `createOpenAI(...)`), LangChain JS (`ChatOpenAI({ model })`, `ChatAnthropic({ model })`) or LlamaIndex TS. Refit misses them today. Confirm this first by scanning a sample.
>
> **Steps**
> 1. Add report-only detection in `pipeline/model-wrappers.ts`. Map each wrapper call to the underlying provider and model string with file and line, and feed it into `scanDeadlines` so retirements show up in `refit deadlines` and the hosted inventory.
> 2. Edits stay out of scope. `pipeline/model-retirements.ts` belongs to FG9; if a hook there is unavoidable, keep it to one call and say so.
> 3. Build a frozen sample of at least 60 public repositories using these wrappers (query and date recorded), with 25 labelled blind.
>
> **Deliverables:** measured precision and recall, and `docs/MODEL-WRAPPERS.md` with how many sample repositories hit an announced retirement.
>
> **Done when** tests cover each wrapper form, plus constants and env fallbacks.
>
> **Keep going:** add the OpenAI-compatible `baseURL` pattern (Groq, Together, Fireworks) as a named stop, not a match, with tests.

### FP4: Cloud-hosted models

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/model-hosts` from `origin/main`.
>
> Customers call the same models through clouds:
> - Amazon Bedrock (`@aws-sdk/client-bedrock-runtime`, model IDs such as `anthropic.claude-…-v1:0`, inference profiles);
> - Azure OpenAI (`AzureOpenAI`, deployment names, `api-version` query strings);
> - OpenRouter (`openai/gpt-…` style IDs).
>
> **Steps**
> 1. Read the official Bedrock model lifecycle page and the Azure OpenAI model retirements page and its API version lifecycle page, and cite them. Add registry entries with source and checkedAt and with matchers for Bedrock model IDs, Azure API versions and model versions.
> 2. Detect the call sites, report-only, in `pipeline/model-hosts.ts`, feeding `scanDeadlines`.
> 3. Azure deployment names are not model names: report them as a named stop that says to check the deployment's model.
>
> **Deliverables:** a frozen sample of at least 40 repositories with 20 labelled blind, measured precision, and `docs/MODEL-HOSTS.md`.
>
> **Done when** registry entries, detection, tests and labels exist.
>
> **Keep going:** report OpenRouter model IDs that map to retired upstream models, using the existing OpenAI and Anthropic entries, with tests.

### FP5: Auth and backend SDKs

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/auth-backend-sdks` from `origin/main`.
>
> **Steps**
> 1. Cover Auth0 (`auth0`, `@auth0/*`), Clerk (`@clerk/*`), Firebase (`firebase`, `firebase-admin`) and Supabase JS (`@supabase/supabase-js`, `@supabase/auth-helpers-*`). Add catalog entries with `adapter: null`, packages verified on npm and hostnames from the docs.
> 2. Read each provider's official deprecation, end-of-life and support-policy pages: SDK majors out of support, deprecated packages (for example the Supabase auth-helpers replaced by `@supabase/ssr`), and shut-down products (for example Firebase Dynamic Links). Add registry entries with source and checkedAt and with version-range matchers.
> 3. Report which installed major is out of support with file and line, and any import of a deprecated package.
>
> **Deliverables:** a frozen sample of at least 80 public apps (at least 15 per provider) with 30 labelled blind, and `docs/AUTH-BACKEND-SDKS.md` with exposure per provider.
>
> **Done when** `deadlines:check` passes and tests cover each matcher.
>
> **Keep going:** add NextAuth/Auth.js major versions the same way.

### FP6: GitHub API and Octokit

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/github-api-detection` from `origin/main`.
>
> **Steps**
> 1. Read GitHub's REST API versioning page (the `X-GitHub-Api-Version` header and its supported versions), the GitHub changelog's API deprecations, and the GraphQL "breaking changes" page, and cite them.
> 2. Add a catalog entry with `adapter: null` (`@octokit/*`, `octokit` and `api.github.com`).
> 3. Add registry entries for announced removals and version end-of-life dates, with matchers.
> 4. Build review-only detection in `pipeline/github-api-calls.ts` covering:
>    - Octokit REST calls (`octokit.rest.<scope>.<method>` and `octokit.request('GET /…')`) against endpoints the pages name as deprecated;
>    - the pinned API version header;
>    - GraphQL queries in template strings that use fields on the breaking-changes list.
>
> **Deliverables:** a frozen sample of at least 50 repositories with 20 labelled blind, measured precision, and `docs/GITHUB-API-DETECTION.md`.
>
> **Done when** detection, registry entries, labels and tests exist.
>
> **Keep going:** generate the deprecated-endpoint data from GitHub's published OpenAPI description (`github/rest-api-description`, pinned commit) with a script.

### FP7: Cloud SDK end of support

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/cloud-sdk-eol` from `origin/main`.
>
> **Steps**
> 1. Cover AWS SDK for JavaScript v2 (`aws-sdk`) and the retired Azure SDK legacy libraries (`azure-storage`, `azure-sb` and the other track-1 packages Microsoft lists as retired). Read AWS's v2 end-of-support announcement and Microsoft's Azure SDK deprecation list, and cite them.
> 2. Add catalog entries with `adapter: null` and registry entries (`kind: "sdk"`) with matchers.
> 3. Report each v2 service client used (`new AWS.S3()`, `new S3()` from `aws-sdk/clients/s3`) with file and line, so the inventory says exactly which services a migration to v3 touches.
> 4. Also report v3 clients for the inventory (no deadline), so a repository that is half migrated is visible.
>
> **Deliverables:** a frozen sample of at least 60 repositories with 25 labelled blind, measured precision and recall per service, and `docs/CLOUD-SDK-EOL.md` with how many sample repositories still use v2 and which services.
>
> **Done when** registry, detection, labels and tests exist.
>
> **Keep going:** add Google Cloud Node.js libraries that are listed as deprecated on Google's pages, the same way.

### FP8: Monorepo and workspace attribution

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/workspace-attribution` from `origin/main`.
>
> **Steps**
> 1. Make detection correct in monorepos. `detectProviders` and the deadline scanners should attribute each finding to the workspace package it lives in, covering:
>    - npm, pnpm and Yarn workspaces;
>    - Nx, Turborepo and Lerna layouts;
>    - nested `package.json` without workspaces.
> 2. Report the package path and name with each finding.
> 3. Exclude, each as a named reason: vendored code, `node_modules`, `dist` and build output, examples, docs sites and test fixtures.
> 4. Resolve versions from the right lockfile per package.
> 5. Measure first. Take the monorepos in the frozen Stripe, Shopify, OpenAI and Anthropic sets (list them with a script) and record today's misattributions and false positives from excluded paths.
> 6. Fix them in `pipeline/workspace-attribution.ts`, with the smallest hook into the scanners. Keep the output additive: existing fields are unchanged.
>
> **Deliverables:** blind labels for 20 monorepos, before and after precision, and `docs/WORKSPACE-ATTRIBUTION.md`.
>
> **Done when** tests cover each layout and exclusion and the numbers are recorded.
>
> **Keep going:** handle the same layout in Python monorepos (several `pyproject.toml` files) if FG5 has merged, otherwise record it as a request.

### FP9: Shopify REST deprecation detection

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/shopify-rest-deprecations` from `origin/main`.
>
> Shopify is priority 1 in `docs/PROVIDER-GOALS.md`. Its REST Admin API is legacy, and specific endpoints and fields have announced removals.
>
> **Steps**
> 1. Read Shopify's official REST deprecation pages and the per-version API release notes, and cite them. Build `data/shopify-rest-deprecations.json` with endpoint, method, field, version removed, source and checkedAt, plus a check script modelled on `npm run meta-graph:check`.
> 2. Detect REST Admin calls in `pipeline/shopify-rest-deprecations.ts`, reusing the existing `shopify.restCalls` evidence. Match them to the deprecations, report-only with file and line, and add registry entries for announced dates with matchers.
> 3. Measure on the 200-app frozen set (`docs/benchmarks/2026-10-16-shopify-fresh-repos.json`) statically.
>
> Do not touch `pipeline/shopify-sdk-upgrade*` (PG9).
>
> **Deliverables:** 20 apps labelled blind, precision and recall, and `docs/SHOPIFY-REST-DEPRECATIONS.md` with the count of apps calling an endpoint with an announced removal.
>
> **Done when** data, check script, detection, labels and tests exist.
>
> **Keep going:** detect GraphQL Admin fields marked deprecated in the pinned schema for the app's API version, report-only.

### FP10: Gemini and Vertex AI

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/gemini-vertex` from `origin/main`.
>
> Gemini is at 20% on its progress checklist in `docs/PROVIDER-GOALS.md`. Its model dates are unverified because ai.google.dev was unreachable on 2026-10-21.
>
> **Steps**
> 1. Retry ai.google.dev's Gemini deprecations page and Vertex AI's model versions and lifecycle page. Add model retirement entries only from pages you read, with source and checkedAt, and record anything still unreachable as Blocked.
> 2. Detect report-only call sites in the `@google/genai` and `@google/generative-ai` SDKs and in `@google-cloud/vertexai`: `getGenerativeModel({ model })`, `models.generateContent({ model })`, constants and env fallbacks.
> 3. Gemini stays report-only per AGENTS.md: no edits, pinned by the existing test.
> 4. Work through every Gemini checklist item that needs no owner decision.
>
> **Deliverables:** the frozen Gemini set (`docs/benchmarks/2026-10-21-gemini-repos.json`, 50 repositories) remeasured with 20 labelled blind, and `docs/GEMINI-PROGRESS.md` with before and after (PP10 folds percentages into PROVIDER-GOALS).
>
> **Done when** detection tests, labels and the doc exist, plus registry entries or a recorded Blocked.
>
> **Keep going:** add Python `google-genai` patterns if FG1 has merged, otherwise record it as a request for FG1.

---

# Otabek: reliability, benchmarks, safety, developer experience

Otabek owns:
- benchmark **correctness**: labels, scorers, harness reliability (`pipeline/*benchmark*.ts` except PP4's `scripts/shopify-benchmark-setup.mjs`) and the benchmark claims checker;
- the **sandbox** (`pipeline/docker-sandbox.ts`) and **security review**;
- **CI** (`.github/workflows/ci*.yml`; PG6 owns `registry-sync.yml`);
- **dependency preparation and validation** (`pipeline/dependency-preparation.ts`, `pipeline/manager-install.ts`, `pipeline/validation*.ts`);
- the Stripe deterministic rule modules;
- **first-run UX** (`pipeline/readiness*.ts`, CLI messages) and the PR body (`pipeline/publication.ts`, `pipeline/review.ts`).

No AWS and no AI. Docker validation runs locally on small samples (20 repositories at most per run).

| Lane | Area it owns | Runner |
|---|---|---|
| OG1 | Inventory ground-truth benchmark (`docs/benchmarks/*-inventory-*`, `scripts/inventory-benchmark*`) | R1 |
| OG2 | Hosted security review and threat model (`docs/SECURITY.md`, small fixes) | R2 |
| OG3 | Docker sandbox hardening (`pipeline/docker-sandbox.ts`, `docs/SANDBOX.md`) | R3 |
| OG4 | Stripe fresh-set ground truth (`docs/benchmarks/*-stripe-fresh-labels*`) | R4 |
| OG5 | Benchmark harness reliability (`pipeline/*benchmark*.ts`) | R6 |
| OG6 | Upstream replay of historical breaking changes | R6 |
| OG7 | AI-app model-site labels and scorer | R1 |
| OG8 | Deadline benchmark refresh and fresh blind sample | R1 |
| OG9 | CI for gated suites and release packaging (`.github/workflows/ci*.yml`) | R5 |
| OG10 | Yarn Berry dependency preparation (`pipeline/manager-install.ts`, `pipeline/yarn-*`) | R3 |
| OP1 | Test-suite flakes and speed | R5 |
| OP2 | First-run CLI and `refit doctor` UX | R7 |
| OP3 | Draft PR body quality (`pipeline/publication.ts`, `pipeline/review.ts`) | R4 |
| OP4 | Validation speed (`pipeline/validation.ts`, `pipeline/dependency-preparation.ts`) | R7 |
| OP5 | Deterministic Stripe rules mined from stops | R4 |
| OP6 | Node version selection for validation (`pipeline/validation-runtime*.ts`) | R3 |
| OP7 | Supply chain and dependency audit | R2 |
| OP8 | Public-repository readiness audit | R2 |
| OP9 | Preparation and baseline failure fixes | R7 |
| OP10 | Benchmark claims checker (`scripts/benchmark-claims*.mjs`) | R6 |

**Runner queues (Otabek)**

| Session | Queue (in order) | Why this order |
|---|---|---|
| R1 | OG1 → OG7 → OG8 | The three labelling lanes; the same blind-labelling habit carries over |
| R2 | OG2 → OP8 → OP7 | Security review, then the public-repository audit, then supply chain |
| R3 | OG3 → OP6 → OG10 | Sandbox first; runtime and Yarn changes then build on the hardened flags |
| R4 | OG4 → OP5 → OP3 | Stripe labels first, so OP5 can mine rules from their misses |
| R5 | OP1 → OG9 | Fix flakes before making more suites required in CI |
| R6 | OG5 → OP10 → OG6 | Harness schema first, so the claims checker and replay use it |
| R7 | OP9 → OP4 → OP2 | Preparation fixes, then speed, then first-run messages |

- **Shared files:** R3 and R7 both touch dependency preparation and validation. Keep edits small and merge `origin/main` often.
- **Docker:** R3, R4, R6 and R7 run Docker validations. Each lane validates one repository at a time.

**Dependencies (Otabek)**

| Consumer | Producer | What it needs | Fallback without it |
|---|---|---|---|
| OP5 | OG4 | The fresh-set labels and the ranked miss causes | Mine from committed results only |
| OP10 | OG5 | The results schemas and validator | Validate against fields present today |
| OG9 | OG5, OP1 | The validator script (a CI job), and the flake fixes before gated suites become required | Add gated jobs as non-required |
| OG10 | OP6 | Runtime selection, so Yarn versions pair with the right Node image | Default image only |
| OP4 | OP9 | Preparation fixes, so speed is measured on the fixed path | Measure `main`'s path |
- **Hosted files belong to Pierce.** OG2 may touch them only with small, test-backed fixes.

## Otabek: goals

### OG1: Inventory ground-truth benchmark

```
/goal On branch bench/inventory-ground-truth (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): there is an independent benchmark for the claim "Refit detects the APIs a repository uses". Freeze 150 public repositories (100 JS/TS applications, 30 Python, 20 Go), sampled by a documented, reproducible procedure (GitHub search queries, date, filters for real applications rather than libraries or tutorials, pinned commits). Label each one blind, before running Refit on it: every external API or SDK it really calls in production code, with provider, package or host, and one evidence file and line, following a labelling guide you write first in docs/INVENTORY-BENCHMARK.md. Commit the labels as JSON. scripts/inventory-benchmark.mjs runs Refit's detection (detectProviders plus whatever exported detectors exist on main when you run it) and scores per-provider precision and recall, listing every false positive and false negative with its file. Done when: all 150 are labelled; the scorer has a test with a tiny synthetic fixture; results on current main are committed and written up with every miss categorised (provider not in catalog, language not supported, raw HTTP, monorepo, other); checks pass; and a PR against main is open. Keep going: rerun the scorer on each Furqan PR branch that has landed detection, and post the before and after per PR in your doc (read-only use of their branches). If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG2: Hosted security review

```
/goal On branch fix/hosted-security (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): the hosted worker has a written threat model in docs/SECURITY.md. It covers: webhook forgery and replay; delivery GUID reuse; installation, account and owner spoofing; approval tampering; a malicious repository's .refit.json, tests or dependencies (escape, exfiltration, resource exhaustion); lease theft; SQL injection; secret exposure in logs, receipts, evidence and error messages; status-token handling and timing attacks; SSRF through any configured URL; and the GitHub App private key's lifetime on disk. Every finding is either fixed with a regression test that failed before the fix, or listed with a reason it is accepted. Fixes are small and confined to the vulnerable function, because Pierce's lanes are restructuring hosted files. Done when: every Fixed item has its test; a test proves a known secret value fed through every error and log path never appears in output, receipts or evidence; constant-time comparison is used for every token check (tested); checks pass; and a PR against main is open. Do not deploy. Keep going: write a second section for the threats PG2 (issue-comment approval) and PG3 (job machines) introduce, as requirements those lanes must meet, under "Requests for other lanes". If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG3: Docker sandbox hardening

```
/goal On branch fix/sandbox-hardening (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): every `docker run` Refit issues against a hostile repository is audited and hardened. The audit covers network (none for validation), user, capabilities (drop all), seccomp and no-new-privileges, read-only root, tmpfs size limits, pids, memory, CPU, ulimits, mount sources and symlink escapes, archive extraction (zip-slip and tar symlinks), output size caps, timeouts, and orphaned-container cleanup on abort. Hostile fixture repositories (fork bomb, disk filler, symlink to a host path, network probe, a huge stdout, a tarball with ../ entries, a postinstall that tries to reach the network during validation) run as gated Docker tests that must fail safely with a named reason. A unit test inspects the exact `docker run` arguments Refit builds and asserts every flag. Done when: every gap found is fixed with its gated test; docs/SANDBOX.md records each control, its test and any accepted risk; the default suite passes; the gated Docker suite passes locally with REFIT_DOCKER_IMAGE=node:22-alpine (or each failure is reported); checks pass; and a PR against main is open. You own the sandbox; OG2 owns the hosted threat model. Keep going: measure the overhead of each new flag on 5 real validations and record it. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG4: Stripe fresh-set ground truth

```
/goal On branch bench/stripe-fresh-labels (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): the 381-repository fresh Stripe set (docs/benchmarks/2026-10-16-stripe-fresh-repos.json) has ground truth for at least 80 repositories, so recall there is known. Label each one blind by reading its code at the pinned commit: every Stripe call or read affected by the move from its before version to the latest, with file and line, following the format and rules of docs/benchmarks/2026-10-14-stripe-labels.json, docs/benchmarks/STRIPE-LABELS.md and pipeline/stripe-ground-truth-cli.ts. Sample half from "affected" and half from "not affected" outcomes in docs/benchmarks/2026-10-16-stripe-fresh-results.json, with a fixed seed recorded. Done when: the labels are committed; `npm run benchmark:stripe-score` is run against them; docs/STRIPE-FRESH-RECALL.md reports precision and recall with every miss and its cause, ranked by how many repositories each cause affects; no detection code is changed (OP5 and others use your misses); checks pass; and a PR against main is open. Keep going: label 40 more, prioritising repositories whose outcome is "stopped", and update the numbers. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG5: Benchmark harness reliability

```
/goal On branch fix/benchmark-harness (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): every benchmark run is self-describing, checkable and resumable. Across the Stripe, Shopify, deadline and AI-app benchmark CLIs (pipeline/*benchmark*.ts and the scripts they call, but not scripts/shopify-benchmark-setup.mjs or scripts/aws-benchmark*, which belong to PP4; PP2 may make a minimal ordering fix in the benchmark CLI and says so in its PR):
  - Results record the Refit commit and refuse to run from a dirty tree unless --allow-dirty is passed and recorded. They also record the frozen list's digest, the options, the Node and Docker versions and the image digest.
  - Every outcome is classified as a repository result or an infrastructure error (clone failure, registry timeout, Docker failure), so summaries can exclude infrastructure errors by rule.
  - Output order is deterministic.
  - --resume skips repositories already finished in the same output directory with the same commit and options, and refuses on a mismatch.
  - A JSON schema per results format is committed and checked by a validator script, run by the existing summaries before they count anything.
Done when: each feature has a test; every committed results file under docs/benchmarks/ is validated (older files may fail only on fields they predate, and that is recorded, not rewritten); docs/BENCHMARK-HARNESS.md documents the fields; checks pass; and a PR against main is open. Keep going: make scripts/stripe-benchmark-compare.mjs report infrastructure-error changes separately from outcome changes. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG6: Upstream replay

```
/goal On branch bench/upstream-replay (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): there is evidence for "Refit would have caught this". Following docs/UPSTREAM-REPLAY.md's method, at least five historical breaking changes are replayed end to end against repositories that were really affected at the time. Candidates: the Stripe PaymentIntent.charges removal, a Stripe basil change, an OpenAI model shutdown, a Shopify Admin version removal and an Anthropic model retirement. For each, find real public repositories with a commit from before the change that used the affected surface (query and date recorded), and a later commit where the maintainers fixed it by hand. Run Refit at the before commit with the before and after contracts, locally, with offline Docker validation for at most 20 repositories in total. Record whether Refit would have caught it, how many days earlier than the maintainers' own fix, what the patch looked like versus the maintainers' fix (read both in full), and whether validation passed. Done when: docs/UPSTREAM-REPLAY-RESULTS.md has the replay table with every miss explained and every claim linked to a pinned commit; checks pass; and a PR against main is open. Keep going: add a sixth replay for a deadline-only provider (report, no patch) to show the alert lead time. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG7: AI-app model-site labels

```
/goal On branch bench/ai-app-labels (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): model-retirement detection has measured precision and recall on the frozen OpenAI (100, docs/benchmarks/2026-10-21-openai-app-repos.json) and Anthropic (50, docs/benchmarks/2026-10-21-anthropic-app-repos.json) sets. Label blind, before looking at Refit's output: every production model site in a random sample of at least 40 OpenAI and 25 Anthropic repositories (fixed seed recorded), plus at least 30 files per set where a quick read finds nothing. Then run detection (static, no Docker, no AI), hand-check every reported site in the sampled repositories, and score. Commit the labels as JSON beside the frozen lists, with a scorer modelled on scripts/ai-model-benchmark-summary.mjs and its test. Done when: docs/AI-APP-PRECISION.md has precision and recall per set, every false positive and false negative with its cause, and the top fixes ranked by how many sites each would recover, written as "Requests for other lanes" for FG9 and FP3 (no detection code is changed here); checks pass; and a PR against main is open. Keep going: label the remaining repositories in both sets. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG8: Deadline benchmark refresh

```
/goal On branch bench/deadline-refresh (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): the deadline benchmark (docs/DEADLINE-BENCHMARK.md) reflects today's registry and is reproducible. Rerun it on the 100-repository set (docs/benchmarks/2026-10-16-deadline-repos.json) with the current data/deadlines.json, following its Reproduce section, and explain every change against docs/benchmarks/2026-10-16-deadline-fresh-results.json. Then build a second, fresh blind sample of 100 public JS/TS applications not in any existing frozen list (query, date and seed recorded; pinned commits). Label exposure to every registry entry blind, then score Refit on it, covering live, test and comment use separately. Done when: both results files and the labels are committed; docs/DEADLINE-BENCHMARK-2026-10-22.md reports precision and recall on both samples, every false positive and false negative with its cause, and the count of sample repositories exposed to the OpenAI shutdown on 2026-10-23; no matcher code is changed (fixes go to "Requests for other lanes"); checks pass; and a PR against main is open. Keep going: add per-provider rows for every provider added to the registry since October 16. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG9: CI for gated suites and release packaging

```
/goal On branch ci/gated-suites (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): CI runs every suite that needs no secrets. Today CI runs only the default suite on Node 22 and 24. Add GitHub Actions jobs for:
  - Postgres (a service container running the hosted tests with REFIT_TEST_DATABASE_URL);
  - Docker (REFIT_DOCKER_IMAGE=node:22-alpine, REFIT_NPM_PREPARE=1);
  - REFIT_OASDIFF=1 with a pinned, checksum-verified oasdiff;
  - `npm run package:cli`, with a smoke install of the tarball into a clean directory and `refit --help` and `refit doctor --help`.
Keep the required checks fast: gated jobs run on main pushes, nightly and on a `full-ci` label. All actions are pinned to commit SHAs, and permissions are least-privilege per job. Done when: each job has passed at least once on your branch (read the run with `gh run view`; never poll in a loop); a deliberately broken commit, reverted afterwards, proves each gated job fails when it should; docs/CI.md documents jobs, triggers and how to reproduce each locally; checks pass; and a PR against main is open. Keep going: add a job that runs the frozen-list validators from OG5 if it has merged, otherwise record it as a request. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

### OG10: Yarn Berry dependency preparation

```
/goal On branch feat/yarn-berry (base: origin/main; follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule): dependency preparation supports Yarn 2 and later (Berry) projects that use the node-modules linker, beside npm, pnpm and Yarn 1 (pipeline/manager-install.ts, docs/DEPENDENCIES.md). It detects .yarnrc.yml and the Berry lockfile format, installs with the repository's committed yarnPath or Corepack-pinned packageManager version, keeps lifecycle scripts off, leaves offline validation unchanged, and caches by lockfile hash like the others. Plug'n'Play projects, unsupported plugins and a missing lockfile each get a named stop. Done when: a static count from the frozen Stripe and Shopify sets' lockfiles shows how many repositories this unblocks; gated Docker tests with fixture projects (node-modules linker, workspaces, PnP stop, yarnPath and Corepack forms) pass with REFIT_DOCKER_IMAGE=node:22-alpine; 5 real Berry repositories from the frozen sets are prepared and validated locally, with results recorded; docs/YARN-BERRY.md documents it; checks pass; and a PR against main is open. Keep going: measure PnP prevalence in the sets and write the PnP support design as Needs owner decision. If a step can only be done by the owner, the goal is met once it is recorded under Blocked with the exact error and everything else is done.
```

## Otabek: prompts

### OP1: Test-suite flakes and speed

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `test/suite-health` from `origin/main`.
>
> **Steps**
> 1. Run `npm test` 10 times under load: the default `--maxWorkers`, then half, then while a Docker build runs. Record every failure and the 30 slowest tests.
> 2. Fix every flake at its cause, never by retrying or skipping. Typical causes: timeouts tied to load, shared temp paths, port reuse, polling defaults, time-of-day dependence, unawaited promises, leaked timers and listeners. Each fix gets its own commit, explaining the cause.
> 3. Cut total suite time by at least 25% without dropping coverage: shared fixtures, cheaper setup, splitting slow files, removing real sleeps. Compare coverage before and after with vitest's coverage run, and include it in the PR.
>
> **Deliverables:** before and after times and failure counts in the PR, with the commands.
>
> **Done when** 10 consecutive loaded runs pass and the 25% target is met, or the remaining time is explained test by test.
>
> **Keep going:** add a vitest setup check that fails any test leaving an open handle, timer or listener, and fix what it finds.

### OP2: First-run CLI and doctor UX

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/first-run-ux` from `origin/main`.
>
> **Steps**
> 1. Act as a new user. On five realistic repositories from the frozen sets (a clean affected Stripe app, a pnpm monorepo, an app with no tests, a Shopify app, an OpenAI app), follow `docs/REPOSITORY-SETUP.md` from zero. Install from `npm run package:cli`'s tarball into a clean directory.
> 2. Record every confusing message, missing next step, stack trace and dead end in a transcript.
> 3. Fix them:
>    - errors name the exact next command;
>    - `refit doctor` output is understood in 10 seconds (a status line, then what to do);
>    - `--help` text is trimmed and consistent;
>    - no stack trace for any expected user error (use the existing `PipelineInputError` types).
> 4. Every changed message gets a test asserting it.
>
> **Deliverables:** `docs/FIRST-RUN.md` with the before and after transcripts.
>
> **Done when** all five repositories reach a clear `refit doctor` verdict and every recorded problem is fixed or listed with a reason.
>
> **Keep going:** do the same for `refit deadlines` on a repository with no deadlines, one with an expired one, and one with only test-file hits.

### OP3: Draft PR body quality

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/pr-body` from `origin/main`.
>
> **Steps**
> 1. Read the draft PRs Refit published under `refit-dev` (linked in `docs/BENCHMARKS.md` and `docs/PULL-REQUESTS.md`) and `docs/PR-TEMPLATE.md` as a reviewing engineer at the customer would.
> 2. Write down what a reviewer needs and does not get.
> 3. Improve the generated body:
>    - what changed and why, with links to the provider changelog or deprecation page;
>    - the exact checks that ran and their results;
>    - what was not verified;
>    - each untraced site with file and line;
>    - how to roll back;
>    - a short reviewer checklist;
>    - all within a hard length budget, with truncation notes.
> 4. Snapshot-test the body for at least seven real result shapes: validated, needs-review waiver, untraced reads, AI patch, model fix, Shopify, and a multi-integration collection.
>
> Do not republish any PR.
>
> **Deliverables:** regenerated bodies in `docs/PR-BODY-EXAMPLES.md`, labelled as regenerated from stored results.
>
> **Done when** all seven snapshots exist and each body is under the budget.
>
> **Keep going:** apply the same treatment to the commit message Refit writes.

### OP4: Validation speed

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `perf/validation` from `origin/main`.
>
> **Steps**
> 1. Measure, locally, where validation time goes on 15 affected Stripe repositories from the frozen sets: dependency preparation, image start, archive extraction, baseline checks, patched checks.
> 2. Cut it without weakening isolation or changing outcomes:
>    - reuse the prepared dependency archive between baseline and patched runs if not already;
>    - avoid repeated extraction;
>    - overlap independent steps;
>    - skip work that cannot change the outcome.
> 3. Each optimization lands in its own commit with a test.
>
> **Deliverables:** `docs/VALIDATION-SPEED.md` with time saved per stage, and proof of identical outcomes and patch hashes on the same 15 repositories before and after, run at the same pinned commits.
>
> **Done when** the stage table and the identical-outcome proof are recorded.
>
> **Keep going:** profile memory per stage and record the peak against the 3 GiB owner limit.

### OP5: Deterministic Stripe rules mined from stops

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/mined-rules` from `origin/main`.
>
> **Steps**
> 1. From the latest committed Stripe benchmark results (fresh, active, held-out), rank every stop reason by how many repositories it blocks. Exclude those that need an owner decision (`payment_method_types` and the others named in AGENTS.md).
> 2. For the top three that are mechanical and evidence-backed by Stripe's changelog (read and cite it), write deterministic migration rules in the existing rule style. Test them with real snippets from those repositories, with attribution.
> 3. Measure on the affected repositories locally with `--validate`, at most 20.
>
> Any rule that would edit beyond confirmed sites is a stop, not an edit.
>
> **Deliverables:** `docs/MINED-RULES.md` with counts before and after and every validated diff read in full and labelled.
>
> **Done when** three rules ship with tests and measurements, or fewer with each rejected candidate explained.
>
> **Keep going:** do the fourth and fifth.

### OP6: Node version selection for validation

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `feat/validation-node-version` from `origin/main`.
>
> **Steps**
> 1. Measure first: from committed Stripe and Shopify results and their logs, count baseline and preparation failures caused by a Node version mismatch (engines errors, unsupported syntax, native module ABI). Also count the repositories that declare a version in `.nvmrc`, `.node-version`, `engines.node`, `volta.node` or `.tool-versions`.
> 2. Then add runtime selection in `pipeline/validation-runtime.ts`. Pick the validation image from an operator allowlist (for example `node:18-alpine`, `node:20-alpine`, `node:22-alpine`; named constants, default unchanged) that satisfies the repository's declaration.
> 3. Pull nothing at validation time (`--pull never` stays). A missing allowed image is a named stop.
> 4. Record the selection in the receipt and the report.
>
> **Deliverables:** `docs/VALIDATION-RUNTIME.md` with the counts, and a local run on 10 repositories that failed for this reason, before and after.
>
> **Done when** tests cover each declaration form, range resolution and the stops.
>
> **Keep going:** honour `packageManager` versions through Corepack the same way, if OG10 has not already.

### OP7: Supply chain and dependency audit

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `chore/supply-chain` from `origin/main`.
>
> A GitHub App that reads customer code must be trustworthy.
>
> **Steps**
> 1. Audit:
>    - `npm audit` (production and dev, with each finding triaged as reachable or not);
>    - every direct dependency's necessity: remove the unused ones, after proving them unused with a build and the full suite;
>    - GitHub Actions pinned to commit SHAs;
>    - Dockerfiles and `fly.toml` images pinned by digest (read only for `fly.toml`: file the change as a request for Pierce);
>    - the `npm run package:cli` tarball contents: no tests, fixtures, docs or secrets shipped;
>    - license compatibility of every production dependency.
> 2. Generate an SBOM for the CLI tarball and the hosted image with a script that adds no runtime dependency.
> 3. Fix what is safe. List the rest with severity.
>
> **Deliverables:** `docs/SUPPLY-CHAIN.md`.
>
> **Done when** each audit item has a result and every fix has passed the checks.
>
> **Keep going:** add a CI step (coordinate through "Requests for other lanes" with OG9) that fails on a new high-severity reachable advisory.

### OP8: Public-repository readiness audit

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `chore/public-readiness` from `origin/main`.
>
> The repository is intended to become public.
>
> **Steps**
> 1. Scan the **entire git history**, not just `HEAD`, for:
>    - secrets (run gitleaks in Docker with its default rules and record the image digest);
>    - account identifiers (AWS account IDs, the Supabase project ref pattern, Fly app secrets, personal emails, internal hostnames);
>    - private customer or third-party data in fixtures and benchmark results;
>    - any vendored code with an incompatible license.
> 2. Never print a found value in full: redact to the first 4 characters in every log and doc.
> 3. For each finding, give file, commit, kind, and whether it is still valid (do not test credentials; mark "assume valid").
> 4. Fix `HEAD` where safe. History rewrites and key rotations are listed as Needs owner decision, never done.
> 5. Also check that `.gitignore` covers every env and state file, that example configs contain no real values, and that docs never name the AWS account, bucket or Supabase ref.
>
> **Deliverables:** `docs/PUBLIC-READINESS.md`.
>
> **Done when** the history scan, the `HEAD` fixes and the owner list exist.
>
> **Keep going:** draft the public README section, contribution notes and security policy as proposals in your doc for PP10, not in the shared files.

### OP9: Preparation and baseline failure fixes

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `fix/preparation-failures` from `origin/main`.
>
> **Steps**
> 1. From the committed Stripe and Shopify benchmark results, rank every dependency-preparation and baseline-check failure by cause, reading the logs. Typical causes: install timeouts, missing workspace packages, git dependencies, private registries, `postinstall`-required builds (prisma generate, native addons), missing env at build time, peer dependency conflicts.
> 2. For the top three mechanical causes that Refit can handle without weakening isolation, implement the fix with tests. For example, run a declared code generator offline when its inputs are committed, or give a clearer named stop when a private registry is required.
> 3. Every unfixable cause gets a named stop that tells the customer exactly what to change in `.refit.json`.
>
> Do not touch Yarn Berry (OG10) or Node version selection (OP6).
>
> **Deliverables:** a local revalidation of up to 20 previously failing repositories, before and after, and `docs/PREPARATION-FAILURES.md`.
>
> **Done when** three causes are fixed or stopped with tests and measured.
>
> **Keep going:** do the next two causes.

### OP10: Benchmark claims checker

> Follow the shared rules in ~/OVERNIGHT-AGENTS.md, including the minimum-time rule. Branch `test/benchmark-claims` from `origin/main`.
>
> Every number Refit publishes must trace to data.
>
> **Steps**
> 1. Write `scripts/benchmark-claims.mjs`. It reads a small claims file, `docs/benchmarks/claims.json`, where each claim is a doc path, the quoted sentence, the results file, a query (a filter and a count or rate) and the expected value.
> 2. It recomputes each value from the committed results JSON, fails on any mismatch, and prints both values.
> 3. Populate `claims.json` with every numeric claim in `docs/BENCHMARKS.md`, `docs/READINESS.md` (latest five checkpoints), `docs/DEADLINE-BENCHMARK.md` and `docs/PROVIDER-GOALS.md` checklists.
> 4. Run it, and list every claim that does not reproduce, with the recomputed value.
>
> Do not edit those docs. Corrections go to PP10 under "Requests for other lanes", with the exact replacement sentence.
>
> **Deliverables:** the checker and its test, the claims file, and `docs/BENCHMARK-CLAIMS.md` with the results.
>
> **Done when** every numeric claim in those docs is either in `claims.json` or listed as "not checkable" with the reason (for example, no results file committed).
>
> **Keep going:** add a CI hook proposal for OG9, and cover `docs/SHOPIFY-BENCHMARK.md` and `docs/STRIPE-BENCHMARK.md`.

---

## Ready to paste

Each person opens one session per row in their main clone and pastes that row's line as the first message. Nothing else needs typing.

### Pierce

**R1** (PG1 → PG4 → PG5)

```
/goal Complete lanes PG1, PG4, PG5 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R2** (PG10 → PG2 → PP8)

```
/goal Complete lanes PG10, PG2, PP8 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R3** (PG3 → PP6 → PG7)

```
/goal Complete lanes PG3, PP6, PG7 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R4** (PP4 → PP3 → PP9)

```
/goal Complete lanes PP4, PP3, PP9 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R5** (PG8 → PG9 → PG6)

```
/goal Complete lanes PG8, PG9, PG6 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R6** (PP5 → PP7 → PP2)

```
/goal Complete lanes PP5, PP7, PP2 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R7** (PP10 integrator)

```
/loop 45m Do lane PP10 from ~/OVERNIGHT-AGENTS.md, one pass per iteration, with $REFIT being the folder this session started in, following the shared rules in that file.
```

### Furqan

**R1** (FG1 → FP10 → FG2)

```
/goal Complete lanes FG1, FP10, FG2 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R2** (FG5 → FP8 → FP4)

```
/goal Complete lanes FG5, FP8, FP4 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R3** (FG4 → FG3 → FG8)

```
/goal Complete lanes FG4, FG3, FG8 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R4** (FP5 → FG10 → FG7)

```
/goal Complete lanes FP5, FG10, FG7 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R5** (FP1 → FP2 → FP6)

```
/goal Complete lanes FP1, FP2, FP6 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R6** (FP7 → FG6 → FP9)

```
/goal Complete lanes FP7, FG6, FP9 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R7** (FG9 → FP3)

```
/goal Complete lanes FG9, FP3 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

### Otabek

**R1** (OG1 → OG7 → OG8)

```
/goal Complete lanes OG1, OG7, OG8 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R2** (OG2 → OP8 → OP7)

```
/goal Complete lanes OG2, OP8, OP7 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R3** (OG3 → OP6 → OG10)

```
/goal Complete lanes OG3, OP6, OG10 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R4** (OG4 → OP5 → OP3)

```
/goal Complete lanes OG4, OP5, OP3 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R5** (OP1 → OG9)

```
/goal Complete lanes OP1, OG9 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R6** (OG5 → OP10 → OG6)

```
/goal Complete lanes OG5, OP10, OG6 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

**R7** (OP9 → OP4 → OP2)

```
/goal Complete lanes OP9, OP4, OP2 from ~/OVERNIGHT-AGENTS.md, in that order, with $REFIT being the folder this session started in, following the shared rules, preflight and handoff rules in that file, and its Dependencies table: push ready/<lane> as soon as a lane others depend on has a stable interface, and pick up producers' ready tags as described. For each lane: create its worktree from a fresh origin/main, run `npm ci`, and do the lane exactly as written. A goal lane is finished when its /goal condition is met; a prompt lane is finished when its "Done when" is met and the minimum-time rule is satisfied through its "Keep going" list. End each lane with its PR open, pushed and summarised, then remove its worktree (the branch stays) and start the next lane immediately. A lane that is Blocked is recorded in its PR, and the runner moves on. This goal is met when every lane in the queue has an open PR with a summary (or a PR recording why it is Blocked), every worktree this session created is removed, and no AWS run this session started is still running.
```

---

## Morning checklist for the owner

1. Check every runner session ended (or note which stopped on a usage limit and restart it with the same `/goal`). Then read PP10's PR summary and `docs/LAUNCH-CHECKLIST.md` on its branch.
2. Merge in PP10's recommended order: producers before consumers (see each Dependencies table). Merge only what you have read, and never merge a lane whose checks fail. Then delete the `ready/*` tags.
3. Decide the "Needs owner decision" items. Then change GitHub App settings (permissions, events, Setup URL) by hand.
4. Stop or collect any AWS run still listed by `node scripts/aws-benchmark.mjs status` (Pierce), and check the Billing page.
5. Start PP1 (post-merge benchmark) on the merged `main`.
6. Deploy only after the merged `main` passes CI and PP1 shows no regressions, following `docs/HOSTED-RUNBOOK.md` once PP5 lands.
