# Refit MVP: one night, nine prompts

Drafted 2026-11-06. Refit is moving from "API migrations" to **"software that never falls behind"**: when anything outside a team's control changes, Refit finds the affected code, fixes it, proves the fix and opens a PR. This plan builds the MVP of that in one night: three laptops, three prompts each, all running in parallel while the founders sleep.

`REFIT-PLAN.md` and `AGENTS.md` still apply, above all the AI-first rule and the four hard limits. This plan only adds to them.

## What the MVP must show in the morning

On a test GitHub org with three sample repos, with the Refit Agent App installed:

1. **One scan finds everything that's behind,** not just APIs: language runtimes, frameworks and libraries, AI models and third-party APIs, each with its deadline and source.
2. **Refit opens at least two real draft PRs** with checks run before and after: one runtime end-of-life upgrade (for example Node 18 to 22, or Python 3.9 to 3.12) and one AI model retirement.
3. **The dashboard shows it:** what's behind, by deadline, and the PRs Refit opened.

Out of scope tonight: government rules, app store policies, vendor switching, self-hosted models, billing.

## What changes, and what stays

| Part                   | Today                                                         | After tonight                                                                                                 |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Inventory              | Finds external APIs (`ApiUsage[]`)                            | Also finds runtimes, frameworks, libraries, AI models, container images and CI versions (`DependencyUsage[]`) |
| Watchers               | Read API providers' changelogs                                | Also read end-of-life dates, package releases, security advisories and model deprecations                     |
| Match, harness, memory | Built for API changes                                         | Same loop; new playbooks and tools for upgrades                                                               |
| App                    | Opens PRs through the GitHub App; the CLI's PR step is a stub | A real end-to-end run on a test org, plus a weekly re-scan                                                    |
| Website                | API migrations                                                | "Software that never falls behind," with a freshness view                                                     |

The loop doesn't change: understand → watch → match → migrate → prove → PR → learn.

## Before launch (Otabek, ten minutes, no AI)

1. Create the integration branch `mvp` from `origin/main` and push it.
2. Add these types to `shared/types.ts` on `mvp`. Additive only.

```ts
// MVP (2026-11-06): anything outside the codebase that can force it to change. Additive only.
export type MigrationKindMvp =
  | 'runtime-eol' // a language or runtime version reaches end of life
  | 'framework-major' // a framework's major version, e.g. React, Next.js, Django
  | 'dependency-major' // a library's major version with breaking changes
  | 'security-fix' // an advisory whose fix needs code changes
  | 'container-image-eol' // a base image or OS version reaches end of life
  | 'ci-deprecation'; // a CI action, image or runner version is retired

export type DependencyKind =
  'api' | 'sdk' | 'library' | 'framework' | 'runtime' | 'ai-model' | 'container-image' | 'ci';

export type DependencyUsage = {
  repo: string;
  kind: DependencyKind;
  name: string; // e.g. 'node', 'react', 'gpt-4o', 'stripe', 'ubuntu', 'actions/checkout'
  version?: string;
  declaredIn: { file: string; line?: number }[]; // where the version is pinned or implied
  callSites?: ApiUsage['callSites']; // for APIs, SDKs and AI models
  notes?: string;
};

export type ExternalChange = Omit<ProviderChange, 'kind'> & {
  kind: MigrationKind | MigrationKindMvp;
  dependencyKind: DependencyKind;
};

export type InventoryDependencies = (repoDir: string, repo: string) => Promise<DependencyUsage[]>;
export type WatchDependency = (dep: DependencyUsage, since?: string) => Promise<ExternalChange[]>;
```

3. Create the test org's three sample repos (examples, labelled as such):
   - a Node 18 Express service that calls OpenAI with a retired model;
   - a Python 3.9 Flask app that uses Stripe;
   - a Next.js app on an old major version with a GitHub Actions workflow on deprecated action versions.
4. Push. Then all nine prompts start at the same time.

## Rules for every prompt

