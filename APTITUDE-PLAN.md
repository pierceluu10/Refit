# Aptitude: overnight build plan

Written 2026-11-01. Refit is renamed **Aptitude**, and we start from scratch. The old deterministic engine is deleted. Its history stays in git, but don't port it back.

## What Aptitude is

A GitHub App for an organization. Once installed, Aptitude:

- knows every external API the org's code uses, where it's used and how;
- watches those APIs for changes;
- has a self-learning agent migrate the code and open PRs that come with proof.

## The end-to-end flow

1. **Install.** An org admin installs the Aptitude GitHub App on the org (all repos or selected ones).
2. **Inventory.** For every repo, Aptitude builds an API usage map:
   - **which APIs:** Stripe, Shopify, Meta Graph, OpenAI, Twilio, Slack and so on;
   - **through what:** the SDK and its version, raw HTTP, or GraphQL;
   - **which version is pinned,** and where the pin lives;
   - **every call site:** file, line, operation, and the fields and params it sends;
   - **how the response is used.**

   It refreshes on every push.

3. **Watch.** Aptitude follows each provider's changelogs, specs, SDK releases and deprecation notices, and turns each change into a structured `ProviderChange`.
4. **Match.** It crosses changes with the inventory. The result is `MigrationTask`s (repo, change, affected call sites, deadline), ranked by deadline and impact.
5. **Migrate.** The harness agent takes a task, works in a sandboxed copy of the repo, edits the code, and runs the checks.
6. **Prove.** It runs the type check, build and tests before and after, counting only new failures. Provider validators (schema validation, a live test call) run as tools the agent uses. The outcome is **verified** or **needs-review**, never "stopped".
7. **Ship.** It opens a PR on a branch, never on the default branch. The PR says what changed and why, the proof, and what's unproven.
8. **Learn.** It records the trajectory and the outcome (checks, PR merged, closed or edited by a human). Successful trajectories become recipes and skills that future runs retrieve.

## Principles: what we learned from Refit

- **No deterministic trap.** Parsers, validators and codemods are tools the agent may use. They are never gates that stop a task.
- **Every task ends with a PR or a "not affected" verdict.** No silent stops.
- **Hard limits, and only these:**
  1. untrusted repo code runs only in the sandbox;
  2. a run-level dollar cap;
  3. PRs only, never a push to the default branch, never a merge;
  4. never print or commit secrets.

  Everything else is guidance in the system prompt, not code.

- **Measure the verified rate end to end.** Hand-check new verified PRs during development. A green check that comes from a broken sandbox is not a result.

## Architecture

| Folder       | What lives there                                                                                                                                       | Owner  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `app/`       | GitHub App: install webhooks, org and repo sync, a check-runs or PR API client, and a tiny server                                                      | Pierce |
| `inventory/` | API usage detection: manifests, imports, HTTP hosts, GraphQL documents, env/config, plus an AI read of the code for whatever parsers miss              | Pierce |
| `harness/`   | The agent loop on the Claude Agent SDK: system prompt, tool registry, sandbox runner, budget ledger, PR writer                                         | Otabek |
| `memory/`    | Self-learning: run records, recipe extraction, retrieval, skill promotion, nightly self-eval                                                           | Otabek |
| `providers/` | One folder per provider: change watcher, knowledge (versions, deadlines, docs URLs), tool pack (validators, docs search), playbooks per migration type | Furqan |
| `evals/`     | Frozen dev and blind repo sets, the benchmark runner, scoring, the hand-check log                                                                      | Furqan |
| `src/`       | The website and dashboard, renamed to Aptitude                                                                                                         | Pierce |

### Shared types (`shared/types.ts`, written first by Otabek's prompt O1)

```ts
export type ApiUsage = {
  repo: string;
  provider: string; // 'stripe' | 'shopify' | 'meta-graph' | 'openai' | ...
  via: 'sdk' | 'http' | 'graphql' | 'webhook';
  sdk?: { name: string; version: string; lockfile?: string };
  pinnedVersion?: { value: string; file: string; line: number };
  callSites: { file: string; line: number; operation: string; fields?: string[]; notes?: string }[];
};
export type ProviderChange = {
  provider: string;
  id: string;
  kind: MigrationKind;
  title: string;
  effectiveDate?: string;
  source: { url: string; quote: string };
  affects: { operations?: string[]; fields?: string[]; versions?: string[]; sdk?: string };
};
export type MigrationKind =
  | 'api-version'
  | 'sdk-major'
  | 'field-removed'
  | 'field-renamed'
  | 'endpoint-removed'
  | 'rest-to-graphql'
  | 'auth-change'
  | 'webhook-payload'
  | 'model-retirement'
  | 'product-shutdown'
  | 'pagination-or-limits'
  | 'other';
export type MigrationTask = {
  id: string;
  repo: string;
  change: ProviderChange;
  usages: ApiUsage[];
  deadline?: string;
  priority: number;
};
export type ToolPack = {
  // one per provider, from providers/<name>/tools.ts
  provider: string;
  tools: AgentTool[]; // e.g. validateShopifyGraphQL, stripeApiVersionInfo, searchDocs
  playbooks: Partial<Record<MigrationKind, string>>; // markdown guidance injected into the prompt
};
export type RunRecord = {
  taskId: string;
  outcome: 'verified' | 'needs-review' | 'not-affected' | 'failed';
  diff: string;
  checks: { name: string; before: string; after: string }[];
  costUsd: number;
  transcriptPath: string;
  pr?: string;
  humanVerdict?: 'merged' | 'closed' | 'edited';
};
```

