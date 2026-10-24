# Refit overnight 2: find problems, not rules (90 lanes)

Ninety lanes, **30 each for Pierce, Furqan and Otabek**. Every lane is real work meant to run **at least 3 hours** with no questions, commits at least hourly and ends in an open PR against `main`. Each person starts **10 sessions** at bedtime: 9 runners that each work through a queue of 3–4 lanes, plus 1 integrator. Pierce also runs one lane, P29, in the morning.

This file builds on [`OVERNIGHT-AGENTS.md`](OVERNIGHT-AGENTS.md) (night 1, 2026-10-22). Its **Shared rules**, **Preflight**, **How a runner works** and **Handoffs** sections apply here, except where [Changes from night 1](#changes-from-night-1) says otherwise. Read both files before starting.

## Night theme: find problems, not rules

**Where Refit is today (checked 2026-10-24 on `main` at `8ace06f`).**

- **Contract diffing is generic, but mapping to code is not.** Contracts are diffed with oasdiff and direct response-field removals for any OpenAPI document. Turning a change into "this line of this repository breaks" needs a hand-written adapter. Only Stripe, OpenAI and Shopify have one; about 45 catalog entries in `pipeline/agent-catalog.ts` have `adapter: null`.
- **Every fix is a hand-written rule for one field.** Examples: `pipeline/stripe-field-moves.ts`, `pipeline/stripe-request-moves.ts`, the `STRIPE_MOVE_REVIEW` table, the `payment_method_types` policy and the Shopify pin moves.
- **The test PRs show it.** The open Refit Agent PRs on the `refit-dev` forks (`gh search prs --author app/refit-agent`) are all Stripe endive rules:
  - "move `payment_method_types` to `allowed_payment_method_types`";
  - "migrate removed `invoice.subscription` reads";
  - "migrate removed Stripe API fields".

  Refit fixes what someone already wrote a rule for, and finds little else.

- **Adding a provider is mostly hand work.** It takes a new `*-calls.ts`, a select script, a score script and a benchmark script. `scripts/` has one set per provider.

**Target.** Refit **finds** problems from evidence any provider already publishes, and **proposes** fixes through one general fixer behind gates that work for any provider:

- **Evidence sources:**
  - API contracts;
  - SDK type declarations and their diffs;
  - `@deprecated` markers;
  - npm `deprecated` messages;
  - OpenAPI `deprecated` fields;
  - SDK changelogs;
  - type errors when compiled against the target SDK;
  - runtime deprecation warnings;
  - GraphQL schema validation.
- **Gates:** patch policy, request diff, rescan, offline validation and human review.
- **Rules stay** as a fast path and as the golden answers the general path is scored against.

**Boundaries tonight. This is not a default switch.**

- `AGENTS.md` says to prefer deterministic, explicitly configured rules and to use AI only as a bounded assistant.
- Pierce decided on 2026-10-22 that there will be **no new automatic Stripe edits** (`docs/MINED-RULES.md`).
- So everything general tonight is built **behind flags that are off by default**:
  - finders: `--finders generic`;
  - fixer: `--fixer agent`.
- Every lane proves that default output is **unchanged** on the frozen sets it touches.
- The morning packet (P30) puts the evidence in front of Pierce: the bake-off of rules against the general fixer (P10, P11, P14), finder recall against the hand adapters (F23), and costs (P28). Pierce then decides whether to make the general path the default. No lane flips a default or widens what Refit edits by default.

### The Problem record (shared interface)

Every finder emits this record, and the fixer, report, CLI and scorer consume it. F01 implements it in `pipeline/problems.ts` exactly as written. Until `ready/F01` exists, a consumer declares an identical local type and switches to the import when it merges F01's branch.

```ts
export type ProblemKind =
  | 'removed-operation'
  | 'removed-request-field'
  | 'removed-response-field'
  | 'changed-type'
  | 'changed-enum'
  | 'removed-export'
  | 'changed-signature'
  | 'deprecated'
  | 'retiring-model'
  | 'end-of-support'
  | 'type-error-on-target'
  | 'runtime-deprecation'
  | 'graphql-invalid'
  | 'version-pin';

export type ProblemEvidence = {
  source:
    | 'contract'
    | 'sdk-types'
    | 'sdk-changelog'
    | 'npm-deprecation'
    | 'openapi-deprecated'
    | 'compile'
    | 'runtime'
    | 'registry'
    | 'docs'
    | 'graphql-schema';
  ref: string; // contract path, package@version, file:line, URL
  quote?: string; // verbatim, at most 300 characters
  checkedAt?: string; // ISO date, required for registry and docs evidence
};

export type Problem = {
  id: string; // sha256 of provider, kind, site file:line:column and change.summary
  provider: string; // catalog id, or the API host when no entry exists
  kind: ProblemKind;
  site: { file: string; line: number; column: number; snippet: string; language: string };
  change: { summary: string; from?: string; to?: string; operation?: string; symbol?: string };
  evidence: ProblemEvidence[]; // at least one
  confidence: 'confirmed' | 'likely' | 'possible';
  deadline?: string; // ISO date, only from registry or provider evidence
  finder: string; // module that produced it, for example 'sdk-type-diff'
  stop?: string; // named reason when the finder could not decide
};
```

## Changes from night 1

1. **Ten sessions per person:** R1–R9 runners plus R10 integrator under `/loop 45m`.
   - This uses more of the Claude plan than night 1. A session that hits a usage limit resumes from its runner `/goal` in the morning; nothing is lost, because lanes push at least hourly.
2. **Handoffs work across people.** Any lane may build on any other lane's `ready/<lane>` tag, following the Handoffs rules in night 1's file. A lane is never Blocked by a producer; it uses the fallback in the Dependencies tables.
3. **Lane ids are new:** P01–P30, F01–F30 and O01–O30. Branches are named in each lane.
4. **Shared docs.**
   - O02 owns `docs/BENCHMARKS.md` tonight.
   - P30 owns `docs/READINESS.md`, `AGENTS.md`, `README.md` and `docs/CLI.md`, and writes the morning packet `docs/OVERNIGHT-2-RESULTS.md`.
   - Everyone else writes findings in their own doc and PR.
5. **AI budget.** Only these lanes may make model requests, each under `REFIT_AI_BUDGET_USD=<cap>`, with the key from the lane owner's own `.env` passed by path (`--env`), never printed:

   | Lane | Cap | Whose key                               |
   | ---- | --- | --------------------------------------- |
   | P09  | $15 | Pierce                                  |
   | P10  | $25 | Pierce                                  |
   | P11  | $15 | Pierce                                  |
   | P12  | $10 | Pierce                                  |
   | P13  | $10 | Pierce (Anthropic key; Blocked if none) |
   | P14  | $15 | Pierce                                  |
   | P19  | $5  | Pierce                                  |
   | O09  | $5  | Otabek (simulated only if no key)       |

   **Total at most $100.** Tests never call a model: they replay recorded transcripts (P12 builds that).

6. **AWS (Pierce only).**
   - On 2026-10-22, EC2 launches were denied by an organization policy. P15 diagnoses it first; Pierce confirms `node scripts/aws-benchmark.mjs launch` works in preflight.
   - If AWS is denied, AWS lanes run at most 20 repositories locally and record Blocked ("AWS").
   - The cap is 3 `c7i.xlarge` shards running at once across all of Pierce's lanes. P10 takes 2, P14 1, P23 1 and P29 3, never at the same moment: P10 and P14 sit in different queues and check `status` before launching.
7. **Docker.**
   - Otabek runs Docker work on his EC2 Docker host when `~/.refit-ec2` works. `scripts/ec2.sh` lives on `origin/feat/ai-agents-phase-4`; read it with `git show` and do not merge that branch.
   - Everyone else uses local Docker under `/tmp/refit-docker.lock`, one repository per hold.
   - Docker-heavy runners: Pierce R4/R5/R8, Furqan R6, Otabek R1/R2/R4/R6/R9.
8. **No Fly and no Supabase, except read-only.** Allowed read-only checks: `curl https://refit-hosted.fly.dev/health`, `fly status` and `fly logs`, if `flyctl` is installed and logged in. Everything hosted is tested against local Postgres. Nothing deploys tonight.
9. **"Default unchanged" is evidence, not a claim.** Any lane that adds a flag diffs default-path results against `main` on every frozen set it touches and commits the diff output, which must be empty or explained line by line.
10. **Merges in the morning go through O14's merge train.** Do not leave a PR in a state that cannot be merged in the order the Dependencies tables imply.

## Morning (owner)

1. Read P30's packet `docs/OVERNIGHT-2-RESULTS.md`: per-lane status, merge order, owner decisions with evidence.
2. Run O14's merge train in dry-run on the merge order. Merge producers first (F01, O07, P09, F03, F05, F02, F04, F06).
3. Start P29, the post-merge benchmark, on merged `main`.
4. Decide, from P10, P11, P14, F23 and P28:
   - whether the general finders become default;
   - whether the agent fixer becomes default for any provider;
   - what happens to the per-field rules.

   Record each decision in `AGENTS.md`.

5. Delete the `ready/*` tags.

---

# Pierce: hosted platform, the general fixer, AWS

Pierce owns:

- the hosted worker: `pipeline/hosted-*`, `pipeline/fly-machines.ts`, `pipeline/hosted-runner.ts`, `pipeline/inventory*`, `pipeline/monitoring*` and `pipeline/report*`;
- `pipeline/ai-patches.ts` and the new `pipeline/problem-fixer*`;
- `scripts/aws-benchmark*`, `fly.toml` and `pipeline/deadline-sync.ts`;
- the Shopify upgrade path and the website branch.

He is the only person with AWS and most of the AI budget.

| Lane | Title                                                   | Owns                                                               | Runner  | AWS      | AI  |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------ | ------- | -------- | --- |
| P01  | Hosted deploy preflight                                 | `pipeline/hosted-preflight*.ts`                                    | R1      | –        | –   |
| P02  | Graceful drain, job timeout, skip unchanged polls       | `pipeline/hosted-drain*.ts`                                        | R1      | –        | –   |
| P03  | Job-machine defects                                     | `pipeline/fly-machines*.ts`, `pipeline/hosted-runner*.ts`          | R2      | –        | –   |
| P04  | Control-side publication and AI grants for job machines | `pipeline/hosted-publication*.ts`                                  | R2      | –        | –   |
| P05  | Accounts by ID and renames                              | `pipeline/hosted-tenancy*.ts`, `pipeline/hosted-lifecycle*.ts`     | R2      | –        | –   |
| P06  | Store security residuals T2 and T12                     | `pipeline/hosted-store*.ts` (small)                                | R1      | –        | –   |
| P07  | Dependency cache on the volume                          | `pipeline/dependency-cache*.ts`                                    | R8      | –        | –   |
| P08  | Local hosted end-to-end on real code                    | `pipeline/hosted-e2e*.test.ts`, fixtures                           | R5      | –        | –   |
| P09  | General fixer                                           | `pipeline/problem-fixer*.ts`                                       | R3      | –        | $15 |
| P10  | Bake-off: rules against the general fixer on Stripe     | `docs/benchmarks/*-bakeoff*`, `docs/BAKEOFF.md`                    | R4      | 2 shards | $25 |
| P11  | Re-derive the refit-dev fork PRs                        | `docs/FORK-PR-REDERIVE.md`                                         | R5      | –        | $15 |
| P12  | Fixer repair loop and recorded transcripts              | `pipeline/model-transcripts*.ts`                                   | R3      | –        | $10 |
| P13  | Anthropic backend for patches                           | `pipeline/ai-providers*.ts`                                        | R3      | –        | $10 |
| P14  | Fixer determinism                                       | `docs/FIXER-DETERMINISM.md`                                        | R5      | 1 shard  | $15 |
| P15  | AWS launch diagnosis and runner doctor                  | `scripts/aws-benchmark*`                                           | R4      | smoke    | –   |
| P16  | Problems-first report                                   | `pipeline/report*.ts`                                              | R6      | –        | –   |
| P17  | General finders in hosted monitoring                    | `pipeline/monitoring*.ts`, `pipeline/inventory*.ts`                | R6      | –        | –   |
| P18  | Alerts and digest dry run                               | `pipeline/hosted-alerts-preview*.ts`                               | R6      | –        | –   |
| P19  | Changelog watcher to change candidates                  | `pipeline/changelog-candidates*.ts`                                | R7      | –        | $5  |
| P20  | Secret redaction in stored inventories                  | `pipeline/inventory-redaction*.ts`                                 | R7      | –        | –   |
| P21  | Deletion on request                                     | `pipeline/hosted-forget*.ts`                                       | R7      | –        | –   |
| P22  | Hosted metrics and Slack redaction                      | `pipeline/hosted-metrics*.ts`                                      | R8      | –        | –   |
| P23  | Hosted capacity with general finders                    | `docs/CAPACITY.md`                                                 | R8      | 1 shard  | –   |
| P24  | Shopify SDK upgrade for the 44 fresh apps               | `pipeline/shopify-sdk-upgrade*.ts`                                 | R9      | –        | –   |
| P25  | Registry sync and default-branch readiness              | `pipeline/deadline-sync.ts`, `.github/workflows/registry-sync.yml` | R9      | –        | –   |
| P26  | Website claims sync                                     | branch from `origin/pre-launch-website`                            | R9      | –        | –   |
| P27  | "What Refit finds" customer guide                       | `docs/WHAT-REFIT-FINDS.md`, `scripts/report-examples.mjs`          | R9      | –        | –   |
| P28  | Cost model for the general path                         | `docs/CAPACITY.md` (fixer section)                                 | R4      | –        | –   |
| P29  | Post-merge benchmark, **morning only**                  | `docs/benchmarks/*-post-merge-2*`                                  | morning | 3 shards | –   |
| P30  | Integrator and morning packet                           | shared docs, `docs/OVERNIGHT-2-RESULTS.md`                         | R10     | –        | –   |

**Runner queues (Pierce)**

| Session | Queue                 | Why                                                                  |
| ------- | --------------------- | -------------------------------------------------------------------- |
| R1      | P01 → P02 → P06       | Everything a safe deploy needs                                       |
| R2      | P03 → P04 → P05       | Job machines and tenancy, the path to outside accounts               |
| R3      | P09 → P12 → P13       | The fixer core; push `ready/P09` early                               |
| R4      | P15 → P10 → P28       | AWS fixed first, then the bake-off on it, then its costs             |
| R5      | P08 → P11 → P14       | Local end-to-end first, so P09 has time to tag before P11            |
| R6      | P16 → P17 → P18       | Report, monitoring, alerts on the Problem record                     |
| R7      | P19 → P20 → P21       | Data handling and changelog candidates                               |
| R8      | P22 → P23 → P07       | Operations and capacity                                              |
| R9      | P24 → P25 → P26 → P27 | Shorter, independent lanes                                           |
| R10     | P30 under `/loop 45m` | Reviews all of Pierce's PRs, collects every person's owner decisions |

### P01: Hosted deploy preflight

```
/goal On branch feat/hosted-preflight (worktree from a fresh origin/main; follow the shared rules of ~/OVERNIGHT-AGENTS.md as changed by ~/OVERNIGHT-AGENTS-2.md, including the 3-hour minimum-time rule; nothing touches Fly or Supabase): `refit hosted preflight` exists and answers "is it safe to fly deploy this commit?" with no state change anywhere. Read docs/HOSTED-ONBOARDING.md, docs/HOSTED-RUNBOOK.md, pipeline/hosted-migrations.ts, fly.toml and scripts/hosted-entrypoint.sh first. In pipeline/hosted-preflight.ts, with a small additive CLI hook, check and report each as pass, warn or fail with the exact fix: pending migrations and what each does (run against a local Postgres restored to the oldest schema version the live service could have, recorded in the PR); every image in REFIT_HOSTED_IMAGES pinned by digest (stripe/stripe-mock:latest is not, and it is now pulled on boot after #241); the required secret names listed in AGENTS.md present in a supplied names-only list (never values); the hosted flags in fly.toml against the owner decisions in docs/LAUNCH-CHECKLIST.md (for example --ai-patch with no REFIT_HOSTED_AI_BUDGET_USD is a fail); the machine size against docs/CAPACITY.md; whether running jobs would be interrupted (until P02 lands, always warn). Tests cover every check with fixtures, including a migration that would fail on the older schema. Done when the command runs on this commit against local Postgres and its output is in the PR, with the exact digest to pin stripe-mock under Needs owner decision; keep going by adding a --json output and a test that the runbook's deploy section matches the command's checks.
```

### P02: Graceful drain, job timeout, skip unchanged polls

```
/goal On branch feat/hosted-drain (worktree from a fresh origin/main; shared rules as above; hosted code is tested only against a local Postgres container in its own schema): a deploy no longer kills hosted jobs mid-run. Read pipeline/hosted-service.ts, pipeline/hosted-store.ts, the job-machine code, docs/HOSTED-RUNBOOK.md, docs/HOSTED-ISOLATION.md and docs/CAPACITY.md first. In pipeline/hosted-drain.ts with small hooks in hosted-service.ts: (a) on SIGTERM or SIGINT the worker stops claiming jobs, lets running jobs finish within a bounded grace period, releases the leases of jobs it cannot finish so another worker takes them without counting a failure, flushes logs and exits 0, and /health reports draining; (b) a job-level timeout flag, off by default, that ends a job with a named error receipt and removes its containers; (c) a flag, off by default, that skips a scheduled poll's scan when the head commit and contract hash are unchanged since the last completed scan, with a skipped receipt. Tests against local Postgres: drain with no jobs, with a finishing job, with one over the grace period, a second SIGTERM forcing exit, a lease picked up by a second worker, the timeout, skip on unchanged and scan on changed, and one test that runs a real `refit hosted serve` process and sends it SIGTERM mid-job. Propose, do not apply, fly.toml kill_timeout and flag values under Needs owner decision, and update docs/HOSTED-RUNBOOK.md. Done when all of that passes; keep going with a `refit hosted drain status` command and a test that two workers draining at once lose no job.
```

### P03: Job-machine defects

```
/goal On branch fix/job-machine-defects (worktree from a fresh origin/main; shared rules as above; the Fly Machines API is only ever the simulated one in pipeline/fixtures, never live): the three defects night 1's review found in per-job machines (#176) are fixed at their cause, each with a test that fails before and passes after. (1) A 429 without Retry-After retries after 0 ms: implement bounded exponential backoff with jitter and a cap, honouring Retry-After when present, and a named error when the budget runs out. (2) One malformed Machines API response ends the whole hosted loop: validate every response at the boundary, fail only that job with a named receipt and keep the loop running. (3) The reaper can destroy another worker's new machine: scope reaping to machines this worker created (label or metadata with the worker id and a creation lease), never touch a machine younger than its lease, and test two workers reaping at once. Read pipeline/fly-machines.ts, pipeline/hosted-runner.ts, docs/HOSTED-ISOLATION.md and the fakes first. Update docs/HOSTED-ISOLATION.md's gaps table. Done when all three are fixed with tests and the simulated end-to-end (create, run, collect, destroy) still passes; keep going by adding a chaos test that injects random 429s, 5xx and malformed bodies into the fake for 500 jobs and asserts no job is lost or double-run.
```

### P04: Control-side publication and AI grants for job machines

```
/goal On branch feat/job-machine-publication (worktree from a fresh origin/main; shared rules as above): with --job-machines on, a validated patch can become a draft PR without giving the job machine any write token, and --ai-patch can run there under the per-installation AI ledger. Today --job-machines drops --ai-patch and --publish-draft (docs/LAUNCH-CHECKLIST.md item 11). Build in pipeline/hosted-publication.ts: the job machine returns the patch, evidence and receipt; the control worker re-verifies the patch against the recorded base commit and the evidence hash, then publishes with its own App token, so the machine never holds a write credential. For AI, add grant/settle on the ledger: the control grants a per-job allowance before start, the machine reports usage, the control settles and refuses any job whose installation or total cap (REFIT_HOSTED_AI_BUDGET_USD) is exhausted. Both behind flags off by default. Test against local Postgres and the fake GitHub and fake Machines API, including a forged patch that does not match the evidence hash and a machine that over-reports usage. Done when both paths pass end to end in the simulated journey; keep going by documenting the threat model delta in docs/HOSTED-ISOLATION.md and listing what is still needed before outside accounts.
```

### P05: Accounts by ID and renames

```
/goal On branch fix/hosted-account-ids (worktree from a fresh origin/main; shared rules as above): the hosted worker identifies the owner and allowed accounts by numeric account ID, not login (security residual T4), and has tested behaviour for account and repository renames and transfers, all behind the existing defaults where behaviour would change. Read pipeline/hosted-tenancy*.ts, pipeline/github-webhooks.ts, the lifecycle code from #200 and docs/LAUNCH-CHECKLIST.md item 7. Add a migration (next free version) that stores account IDs, backfills from stored installation payloads, and matches by ID with the login kept for display. Implement: same-account repository rename keeps its approval with a new fingerprint recorded in an audit row; account rename keeps approvals; cross-account transfer drops approval and records why. Tests with recorded webhook payload shapes for every case. Put the rename and transfer policy under Needs owner decision with what the code does today. Done when matching is by ID end to end in tests and every case has a test; keep going by adding `refit hosted accounts` listing ID, login and status.
```

### P06: Store security residuals T2 and T12

```
/goal On branch fix/hosted-store-residuals (worktree from a fresh origin/main; shared rules as above): the two open security residuals from #171 are closed or turned into explicit options. T12: support sslmode=verify-full with a CA bundle path for REFIT_DATABASE_URL, tested against local Postgres configured with a self-signed CA (verify-full passes with the right CA and fails with a wrong one); document how to fetch Supabase's CA, and leave switching the live URL under Needs owner decision. T2: an identical legitimate redelivery is refused and cannot be redelivered; design and implement redelivery that keeps replay protection (for example the GitHub delivery id plus the hash, with an explicit `refit hosted redeliver <delivery>` command that the owner runs), with tests for replay, legitimate redelivery and forged redelivery. Update docs/SECURITY.md's threat table. Done when both have tests and docs; keep going by auditing every other stored secret-like field for encryption at rest and writing the gaps.
```

### P07: Dependency cache on the volume

```
/goal On branch feat/hosted-dependency-cache (worktree from a fresh origin/main; shared rules as above; touch pipeline/dependency-preparation.ts only with a small additive hook, since Otabek owns it): the dependency archive cache survives deploys and has a bound. Today it is lost on each deploy (docs/LAUNCH-CHECKLIST.md item 16). In pipeline/dependency-cache.ts: a cache directory option (default unchanged) that the hosted worker can point at /data; a size bound with least-recently-used eviction and a high-water mark; integrity by the existing lockfile-hash key plus a content hash checked on read, refusing and evicting on mismatch; safe concurrent access by two jobs. Tests for eviction order, corruption, concurrency and the bound. Measure locally on 10 repositories from the frozen sets: cold and warm preparation times and the cache size. Propose a bound for the 20 GB volume under Needs owner decision. Done when the cache works with tests and measurements; keep going by adding cache statistics to `refit hosted status`.
```

### P08: Local hosted end-to-end on real code

```
/goal On branch test/hosted-e2e-real-code (worktree from a fresh origin/main; shared rules as above; never contact real GitHub, Fly or Supabase): a test runs a real `refit hosted serve` process against local Postgres and a fake GitHub that serves pinned clones of five public repositories behind the refit-dev fork PRs, and shows the whole hosted path on real code: install webhook, inventory, approval, scheduled poll, job, offline Docker validation, patch, and a draft PR captured by the fake (never sent). Read pipeline/customer-journey*.test.ts, pipeline/fixtures/fake-github*, docs/HOSTED-ONBOARDING.md and the fork PR list (gh search prs --author app/refit-agent) first. Pick five repositories whose fork PRs cover payment_method_types, invoice.subscription, current_period_* and a [Needs review] draft; clone each at the commit its fork PR was based on, depth 1, into an ignored directory. Gate the test behind an env variable so the default suite stays fast, and report its run separately. Compare each captured draft with the real fork PR's diff and body. Done when the five run end to end with captured drafts that match the fork PRs or every difference is explained; keep going by adding a sixth repository that should stop for review and asserting the review issue body.
```

### P09: General fixer

```
/goal On branch feat/problem-fixer (worktree from a fresh origin/main; shared rules as above; at most $15 of model spend under REFIT_AI_BUDGET_USD=15, key passed by path; tests use recorded transcripts only): `refit run --fixer agent`, off by default, proposes a patch for any confirmed Problem record (see the interface in ~/OVERNIGHT-AGENTS-2.md) from any provider, not only those with rules. Read AGENTS.md, docs/ARCHITECTURE.md (AI and validation), pipeline/ai-patches.ts, pipeline/ai-patch-eval*.ts and pipeline/request-removals.ts first. Push ready/P09 as soon as the interface below is stable. In pipeline/problem-fixer.ts: input is a set of Problems plus their evidence (contract diff fragment, changelog quote, type errors); the model gets only the files containing problem sites and their direct imports, the evidence, and the owner policies from AGENTS.md as constraints (never delete a removed request parameter, replace it only as policy allows or stop; never edit tests; never add hosts). Every proposal goes through gates before validation: the patch policy checker from O07 (merge ready/O07 when it exists; until then implement the same checks inline: edits only at problem sites, their imports and package files), a rescan that shows each targeted Problem gone and no new Problem, and the existing offline validation. Any gate failure is a named stop with the evidence; the default path (no flag) must be byte-identical to main on the Stripe held-out 50 and Shopify original 50 scans (commit the diff). Measure on 10 repositories locally with validation, read every diff in full, label correct, partial or wrong. Done when the flag works end to end with gates and tests and the 10 are labelled; keep going on 10 adapter-less repositories using Problems from Furqan's finders (merge their ready tags) and report what the fixer did there.
```

### P10: Bake-off: rules against the general fixer on Stripe

```
/goal On branch bench/fixer-bakeoff (worktree from a fresh origin/main; shared rules as above; at most $25 of model spend; AWS at most 2 c7i.xlarge shards, run id bakeoff-<date>-pierce-<n>, collect or stop when done): there is a fair, labelled comparison between Refit's rules and the general fixer on the same repositories. Do P15 first if AWS launch fails. Merge ready/P09 (wait per the handoff rules; fallback: compare rules against the existing --ai patch path and say so). On the Stripe held-out 50 and original 100 at their frozen commits, from a pinned worktree, run three arms: rules only (today's default), fixer only (--fixer agent with rules disabled for that run), and rules then fixer for what rules stopped on. Same validation, same images, same budget per repository. For every repository record outcome, validation, cost and time; read every patch that passed validation in full and label correct, partial or wrong, with the reason; a wrong patch that passes validation is the most important finding, so list each. Write docs/BAKEOFF.md with the table per arm, the wrong patches, which rules the fixer reproduced exactly, and which stops the fixer got past correctly. Done when all three arms are complete on both sets and every passing patch is labelled; keep going by adding the Stripe fresh 381 in the third arm only.
```

### P11: Re-derive the refit-dev fork PRs

```
/goal On branch bench/fork-pr-rederive (worktree from a fresh origin/main; shared rules as above; at most $15 of model spend; never push to or comment on the forks): for every open Refit Agent PR on the refit-dev forks (list with `gh search prs --author app/refit-agent --state open --limit 100`), we know whether the general path would have found the same problems and made the same fix without the hand rules. Merge ready/P09 and the ready tags of F05 and F06 when present (fallback: run only the finders and fixer that exist and say so). For each PR: take its base commit, run Refit's default path and the general path (--finders generic --fixer agent with rules disabled), and compare problem lists and diffs file by file against the PR. Classify each PR: same fix, equivalent fix, different but correct, worse, or not found, with the reason. List the problems the general path found that the rule PR missed. Write docs/FORK-PR-REDERIVE.md with the table and every diff that differs. Done when every PR is classified; keep going by doing the same for the closed Refit Agent PRs.
```

### P12: Fixer repair loop and recorded transcripts

```
/goal On branch feat/model-transcripts (worktree from a fresh origin/main; shared rules as above; at most $10 of model spend): every model interaction in Refit can be recorded and replayed, so tests and benchmarks of the AI paths are deterministic and free, and the fixer's repair loop uses validation output properly. In pipeline/model-transcripts.ts: record request and response (with secrets and source redacted where needed) keyed by a hash of the prompt inputs; replay mode that fails loudly on a missing key; a CLI option to run any AI path in record or replay mode. Convert the existing AI tests to replayed transcripts. Then improve the repair loop in ai-patches.ts (and in P09's fixer through its ready tag): feed the exact failing check output trimmed to the relevant files, stop after a bounded number of attempts with a named reason, and never accept a repair that edits outside the original patch's sites. Measure on 10 repositories that failed validation on first try in night 1's runs: fixed by repair, still failing, or wrong. Done when tests run with no network and no key, and the measurement is in the PR; keep going by recording transcripts for P10's runs so the bake-off can be replayed for free.
```

### P13: Anthropic backend for patches

```
/goal On branch feat/anthropic-patches (worktree from a fresh origin/main; shared rules as above; at most $10 of model spend; if no Anthropic key is in Pierce's .env, build and test with recorded transcripts only and record Blocked for the measurement): AI patches and the general fixer can use an Anthropic model behind `--ai-provider anthropic`, off by default. Read the claude-api docs pages for the current Messages API and model ids, the price table in pipeline/ai-budget.ts and pipeline/ai-patches.ts. Add a provider interface in pipeline/ai-providers.ts that both providers implement (no other provider-specific code paths), price entries only from pricing pages read with source and checkedAt, the same budget enforcement and the same output parsing guarantees. Tests with recorded transcripts for success, refusal, malformed output, max-token cutoff and budget exhaustion. Measure the same 10 repositories with both providers and label every passing diff. Done when the flag works with tests and the comparison is in the PR; keep going by measuring a smaller Anthropic model on the same 10 and reporting cost per correct patch.
```

### P14: Fixer determinism

```
/goal On branch bench/fixer-determinism (worktree from a fresh origin/main; shared rules as above; at most $15 of model spend; AWS at most 1 shard when P10's shards are not running, checked with status first): we know how stable the general fixer's outcomes are. Merge ready/P09. On 30 repositories from the Stripe held-out set and 10 adapter-less repositories, run the fixer three times each with the same inputs and settings. Measure outcome agreement, patch identity, and for differing patches whether each is correct (read and label). Find the sources of variance (prompt ordering, file ordering, temperature or sampling settings the provider accepts per data/model-parameters.json, nondeterministic evidence order) and fix every one that Refit controls. Rerun to show the improvement. Write docs/FIXER-DETERMINISM.md. Done when the three runs and the fix-and-rerun are complete; keep going by adding a determinism check to P12's replay that flags a prompt whose inputs hash differently across runs.
```

### P15: AWS launch diagnosis and runner doctor

```
/goal On branch fix/aws-runner-doctor (worktree from a fresh origin/main; shared rules as above; AWS only through scripts/aws-benchmark.mjs and read-only IAM calls; never change policies, quotas or plans): we know exactly why EC2 launches were denied on 2026-10-22 and the runner says so before anyone wastes a night. Run `aws sts get-caller-identity` and the runner's status, attempt one smoke launch, and if denied capture the error and use read-only checks (iam simulate-principal-policy for ec2:RunInstances with the runner's parameters, organization SCP visibility if readable) to find which condition denies it (region, instance type, market, tags, IMDS settings). Add an `aws-benchmark.mjs doctor` subcommand that checks credentials, region, quota headroom, a dry-run RunInstances with the exact launch parameters (DryRun=true), the bucket and the AMI, and prints each failure with the fix. Tests with mocked AWS responses. Write what would unblock launches for the owner. Done when doctor exists with tests and the diagnosis is in the PR; keep going by making launch call doctor's dry run first and refusing with its message.
```

### P16: Problems-first report

```
/goal On branch feat/problems-report (worktree from a fresh origin/main; shared rules as above): `refit report --problems`, off by default, leads with what will break, where and by when, built from Problem records from every finder, deduplicated and ranked by deadline, confidence and kind, with each problem's evidence and the fix status (rule, fixer proposal, stopped with reason, or not attempted). Merge ready/F01 (fallback: the identical local type, adapting today's scanners' outputs). Read pipeline/report*.ts and docs/REPORT*.md if present. Keep the default report byte-identical to main on 20 frozen repositories (commit the diff). Render Markdown and JSON; tests on fixture Problem sets for ranking, deduplication, grouping by provider and file, and empty and huge cases with a size cap. Run it on 20 repositories across Stripe, Shopify and the AI-app sets and commit the outputs. Done when the flag works with tests and outputs; keep going by adding the hosted report issue body variant behind the same flag, rendering only.
```

### P17: General finders in hosted monitoring

```
/goal On branch feat/hosted-general-finders (worktree from a fresh origin/main; shared rules as above; local Postgres only): the hosted inventory and monitoring pass can run the general finders in report-only mode for every inventoried repository, behind a flag off by default, storing Problem records. Merge ready/F01 and the ready tags of the static finders (F02, F05, F07, F08, F09, F12, F14) as they appear; each one missing is listed. Add a migration for a problems table keyed by repository, commit and problem id, with retention matching the inventory's. The pass must respect per-installation caps, time budgets per repository and the named stops the finders produce, and must never run repository code (finders that need Docker, F06 and F11, are excluded in hosted mode). Tests against local Postgres for insert, update on new commit, problem resolution when a site disappears, and the caps. Done when a monitoring pass over five fixture repositories stores the expected Problems; keep going by exposing them in `refit hosted inventory --problems`.
```

### P18: Alerts and digest dry run

```
/goal On branch feat/hosted-alerts-preview (worktree from a fresh origin/main; shared rules as above; nothing is posted anywhere): owner decision 9 (alerts, digest and reports) can be made from real output. `refit hosted alerts --dry-run` renders, for every inventoried repository in a local Postgres seeded from fixture inventories, exactly which issues and comments REFIT_HOSTED_ALERTS, REFIT_HOSTED_ALERT_DIGEST and REFIT_HOSTED_REPORTS would create, with title, body, target repository, whether that repository approved Refit, and the cadence. Add per-installation and per-pass caps on issues behind flags (default unchanged) and a rule that closed issues get no further comments, also behind a flag. Tests for every case in decision 9: unapproved repositories, fully ignored exposures, closed issues, weekly cadence. Commit a rendered sample from fixtures that mirror five benchmark repositories. Done when the dry run and caps work with tests; keep going by writing the proposed defaults with the sample attached under Needs owner decision.
```

### P19: Changelog watcher to change candidates

```
/goal On branch feat/changelog-candidates (worktree from a fresh origin/main; shared rules as above; at most $5 of model spend; reading public changelog pages is allowed, registries are never edited from model output): Refit can turn a provider changelog page into structured change candidates for human review, for any provider. Read pipeline/deadline-sync.ts and the docs snapshot code first. Given a configured changelog URL, fetch the visible text with the existing snapshot code, diff it against the stored snapshot, and for new sections ask the model to extract candidates (provider, kind, affected operation or field or model, effective date) where every candidate must carry a verbatim quote that is found in the page text by exact string match; candidates without a matching quote are dropped and counted. Output is review-only JSON plus Markdown; it never writes data/deadlines.json or any registry, because AGENTS.md requires a person to have read the page. Tests with recorded transcripts and saved pages, including a hallucinated quote. Run it on the Stripe, OpenAI, Anthropic, Shopify and Twilio changelogs once and label each candidate correct, partial or wrong. Done when the tool works with tests and the labelled run is committed; keep going by turning correct candidates into Problem records with evidence source 'docs' when a finder can locate the site.
```

### P20: Secret redaction in stored inventories

```
/goal On branch fix/inventory-redaction (worktree from a fresh origin/main; shared rules as above): stored inventories no longer keep secret-looking source lines (owner decision 5). Read pipeline/inventory*.ts and what the inventory stores. Before storage, redact values matching known key formats (Stripe sk_ and rk_, OpenAI sk-, Anthropic, GitHub tokens, AWS keys, private key blocks, generic high-entropy strings next to key-like names) in trimmed source lines, keeping enough context to find the site. Redaction is on by default because it only removes data; document that. Add a migration that redacts existing rows. Tests with a fixture corpus of real-shaped fake keys and near misses (UUIDs, hashes, base64 assets) with precision and recall reported. Done when new and existing rows are redacted with tests; keep going by applying the same redaction to job evidence, receipts and logs, with tests.
```

### P21: Deletion on request

```
/goal On branch feat/hosted-forget (worktree from a fresh origin/main; shared rules as above; local Postgres only): the setup pages promise deletion on request, and today the operator does it by hand. `refit hosted forget --account <id>` (and `--repository <id>`) deletes every row and stored file for that account or repository across all refit_* tables and the volume, except the minimal audit record the policy requires (record what is kept and why), in one transaction for the database and a verified pass for files, with a dry-run that lists what would be deleted. Tests seed every table and assert nothing about the account remains, that other accounts are untouched, and that the dry run changes nothing. Update docs/DATA-HANDLING.md and the runbook. Done when the command is tested on every table; keep going with a test that fails when a new refit_* table is added without forget coverage.
```

### P22: Hosted metrics and Slack redaction

```
/goal On branch feat/hosted-metrics (worktree from a fresh origin/main; shared rules as above): the hosted worker exposes operational metrics and can send Slack notices without customer data. Add a Prometheus-text /metrics endpoint protected by the service token: jobs by outcome, job duration buckets, queue depth, AI spend by installation (no names), Docker preparation time and failures by named stop. Add a redaction mode for REFIT_SLACK_WEBHOOK_URL notices that replaces repository names and error text with ids and stop names, on by default when Slack is enabled; document it for owner decision 14. Tests for both. Done when both are tested and documented; keep going by writing a Grafana-free dashboard as a `refit hosted status --metrics` table.
```

### P23: Hosted capacity with general finders

```
/goal On branch bench/hosted-capacity-2 (worktree from a fresh origin/main; shared rules as above; AWS at most 1 shard, not at the same moment as P10 or P14): docs/CAPACITY.md has measured numbers for the general finders, on an instance sized like the proposed Fly performance-1x 8 GB. Merge the ready tags of the static finders. On 100 repositories from the fresh sets, measure per-repository CPU time, peak memory and wall time for today's inventory and for the inventory plus general finders, and the Docker finders separately on 10. Derive machines needed per 100 customers at hourly and 300-second polling with and without P02's skip-unchanged. Update docs/CAPACITY.md with method, commit and numbers. Done when measured and written; keep going with the same on shared-cpu-2x 4 GB-equivalent to show the difference.
```

### P24: Shopify SDK upgrade for the 44 fresh apps

```
/goal On branch feat/shopify-sdk-upgrade-44 (worktree from a fresh origin/main; shared rules as above): of the 200 fresh Shopify apps, the 44 that need an SDK upgrade are classified and the upgrade path is measured. Read pipeline/shopify-sdk-upgrade.ts, docs/BENCHMARKS.md (Shopify) and the fresh results. For each of the 44, record the locked @shopify/shopify-api (and app framework) version, the target, and what blocks the upgrade today. Fix the top mechanical blocker behind a flag if it widens edits, else directly with tests on real snippets. Validate at most 20 locally under the Docker lock, read every diff and label it. Done when all 44 are classified and the fix is measured; keep going with the 32 REST users: which REST calls are deprecated per FP9's data and what the GraphQL replacement is, review-only.
```

### P25: Registry sync and default-branch readiness

```
/goal On branch fix/registry-sync-ready (worktree from a fresh origin/main; shared rules as above; never change repository settings): when the owner makes main the default branch and allows Actions, the registry sync and scheduled workflows work the first time. Read .github/workflows/*.yml, pipeline/deadline-sync.ts and docs/LAUNCH-CHECKLIST.md item 15. Make every scheduled workflow's logic runnable locally as a script with tests (inputs, outputs, the pull request it would open rendered to a file), fix what fails, and add a `--dry-run` that shows the PR body. Write the exact owner steps (default branch, Actions permissions, PR creation) and what each workflow will do in its first week. Done when each workflow's script passes locally with tests; keep going with the review policy question (whether a reviewed sync PR counts as a page someone read) written up with options under Needs owner decision.
```

### P26: Website claims sync

```
/goal On branch site/claims-sync from origin/pre-launch-website (worktree; shared rules as above; never touch ~/Repos/Refit directly): every number and capability claim on the website matches docs/BENCHMARKS.md and docs/READINESS.md on main, linked to its source. List every claim with file and line, mark current, stale or unbacked, fix stale ones (the "82% blocked" figure predates the card rule) and remove or qualify unbacked ones. Add a build-time check that fails when a claim has no source. Build the site and screenshot the changed pages into the PR. Done when every claim is sourced and the check passes; keep going by adding a "What Refit finds" section fed from P27's examples.
```

### P27: "What Refit finds" customer guide

```
/goal On branch docs/what-refit-finds (worktree from a fresh origin/main; shared rules as above): docs/WHAT-REFIT-FINDS.md shows a customer, with real anonymised-or-public examples from the frozen benchmarks, every kind of problem Refit reports and what happens next: fixed with a validated draft, drafted for review, or reported only. Generate the examples with scripts/report-examples.mjs (extend it) from committed results, never by hand, and add a test that every example still reproduces from its pinned commit and results file. Cover Stripe, Shopify, OpenAI and Anthropic model retirements, deadlines, and, behind clear "preview" labels, the general finders' kinds. Done when the doc is generated and tested; keep going by generating the same as JSON for the website.
```

### P28: Cost model for the general path

```
/goal On branch docs/fixer-costs (worktree from a fresh origin/main; shared rules as above): docs/CAPACITY.md has a measured cost model for the general finders and fixer. Merge P10's and P14's branches read-only for their results (fallback: wait per handoff rules, then use night 1's AI runs and say so). Compute model cost per repository, per problem and per correct patch for each arm and provider, Docker time per validation, and the expected monthly cost per customer at the polling rates in CAPACITY.md, with the AI caps that bound it. Done when the section is written from committed data with the commits named; keep going by adding a script that recomputes it from the result files and a test.
```

### P29: Post-merge benchmark (morning only)

```
/goal On branch bench/post-merge-2 (worktree pinned to merged main after the morning merges; shared rules as above; AWS at most 3 shards): the night's merged work is measured on the frozen sets with the default path and, separately, with --finders generic and --fixer agent where the owner allows AI spend. Run the Stripe held-out 50 and original 100, the Shopify original 50 and both AI-app sets with defaults, compare with scripts/stripe-benchmark-compare.mjs and the equivalents against O02's refresh, and explain every outcome change by repository. Write the results into docs/benchmarks and hand the numbers to O02's owner of BENCHMARKS.md via the PR. Done when every set is compared and every change explained.
```

### P30: Integrator and morning packet

```
/loop 45m /goal On branch docs/overnight-2-results (worktree from a fresh origin/main; shared rules as above): every PR from all 90 lanes is reviewed at least once, and docs/OVERNIGHT-2-RESULTS.md is the owner's morning packet. Each pass: list open PRs from tonight's branches, read each new or updated one at its head commit, check it against its lane's goal and the shared rules (tests strict, default unchanged with evidence, no secrets, no live calls, claims backed), and leave one review comment naming the commit with findings. Keep the packet current: per-lane status (done, partial, blocked with reason), the merge order from the Dependencies tables (producers first: F01, O07, P09, F03, F05, F02, F04, F06), conflicts O14's merge train reports, every Needs owner decision from every lane grouped and ranked, and the bake-off evidence (P10, P11, P14, F23, P28) summarised as the decision the owner must make on making the general path default. Update docs/READINESS.md only with merged facts. The loop ends at 07:00 local time with a final pass.
```

---

# Furqan: problem finders

Furqan owns what Refit can **find**:

- the Problem record `pipeline/problems.ts`;
- every new finder module;
- the language tracers (`pipeline/python/`, `pipeline/go/`, and new Ruby and PHP);
- contract sources, `pipeline/agent-catalog.ts`, `data/api-hosts.json`, `data/deadlines.json` entries and their matchers;
- the per-provider detectors (`pipeline/*-calls.ts`).

No AI and no AWS. Finders are static unless the lane says Docker: they read public SDK tarballs (downloaded, never installed) and repositories cloned at pinned commits, and never run strangers' code outside Refit's sandbox.

**Every finder lane:**

- emits Problem records;
- exposes one exported function the hosted inventory can call;
- has named stops for every limit (file size, parse time, node count, depth, work budget, following `docs/ARCHITECTURE.md` "Rules every tracer must satisfy");
- runs behind `--finders generic`, so default output stays identical, with the diff committed;
- is measured against blind labels on a frozen sample with a pinned search query and date. "Not measured" is said when it is not.

| Lane | Title                                                      | Owns                                                          | Runner |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| F01  | Problem record and adapters for today's scanners           | `pipeline/problems*.ts`                                       | R1     |
| F02  | Raw HTTP calls to OpenAPI operations, any provider         | `pipeline/http-operation-finder*.ts`                          | R3     |
| F03  | Contract sources for many providers                        | `data/contract-sources.json`, `pipeline/contract-sources*.ts` | R2     |
| F04  | SDK mapping derived from SDK packages                      | `pipeline/sdk-mapping-derive*.ts`                             | R5     |
| F05  | SDK type-diff finder                                       | `pipeline/sdk-type-diff*.ts`                                  | R4     |
| F06  | Compile-against-target finder (Docker)                     | `pipeline/target-compile-finder*.ts`                          | R6     |
| F07  | `@deprecated` marker finder                                | `pipeline/deprecated-marker-finder*.ts`                       | R7     |
| F08  | npm deprecation finder                                     | `pipeline/npm-deprecation-finder*.ts`                         | R7     |
| F09  | OpenAPI `deprecated` and sunset finder                     | `pipeline/openapi-deprecated-finder*.ts`                      | R2     |
| F10  | SDK changelog BREAKING parser                              | `pipeline/sdk-changelog*.ts`                                  | R4     |
| F11  | Runtime deprecation-warning finder (Docker)                | `pipeline/runtime-warning-finder*.ts`                         | R6     |
| F12  | General GraphQL finder                                     | `pipeline/graphql-finder*.ts`                                 | R9     |
| F13  | Webhook event-schema finder                                | `pipeline/webhook-event-finder*.ts`                           | R7     |
| F14  | API version pins in code, config and env                   | `pipeline/version-pin-finder*.ts`                             | R5     |
| F15  | Python general finders                                     | `pipeline/python/`                                            | R8     |
| F16  | Go general finders                                         | `pipeline/go/`                                                | R8     |
| F17  | Ruby tracer, report only                                   | `pipeline/ruby/`                                              | R8     |
| F18  | PHP tracer, report only                                    | `pipeline/php/`                                               | R8     |
| F19  | Deduplication and confidence across finders                | `pipeline/problem-merge*.ts`                                  | R1     |
| F20  | Twilio through the general finders                         | `docs/benchmarks/*-twilio-*`                                  | R3     |
| F21  | Slack, Discord and GitHub REST through the general finders | `docs/benchmarks/*-general-rest-*`                            | R3     |
| F22  | openai-node v3 to v4 benchmark                             | `docs/benchmarks/*-openai-v3-*`                               | R4     |
| F23  | Stripe: general finders against the hand adapter           | `docs/FINDER-PARITY.md`                                       | R5     |
| F24  | Finder coverage per catalog entry                          | `pipeline/agent-catalog.ts` (field), `refit agents`           | R1     |
| F25  | More model providers' retirements                          | `data/deadlines.json` entries                                 | R9     |
| F26  | Meta WhatsApp and Messenger changelogs                     | `data/meta-graph-changes.json`                                | R9     |
| F27  | Gemini dates and Vertex                                    | Gemini entries                                                | R9     |
| F28  | API hosts from OpenAPI `servers`                           | `data/api-hosts.json`                                         | R2     |
| F29  | Finder speed and limits                                    | finder budgets                                                | R6     |
| F30  | Integrator for Furqan's lanes                              | –                                                             | R10    |

**Runner queues (Furqan)**

| Session | Queue                 | Why                                                                                    |
| ------- | --------------------- | -------------------------------------------------------------------------------------- |
| R1      | F01 → F19 → F24       | The record first (push `ready/F01` within the first hour), then merging, then coverage |
| R2      | F03 → F28 → F09       | Contract sources feed hosts and OpenAPI deprecations                                   |
| R3      | F02 → F20 → F21       | The HTTP finder, then two provider measurements on it                                  |
| R4      | F05 → F10 → F22       | Type diff, changelog links to its symbols, then the openai v3 benchmark                |
| R5      | F04 → F23 → F14       | Derived mapping, the Stripe parity test, then version pins                             |
| R6      | F06 → F11 → F29       | Both Docker finders in one queue, so they never fight over the lock                    |
| R7      | F07 → F08 → F13       | Small static finders                                                                   |
| R8      | F15 → F16 → F17 → F18 | Tracers, in order of existing support                                                  |
| R9      | F12 → F25 → F26 → F27 | GraphQL, then registry-reading lanes                                                   |
| R10     | F30 under `/loop 45m` | Reviews Furqan's PRs, feeds P30                                                        |

### F01: Problem record and adapters for today's scanners

```
/goal On branch feat/problem-record (worktree from a fresh origin/main; shared rules of ~/OVERNIGHT-AGENTS.md as changed by ~/OVERNIGHT-AGENTS-2.md, including the 3-hour minimum-time rule): pipeline/problems.ts implements the Problem record exactly as written in ~/OVERNIGHT-AGENTS-2.md, and every existing scanner's output can be converted to Problems without changing its default output. Push ready/F01 within the first hour, once the type, the id function and a validator are tested; after that change the interface only additively. Then write adapters from: the Stripe and OpenAI adapter findings, request removals, response removals, Shopify GraphQL validation, deadline exposures (scanDeadlines), model retirements, and the review-only detectors (meta-graph, paypal, slack, cloudflare, github-api, messaging). Each adapter keeps every field the source had (in change or evidence) and has tests on real fixture outputs. Add `refit problems --json` behind --finders generic that prints the merged list. Prove default output of every existing command is unchanged on 20 frozen repositories (commit the diff). Done when the type, validator and all adapters have tests; keep going by documenting the record in docs/ARCHITECTURE.md's own section in your PR (P30 folds it in).
```

### F02: Raw HTTP calls to OpenAPI operations, any provider

```
/goal On branch feat/http-operation-finder (worktree from a fresh origin/main; shared rules as above): Refit maps raw HTTP calls in JS/TS (fetch, axios, got, ky, undici, node-fetch, and base-URL clients built with axios.create) to OpenAPI operations of any provider whose contract is available, and reports contract changes on those operations as Problems, with no provider-specific code. Merge ready/F01 and ready/F03 when present (fallback: the local type and the contracts already in the repository). Resolve host from literals, template literals and same-file constants or env defaults, match path templates against the contract's paths (including path parameters and version prefixes), method from options, and body fields from object literals; anything unresolved is a named stop. Read pipeline/api-hosts.ts, pipeline/openapi-operations.ts and the review-only detectors first; reuse them. Tests on real-shaped snippets for every resolution case and for near misses. Measure on a frozen blind-labelled sample of 30 repositories that call at least two of the contract-source providers by raw HTTP. Done when the finder works with tests and is measured; keep going by matching request body fields against removed request properties and response reads against removed response fields.
```

### F03: Contract sources for many providers

```
/goal On branch feat/contract-sources (worktree from a fresh origin/main; shared rules as above; downloading public spec repositories is allowed, nothing is installed or run): Refit has pinned, historical OpenAPI contracts for at least 15 providers beyond Stripe and Shopify, so contract-driven finders work for them. For each provider in the catalog, find its official machine-readable contract (the provider's own GitHub spec repository first, for example github/rest-api-description, twilio/twilio-oai, openai/openai-openapi, slack, sendgrid, plaid, square, adyen; APIs.guru only as a labelled fallback), and record in data/contract-sources.json the source URL, licence, pinned commit or version, the version history available, and checkedAt. Add pipeline/contract-sources.ts to fetch a pinned version into the existing snapshot format with a SHA-256 check, and to list the versions between two dates. Run oasdiff between the oldest and newest pinned versions for each and commit a summary of breaking changes counted by kind. Providers with no official contract are listed with why. Done when 15 providers have pinned, checksummed sources with tests; keep going to 25.
```

### F04: SDK mapping derived from SDK packages

```
/goal On branch feat/sdk-mapping-derive (worktree from a fresh origin/main; shared rules as above; SDK tarballs are downloaded from the npm registry and never installed): Refit derives the map from SDK method to OpenAPI operation automatically from a generated SDK's published package, instead of by hand. Read pipeline/stripe-operations.ts, pipeline/stripe-sdk-metadata.json, scripts/stripe-sdk-metadata.mjs and pipeline/provider-operations.ts first. For SDKs generated from OpenAPI (stripe-node, openai-node, twilio-node, plaid-node, @octokit/rest, square), read the package's source or declaration files to extract resource paths, HTTP methods and method names, and map them to operations in the pinned contract (F03's ready tag, or the contracts in the repository). Compare the derived Stripe map with the hand-made stripe-sdk-metadata.json: exact matches, differences and why; this tells us whether the hand map can be retired. Commit derived maps with provenance (package@version, SHA-256 of the tarball). Done when Stripe parity is measured and at least four other SDKs have derived maps with tests; keep going by wiring derived maps into SDK call tracing behind --finders generic.
```

### F05: SDK type-diff finder

```
/goal On branch feat/sdk-type-diff (worktree from a fresh origin/main; shared rules as above; tarballs downloaded, never installed): for any npm SDK, Refit diffs the TypeScript declarations of the locked version against a target version and reports every usage in the repository of a removed or changed export, method, parameter, property or enum member as a Problem with evidence 'sdk-types'. Push ready/F05 once the diff output format is stable. Build the declaration diff with the TypeScript compiler API over the two packages' .d.ts files (resolving re-exports), classify changes (removed, renamed when a deprecation or changelog says so, optional to required, type narrowed, enum member removed), then find usages through TypeScript symbol resolution in the repository against the locked version's declarations. Named stops for packages without declarations, huge declaration sets and unresolved symbols. Tests with two small synthetic SDK versions and with real pairs (stripe 17 to 18, openai 3 to 4, @shopify/shopify-api majors). Measure on 20 frozen repositories per pair. Done when the finder works with tests and is measured; keep going with @types packages for SDKs that ship none.
```

### F06: Compile-against-target finder (Docker)

```
/goal On branch feat/target-compile-finder (worktree from a fresh origin/main; shared rules as above; repository code and dependency installs only inside Refit's offline sandbox, one repository per Docker lock hold; Otabek owns pipeline/validation*.ts and pipeline/dependency-preparation.ts, so call them, and change them only with small additive hooks): Refit finds breaking SDK usages without any rule by preparing the repository with the target SDK version in the sandbox, running the repository's type check before and after, and turning each new error that points at a symbol from that SDK into a Problem with evidence 'compile'. Map errors to SDK symbols with the TypeScript program, drop errors unrelated to the SDK, and stop by name where preparation fails. Tests on fixture projects for an SDK removal, a signature change and an unrelated error. Measure on 20 repositories from the Stripe held-out set (stripe-node target) and 10 from the openai v3 set (F22, read its branch), comparing with the adapter's findings and F05's. Done when measured; keep going with Shopify API library upgrades.
```

### F07: `@deprecated` marker finder

```
/goal On branch feat/deprecated-marker-finder (worktree from a fresh origin/main; shared rules as above; tarballs never installed): every usage in a repository of an SDK symbol marked @deprecated in the locked version's declarations becomes a Problem of kind 'deprecated' with the JSDoc text as evidence, and a deadline only when the text states a date. Use the TypeScript checker's deprecation information over the locked package's declarations. Tests with synthetic and real declarations (openai, stripe, @shopify, aws-sdk v2, firebase-admin). Measure on 30 repositories from the frozen sets with blind labels. Done when measured; keep going with @deprecated in Python docstrings via F15's tracer, report only.
```

### F08: npm deprecation finder

```
/goal On branch feat/npm-deprecation-finder (worktree from a fresh origin/main; shared rules as above; registry metadata only): for every locked dependency that is an API SDK in the catalog or the package inventory, Refit reads the npm registry's deprecated message for the exact locked version and reports it as a Problem of kind 'end-of-support' or 'deprecated' at the manifest line, with the message and registry URL as evidence, and links it to FP7's cloud SDK data where present. Cache registry metadata with a TTL and an offline mode for tests. Tests on recorded registry responses. Run it over all 581 fresh-set repositories and both AI-app sets and commit counts per package. Done when tested and run; keep going by doing the same for PyPI yanked releases and Go module retractions in F15 and F16's manifests.
```

### F09: OpenAPI `deprecated` and sunset finder

```
/goal On branch feat/openapi-deprecated-finder (worktree from a fresh origin/main; shared rules as above): operations, parameters and schema properties marked deprecated, or carrying x-sunset or similar vendor extensions, in a provider's current contract become Problems at every traced use (SDK calls through the adapters or F04's derived maps, and raw HTTP through F02). Merge ready/F03. Record per provider which extensions they use. Tests with contract fragments from at least five providers. Measure on the frozen samples available. Done when measured; keep going by tracking when a deprecated element first appeared in the pinned history, as evidence of how long the warning has stood.
```

### F10: SDK changelog BREAKING parser

```
/goal On branch feat/sdk-changelog (worktree from a fresh origin/main; shared rules as above; no AI): Refit reads CHANGELOG.md, HISTORY.md or release notes shipped in an SDK tarball and extracts, deterministically, entries under breaking or removed headings between the locked and target versions, then links each to F05's changed symbols when the entry names them (merge ready/F05). Unlinked entries are kept as review-only evidence. Tests on real changelogs from stripe-node, openai-node, @shopify/shopify-api, twilio, @slack/web-api and aws-sdk. Done when the parser and linking are tested and measured as the share of F05's changes that gain a changelog quote; keep going by recognising migration-guide links and attaching them as evidence.
```

### F11: Runtime deprecation-warning finder (Docker)

```
/goal On branch feat/runtime-warning-finder (worktree from a fresh origin/main; shared rules as above; strangers' code runs only in Refit's offline sandbox, one repository per Docker lock hold): when a repository's own tests run in the sandbox, Refit captures SDK deprecation warnings (process.emitWarning with DeprecationWarning, console.warn from SDK modules, known SDK warning prefixes) with the stack frame in the repository, and reports each as a Problem with evidence 'runtime'. Hook into validation output with a small additive change; never weaken isolation. Tests on fixture projects. Measure on 20 repositories with runnable tests from the frozen sets. Done when measured; keep going by running with the target SDK too and reporting warnings that only appear there.
```

### F12: General GraphQL finder

```
/goal On branch feat/graphql-finder (worktree from a fresh origin/main; shared rules as above): the Shopify GraphQL validation becomes a general finder: any GraphQL API with an introspection snapshot (Shopify Admin and Storefront, GitHub GraphQL, Contentful, others with a published schema) validates every traced document in a repository against the target schema and reports invalid fields, removed enum values and deprecated fields as Problems. Reuse pipeline/shopify-* validation, extracting the provider-neutral part with Shopify's behaviour unchanged (prove it on the Shopify original and fresh sets). Trace documents in gql tags, graphql() calls, .graphql files and string constants passed to known clients. Tests per provider. Measure on GitHub GraphQL with a frozen sample of 20 repositories. Done when measured; keep going with schema-version history for GitHub's public schema.
```

### F13: Webhook event-schema finder

```
/goal On branch feat/webhook-event-finder (worktree from a fresh origin/main; shared rules as above): code that handles provider webhook events (switches over event.type, reads event.data.object fields) is checked against the event schemas in the contract, and removed event types and removed or moved payload fields become Problems. Start with Stripe and GitHub, where contracts define event payloads, and design it provider-neutral. Tests with real-shaped handlers. Measure on 20 repositories with webhook handlers. Done when measured; keep going with Shopify webhooks from its topic list.
```

### F14: API version pins in code, config and env

```
/goal On branch feat/version-pin-finder (worktree from a fresh origin/main; shared rules as above): Refit finds every place a repository pins a provider API version, not just apiVersion literals: env defaults (STRIPE_API_VERSION), .env.example, shopify.app.toml, YAML and JSON config, HTTP headers (Stripe-Version, anthropic-version, X-GitHub-Api-Version, Shopify URL path versions), and reports pins older than the provider's oldest supported version or past a registry deadline as Problems with evidence. Tests for each form. Measure on the Stripe and Shopify frozen sets, where pins are known. Done when measured; keep going with Python and Go forms through F15 and F16.
```

### F15: Python general finders

```
/goal On branch feat/python-general-finders (worktree from a fresh origin/main; shared rules as above, including the tree-sitter rules in AGENTS.md; report only, no edits): the Python tracer reports Problems for stripe-python, openai-python and anthropic-python calls against contract changes, and maps requests and httpx calls to OpenAPI operations as F02 does for JS/TS. Reuse the existing Python tracer and its limits. Tests per SDK and per HTTP client. Measure on 30 Python repositories with blind labels. Done when measured; keep going with Python manifests for F08.
```

### F16: Go general finders

```
/goal On branch feat/go-general-finders (worktree from a fresh origin/main; shared rules as above, including the tree-sitter rules; report only): the Go tracer reports Problems for stripe-go and the official openai-go and anthropic-sdk-go calls against contract changes, and maps net/http requests to OpenAPI operations. Tests per SDK. Measure on 20 Go repositories with blind labels. Done when measured; keep going with go.mod retractions for F08.
```

### F17: Ruby tracer, report only

```
/goal On branch feat/ruby-tracer (worktree from a fresh origin/main; shared rules as above; follow every rule in docs/ARCHITECTURE.md "Rules every tracer must satisfy": vendored grammar pinned by SHA-256 with provenance, named limits, failure is a stop, report only, conformance test): Refit traces stripe-ruby and ruby-openai calls and model ids in Ruby, emitting SdkCallRecords and Problems. Add Ruby to REPORT_ONLY_LANGUAGES and the conformance suite. Measure on 20 Rails apps with blind labels. Done when the tracer passes conformance and is measured; keep going with Net::HTTP and Faraday calls mapped to operations.
```

### F18: PHP tracer, report only

```
/goal On branch feat/php-tracer (worktree from a fresh origin/main; shared rules as above, with the same tracer rules as F17): Refit traces stripe-php and openai-php calls and model ids in PHP (including Laravel facades where resolvable), emitting SdkCallRecords and Problems, report only. Measure on 20 Laravel or WordPress-plugin repositories with blind labels. Done when it passes conformance and is measured; keep going with Guzzle calls mapped to operations.
```

### F19: Deduplication and confidence across finders

```
/goal On branch feat/problem-merge (worktree from a fresh origin/main; shared rules as above): when several finders report the same site (the adapter, F02, F05, F06, F07), Refit merges them into one Problem with all evidence, sets confidence from agreement (compile evidence plus contract evidence is confirmed; a single heuristic is possible), and keeps the strongest kind. Merge ready/F01. Rules are explicit and tested on fixture combinations; conflicts (finders disagree on kind or change) are kept as separate Problems with a link. Done when tested and run on 20 repositories with every finder available; keep going by reporting per-finder unique contributions on those 20.
```

### F20: Twilio through the general finders

```
/goal On branch bench/twilio-general (worktree from a fresh origin/main; shared rules as above): Twilio, which has no adapter, is measured end to end on the general finders. Merge ready tags of F02, F03, F04, F05 and F08 as available. Freeze 30 public repositories using twilio-node or raw Twilio REST with a pinned search query and date, label blind every Twilio call and every call affected by changes between their pinned contract version and the latest, then run the finders and score precision and recall per kind. Done when scored and committed with the scorer and its test; keep going with SendGrid the same way.
```

### F21: Slack, Discord and GitHub REST through the general finders

```
/goal On branch bench/general-rest (worktree from a fresh origin/main; shared rules as above): for Slack, Discord and GitHub REST, the general finders are compared with the existing per-provider detectors (pipeline/slack-calls.ts, pipeline/github-api-calls.ts, and Discord's catalog-only state) on their existing frozen samples, so we know whether the per-provider detectors can be retired. Report per provider: calls both find, only the detector finds, only the general finders find, with each disagreement explained by reading the code. Done when all three are compared; keep going by writing which per-provider modules could be deleted and what the general finders still miss, under Needs owner decision.
```

### F22: openai-node v3 to v4 benchmark

```
/goal On branch bench/openai-v3-v4 (worktree from a fresh origin/main; shared rules as above): there is a frozen, blind-labelled benchmark of 50 public applications still on openai v3 (Configuration, OpenAIApi, createChatCompletion), the most common real SDK migration in AI apps, to test general finding with no rule written for it. Select with a pinned query and date, filters for applications as in scripts/ai-app-select.mjs, pin commits, and label blind every v3 call and what v4 requires. Run F05 (merge ready/F05), F07, F08 and today's detection, and score them. Done when frozen, labelled and scored; keep going by handing the set to P09 and P10 in your PR for fixer measurement.
```

### F23: Stripe: general finders against the hand adapter

```
/goal On branch bench/finder-parity (worktree from a fresh origin/main; shared rules as above): the owner can see whether the general finders could replace the hand-built Stripe adapter for detection. On the labelled 30 of the original 100 and the held-out 50, run the Stripe adapter and the general finders (F02, F04's derived map, F05, F06's results when available from its branch, F09, F14), and compare against labels: recall and precision per kind, every disagreement explained. Write docs/FINDER-PARITY.md. Done when both sets are compared and explained; keep going with the Shopify original 50 against the Shopify path.
```

### F24: Finder coverage per catalog entry

```
/goal On branch feat/catalog-finder-coverage (worktree from a fresh origin/main; shared rules as above): adapter: null no longer reads as "Refit does nothing" for a provider. Add to each catalog entry a computed coverage summary (which general finders apply: contract source, derived mapping, type diff, deprecations, GraphQL, HTTP), derived from data, not hand-typed, and show it in `refit agents`. Tests that coverage updates when a contract source or derived map is added. Done when every entry shows coverage; keep going by listing the ten providers where adding a contract source would add the most coverage.
```

### F25: More model providers' retirements

```
/goal On branch feat/model-providers-more (worktree from a fresh origin/main; shared rules as above; registry entries only from provider pages read, each with source and checkedAt; npm run deadlines:check after editing): Mistral, Cohere, Groq, Together, xAI and Perplexity model retirements and deprecations are in data/deadlines.json, and the model-ID finder detects their SDK and raw HTTP uses, report only. Pages that cannot be reached are recorded as Blocked. Measure on a frozen sample of 30 apps using these SDKs. Done when entries are added from pages read and detection is measured; keep going with AI SDK wrapper model strings for these providers.
```

### F26: Meta WhatsApp and Messenger changelogs

```
/goal On branch data/meta-platform-changelogs (worktree from a fresh origin/main; shared rules as above; entries only from developers.facebook.com pages read, never from search summaries or memory; npm run meta-graph:check): the WhatsApp Business Platform and Messenger Platform changelogs are reviewed, so their requests can stop being blanket stops where the changelog shows no change. Add entries with source and checkedAt; record pages that could not be read. Done when both changelogs are reviewed back to v14.0 or Blocked with the exact error; keep going by rerunning scripts/meta-graph-benchmark.mjs and reporting how many stops changed.
```

### F27: Gemini dates and Vertex

```
/goal On branch data/gemini-dates (worktree from a fresh origin/main; shared rules as above; Gemini dates only from Google's deprecations page on ai.google.dev, read by you): if the page is reachable, add Gemini model retirement entries with source and checkedAt; if not, record Blocked with the exact error and do the Vertex AI model-version pages the same way. Report-only rules for Gemini in AGENTS.md stay. Done when entries are added or Blocked is recorded for both; keep going by rerunning scripts/gemini-benchmark.mjs with the new entries.
```

### F28: API hosts from OpenAPI `servers`

```
/goal On branch data/api-hosts-from-contracts (worktree from a fresh origin/main; shared rules as above): data/api-hosts.json grows from the servers fields of F03's pinned contracts (merge ready/F03), each new host with its contract source as provenance, and regional or sandbox hosts labelled. Run scripts/api-hosts-verify.mjs and the API-host benchmark before and after. Done when hosts are added with provenance and the benchmark shows no precision loss; keep going with hosts from SDK source defaults found by F04.
```

### F29: Finder speed and limits

```
/goal On branch perf/finder-budgets (worktree from a fresh origin/main; shared rules as above): every general finder has a time and memory budget with named stops, and running all static finders over the 581 fresh-set repositories finishes within a stated bound. Merge the finders' ready tags as available. Measure per-finder time and peak memory, fix the largest hotspots (shared TypeScript program reuse across finders is the likely one), and add a test per finder that its budget stop fires. Done when the full run is measured before and after; keep going by making finders share one parsed program per repository.
```

### F30: Integrator for Furqan's lanes

```
/loop 45m /goal Review every open PR from lanes F01–F29 at its head commit each pass, check it against its lane goal and the shared rules (default output unchanged with the diff committed, blind labels, named stops, no installs), leave one review comment naming the commit, and post a short status per lane to P30's PR as a comment. Track ready tags and tell consumers in their PRs when a producer's interface changed. The loop ends at 07:00 local time.
```

---

# Otabek: reliability, validation, gates, benchmarks

Otabek owns:

- benchmark correctness: labels, scorers, the claims checker, `docs/BENCHMARKS.md` tonight;
- the sandbox and the validation and dependency-preparation modules;
- the gates every fixer must pass: patch policy, request diff, response replay;
- security of the AI path;
- CI and release dry runs;
- the merge train;
- CLI and PR-body UX.

No AWS. AI only in O09, with a $5 cap. Docker on the EC2 host when available.

O01–O06 are six of the seven prompts in `OTABEK-PROMPTS.md`, kept as written there; the seventh (graceful hosted deploys) moved to Pierce as P02.

| Lane | Title                                                      | Owns                                                                | Runner |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| O01  | Gated suites on current `main`                             | failing gated tests, `docs/GATED-SUITES.md`                         | R1     |
| O02  | Benchmark truth refresh                                    | `docs/BENCHMARKS.md`, `docs/BENCHMARK-CLAIMS.md`                    | R2     |
| O03  | Known defects                                              | the defect code paths                                               | R3     |
| O04  | Model fixes behind official base URLs                      | `pipeline/model-endpoint-hosts*.ts`                                 | R4     |
| O05  | Remaining Stripe stops                                     | `docs/STRIPE-REMAINING-STOPS.md`                                    | R4     |
| O06  | Public-repository readiness                                | `docs/PUBLIC-READINESS.md`                                          | R5     |
| O07  | Patch policy checker                                       | `pipeline/patch-policy*.ts`                                         | R6     |
| O08  | Request-diff validation                                    | `pipeline/request-diff*.ts`                                         | R6     |
| O09  | Prompt injection and untrusted repositories in the AI path | `docs/AI-THREATS.md`, tests                                         | R5     |
| O10  | Response-shape replay                                      | `pipeline/response-replay*.ts`                                      | R6     |
| O11  | General Problem scorer                                     | `scripts/problem-score*.mjs`                                        | R7     |
| O12  | Upstream replay of SDK majors                              | `docs/UPSTREAM-REPLAY*.md`                                          | R7     |
| O13  | Golden outcomes snapshot                                   | `pipeline/golden-outcomes*.test.ts`                                 | R2     |
| O14  | Merge train                                                | `scripts/merge-train*.mjs`                                          | R8     |
| O15  | Test-suite speed and flake hunt                            | test infrastructure                                                 | R1     |
| O16  | CI ready to enable                                         | `.github/workflows/ci*.yml`                                         | R1     |
| O17  | Release 0.40.0 dry run                                     | release scripts                                                     | R8     |
| O18  | `refit problems` CLI and first-run output                  | CLI wiring                                                          | R7     |
| O19  | Draft PR body for general fixes                            | `pipeline/publication.ts`, `pipeline/review.ts`                     | R9     |
| O20  | Sandbox hardening II                                       | `pipeline/docker-sandbox.ts`                                        | R5     |
| O21  | Dependency preparation, remaining causes                   | `pipeline/dependency-preparation.ts`, `pipeline/manager-install.ts` | R9     |
| O22  | Validation speed II                                        | `pipeline/validation*.ts`                                           | R9     |
| O23  | Stripe validation regressions                              | `docs/STRIPE-REGRESSIONS.md`                                        | R4     |
| O24  | CLI docs generated and checked                             | `scripts/cli-docs*.mjs`                                             | R8     |
| O25  | Registry staleness and date correctness                    | registry checks                                                     | R3     |
| O26  | Scanner fuzzing                                            | `pipeline/*fuzz*.test.ts`                                           | R3     |
| O27  | Python offline validation groundwork                       | `pipeline/python-validation*.ts`                                    | R9     |
| O28  | PR claims checker                                          | `pipeline/publication-claims*.ts`                                   | R8     |
| O29  | Docs truth sweep                                           | `scripts/benchmark-claims*.mjs` extension                           | R2     |
| O30  | Integrator for Otabek's lanes                              | –                                                                   | R10    |

**Runner queues (Otabek)**

| Session | Queue                 | Why                                                               |
| ------- | --------------------- | ----------------------------------------------------------------- |
| R1      | O01 → O15 → O16       | Gated suites green, flakes gone, then CI that can require them    |
| R2      | O02 → O13 → O29       | Truthful numbers, then a snapshot that keeps them true, then docs |
| R3      | O03 → O26 → O25       | Defects, then fuzzing for the next ones, then dates               |
| R4      | O04 → O05 → O23       | Model fixes and Stripe stops, then the regressions                |
| R5      | O06 → O09 → O20       | Public readiness, AI threats, sandbox                             |
| R6      | O07 → O08 → O10       | The gates the general fixer needs; push `ready/O07` early         |
| R7      | O11 → O12 → O18       | Scorer and replay for the general path, then its CLI              |
| R8      | O14 → O17 → O24 → O28 | Morning tooling and release safety                                |
| R9      | O19 → O21 → O22 → O27 | PR body, preparation and validation                               |
| R10     | O30 under `/loop 45m` | Reviews Otabek's PRs, feeds P30                                   |

### O01–O06: the first six prompts

Use the `/goal` blocks for lanes 1, 2, 3, 5, 6 and 7 from `OTABEK-PROMPTS.md` as O01, O02, O03, O04, O05 and O06, in that order. Lane 4 there, graceful hosted deploys, moved to Pierce as P02. Each keeps its branch and owned files.

### O07: Patch policy checker

```
/goal On branch feat/patch-policy (worktree from a fresh origin/main; shared rules of ~/OVERNIGHT-AGENTS.md as changed by ~/OVERNIGHT-AGENTS-2.md, including the 3-hour minimum-time rule): there is one provider-independent checker that any fixer's patch must pass, and a corpus of bad patches that every fixer must be rejected on. Push ready/O07 once the API is stable: checkPatch(problems, patch, repository) returning pass or named violations. Violations: an edit outside problem sites, their imports and package files; deletion of a removed request parameter instead of replacing it per policy; edits to tests, CI, lockfiles beyond the SDK upgrade, env files or secrets; new network hosts or base URLs; widened types (any, as unknown as, @ts-ignore, eslint-disable) added by the patch; removed error handling; changed exported signatures; a patch that does not remove every targeted Problem on rescan. Build the corpus in pipeline/fixtures/bad-patches from real shapes seen in night 1 (the Codex patches that deleted payment_method_types, in docs/BENCHMARKS.md) and synthetic ones, at least 40 cases, each with the violation it must raise, plus 20 good patches from Refit's validated fixes that must pass. Run today's rules and AI patch path through it and report any accepted bad patch. Done when the checker and corpus are tested; keep going by wiring it into the existing AI patch path behind a flag and measuring how many past AI patches it would have rejected.
```

### O08: Request-diff validation

```
/goal On branch feat/request-diff (worktree from a fresh origin/main; shared rules as above; strangers' code only in the offline sandbox, one repository per Docker lock hold): Refit can show, for a patch, exactly how outbound API requests change. For each patched function that reaches a traced SDK call or raw HTTP call, build a harness in the sandbox that imports the module with the SDK client replaced by a recorder (stripe-node, openai-node and fetch first), invokes the function with arguments derived from its parameter types or from the repository's own tests where they exist, and records method, path and body before and after the patch. The gate passes when the only differences are the ones the Problems require (for example payment_method_types to allowed_payment_method_types with the same value) and reports every other difference. Named stops where the function cannot be invoked. Tests on fixture projects, including a patch that silently drops a parameter. Measure on night 1's 53 validated Stripe fixes: how many could be exercised and whether any changes a request unexpectedly. Done when measured; keep going by making it a validation option behind a flag.
```

### O09: Prompt injection and untrusted repositories in the AI path

```
/goal On branch sec/ai-threats (worktree from a fresh origin/main; shared rules as above; at most $5 of model spend with Otabek's own key passed by path, otherwise recorded transcripts and a fake model only): the AI patch path and the general fixer are reviewed and tested against untrusted repository content. Write docs/AI-THREATS.md: inputs the model sees, what an attacker controls (comments, strings, file names, README, package metadata), what the model's output can do (edit files, add dependencies, add hosts, exfiltrate through code), and which gates stop each. Build fixture repositories with injection attempts (comments telling the model to add a postinstall script, call an external URL, edit CI, leak env, delete checks) and tests that the gates (O07's checker through its ready tag, the sandbox's offline network, validation) reject every resulting patch. Read P09's branch and test it too when ready/P09 exists. Done when every threat has a test or is listed as open with its fix; keep going by adding input sanitisation for the prompt (strip or fence untrusted text) with tests.
```

### O10: Response-shape replay

```
/goal On branch feat/response-replay (worktree from a fresh origin/main; shared rules as above; offline sandbox only): for patches that change response-field reads, Refit feeds target-version responses (OpenAPI examples, stripe-mock responses from the generated checks, and schema-generated samples) to the patched code paths and shows that every read returns a defined value of the right type where the old code did. Build on the request-diff harness (merge ready/O08 if pushed, else build the minimal invocation part yourself). Tests on fixtures for a moved field, a field that became nullable and an expandable object that is now an id. Measure on the validated Stripe fixes that move response reads. Done when measured; keep going with Shopify GraphQL responses from the introspection schema.
```

### O11: General Problem scorer

```
/goal On branch bench/problem-scorer (worktree from a fresh origin/main; shared rules as above): one scorer evaluates any finder's Problem records against blind labels, per provider and kind, with precision, recall, and the list of misses and false positives. Merge ready/F01. Define the label format (site, kind, change) in docs/LABELS.md with matching rules (exact line, or same call expression when lines moved), port two existing labelled sets (the Stripe labelled 30 and the AI-app model sites) into it with converters and tests, and score today's scanners through F01's adapters. Done when both sets score with tests; keep going by porting the Gemini and API-host labels.
```

### O12: Upstream replay of SDK majors

```
/goal On branch bench/upstream-replay-sdk (worktree from a fresh origin/main; shared rules as above): the upstream replay (docs/UPSTREAM-REPLAY.md) gains historical SDK major upgrades as frozen cases: openai v3 to v4, stripe-node majors, @shopify/shopify-api majors and @slack/web-api majors. For each, pick repositories whose history contains the human migration commit, pin the commit before and after, and record the human diff as the answer. Score the general finders (do they find the sites the human changed?) and, when ready/P09 exists, hand the cases to P09 and P10 in the PR. Done when at least 20 cases are frozen with answers; keep going to 40.
```

### O13: Golden outcomes snapshot

```
/goal On branch test/golden-outcomes (worktree from a fresh origin/main; shared rules as above): a fast, offline test catches unintended outcome changes from tonight's 90 PRs. Pick 30 repositories across the frozen sets whose scan (no Docker, no network) runs in seconds, vendor the minimum needed (their scan inputs at pinned commits under a size cap, or a reproducible fetch with SHA-256 for CI) and commit the expected outcomes, stops and finding counts. The test fails with a readable diff when any outcome changes, and an explicit update command rewrites the snapshot with a required reason. Check licences before vendoring anything and prefer the fetch. Done when the test runs in under two minutes and is green on main; keep going by adding the snapshot diff to O14's merge-train report.
```

### O14: Merge train

```
/goal On branch tools/merge-train (worktree from a fresh origin/main; shared rules as above; never push to main, never merge a PR, never force-push): scripts/merge-train.mjs takes an ordered list of PR numbers or branches, merges them one at a time into a scratch branch from origin/main, runs typecheck, format check, tests (--maxWorkers=2) and build after each, and reports per PR: clean, conflict (files), or the first failing check, and which earlier PR it interacts with. It never pushes the scratch branch. Default order comes from the Dependencies tables in ~/OVERNIGHT-AGENTS-2.md. Tests with a fixture repository. Run it at the end of the night over every open PR and attach the report to P30's PR. Done when the tool works with tests and has produced a real report; keep going by suggesting conflict resolutions for JSON-list conflicts (keep both sides) as patches in the report.
```

### O15: Test-suite speed and flake hunt

```
/goal On branch test/speed-and-flakes (worktree from a fresh origin/main; shared rules as above): the default suite is faster and has no known flake. Run npm test five times with --maxWorkers=2 and once with randomised order, record every intermittent failure with its seed, fix the cause of each without weakening a test (pipeline/stripe-benchmark-cli.test.ts belongs to O03), and measure the slowest 20 test files; make the largest ones faster by sharing setup or fixtures, never by deleting coverage. Done when five consecutive runs pass and the time saved is measured; keep going with the gated suites' slowest tests.
```

### O16: CI ready to enable

```
/goal On branch ci/ready-to-enable (worktree from a fresh origin/main; shared rules as above; never change repository settings): when the owner enables Actions and makes main the default branch, CI runs the default checks on PRs (Node 22 and 24), the gated suites nightly on main, the audit gate and the claims checker, with pinned action SHAs. Validate every workflow with actionlint if available offline, and make each job's steps a script runnable locally with tests. Use O01's gated-suite commands (read its branch). Write the exact owner steps and expected first-run times. Done when every job runs locally as a script; keep going by adding O13's golden test as a required check.
```

### O17: Release 0.40.0 dry run

```
/goal On branch chore/release-0.40.0-dry-run (worktree from a fresh origin/main; shared rules as above; never tag, publish or create a release): everything for a 0.40.0 pre-release is ready for the owner. Run npm run package:cli to a new directory, compute SHA256SUMS, smoke-install the archive in a clean temp directory and run `refit --version`, `refit doctor` and one offline scan, and draft the dated READINESS checkpoint text and the version bump as a PR the owner can merge. Record every problem found and fix the ones in packaging. Done when the dry run is clean or every failure is fixed or recorded; keep going by checking that the package contains no file that O06 flags.
```

### O18: `refit problems` CLI and first-run output

```
/goal On branch feat/problems-cli (worktree from a fresh origin/main; shared rules as above): `refit problems` (behind --finders generic until the owner decides) gives a first-time user one command that lists what will break in their repository, grouped by provider and deadline, with evidence and next step, in human and --json forms. Merge ready/F01 and finder ready tags as available. Follow the first-run style from docs/FIRST-RUN.md; tests with fixture Problem sets; run it on 10 frozen repositories and commit outputs. Done when tested with outputs; keep going with `refit problems --explain <id>`.
```

### O19: Draft PR body for general fixes

```
/goal On branch feat/general-fix-pr-body (worktree from a fresh origin/main; shared rules as above): a draft PR from the general fixer explains, per Problem: what changed upstream (with the evidence quote and link), where the code was affected, what the patch does, which gates it passed (policy, request diff, rescan, checks with exact commands), and what a reviewer must check, following docs/PR-TEMPLATE.md with its Code Changes section. Read ready/P09's output format. Rule-based PR bodies stay byte-identical (test). Render samples for five fixture patches. Done when tested with samples; keep going by adding a "how this was found" line naming the finder.
```

### O20: Sandbox hardening II

```
/goal On branch sec/sandbox-hardening-2 (worktree from a fresh origin/main; shared rules as above): the validation sandbox's guarantees are tested, not assumed: no network egress (DNS, IP, IPv6, proxy env), no host mounts beyond the workspace, no privilege escalation, memory and swap limits as decided (owner decision 13: --memory-swap equal to --memory), process and file-count limits. Add gated tests that try each from inside a container and must fail. Evaluate rootless Docker or user-namespace remapping and gVisor as options, measured, under Needs owner decision. Done when every guarantee has a test; keep going with a test that a postinstall script cannot reach the network during preparation.
```

### O21: Dependency preparation, remaining causes

```
/goal On branch feat/preparation-remaining (worktree from a fresh origin/main; shared rules as above; offline sandbox; limits are owner decisions): of the 45 repositories in docs/PREPARATION-FAILURES.md, the causes still open (dependency tree too large, Git dependencies, pnpm link:, submodules, conflicting files) each get either a fix behind a flag with measurements or a sharper named stop with the exact .refit.json change. For Git dependencies, prototype fetching a pinned commit by hash over the sandbox's preparation network with integrity recorded, behind a flag. Revalidate up to 20. Done when every open cause has a flag-or-stop with measurements; keep going with the Yarn 1 out-of-space cases at the 4g profile.
```

### O22: Validation speed II

```
/goal On branch perf/validation-2 (worktree from a fresh origin/main; shared rules as above): a validation on a warm cache is faster. Measure the stages (container start, archive restore, checks) on 10 repositories, then reduce the largest: reuse a prepared container image layer per lockfile hash, restore archives with a faster method, skip duplicate type checks when the baseline result is cached by commit. Every change keeps isolation and correctness, with tests. Done when measured before and after; keep going with parallel validations on the EC2 host with the lock replaced by a counted semaphore there only.
```

### O23: Stripe validation regressions

```
/goal On branch bench/stripe-regressions (worktree from a fresh origin/main; shared rules as above): the Stripe repositories whose card-rule patch regressed on stripe-node 23 type errors (10 in docs/BENCHMARKS.md, 12 validation-regression in docs/MINED-RULES.md) are each explained: the first new type error, the stripe-node change behind it with the changelog quote, and what a correct fix would be. Rank causes. If a cause is mechanical, hand it to the general fixer as a Problem (F06's compile evidence) rather than writing a rule, and record that in the PR. Done when every repository is explained; keep going by checking which of them P10's fixer arm passed and whether correctly.
```

### O24: CLI docs generated and checked

```
/goal On branch docs/cli-generated (worktree from a fresh origin/main; shared rules as above): docs/CLI.md's command and flag reference is generated from the CLI's own definitions, and a test fails when they drift. Keep the hand-written prose sections; generate only the reference tables between markers. Done when generated and tested; keep going by checking every command example in docs/*.md parses against the CLI definitions.
```

### O25: Registry staleness and date correctness

```
/goal On branch fix/registry-dates (worktree from a fresh origin/main; shared rules as above): deadline math and registry freshness are correct. Test days-until and --fail-within across time zones, DST changes, end-of-day deadlines and leap years; fix any error. Add a check that flags registry entries whose checkedAt is older than a configured age (warning only, default unchanged), and report today's stale entries. Done when tested and the stale list is in the PR; keep going with the same for data/model-parameters.json and data/meta-graph-changes.json.
```

### O26: Scanner fuzzing

```
/goal On branch test/scanner-fuzz (worktree from a fresh origin/main; shared rules as above): malformed input never crashes a scanner; it produces a named stop. Fuzz the TypeScript scanning entry points, the tree-sitter tracers, config parsing (.refit.json, .refit-ignore-paths.json, .refit-deadlines-ignore.json), lockfile parsers and the OpenAPI loader with mutated real inputs for a bounded time each; fix every crash at its cause with a regression test from the minimised input. Done when each target ran its time budget with no open crash; keep going by adding the fuzz run as an opt-in npm script.
```

### O27: Python offline validation groundwork

```
/goal On branch feat/python-validation (worktree from a fresh origin/main; shared rules as above; behind a flag off by default; Python stays report only per AGENTS.md): Refit can prepare a Python project's dependencies offline in the sandbox (pip or uv from a lockfile or pinned requirements, with hashes when present) and run its own checks (pytest, mypy or pyright when configured), so Python fixes could be validated if the owner later allows them. Same isolation rules as Node preparation. Tests on fixture projects; measure on 10 Python repositories from FG1's sets. Done when measured; keep going with Poetry lockfiles.
```

### O28: PR claims checker

```
/goal On branch feat/pr-claims-check (worktree from a fresh origin/main; shared rules as above): before any draft PR is published, every factual claim in its body (counts of usages and files, checks that ran and passed, versions, evidence links) is verified against the job's stored evidence, and publication stops with a named reason on a mismatch. Tests with fixture bodies and evidence, including a body that claims a check passed that did not run. Done when wired into publication with tests; keep going by running it over the bodies of every open refit-dev fork PR and reporting mismatches.
```

### O29: Docs truth sweep

```
/goal On branch docs/truth-sweep (worktree from a fresh origin/main; shared rules as above; docs/BENCHMARKS.md belongs to O02): extend the claims checker from O02 (read its branch) to every docs/*.md file and the README, list every numeric or capability claim without a backing result, readiness checkpoint or test, and fix or qualify each in the docs this lane may edit. Shared docs (READINESS, AGENTS, README, CLI) changes go to P30 as suggested patches in the PR. Done when the checker covers all docs and the list is resolved or handed over; keep going by making the checker run in O16's CI.
```

### O30: Integrator for Otabek's lanes

```
/loop 45m /goal Review every open PR from lanes O01–O29 at its head commit each pass, check it against its lane goal and the shared rules (tests strict, gated results reported separately, default unchanged with evidence, no secrets), leave one review comment naming the commit, and post a short status per lane to P30's PR as a comment. Run O14's merge train in dry-run once O14 has a working version and attach its report. The loop ends at 07:00 local time.
```

---

## Dependencies (all people)

| Consumer                              | Producer       | What it needs                         | Fallback without it                     |
| ------------------------------------- | -------------- | ------------------------------------- | --------------------------------------- |
| Every finder, P09, P16, P17, O11, O18 | F01            | `pipeline/problems.ts`                | The identical local type from this file |
| P09                                   | O07            | `checkPatch`                          | The same checks inline in the fixer     |
| P10, P11, P14, O19, O09               | P09            | `--fixer agent` and its output format | Today's `--ai` path, labelled as such   |
| P28                                   | P10, P14       | Result files                          | Night 1's AI runs                       |
| F02, F09, F28, F20, F21               | F03            | Contract sources                      | Contracts already in the repository     |
| F10, F22, F06                         | F05            | Type-diff output                      | Report the finder alone                 |
| F23                                   | F02, F04, F06  | Finders and derived map               | Compare the finders that exist          |
| F19                                   | F01            | Problem record                        | Same runner, so it is there             |
| O10                                   | O08            | Invocation harness                    | Build the minimal part                  |
| O16, O29                              | O01, O02       | Gated commands, claims checker        | Read their branches                     |
| P17, P23                              | static finders | Finder entry points                   | List missing finders                    |

**Merge order for the morning:** F01, O07, P09, F03, F05, F02, F04, F06, then everything else in any order O14's merge train accepts.

## Ready to paste

Each runner pastes the runner `/goal` from night 1's file ("How a runner works") with its own lanes and `~/OVERNIGHT-AGENTS-2.md` in place of `~/OVERNIGHT-AGENTS.md`. Link the file first:

```bash
ln -sf "$REFIT/OVERNIGHT-AGENTS-2.md" ~/OVERNIGHT-AGENTS-2.md
```

| Person | R1          | R2          | R3          | R4          | R5          | R6          | R7          | R8              | R9              | R10 |
| ------ | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | --------------- | --------------- | --- |
| Pierce | P01 P02 P06 | P03 P04 P05 | P09 P12 P13 | P15 P10 P28 | P08 P11 P14 | P16 P17 P18 | P19 P20 P21 | P22 P23 P07     | P24 P25 P26 P27 | P30 |
| Furqan | F01 F19 F24 | F03 F28 F09 | F02 F20 F21 | F05 F10 F22 | F04 F23 F14 | F06 F11 F29 | F07 F08 F13 | F15 F16 F17 F18 | F12 F25 F26 F27 | F30 |
| Otabek | O01 O15 O16 | O02 O13 O29 | O03 O26 O25 | O04 O05 O23 | O06 O09 O20 | O07 O08 O10 | O11 O12 O18 | O14 O17 O24 O28 | O19 O21 O22 O27 | O30 |