- Branch from `origin/mvp` with `--no-track`, and open a draft PR into `mvp`. Never push to `main`, never merge.
- Edit only your folders (the table below). Code against the types above, with a local stub until the real module lands.
- Each workspace adds its dependencies to its own `package.json`.
- Run typecheck, format check, tests and build before each commit. Conventional commits, no AI attribution lines, no co-author trailers.
- Every real model run sets `REFIT_AI_BUDGET_USD`. **Caps below are proposals: the founders approve them before launch.** No real benchmark tonight.
- Label every example. Don't invent customers, metrics or passing checks.

## Who owns what

| Laptop | Prompt                                                 | Folders                                                                | Proposed cap |
| ------ | ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------ |
| Otabek | O1 Orchestrator: any external change                   | `orchestrator/`                                                        | $3           |
| Otabek | O2 Harness: upgrades                                   | `harness/`                                                             | $8           |
| Otabek | O3 Memory: upgrade recipes                             | `memory/`                                                              | $2           |
| Pierce | P1 App: real end-to-end PRs                            | `app/`                                                                 | $4           |
| Pierce | P2 Inventory: every dependency                         | `inventory/`                                                           | $5           |
| Pierce | P3 Website and freshness dashboard                     | `src/`, `public/`, `index.html`                                        | $0           |
| Furqan | F1 Watchers: end-of-life, releases, advisories, models | `providers/` (not tools or playbooks)                                  | $4           |
| Furqan | F2 Tool packs and playbooks for upgrades               | `providers/*/tools.ts`, `providers/*/playbooks/`, `providers/toolkit/` | $3           |
| Furqan | F3 Evals for upgrades                                  | `evals/`                                                               | $2           |

Proposed total: about $31, roughly $10–13 per laptop.

---

## Otabek's laptop

### O1: the orchestrator handles any external change

```text
Extend Refit's loop in orchestrator/ from API changes to any external change. Read MVP-PLAN.md, REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first".

Deliver:
- The loop takes DependencyUsage[] from inventory and ExternalChange[] from the watchers, alongside the existing ApiUsage and ProviderChange. Keep the API path working.
- The match agent decides which external changes touch which dependencies and call sites, why, and how urgent each is. Rank tasks by deadline first, then impact. No rule tables that decide relevance; version overlap and dates are hints for the agent.
- `refit scan --repo <path>`: a dry run that prints a "what's behind" report (dependency, current version, what changed, deadline, source link) and writes it as JSON for the dashboard.
- `refit run` keeps working end to end, now including upgrade tasks.
Code against inventory, watcher and harness stubs; their real modules land on other branches tonight. Test end to end with stubs, plus one real match run on fixtures.
Use subagents for the match agent, the scan report and the loop. Branch `mvp/orchestrator`, draft PR into `mvp`. Edit only orchestrator/. AI spend cap: $3.
```

### O2: the harness does upgrades

```text
Teach Refit's migration agent in harness/ to do upgrades: runtime end-of-life, framework and library majors, base images, CI versions and AI model retirements. Read MVP-PLAN.md, REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first" and "The harness system prompt".

Deliver:
- The system prompt handles ExternalChange tasks, not only API changes: what's changing, the deadline, the source quote and every place the version is declared.
- Tools the agent may call, which return information and never block: bump a version where it's declared (package.json engines, .nvmrc, .python-version, pyproject, Dockerfile FROM, workflow files); run the package manager's upgrade; fetch the official migration guide and changelog between two versions; run a codemod if one exists.
- Before/after checks as today (type check, build, tests; count only new failures), run in the sandbox on the NEW runtime version. The outcome is verified or needs-review, never stopped.
- PR bodies for upgrades: what was upgraded and why, the deadline, the checks before and after, what's unproven, and any behaviour change.
Test with a fake model. Then ONE real run on the test org's Node 18 sample repo, capped at $5, and report the diff and whether you'd merge it.
Use subagents for the tools, the prompt and the checks. Branch `mvp/harness`, draft PR into `mvp`. Edit only harness/. AI spend cap: $8.
```

### O3: memory learns upgrade recipes