### The harness system prompt (structure, written in O2)

1. **Role:** "You are Aptitude, an engineer who migrates code when external APIs change."
2. **The task:** the change (with its quoted source), the affected call sites, the deadline.
3. **Workflow:**
   - understand the usage;
   - read the provider docs, using the docs tool;
   - plan;
   - edit;
   - run the checks;
   - iterate until they pass or you can explain why they can't;
   - write the PR summary.
4. **Tools:** the general ones (files, shell in the sandbox, install, test, build, web docs), plus the provider's ToolPack, plus retrieved recipes from memory.
5. **Definition of done:**
   - **verified:** checks pass before and after, and the provider validators pass;
   - **needs-review:** list exactly what's unproven, and any behaviour change.
6. **Style:** the smallest correct change; keep behaviour the same unless the change requires otherwise, and say so.
7. **Hard limits:** the four above, and nothing else.

## Budget (needs founder approval before launch)

- **AI cap per laptop overnight: $20** (proposed), enforced in code by the budget ledger and stated in every prompt.
- Development runs use 3–5 dev repos at a time. **No full benchmark tonight.**
- Each prompt stops spending when its share is used, and reports what it got.

## Git rules for every prompt

- **Integration branch:** `aptitude`, cut from `main`. Otabek's O1 creates it first.
- **Each prompt:** its own branch, cut with `--no-track` from `origin/aptitude`, and a draft PR into `aptitude`.
- **Never push to `main`** and never merge. The founders merge in the morning.
- Run typecheck, format, tests and build before each commit. Conventional commits, no AI attribution lines.
- **Each prompt edits only its own folders** (the table above), so parallel prompts don't conflict.
- `shared/types.ts` changes go through O1's branch.

## How to run the prompts

On each laptop:

1. Open one Claude Code session per prompt, all in parallel.
2. Paste the prompt as written.
3. Each prompt tells its session to split the work across subagents and to keep going until it's done or its budget is used.

---

## Otabek's laptop: harness and self-learning

### O1: foundation (start this first; others branch from its push)

```text
You are building the foundation of Aptitude (formerly Refit), an org-wide GitHub App whose agent migrates code when external APIs change. Read APTITUDE-PLAN.md on branch docs/aptitude-plan first.

1. Create branch `aptitude` from origin/main and push it.
2. On it, set up the monorepo folders from the plan (app/, inventory/, harness/, memory/, providers/, evals/, shared/), with a TypeScript build, vitest and prettier wired for all of them alongside the existing website.
3. Write shared/types.ts exactly as in the plan.
4. Update AGENTS.md and README.md for Aptitude.
5. Push within the first 30 minutes, so the other prompts can branch from it.

Then continue on branch `aptitude/foundation-ci`: CI for typecheck, format, test and build across all folders.

Use subagents for independent pieces (CI, folder scaffolding, docs). Draft PR into `aptitude`. Never push to main. No AI attribution lines. AI spend: $0. This prompt makes no model calls.
```

### O2: the harness agent

```text
Build Aptitude's harness in harness/. Read APTITUDE-PLAN.md (branch docs/aptitude-plan) and shared/types.ts on origin/aptitude.

Goal: runTask(task: MigrationTask) runs a Claude agent (Claude Agent SDK, model claude-sonnet-5-5, escalating to claude-opus-5-5) in a sandboxed copy of the repo and returns a RunRecord.

Deliver:
- The structured system prompt from the plan, built from the task, the ToolPack and retrieved recipes. Keep it in harness/prompt.ts and make it readable.
- A tool registry: general tools (file ops, shell limited to the sandbox, install with the repo's package manager, run tests/build/typecheck, docs fetch), plus the provider ToolPack, plus memory retrieval.
- A sandbox runner: Docker on Linux CI, or a temp copy with install scripts disabled when Docker is unavailable locally. Untrusted code never runs on the host with scripts enabled.
- Before/after checks that count only new failures. Outcome verified or needs-review. No stops.
- A budget ledger with a hard run cap (APTITUDE_AI_BUDGET_USD) that every model call goes through.
- A PR body writer: change, why, proof, unproven, behaviour changes.
- Hard limits only as in the plan. No other refusal logic.

Test with a fake model for the loop. Then do ONE real run on one public dev repo with a small known change (pick a Stripe or OpenAI SDK repo you find), capped at $5.

Use subagents: one for the sandbox, one for the tools, one for the prompt and PR writer, then integrate yourself. Branch `aptitude/harness` from origin/aptitude, draft PR into `aptitude`. Edit only harness/. Never push to main. No AI attribution lines. AI spend cap: $8 total.
```

