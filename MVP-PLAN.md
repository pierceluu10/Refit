# Refit MVP: one night, ten prompts

Drafted 2026-11-06. Refit is moving from "API migrations" to **"software that never falls behind"**: when anything outside a team's control changes, Refit finds the affected code, fixes it, proves the fix and opens a PR. This plan builds the MVP in one night: three laptops running ten prompts in parallel while the founders sleep.

`REFIT-PLAN.md` and `AGENTS.md` still apply, above all the AI-first rule and the four hard limits. This plan adds to them; where they conflict, `AGENTS.md` wins.

## Contents

1. [Goal and demo](#1-goal-and-demo)
2. [Scope](#2-scope)
3. [How the work is split](#3-how-the-work-is-split)
4. [Architecture after tonight](#4-architecture-after-tonight)
5. [Before launch](#5-before-launch)
6. [Shared contract](#6-shared-contract)
7. [Rules for every prompt](#7-rules-for-every-prompt)
8. [Otabek's prompts (40%)](#8-otabeks-prompts-40)
9. [Pierce's prompts (40%)](#9-pierces-prompts-40)
10. [Furqan's prompts (20%)](#10-furqans-prompts-20)
11. [Morning: integration and demo](#11-morning-integration-and-demo)
12. [Risks and fallbacks](#12-risks-and-fallbacks)
13. [After the MVP](#13-after-the-mvp)
14. [Open decisions](#14-open-decisions)

---

## 1. Goal and demo

**One sentence:** install the Refit GitHub App on an org, and Refit finds everything outside the code that has changed or is about to, then opens tested PRs to keep the code current.

**The morning demo,** on a test org with three sample repos:

1. Install the Refit Agent App on the test org and pick the repos.
2. Refit scans each repo and finds what it depends on: language runtimes, frameworks, libraries, AI models, third-party APIs, base container images and CI versions.
3. Refit's watchers find what has changed or is about to: end-of-life dates, major releases, security advisories, model retirements and API changes, each with a source link and quote.
4. The **What's behind** page lists every finding by deadline.
5. Refit opens draft PRs with checks run before and after. At least three: a runtime end-of-life upgrade, an AI model retirement and one more (a CI action version, a library major or an API change).
6. Merging one PR shows up on the dashboard, and memory records the verdict.

**Definition of done for the MVP:**

- [ ] Steps 1–6 work on the test org without manual edits to the code.
- [ ] Every task ends in a PR or a "not affected" verdict, with a note on what's unproven. Attempted rate is 100%.
- [ ] All four hard limits hold: sandbox only, run-level dollar cap, PRs only, no secrets printed or committed.
- [ ] Typecheck, format check, tests and build pass on `mvp`.
- [ ] The smoke test runs the three sample repos end to end with a fake model.

## 2. Scope

**In scope tonight**

| Category            | Examples                                                   | Change kinds                  |
| ------------------- | ---------------------------------------------------------- | ----------------------------- |
| Language runtimes   | Node.js, Python                                            | `runtime-eol`                 |
| Frameworks          | Next.js, React, Express, Flask, Django                     | `framework-major`             |
| Libraries           | Any npm or PyPI package with a breaking major              | `dependency-major`            |
| Security advisories | OSV and GitHub advisories whose fix needs code changes     | `security-fix`                |
| AI models           | OpenAI, Anthropic and Google model retirements             | `model-retirement` (existing) |
| Third-party APIs    | The existing API path (Stripe, OpenAI, Shopify and others) | existing kinds                |
| Container images    | Dockerfile base images and OS versions                     | `container-image-eol`         |
| CI                  | Deprecated GitHub Actions and runner versions              | `ci-deprecation`              |

**Out of scope tonight:** Kubernetes and cloud platform upgrades, app store and browser policies, government rules, vendor switching, self-hosted models, billing, SSO, private sandboxes.

**Languages tonight:** JavaScript/TypeScript and Python. Others are found and reported but not migrated if the agent can't prove the fix; it still opens a needs-review PR with notes, never a silent stop.

## 3. How the work is split

Ten prompts, split by the founders' Claude plans: **Otabek 40% (4 prompts), Pierce 40% (4 prompts), Furqan 20% (2 prompts)**. Every prompt owns its files; no two prompts edit the same file.

| Owner  | Prompt                                            | Owns                                                                                                                    | Proposed AI cap |
| ------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------- |
| Otabek | **O1** Orchestrator: any external change          | `orchestrator/`, `README.md`, `AGENTS.md`, `.env.example`, root config lines                                            | $3              |
| Otabek | **O2** Harness agent: upgrades                    | `harness/agent.ts`, `prompt.ts`, `tools.ts`, `pr.ts`, `summary.ts`, `run.ts`, `types.ts`, `index.ts` and their tests    | $6              |
| Otabek | **O3** Sandbox, checks, ledger and model layer    | `harness/sandbox.ts`, `checks.ts`, `secrets.ts`, `ledger.ts`, `validators.ts` and their tests; `shared/models.ts` (new) | $2              |
| Otabek | **O4** Memory and evals                           | `memory/`, `evals/`                                                                                                     | $4              |
| Pierce | **P1** App: install → scan → PRs                  | `app/` except `app/api/`                                                                                                | $4              |
| Pierce | **P2** Inventory: every dependency                | `inventory/`                                                                                                            | $5              |
| Pierce | **P3** Report API, PR lifecycle and notifications | `app/api/` (new), `app/lifecycle/` (new), `app/notify/` (new)                                                           | $1              |
| Pierce | **P4** Website, onboarding and dashboard          | `src/`, `public/`, `index.html`                                                                                         | $0              |
| Furqan | **F1** Watchers for every change source           | `providers/` except `providers/toolkit/` and `providers/*/tools.ts`, `providers/*/playbooks/`                           | $4              |
| Furqan | **F2** Tools and playbooks for upgrades           | `providers/toolkit/`, `providers/*/tools.ts`, `providers/*/playbooks/`, `providers/upgrades/` (new)                     | $3              |

**Proposed total: $32** (Otabek $15, Pierce $10, Furqan $7). The founders approve these caps before launch.

**Before launch:** Otabek writes the shared contract (section 6). Pierce sets up the test org, the sample repos and the GitHub App settings (section 5).

## 4. Architecture after tonight

```text
GitHub App install / push / weekly schedule            (P1)
  → checkout in a fresh directory                      (P1)
  → inventory: ApiUsage[] + DependencyUsage[]          (P2)
  → watchers: ProviderChange[] + ExternalChange[]      (F1)
  → match agent: ranked ExternalTask[]                 (O1)
  → scan report: what's behind, by deadline            (O1 → P3 → P4)
  → harness: edit in the sandbox, prove, PR body       (O2, O3, tools from F2)
  → PR opener + lifecycle (open, update, supersede)    (P1, P3)
  → memory: run record, recipe, human verdict          (O4)
  → dashboard: What's behind, Runs, PRs                (P4)
```

Model calls go through one model layer (O3), so every part draws on the same run budget and the model can be swapped per step later.

## 5. Before launch

### Otabek (ten minutes, no AI)

1. Create the integration branch `mvp` from `origin/main` and push it.
2. Add section 6's types to `shared/types.ts` on `mvp`. Run typecheck.
3. Confirm the caps with the other founders.

### Pierce (twenty minutes, no AI)

1. Create a test GitHub org (for example `refit-demo`, an illustrative name). Install nothing yet.
2. Create three sample repos, labelled in their README as Refit demo repos:
   - **`demo-node-api`**: an Express service on Node 18 (`engines`, `.nvmrc`, Dockerfile `FROM node:18`), calling OpenAI with a retired model, with a few passing tests.
   - **`demo-python-app`**: a Flask app on Python 3.9 (`.python-version`, `pyproject.toml`), using the Stripe SDK at an old major, with pytest tests.
   - **`demo-next-web`**: a Next.js app on an older major, with a GitHub Actions workflow on deprecated action versions (for example an old `actions/checkout`).
3. In the Refit Agent App's settings (ID 5275879): turn on webhooks, add the permissions and events from `app/SETUP.md`, point the webhook at the smee or tunnel URL from `app/SETUP.md`.
4. Put the app's credentials in each laptop's local `.env` (never committed).

### Every laptop

- Node 22.12+ and Docker running; `npm ci` on `mvp`.
- Local `.env` with `ANTHROPIC_API_KEY`, `REFIT_AI_BUDGET_USD` (the prompt's cap) and, for P1 and P3, the app credentials.
- One Claude Code session per prompt, in auto mode, each in its own worktree of `mvp`.

## 6. Shared contract

Added to `shared/types.ts` before launch. **Additive only;** breaking changes are agreed in the morning.

```ts
// MVP (2026-11-06): anything outside the codebase that can force it to change. Additive only.

export type MigrationKindMvp =
  | 'runtime-eol' // a language or runtime version reaches end of life
  | 'framework-major' // a framework's major version, e.g. Next.js, Django
  | 'dependency-major' // a library's major version with breaking changes
  | 'security-fix' // an advisory whose fix needs code changes
  | 'container-image-eol' // a base image or OS version reaches end of life
  | 'ci-deprecation'; // a CI action, image or runner version is retired

export type DependencyKind =
  'api' | 'sdk' | 'library' | 'framework' | 'runtime' | 'ai-model' | 'container-image' | 'ci';

export type DependencyUsage = {
  repo: string;
  kind: DependencyKind;
  name: string; // e.g. 'node', 'next', 'gpt-4o', 'stripe', 'node:18-bookworm', 'actions/checkout'
  ecosystem?: string; // e.g. 'npm', 'pypi', 'docker', 'github-actions', 'openai'
  version?: string;
  declaredIn: { file: string; line?: number; text?: string }[]; // every place the version is set or implied
  callSites?: ApiUsage['callSites']; // for APIs, SDKs and AI models
  notes?: string;
};

export type ExternalChange = Omit<ProviderChange, 'kind'> & {
  kind: MigrationKind | MigrationKindMvp;
  dependencyKind: DependencyKind;
  dependency: string; // matches DependencyUsage.name
  fromVersions?: string[];
  toVersion?: string; // the recommended target, when there is one
  severity?: 'deadline' | 'security' | 'breaking' | 'notice';
};

export type ExternalTask = Omit<MigrationTask, 'change'> & {
  change: ExternalChange;
  dependencies: DependencyUsage[];
};

export type BehindItem = {
  repo: string;
  dependency: DependencyUsage;
  change: ExternalChange;
  deadline?: string;
  status: 'open' | 'pr-open' | 'merged' | 'not-affected';
  pr?: string;
};

export type ScanReport = {
  repo: string;
  scannedAt: string;
  items: BehindItem[];
  costUsd: number;
  errors: string[]; // what couldn't be read, said honestly
};

// Entry points. Each owner exports these; everyone else codes against stubs until they land.
export type InventoryDependencies = (repoDir: string, repo: string) => Promise<DependencyUsage[]>; // P2
export type WatchDependency = (dep: DependencyUsage, since?: string) => Promise<ExternalChange[]>; // F1
export type ScanRepo = (
  repo: string,
  dir: string,
) => Promise<{ report: ScanReport; tasks: ExternalTask[] }>; // O1
export type RunExternalTask = (task: ExternalTask, repoDir: string) => Promise<RunRecord>; // O2
export type RetrieveExternalRecipes = (task: ExternalTask) => Promise<Recipe[]>; // O4
```

**Where each entry point lives**

| Entry point                                                                | Module                        | Owner |
| -------------------------------------------------------------------------- | ----------------------------- | ----- |
| `inventoryDependencies`                                                    | `inventory/index.ts`          | P2    |
| `watchDependency`                                                          | `providers/index.ts`          | F1    |
| `scanRepo`, `runRepoJob`                                                   | `orchestrator/index.ts`       | O1    |
| `runExternalTask`                                                          | `harness/index.ts`            | O2    |
| `createModel`, `MODEL_PRICES`                                              | `shared/models.ts`            | O3    |
| `retrieveExternalRecipes`, `learnFromRun`, `recordVerdict`, `listRunViews` | `memory/index.ts`             | O4    |
| upgrade tools (`endOfLife`, `migrationGuide`, …)                           | `providers/upgrades/index.ts` | F2    |
| `GET /api/report`, `GET /api/runs`                                         | `app/api/`                    | P3    |

## 7. Rules for every prompt

- Branch from `origin/mvp` with `--no-track`; open a **draft PR into `mvp`**. Never push to `main`, never merge.
- Edit only the files you own (section 3). Code against section 6's types, with a local stub until the real module lands.
- Each workspace adds its dependencies to its own `package.json`, never the root.
- Follow the AI-first rule: the model reads, decides and edits; scanners, parsers and validators are tools, never gates. No rule that decides a repo or change is "unsupported." No task ends without an attempt.
- The four hard limits, in code: untrusted repo code runs only in the sandbox; a run-level dollar cap; PRs only; never print or commit secrets.
- Every real model run sets `REFIT_AI_BUDGET_USD` to the prompt's cap. **No real benchmark tonight.**
- Label every example. Don't invent customers, metrics or passing checks.
- Run typecheck, format check, tests and build before each commit. Conventional commits, no AI attribution lines, no co-author trailers.
- Use subagents for independent parts, then integrate. Keep going until the deliverables are done or the cap is used, then write a short status note in the PR: done, not done, and what to check in the morning.

---

## 8. Otabek's prompts (40%)

### O1: the orchestrator handles any external change

```text
Extend Refit's end-to-end loop in orchestrator/ from API changes to any external change. Read MVP-PLAN.md (sections 1–7), REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first".

Deliver:
- scanRepo(repo, dir) → { report: ScanReport, tasks: ExternalTask[] }: inventory (ApiUsage[] and DependencyUsage[]) → watchers (ProviderChange[] and ExternalChange[]) → match. Code against P2's inventoryDependencies, F1's watchDependency and O2's runExternalTask with local stubs; they land on other branches tonight.
- The match agent decides which external changes touch which dependencies and call sites, why, and how urgent each is. Rank by deadline, then severity (security first), then impact. Version overlap and dates are hints for the agent, never rule tables. Every change the agent judges irrelevant becomes a "not affected" item with its reason.
- Task shaping: one task per change per repo; group a runtime bump with the Dockerfile, .nvmrc and CI lines that must move with it; never two open tasks for the same dependency and target.
- runRepoJob runs ExternalTasks as well as API tasks, and returns RunRecords for both. Keep the existing API path working.
- CLI: `refit scan --repo <path> [--out report.json]` prints a "what's behind" table and writes the ScanReport; `refit run` includes upgrade tasks; `--dry-run` still stops before PRs.
- Every part draws on one run budget through O3's model layer (shared/models.ts); stub it until it lands.
- Docs: update README.md and AGENTS.md for "software that never falls behind"; refresh .env.example (ANTHROPIC_API_KEY, REFIT_AI_BUDGET_USD, the GitHub App variables, REFIT_SLACK_WEBHOOK_URL), with no secrets.
Tests: end to end with stubs on the three sample repos' fixtures; one real match run on fixtures, capped at $3.
Use subagents for the match agent, the scan report and CLI, and the docs. Branch `mvp/orchestrator`, draft PR into `mvp`. Edit only orchestrator/, README.md, AGENTS.md, .env.example and the root config lines that register workspaces. AI spend cap: $3.
```

### O2: the harness agent does upgrades

```text
Teach Refit's migration agent to do upgrades. Read MVP-PLAN.md (sections 1–7), REFIT-PLAN.md ("The harness system prompt"), AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first".

Goal: runExternalTask(task, repoDir) → RunRecord, for every kind in section 2: runtime-eol, framework-major, dependency-major, security-fix, container-image-eol, ci-deprecation and model-retirement. runTask keeps working for API tasks.

Deliver:
- The system prompt (harness/prompt.ts, versioned): the change with its source quote and deadline; every place the dependency is declared; the call sites; retrieved recipes; the provider or upgrade playbook; the definition of done (verified: checks pass before and after on the new version, plus validators; needs-review: exactly what's unproven and any behaviour change); the smallest correct change.
- Tools the agent may call (harness/tools.ts), all returning information and never blocking: read, search and edit files; bump a version in each place it's declared (package.json engines and dependencies, lockfiles via the package manager, .nvmrc, .python-version, pyproject.toml, requirements*.txt, Dockerfile FROM, workflow files); run the package manager's install and upgrade in the sandbox; run checks on a chosen runtime version (from O3); F2's upgrade tools (endOfLife, migrationGuide, registryDiff, modelReplacement, actionVersions, codemod); memory retrieval; web and docs fetch.
- The agent iterates on failures itself and escalates from Sonnet to Opus when stuck, as today. Outcome is verified or needs-review, never stopped.
- PR bodies (harness/pr.ts) for upgrades: title "Upgrade <dependency> <from> → <to>"; what changed and why; the deadline and source link; checks before and after; what's unproven; behaviour changes; files touched.
Tests: the fake-model session for every kind; then ONE real run on demo-node-api (Node 18 → a supported LTS), capped at $5. Report the diff and whether you'd merge it.
Use subagents for the prompt, the tools and the PR writer. Branch `mvp/harness`, draft PR into `mvp`. Edit only the harness files O2 owns in MVP-PLAN.md section 3. AI spend cap: $6.
```

### O3: sandbox, checks, ledger and the model layer

```text
Make Refit's sandbox and checks work for upgrades, and put every model call behind one layer. Read MVP-PLAN.md (sections 1–7), REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp.

Deliver:
- Multi-runtime sandbox (harness/sandbox.ts): run a repo's checks on a chosen runtime and version, in Docker on official images (Node 18, 20, 22, 24; Python 3.9 to 3.13), with install scripts off unless the agent asks and the run stays in the sandbox. Locally without Docker, the existing temp-copy mode with scripts disabled. Untrusted code never runs on the host.
- Before/after checks (harness/checks.ts): "before" on the current version, "after" on the target version; type check, build, tests and lint where the repo has them; count only new failures; record each check's command, exit code and a short log tail.
- Secrets (harness/secrets.ts): scan diffs, logs and PR bodies for secrets before anything leaves the sandbox, and redact them. Never print a secret.
- Validators (harness/validators.ts): a model call still works with the replacement model (request shape, and a live call only with a test key the customer supplied); a Dockerfile builds; a workflow file parses.
- The model layer (shared/models.ts, new): createModel(step) returns the model for each step (inventory, watch, match, harness, reviewer) from one table, with prices for every model used, so ledgers stop defaulting unknown models to Opus prices. Every ledger reads prices from it. Keep Claude as the default everywhere; the point is that a step's model can be swapped later.
- The run-level dollar cap holds across every part, and refuses to spend when REFIT_AI_BUDGET_USD is missing.
Tests for each part; Docker tests skip cleanly when Docker isn't running. Real AI spend only to check one validator, capped at $2.
Use subagents for the sandbox and checks, secrets and validators, and the model layer. Branch `mvp/sandbox`, draft PR into `mvp`. Edit only the files O3 owns in MVP-PLAN.md section 3. AI spend cap: $2.
```

### O4: memory and evals for upgrades

```text
Extend Refit's memory and evals to cover upgrades. Read MVP-PLAN.md (sections 1–7), REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first".

Memory (memory/):
- Recipes keyed by dependency and version range ("node 18 → 22", "next 13 → 15", "gpt-4o → replacement"), as well as provider and kind. Existing recipes stay readable.
- Extraction after a verified run: preconditions, steps, pitfalls and a diff sketch, linked to the run.
- retrieveExternalRecipes(task): AI judgement plus embeddings, never a fixed keyword match.
- Learning from verdicts: recordVerdict stores merged, closed or edited; an edited PR's final diff updates the recipe; promotion and demotion work for upgrade recipes.
- RunView and ScanReport history for the dashboard (listRunViews, latest report per repo).

Evals (evals/):
- Sets: upgrade-dev-20, public JavaScript and Python repos pinned to end-of-life Node or Python or an old framework major, with tests that run; record why each was picked. A separate blind set, frozen and unopened; record only its path and hash.
- Scoring by change kind (API, runtime, framework, library, security, model, image, CI): verified, needs-review and not-affected rates, cost per repo, and the attempted rate, which must be 100%.
- The one-command smoke test runs the three sample repos (as fixtures) end to end with a fake model, through scanRepo and runRepoJob.
- The advisory reviewer reviews upgrade PRs too; it never changes the grade.
No real benchmark tonight. Real AI calls only for 2 recipe extractions and 2 reviewer checks, capped at $4 total.
Use subagents for recipes and retrieval, verdicts and views, the eval set, and scoring and the smoke test. Branch `mvp/memory-evals`, draft PR into `mvp`. Edit only memory/ and evals/. AI spend cap: $4.
```

---

## 9. Pierce's prompts (40%)

### P1: the app runs install → scan → PRs

```text
Make Refit's GitHub App in app/ run the whole loop on a real test org. Read MVP-PLAN.md (sections 1–7), REFIT-PLAN.md, AGENTS.md, app/SETUP.md and shared/types.ts on origin/mvp.

Deliver:
- Install: when the app is installed or repos are added, list the selected repos and queue a scan for each. Removing repos or uninstalling stops their jobs and deletes their checkouts.
- Scan job: fresh checkout into a temp directory (repo code never runs on the host) → O1's scanRepo → store the ScanReport → queue each ExternalTask.
- Run job: O1's runRepoJob with the existing createOpenPullRequest; draft PRs on refit/<task-slug> branches. Never push to a default branch, never merge.
- Triggers: push to the default branch re-scans that repo; a weekly schedule re-scans every installed repo; both go through the existing queue with retries and concurrency.
- pull_request closed or merged → O4's recordVerdict.
- Per-repo settings the customer controls (pause Refit, ignore a dependency) in an optional .refit.yml. These are the customer's choices, never a hard-coded rule about what Refit supports.
- Replace the CLI's stub PR link with the real opener when app credentials are present; keep the stub when they're not.
- Wire in P3's parts with local stubs until they land: mount the routes from app/api/index.ts in the server, call app/lifecycle/index.ts before opening each PR, and call app/notify/index.ts after each run.
- app/SETUP.md: a morning runbook to install on the test org, trigger a scan, and watch PRs appear.
Secrets only from env; never commit or print them. Tests with recorded webhook payloads. One real end-to-end run on the test org's demo-node-api, capped at $4.
Use subagents for install and scan, triggers and the queue, and settings and the runbook. Branch `mvp/app`, draft PR into `mvp`. Edit only app/ except app/api/, app/lifecycle/ and app/notify/, which P3 owns. AI spend cap: $4.
```

### P2: the inventory finds every dependency

```text
Extend Refit's codebase-understanding agent in inventory/ to find everything outside the code that can force it to change. Read MVP-PLAN.md (sections 1–7), REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first".

Goal: inventoryDependencies(repoDir, repo) → DependencyUsage[], alongside the existing inventoryRepo → ApiUsage[].
The agent reads the repo like a new engineer and finds, with every place each version is declared:
- language runtimes and versions: package.json engines, .nvmrc, .node-version, .python-version, pyproject.toml, setup.cfg, runtime.txt, Dockerfiles, serverless and cloud config, CI matrices;
- frameworks and important libraries, with resolved versions from lockfiles (package-lock, pnpm-lock, yarn.lock, poetry.lock, uv.lock, requirements*.txt);
- AI models named in code, config or env defaults, with call sites;
- third-party APIs and SDKs (the existing inventory);
- base container images and OS versions;
- GitHub Actions versions and runner images.
Fast scanners (manifests, lockfiles, Dockerfiles, workflow files) point the agent at likely files; the agent's reading is the source of truth and can find what no scanner knows. Monorepos: one entry per package that declares its own version.
Also fill ProviderHints so F1's watchers know where to look.
Tests: fixtures for the three sample repos plus a monorepo; one real run per sample repo, capped at $5 total. Report what it found that the scanners missed.
Use subagents for runtimes and images and CI, libraries and frameworks, and models and APIs. Branch `mvp/inventory`, draft PR into `mvp`. Edit only inventory/. AI spend cap: $5.
```

### P3: report API, PR lifecycle and notifications

```text
Build the parts of Refit's app that keep PRs tidy and let people see results. Read MVP-PLAN.md (sections 1–7), AGENTS.md, app/SETUP.md and shared/types.ts on origin/mvp.

Deliver, in new folders so you don't collide with P1. Each folder exports from its own index.ts; P1 wires them into the server and the run job:
- app/api/: an authenticated HTTP API (REFIT_SERVICE_TOKEN) the dashboard reads: GET /api/repos, GET /api/report?repo= (the latest ScanReport), GET /api/runs (O4's RunViews), GET /api/prs. JSON only; never return secrets or raw repo contents.
- app/lifecycle/: PR lifecycle. Before opening a PR, find an open Refit PR for the same dependency and target and update it instead of opening a second one; when a newer target supersedes an open PR, update or close the old one with a comment saying why; keep BehindItem.status in step (open → pr-open → merged); when a PR's branch conflicts with the default branch, re-run the task on a fresh checkout.
- app/notify/: a short Slack message (REFIT_SLACK_WEBHOOK_URL, optional) when a verified PR opens and when a deadline is under 30 days; a weekly digest per org of what's behind. No secrets, no repo contents beyond names, titles and links.
Tests with recorded payloads and a fake GitHub client. AI spend: up to $1 for one real lifecycle check on the test org.
Use subagents for the API, the lifecycle and notifications. Branch `mvp/app-api`, draft PR into `mvp`. Edit only app/api/, app/lifecycle/ and app/notify/. AI spend cap: $1.
```

### P4: website, onboarding and dashboard

```text
Update Refit's website and dashboard in src/ for "software that never falls behind." Read MVP-PLAN.md (sections 1–7), DESIGN.md and AGENTS.md on origin/mvp. Keep DESIGN.md's design system: polish, don't redesign.

Deliver:
- Landing page: "Software that never falls behind." Plain language a non-technical buyer gets in ten seconds: Refit keeps code current when APIs, AI models, runtimes, frameworks, libraries and CI change. How it works in four steps (install, scan, fix, prove). No invented customers, logos or metrics.
- Pricing: Watch (free: maps everything your code depends on and alerts you); Paid ($319 a month for up to 50 repos, then $5 per extra repo up to 200); Enterprise (custom above 200 repos: private sandbox, audit trail, SSO). Billing starts after your first merged fix.
- Onboarding: "Install the GitHub App" → choose repos → "first scan running" → the What's behind page.
- Dashboard pages:
  - What's behind: every BehindItem per repo, sorted by deadline, with the dependency, current version, what changed, target, deadline, source link and status; filters by repo, kind and status.
  - Runs: O4's RunViews with outcome, cost and PR link.
  - Repo detail: everything one repo depends on (DependencyUsage[]) and its open PRs.
- Data from P3's /api endpoints; until they land, fixture data visibly labelled "Example data."
- Docs page: what Refit watches, what a PR contains, the hard limits, and how to pause or ignore something with .refit.yml.
Tests for every new page. No AI spend.
Use subagents for the landing and pricing, onboarding and docs, and the dashboard. Branch `mvp/site`, draft PR into `mvp`. Edit only src/, public/ and index.html.
```

---

## 10. Furqan's prompts (20%)

### F1: watchers for every change source

```text
Extend Refit's watchers in providers/ beyond API providers. Read MVP-PLAN.md (sections 1–7), REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first".

Goal: watchDependency(dep, since) → ExternalChange[], exported from providers/index.ts, for every DependencyKind. Keep the existing API watchers working.
Sources (structured feeds are inputs the agent may use; the agent decides what matters):
- Runtimes, frameworks, OS and images: end-of-life and support dates, from endoflife.date's public API and the official release-schedule pages.
- Libraries and frameworks: new major versions and their migration guides, from the npm and PyPI registries and the project's changelog or GitHub releases.
- Security: advisories from OSV and the GitHub Advisory Database, kept only when the fix needs more than a version bump or the bump crosses a major.
- AI models: retirements and replacements from OpenAI's, Anthropic's and Google's deprecation pages.
- CI: deprecated GitHub Actions and runner versions, from the actions' releases and GitHub's changelog.
Every ExternalChange carries its kind, dependency, affected versions, recommended target, effective date when there is one, severity, and an exact source quote with its URL. Cache fetched pages for a day; record what couldn't be read instead of failing silently.
Tests: saved fixtures per source, plus one live read per source, capped at $4 total.
Use one subagent per source group. Branch `mvp/watchers`, draft PR into `mvp`. Edit only providers/, not providers/toolkit/, providers/upgrades/, providers/*/tools.ts or providers/*/playbooks/, which F2 owns. AI spend cap: $4.
```

### F2: tools and playbooks for upgrades

```text
Build the tools and playbooks Refit's agent uses for upgrades. Read MVP-PLAN.md (sections 1–7), REFIT-PLAN.md and shared/types.ts on origin/mvp, especially "AI-first".

Tools, in providers/upgrades/ (exported from providers/upgrades/index.ts as AgentTools). They are helpers the agent may call to check itself; they return information and never block:
- endOfLife(product, version): end-of-life date, supported versions and the recommended target;
- migrationGuide(package, from, to): the relevant changelog and migration-guide passages with links;
- registryDiff(package, from, to): the breaking changes listed between two versions;
- codemod(package, from, to): known official codemods (for example Next.js codemods) and how to run them in the sandbox;
- modelReplacement(provider, model): the recommended replacement, its retirement date and request-shape differences;
- actionVersions(action): current and deprecated GitHub Actions versions;
- dockerImageTags(image): supported tags for a base image.
Playbooks, in providers/upgrades/playbooks/: one short markdown per kind (runtime-eol, framework-major, dependency-major, security-fix, container-image-eol, ci-deprecation, model-retirement), plus Node, Python, Next.js and Django specifics. AI drafts them from official docs with links; you review them. Each covers what usually breaks, how to spot it in code, what to check and common pitfalls. Advice to a smart engineer, not rules.
Keep the existing provider tools and playbooks working; add model-retirement playbooks to providers/openai and the other model providers.
Tests: every tool with fixtures; live calls capped at $3 total.
Use subagents for the tools and the playbooks. Branch `mvp/toolpacks`, draft PR into `mvp`. Edit only providers/toolkit/, providers/upgrades/, providers/*/tools.ts and providers/*/playbooks/. AI spend cap: $3.
```

---

## 11. Morning: integration and demo

### Merge order

1. F2 tools and playbooks
2. F1 watchers
3. P2 inventory
4. O3 sandbox, checks and model layer
5. O4 memory and evals
6. O2 harness
7. O1 orchestrator
8. P1 app
9. P3 report API, lifecycle and notifications
10. P4 website and dashboard

For each PR: review it against the AI-first rule (reject any new rule that stops or skips a task), read its status note, then merge into `mvp`. Regenerate `package-lock.json` with `npm install` if it conflicts.

### Integration prompt (one session, after the merges)

```text
Integrate Refit's MVP on the mvp branch. Read MVP-PLAN.md and AGENTS.md.
Replace every remaining local stub with the real module from section 6's table. Run typecheck, format check, tests and build until they pass. Run O4's smoke test on the three sample repos with a fake model. Then run `refit scan` for real on each sample repo, capped at $3 total, and report the What's behind table. Fix what breaks with the smallest change. Don't add rules that stop or skip tasks. Branch `mvp/integration`, draft PR into `mvp`. AI spend cap: $3.
```

### Demo checklist

- [ ] Install the app on the test org; all three repos queue a scan.
- [ ] What's behind shows runtime, framework, model and CI findings with deadlines and source links.
- [ ] At least three draft PRs open, each with checks before and after and an honest "unproven" section.
- [ ] Read every PR by hand. Record whether you'd merge it in `evals/reviews.json`.
- [ ] Merge one; the dashboard and memory show the verdict.
- [ ] Record a two-minute screen capture for the PearX follow-up.

## 12. Risks and fallbacks

| Risk                                         | Fallback                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A prompt runs out of plan usage or budget    | Its status note says what's done; the integration prompt fills the gap with the stub, and the demo skips that part |
| The real PR step fails on the test org       | Demo with `refit run --dry-run` and show the diff and checks; fix P1 first in the morning                          |
| Docker isn't available on a laptop           | O3's temp-copy sandbox with install scripts disabled; never run repo code on the host with scripts enabled         |
| Watchers return noisy or wrong changes       | The match agent marks them not affected with reasons; F1 tightens prompts, not rules                               |
| The upgrade breaks tests the agent can't fix | The PR is needs-review with exactly what's unproven, never a silent stop                                           |
| Merge conflicts in shared files              | Section 3 gives every file one owner; shared/types.ts is additive only                                             |
| Spend runs past a cap                        | The ledgers refuse to spend past `REFIT_AI_BUDGET_USD`; check `evals` cost reports                                 |

## 13. After the MVP

1. First real upgrade benchmark on upgrade-dev-20, with a founder-approved budget.
2. Hand-check every verified PR before quoting any number.
3. Pilots with the LOI customers in January: let them pick which forced change hurts most.
4. Next triggers: Kubernetes and cloud runtimes, app store and browser policies.
5. Security questionnaire answers: data flow, Anthropic as subprocessor, retention, and running in the customer's cloud (Bedrock or Vertex) for Enterprise.
6. Update the LOIs' goals and the PearX pitch to the new positioning.

## 14. Open decisions

- [ ] Approve the per-prompt caps (about $32, plus $3 for integration).
- [ ] Test org name and who owns it.
- [ ] Whether `ApiUsage` folds into `DependencyUsage` after the MVP (a breaking change; decide together).
- [ ] Which trigger the pitch leads with after APIs: runtimes, frameworks or AI models.
- [ ] Whether the weekly re-scan runs on a laptop for the demo or on a hosted server.