```text
Extend Refit's memory in memory/ to learn upgrades. Read MVP-PLAN.md, REFIT-PLAN.md and shared/types.ts on origin/mvp, especially "AI-first".

Deliver:
- Recipes keyed by dependency and version range (for example "node 18 → 22", "next 13 → 15", "gpt-4o → its replacement"), not only by provider and MigrationKind. Keep existing recipes readable.
- Extraction after a verified upgrade run: preconditions, steps, pitfalls and a diff sketch, linked to the run.
- Retrieval for ExternalChange tasks, chosen by AI judgement and embeddings, never a fixed keyword match.
- RunView covers upgrade runs, so the dashboard can show them.
Unit-test with fixtures; real AI calls only for 2 extraction tests.
Use subagents per component. Branch `mvp/memory`, draft PR into `mvp`. Edit only memory/. AI spend cap: $2.
```

---

## Pierce's laptop

### P1: the app runs end to end on a real org

```text
Make Refit's GitHub App in app/ run the whole loop on a real test org. Read MVP-PLAN.md, REFIT-PLAN.md, AGENTS.md, app/SETUP.md and shared/types.ts on origin/mvp.

Deliver:
- Install → scan → PRs: when the app is installed, queue a scan of each repo; when the orchestrator returns tasks, run them and open draft PRs through the existing createOpenPullRequest.
- A weekly re-scan of every installed repo, plus a re-scan on push to the default branch, behind the existing queue.
- An endpoint that serves the latest "what's behind" report and RunViews for the dashboard.
- Replace the CLI's stub PR link with the real opener when app credentials are present; keep the stub when they're not.
- A runbook in app/SETUP.md for the morning: install on the test org, trigger a scan, watch the PRs appear.
Secrets only from env; never commit or print them. Tests with recorded webhook payloads. One real end-to-end run on the test org, capped at $4.
Use subagents for the scan flow, the scheduler and the report endpoint. Branch `mvp/app`, draft PR into `mvp`. Edit only app/. AI spend cap: $4.
```

### P2: the inventory finds every dependency

```text
Extend Refit's codebase-understanding agent in inventory/ to find everything outside the code that can force it to change. Read MVP-PLAN.md, REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first".

Goal: inventoryDependencies(repoDir, repo) returns DependencyUsage[], alongside the existing ApiUsage[].
The agent reads the repo like a new engineer and finds:
- language runtimes and their versions (package.json engines, .nvmrc, .python-version, pyproject, go.mod, Dockerfiles, serverless and cloud config);
- frameworks and important libraries, with versions from lockfiles;
- AI models named in code or config, with call sites;
- third-party APIs and SDKs (the existing inventory);
- base container images and OS versions;
- CI action and runner versions.
Fast scanners point the agent at likely files; the agent's reading is the source of truth and can find things no scanner knows.
Test on the three sample repos (fixtures) and one real run per sample repo, capped at $5 total.
Use subagents for runtimes and images, libraries and frameworks, and models and APIs. Branch `mvp/inventory`, draft PR into `mvp`. Edit only inventory/. AI spend cap: $5.
```

### P3: the website and the freshness dashboard

```text
Update Refit's website and dashboard in src/ for the new positioning. Read MVP-PLAN.md, DESIGN.md and AGENTS.md on origin/mvp. Keep DESIGN.md's design system: polish, don't redesign.

Deliver:
- Landing page copy for "Software that never falls behind": Refit keeps code current when APIs, AI models, runtimes, frameworks, libraries and CI change. Plain language a non-technical buyer understands; no invented customers or metrics.
- Pricing: Watch (free), Paid ($319 a month for up to 50 repos, then $5 per extra repo up to 200), Enterprise (custom above 200). Billing starts after the first merged fix.
- A "What's behind" dashboard page: every dependency per repo with its current version, what changed, the deadline and the source, sorted by deadline, plus the PRs Refit opened. It reads P1's endpoint; until that lands, use fixture data visibly labelled as an example.
Tests for the new pages. No AI spend.
Branch `mvp/site`, draft PR into `mvp`. Edit only src/, public/ and index.html.
```

---

## Furqan's laptop

### F1: watchers for end-of-life dates, releases, advisories and models