### O3: self-learning memory

```text
Build Aptitude's self-learning in memory/. Read APTITUDE-PLAN.md (branch docs/aptitude-plan) and shared/types.ts on origin/aptitude.

Deliver:
- **Run store:** save every RunRecord, its transcript and the human verdict (from PR webhooks later) as local JSON files now, behind an interface that can move to Postgres.
- **Recipe extraction:** after a verified run, an AI pass distils the trajectory into a recipe (provider, migration kind, preconditions, steps, pitfalls, a diff sketch), with the source run linked.
- **Retrieval:** given a MigrationTask, return the top recipes by provider, kind and code similarity, for harness/prompt.ts to inject. Export retrieveRecipes(task).
- **Skill promotion:** a recipe that's verified on 3+ different repos becomes a "skill" (a reusable tool or prompt block). A recipe that fails twice after promotion is demoted.
- **Nightly self-eval:** rerun a small fixed set of past tasks with the current memory and report whether verified went up or down.

Unit-test all of it with fixtures. Real AI calls only for 3 extraction tests, capped at $3.

Use subagents per component. Branch `aptitude/memory` from origin/aptitude, draft PR into `aptitude`. Edit only memory/. Never push to main. No AI attribution lines. AI spend cap: $3.
```

---

## Pierce's laptop: GitHub App, inventory and website

### P1: the GitHub App and install flow

```text
Build Aptitude's GitHub App in app/. Read APTITUDE-PLAN.md (branch docs/aptitude-plan) and shared/types.ts on origin/aptitude (wait for O1's push if it isn't there yet).

Deliver:
- An app manifest (permissions: contents read/write, pull requests write, checks write, metadata read; events: installation, installation_repositories, push, pull_request).
- A webhook server (verify signatures) that handles:
  - org install: list all repos and queue an inventory job for each;
  - repos added or removed;
  - push: queue an inventory refresh;
  - pull_request closed or merged: send the human verdict to memory.
- An installation-token client and a PR opener (branch, commit, PR) used by the harness.
- A local dev setup with smee or a tunnel, plus docs for creating the app on GitHub. Don't create it yourself; a founder does that with their own account.
- Secrets only from env. Never commit or print them.

Tests with recorded webhook payloads. No AI calls.

Use subagents for the webhook handling, the token client and PR opener, and the docs. Branch `aptitude/app` from origin/aptitude, draft PR into `aptitude`. Edit only app/. Never push to main. No AI attribution lines. AI spend: $0.
```

### P2: API inventory

```text
Build Aptitude's API inventory in inventory/. Read APTITUDE-PLAN.md (branch docs/aptitude-plan) and shared/types.ts on origin/aptitude.

Goal: inventoryRepo(dir) returns ApiUsage[]: every external API the repo uses, through what (SDK, HTTP, GraphQL, webhook), the pinned version and where it lives, and every call site with its operation and fields.

How:
- Cheap detectors first, as tools, not gates: package manifests and lockfiles (npm, pnpm, yarn, pip, poetry, go.mod, Gemfile), SDK imports, known API hosts in URLs, GraphQL documents, env var names, config files (shopify.app.toml and similar).
- Then an AI pass (Claude) reads the files the detectors flagged, and files they couldn't classify, to fill in operations, fields and "how the response is used".
- Start with 10 providers: Stripe, Shopify, Meta Graph, OpenAI, Anthropic, Twilio, Slack, GitHub, Google Maps, SendGrid. Make adding more data-only.
- Output a per-repo JSON plus a human summary.

Test on 5 public repos per provider that you pick. Report precision by hand-checking 10 usages.

Use subagents per language family and one for the AI pass. Branch `aptitude/inventory` from origin/aptitude, draft PR into `aptitude`. Edit only inventory/. Never push to main. No AI attribution lines. AI spend cap: $6.
```

### P3: rename the website to Aptitude, plus a dashboard skeleton