```text
Extend Refit's watchers in providers/ beyond API providers. Read MVP-PLAN.md, REFIT-PLAN.md, AGENTS.md and shared/types.ts on origin/mvp, especially "AI-first".

Implement WatchDependency(dep, since) → ExternalChange[] for:
- Runtimes, frameworks, databases, OS and Kubernetes versions: end-of-life dates. endoflife.date's public API is a fast structured source; the agent may also read official release-schedule pages.
- Libraries and frameworks: new major versions and their migration guides, from the npm and PyPI registries and the project's changelog or GitHub releases.
- Security advisories that need code changes, from OSV or the GitHub Advisory Database.
- AI model retirements from OpenAI's, Anthropic's and Google's deprecation pages.
- CI: deprecated GitHub Actions versions.
Every ExternalChange has a kind, the affected versions, an effective date when one exists and an exact source quote with its URL. Structured feeds are inputs the agent may use; the agent decides what matters.
Test on saved fixtures, plus one live read per source, capped at $4 total.
Use one subagent per source. Branch `mvp/watchers`, draft PR into `mvp`. Edit only providers/, not providers/*/tools.ts, providers/*/playbooks/ or providers/toolkit/, which F2 owns. AI spend cap: $4.
```

### F2: tools and playbooks for upgrades

```text
Build the tools and playbooks Refit's agent uses for upgrades, in providers/toolkit/, providers/*/tools.ts and providers/*/playbooks/. Read MVP-PLAN.md, REFIT-PLAN.md and shared/types.ts on origin/mvp, especially "AI-first".

Tools are helpers the agent may call to check itself; they return information and never block:
- endOfLife(product, version): the end-of-life date and the supported versions;
- migrationGuide(package, from, to): the relevant changelog and migration-guide passages;
- registryDiff(package, from, to): breaking changes listed between two versions;
- modelReplacement(provider, model): the recommended replacement and any request-shape differences;
- actionVersions(action): current and deprecated GitHub Actions versions.
Playbooks: one short markdown per new kind (runtime-eol, framework-major, dependency-major, security-fix, container-image-eol, ci-deprecation), drafted by AI from official docs with links, then reviewed by you. Each covers what usually breaks, how to spot it in code, what to check and common pitfalls. Advice, not rules.
Unit-test every tool with fixtures; live calls capped at $3 total.
Use subagents per tool group. Branch `mvp/toolpacks`, draft PR into `mvp`. Edit only those paths. AI spend cap: $3.
```

### F3: evals for upgrades

```text
Extend Refit's evals in evals/ to cover upgrades. Read MVP-PLAN.md, REFIT-PLAN.md and shared/types.ts on origin/mvp.

Deliver:
- A dev set, runtime-eol-dev-20: public repos pinned to end-of-life Node or Python versions, with tests that run. Record why each was picked. Keep a separate blind set frozen and unopened; record only its path and hash.
- Scoring broken down by change kind (API, runtime, framework, library, model, CI): verified, needs-review and not-affected rates, cost per repo and the attempted rate, which must be 100%.
- The one-command smoke test runs the three sample repos end to end with a fake model.
Do not run a real benchmark tonight; the founders approve the first one with a budget. Real AI calls only to check the reviewer on 2 fixtures, capped at $2.
Use subagents for the set, the scoring and the smoke test. Branch `mvp/evals`, draft PR into `mvp`. Edit only evals/. AI spend cap: $2.
```

---

## Morning checklist (founders)

1. Review the draft PRs into `mvp`. Check each against the AI-first rule: reject any new rule that stops or skips a task.
2. Merge in this order: F1 watchers, F2 tools, P2 inventory, O3 memory, O2 harness, O1 orchestrator, P1 app, P3 site, F3 evals.
3. Regenerate the lockfile if needed, then run F3's smoke test on the three sample repos.
4. Install the Refit Agent App on the test org and run the demo: scan, the "what's behind" page, the PRs.
5. Read every PR by hand before calling it verified. Record what you'd merge.
6. Decide the first real benchmark and its budget.

## Open questions for the founders

- [ ] Approve the per-prompt caps (about $31 total).
- [ ] Which sample repos to use, and who creates the test org.
- [ ] Should the API path keep its own types, or move fully to `DependencyUsage` once the MVP works? (A breaking change: decide together.)
- [ ] Which second trigger to lead the pitch with after APIs: runtimes, frameworks or AI models.