```text
Rename the website in src/ from Refit to Aptitude: copy, titles, metadata, logo text, the favicon wording and links. Keep DESIGN.md's design system. Polish, don't redesign. Read APTITUDE-PLAN.md (branch docs/aptitude-plan) and AGENTS.md.

Then add a dashboard skeleton: org → repos → APIs used (from the ApiUsage shape in shared/types.ts) → open migration tasks and PRs. Fixture data must be visibly labelled as an example; no invented customers or metrics.

Run typecheck, format, tests and build. Use subagents for the rename sweep and the dashboard. Branch `aptitude/website` from origin/aptitude, draft PR into `aptitude`. Edit only src/, public/ and index.html. Never push to main. No AI attribution lines. AI spend: $0.
```

---

## Furqan's laptop: providers, knowledge and evals

### F1: provider watchers and knowledge

```text
Build Aptitude's provider knowledge in providers/. Read APTITUDE-PLAN.md (branch docs/aptitude-plan) and shared/types.ts on origin/aptitude.

For each of Stripe, Shopify, Meta Graph, OpenAI and Twilio, build providers/<name>/ with:
- watcher.ts: fetch the provider's changelog, RSS/Atom, specs or SDK releases and emit ProviderChange[], each with a source URL and an exact quote. Use AI to classify prose into MigrationKind and the affected operations and fields. Use deterministic fetching and diffing where the provider publishes machine-readable specs (OpenAPI, the GraphQL schema).
- knowledge.json: supported versions, retirement dates, docs URLs, SDK packages per language. Each entry carries its source and date.
- A shared interface so adding a provider is a folder plus data.

Test each watcher against saved fixtures, plus one live fetch per provider.

Use one subagent per provider. Branch `aptitude/providers` from origin/aptitude, draft PR into `aptitude`. Edit only providers/ (not providers/*/tools.ts, which F2 owns). Never push to main. No AI attribution lines. AI spend cap: $5.
```

### F2: provider tool packs and migration playbooks

```text
Build the ToolPack for each provider in providers/<name>/tools.ts and playbooks/. Read APTITUDE-PLAN.md (branch docs/aptitude-plan) and shared/types.ts on origin/aptitude.

Tools the agent can call (helpers, never gates):
- **Shopify:** validate a GraphQL document against a version's Admin schema; look up the REST-to-GraphQL mapping.
- **Stripe:** API version info; validate params against the OpenAPI spec at a version.
- **Meta:** check fields and edges against the version change table.
- **OpenAI:** model retirement lookup and the replacement model; validate request shape.
- **Twilio:** endpoint and version lookup.
- **Every provider:** searchDocs(provider, query).

Playbooks: one short markdown per MigrationKind per provider. Cover what usually changes, how to find it in code, what to check, and common pitfalls. Write them from the provider docs, with links. Keep them guidance, not rules.

Unit-test every tool. Use one subagent per provider. Branch `aptitude/toolpacks` from origin/aptitude, draft PR into `aptitude`. Edit only providers/*/tools.ts and providers/*/playbooks/. Never push to main. No AI attribution lines. AI spend cap: $3.
```

### F3: evals and benchmark harness

```text
Build Aptitude's evals in evals/. Read APTITUDE-PLAN.md (branch docs/aptitude-plan) and shared/types.ts on origin/aptitude.

Deliver:
- **Repo sets:** recover the frozen Refit repo lists from git history as data only: `git log --all -- 'subsets/*.json' 'docs/benchmarks/*-repos.json'`. Recover the dev sets (shopify-dev-60, meta-dev-60, the Stripe dev lists). Keep the blind sets frozen and unopened; record only their paths and hashes.
- **A runner:** inventory → match → harness → score, one repo per GitHub Actions shard. Concurrency and a dollar cap are inputs, and it never runs without an explicit cap.
- **Scoring:** verified rate, needs-review rate, not-affected, cost per repo, and a hand-check log (evals/reviews.json) for every verified PR.
- **A one-command local smoke test** on 3 dev repos with a fake model.

Do not run a real benchmark tonight; the founders approve the first one with a budget.

Use subagents for the repo-set recovery, the runner and the scoring. Branch `aptitude/evals` from origin/aptitude, draft PR into `aptitude`. Edit only evals/. Never push to main. No AI attribution lines. AI spend: $0.
```

---

## Morning checklist (founders)

1. Review the draft PRs into `aptitude` and merge them in this order:
   1. O1 foundation;
   2. F1 providers;
   3. F2 tool packs;
   4. P2 inventory;
   5. O2 harness;
   6. O3 memory;
   7. P1 app;
   8. P3 website;
   9. F3 evals.
2. Run F3's smoke test end to end.
3. Approve a budget for the first real dev benchmark (suggestion: 20 repos, $40), and read the hand-checks before trusting any number.
4. Create the Aptitude GitHub App on the org and install it on a test org first.
