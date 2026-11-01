# Aptitude: overnight build plan

Written 2026-11-01. Refit is renamed **Aptitude**, and we start from scratch. The old deterministic engine is deleted. Its history stays in git, but don't port it back.

## What Aptitude is

A GitHub App for an organization. Once installed, Aptitude:

- **reads each codebase** the way a new engineer would;
- **understands** which external APIs it uses, where, and how;
- **goes from there:** watches those APIs for changes, migrates the affected code, proves the migration works, and opens a PR;
- **learns from every outcome.**

## AI-first: the rule above all others

Refit failed because it was a rule engine with a little AI on top. About three in four repos hit a rule and stopped before anything was tried. Aptitude is the opposite: **an AI agent does the understanding, deciding and editing. Code exists to give it tools, context and a way to check its work.**

**Do:**

- **Let the model read and reason.** Reading code, understanding API usage, reading changelogs, deciding whether a change matters, planning and editing: all of it is the agent's job.
- **Write parsers, scanners, validators and codemods only as tools** the agent may call to go faster or check itself. Never as gates.
- **Make the outcome of every task a PR or a "not affected" verdict,** with an honest note on what's unproven. Never a silent stop.
- **Put guidance in prompts, playbooks and memory,** not in `if` statements.
- **When the agent is unsure, have it try anyway and say so in the PR.** Don't refuse.

**Reject these in review.** They are the Refit trap:

- a hand-written rule that decides whether a repo, file or change is "supported";
- any branch that ends a task without an attempt (`stop`, `refuse`, `skip`, "separate reviewed change");
- a fixed list of patterns as the only way to find API usage;
- AI calls shaped as "answer yes or no, decline if unsure";
- "cautious" defaults that make the agent do less.

**The only hard limits, enforced in code:**

1. Untrusted repo code runs only in the sandbox.
2. A run-level dollar cap.
3. PRs only. Never push to the default branch, never merge.
4. Never print or commit secrets.

## The end-to-end flow

1. **Install.** An org admin installs the Aptitude GitHub App on the org (all repos or selected ones).
2. **Understand the codebase.** An agent reads each repo and writes an API usage map. For every external API it records:
   - which provider;
   - through what: an SDK and its version, raw HTTP, GraphQL, or webhooks;
   - which version is pinned, and where;
   - every call site, with what it sends;
   - what the code does with the response.

   Fast scanners (manifests, imports, hosts) only point the agent at likely files. The agent's reading is the source of truth, and it finds APIs that no scanner knows. It re-reads on every push.

3. **Watch.** Agents read each provider's changelogs, specs, SDK releases and deprecation notices. They write structured `ProviderChange`s, each with a source quote. Machine-readable specs are a shortcut, not a requirement.
4. **Match.** An agent decides which changes touch which call sites, and why. The result is `MigrationTask`s ranked by deadline and impact.
5. **Migrate.** The harness agent takes a task, works in a sandboxed copy of the repo, and edits the code.
6. **Prove.** The agent runs the type check, build and tests before and after, counting only new failures. It calls provider validators as tools: schema validation, a live test call. It keeps iterating until the checks pass or it can explain why they can't. The outcome is **verified** or **needs-review**.
7. **Ship.** A PR on a branch. It says what changed and why, the proof, what's unproven, and any behaviour change.
8. **Learn.** Every trajectory and outcome is recorded: the checks, and whether a human merged, closed or edited the PR. Successful trajectories become recipes and skills that future runs retrieve.

## Architecture

| Folder          | What lives there                                                                                                | Owner                    |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `orchestrator/` | The end-to-end loop (understand → watch → match → migrate → PR → learn), the match agent, the CLI and the queue | Otabek                   |
| `harness/`      | The migration agent on the Claude Agent SDK: system prompt, tool registry, sandbox, budget ledger, PR writer    | Otabek                   |
| `memory/`       | Self-learning: run records, recipe extraction, retrieval, skill promotion, nightly self-eval                    | Otabek                   |
| `app/`          | The GitHub App: install webhooks, org and repo sync, PR opener, verdict feedback                                | Pierce                   |
| `inventory/`    | The codebase-understanding agent that produces `ApiUsage[]`                                                     | Pierce                   |
| `src/`          | The website and dashboard, renamed to Aptitude                                                                  | Pierce                   |
| `providers/`    | Per provider: changelog-reading watcher, knowledge, tool pack, playbooks                                        | Furqan                   |
| `evals/`        | Frozen dev and blind repo sets, the benchmark runner, scoring, hand-checks                                      | Furqan                   |
| `shared/`       | `types.ts`, the contract every folder codes against                                                             | Everyone (additive only) |

### Shared types (`shared/types.ts`, on `aptitude` before launch)

```ts
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
export type ApiUsage = {
  repo: string;
  provider: string; // any provider the agent finds, not a fixed list
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
export type MigrationTask = {
  id: string;
  repo: string;
  change: ProviderChange;
  usages: ApiUsage[];
  deadline?: string;
  priority: number;
};
export type AgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: unknown, context: { repoDir: string }) => Promise<string>;
};
export type ToolPack = {
  provider: string;
  tools: AgentTool[]; // helpers the agent may call, never gates
  playbooks: Partial<Record<MigrationKind, string>>; // guidance injected into the prompt
};
export type Recipe = {
  id: string;
  provider: string;
  kind: MigrationKind;
  preconditions: string;
  steps: string;
  pitfalls: string;
  sourceRuns: string[];
  verifiedRepos: number;
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
// Entry points each owner exports; everyone else codes against them with stubs tonight.
export type InventoryRepo = (repoDir: string, repo: string) => Promise<ApiUsage[]>;
export type WatchProvider = (since?: string) => Promise<ProviderChange[]>;
export type RetrieveRecipes = (task: MigrationTask) => Promise<Recipe[]>;
export type RunTask = (task: MigrationTask, repoDir: string) => Promise<RunRecord>;
```

### The harness system prompt (structure, built in O2)

1. **Role:** "You are Aptitude, a senior engineer who migrates code when external APIs change. You always attempt the migration."
2. **The task:** the change (with its quoted source), the affected call sites, the deadline.
3. **Workflow:**
   - understand the usage in this repo;
   - read the provider docs;
   - check memory for recipes;
   - plan;
   - edit;
   - run the checks and validators;
   - iterate;
   - write the PR summary.
4. **Tools:** files, shell in the sandbox, install, tests, build, type check, web and docs search, the provider's tool pack, and memory.
5. **Definition of done:**
   - **verified:** checks pass before and after, and the provider validators pass;
   - **needs-review:** state exactly what's unproven, and any behaviour change.
6. **Style:** the smallest correct change. Keep behaviour the same unless the API change forces otherwise, and say so.
7. **Hard limits:** the four above, and nothing else.

## Budget (needs founder approval before launch)

- **AI cap per laptop overnight: $20** (proposed), enforced by the budget ledger and stated in each prompt.
- Development uses 3–5 dev repos at a time. **No full benchmark tonight.**
- Each prompt stops spending at its cap and reports what it got.

## Running all 9 prompts in parallel

- **Before launch (Otabek, five minutes, no AI):** push the `aptitude` branch scaffold. It's ready locally and contains:
  - the folders as npm workspaces;
  - `shared/types.ts`;
  - typecheck, format, test and build wired for every folder.
- **Then all 9 prompts on all 3 laptops start at the same time.** None waits on another:
  - each prompt owns its folders (the table above);
  - each codes against the entry-point types in `shared/types.ts`, using a local stub until the real module exists;
  - each adds its dependencies to its own folder's `package.json`, not the root.
- **Lockfile:** if `package-lock.json` conflicts in the morning, regenerate it with `npm install`.
- **Shared types:** `shared/types.ts` gets additive changes only overnight. Breaking changes are agreed in the morning.

## Git rules for every prompt

- Branch from `origin/aptitude` with `--no-track`, and open a draft PR into `aptitude`.
- Never push to `main` and never merge. The founders merge in the morning.
- Run typecheck, format, tests and build before each commit. Conventional commits, no AI attribution lines.

## How to run

On each laptop:

1. Open one Claude Code session per prompt and paste it as written.
2. Each prompt splits its work across subagents and keeps going until it's done or its cap is used.

---

## Otabek's laptop: the loop, the harness, self-learning

### O1: the end-to-end loop and the match agent

```text
Build Aptitude's end-to-end loop in a new folder orchestrator/. Add it to the workspaces, the tsconfig include, the vitest backend list and the format scripts. Read APTITUDE-PLAN.md and shared/types.ts on origin/aptitude, especially "AI-first".

Deliver:
- The match agent. Given ProviderChange[] and ApiUsage[], a Claude agent decides which changes touch which call sites, why, and how urgent each is, and outputs ranked MigrationTask[] with its reasoning. Do not write rule tables that decide relevance. Field and operation overlap may be passed to the agent as hints only.
- The loop: for an installed org, understand (inventory) → watch → match → runTask → open the PR → record the outcome in memory. Code against the entry-point types with stubs; the real modules land in other branches tonight.
- A CLI: `aptitude run --repo <path>` runs the whole loop on one local repo, with `--dry-run` stopping before the PR.
- A simple in-process queue with retries and concurrency, behind an interface a real queue can replace later.
- Update AGENTS.md and README.md for Aptitude, including the AI-first rule.

Test end to end with stubs, plus one real match run on fixtures, capped at $2.

Use subagents for the match agent, the loop and CLI, and the docs. Branch `aptitude/orchestrator`, draft PR into `aptitude`. Edit only orchestrator/, AGENTS.md, README.md and the root config lines that register orchestrator/. Never push to main. No AI attribution lines. AI spend cap: $2.
```

### O2: the harness agent

```text
Build Aptitude's migration agent in harness/. Read APTITUDE-PLAN.md and shared/types.ts on origin/aptitude, especially "AI-first" and "The harness system prompt".

Goal: runTask(task, repoDir) runs a Claude agent on the Claude Agent SDK and returns a RunRecord. Use model claude-sonnet-5-5, escalating to claude-opus-5-5 when it gets stuck. The agent works in a sandboxed copy of the repo.

Deliver:
- The structured system prompt from the plan, in harness/prompt.ts. Build it from the task, the provider ToolPack and retrieved recipes. Readable and versioned.
- A tool registry:
  - files, and a shell limited to the sandbox;
  - install with the repo's package manager;
  - tests, build and type check;
  - web and docs fetch;
  - the provider ToolPack and memory retrieval.
- The agent decides which tools to use. Tools return information and never block it.
- The sandbox: Docker on Linux CI. Locally without Docker, a temp copy with install scripts disabled. Untrusted code never runs on the host with scripts enabled.
- Before/after checks that count only new failures. The agent iterates on failures itself. Outcome: verified or needs-review, never stopped.
- A budget ledger with a hard run cap (APTITUDE_AI_BUDGET_USD) that every model call goes through.
- A PR body writer: change, why, proof, unproven, behaviour changes.
- The four hard limits from the plan, and NO other refusal or gating logic.

Test the loop with a fake model. Then ONE real run on one public dev repo with a small known change (a Stripe or OpenAI SDK repo you find), capped at $5. Report the diff and whether you'd merge it.

Use subagents for the sandbox, the tools, and the prompt and PR writer, then integrate. Branch `aptitude/harness`, draft PR into `aptitude`. Edit only harness/. Never push to main. No AI attribution lines. AI spend cap: $8.
```

### O3: self-learning memory

```text
Build Aptitude's self-learning in memory/. Read APTITUDE-PLAN.md and shared/types.ts on origin/aptitude, especially "AI-first".

Deliver:
- A run store: every RunRecord, its transcript and the human verdict, as local JSON for now, behind an interface that can move to Postgres.
- Recipe extraction: after a verified run, an AI pass distils the trajectory into a Recipe (preconditions, steps, pitfalls, a diff sketch), linked to its run.
- Retrieval: retrieveRecipes(task) returns the most relevant recipes, chosen by AI judgement and embeddings over provider, kind and code. Not a fixed keyword match. harness/prompt.ts injects them.
- Skill promotion: a recipe verified on 3+ different repos becomes a skill (a reusable prompt block or tool). A skill that fails twice after promotion is demoted.
- A nightly self-eval: rerun a small fixed set of past tasks with the current memory and report whether the verified rate moved.

Memory is guidance the agent reads, never a rule that blocks it. Unit-test with fixtures; real AI calls only for 3 extraction tests.

Use subagents per component. Branch `aptitude/memory`, draft PR into `aptitude`. Edit only memory/. Never push to main. No AI attribution lines. AI spend cap: $3.
```

---

## Pierce's laptop: the GitHub App, codebase understanding, the website

### P1: the GitHub App and install flow

```text
Build Aptitude's GitHub App in app/. Read APTITUDE-PLAN.md and shared/types.ts on origin/aptitude.

Deliver:
- An app manifest:
  - permissions: contents read/write, pull requests write, checks write, metadata read;
  - events: installation, installation_repositories, push, pull_request.
- A webhook server that verifies signatures and handles:
  - org install: list every repo and queue a codebase-understanding job;
  - repos added or removed;
  - push: queue a re-read;
  - pull_request merged or closed: send the human verdict to memory.
- An installation-token client and a PR opener (branch, commit, PR) that the harness calls.
- A local dev setup (smee or a tunnel) and docs for registering the app. Don't register it yourself; a founder does that with their own account.
- Secrets only from env. Never commit or print them.

Tests with recorded webhook payloads. No AI calls needed here.

Use subagents for the webhooks, the token client and PR opener, and the docs. Branch `aptitude/app`, draft PR into `aptitude`. Edit only app/. Never push to main. No AI attribution lines. AI spend: $0.
```

### P2: the codebase-understanding agent

```text
Build Aptitude's codebase-understanding agent in inventory/. Read APTITUDE-PLAN.md and shared/types.ts on origin/aptitude, especially "AI-first".

Goal: inventoryRepo(repoDir, repo) returns ApiUsage[]: every external API the repo talks to, found the way a new engineer would find it.

How:
- A Claude agent (Claude Agent SDK) reads the repo with file and search tools. It looks at dependencies, imports, HTTP and GraphQL calls, webhooks, config and env names. It works out:
  - which external APIs are used, including ones nobody listed in advance;
  - through what;
  - the pinned version and where it lives;
  - every call site, with what it sends;
  - what the code does with the response.
- Fast helpers make it cheaper, never smarter. Give the agent tools that list manifests and lockfiles, grep for imports and API hosts, and find GraphQL documents. The agent decides what to read; helpers never decide what counts as an API.
- Big repos: the agent maps the repo first, then reads the relevant areas in parallel subagents, then merges the results.
- Output: per-repo JSON plus a short human summary ("This repo uses Stripe for payments through stripe-node 14 in 12 places...").

Test on 10 public repos of different kinds that you pick, including at least two that use an API outside the big names. Hand-check 15 usages and report precision and anything missed.

Use subagents for the agent loop, the helper tools, and the evaluation. Branch `aptitude/inventory`, draft PR into `aptitude`. Edit only inventory/. Never push to main. No AI attribution lines. AI spend cap: $6.
```

### P3: rename the website to Aptitude, plus a dashboard skeleton

```text
Rename the website in src/ from Refit to Aptitude: copy, titles, metadata, logo text and links. Keep DESIGN.md's design system. Polish, don't redesign. Read APTITUDE-PLAN.md and AGENTS.md on origin/aptitude.

Update the site's story to the AI-first flow: install → Aptitude reads your code and understands every API you use → it watches them → it migrates and proves → you review the PR.

Then add a dashboard skeleton: org → repos → APIs each repo uses (the ApiUsage shape) → open migration tasks and PRs. Fixture data must be visibly labelled as an example. No invented customers or metrics.

Run typecheck, format, tests and build. Use subagents for the rename sweep and the dashboard. Branch `aptitude/website`, draft PR into `aptitude`. Edit only src/, public/ and index.html. Never push to main. No AI attribution lines. AI spend: $0.
```

---

## Furqan's laptop: provider knowledge, tools, evals

### F1: provider watchers that read changelogs

```text
Build Aptitude's provider watchers in providers/. Read APTITUDE-PLAN.md and shared/types.ts on origin/aptitude, especially "AI-first".

For each of Stripe, Shopify, Meta Graph, OpenAI and Twilio, build providers/<name>/ with:
- watcher.ts: an AI agent reads the provider's changelog, release notes, SDK releases and deprecation pages, and writes ProviderChange[]. Each change gets a MigrationKind, the affected operations and fields, an effective date, and an exact source quote. Fetching and spec diffs (OpenAPI, the GraphQL schema) are inputs the agent can use, not the classifier.
- knowledge.json: supported versions, retirement dates, docs URLs and SDK packages. The agent drafts it from the docs; every entry carries its source and date.
- A shared interface, so a new provider is a folder plus a short prompt. Show it by adding a sixth provider of your choice with no new code.

Test each watcher on saved fixtures, plus one live read per provider.

Use one subagent per provider. Branch `aptitude/providers`, draft PR into `aptitude`. Edit only providers/ (not providers/*/tools.ts or providers/*/playbooks/, which F2 owns). Never push to main. No AI attribution lines. AI spend cap: $5.
```

### F2: provider tool packs and playbooks

```text
Build each provider's ToolPack in providers/<name>/tools.ts and providers/<name>/playbooks/. Read APTITUDE-PLAN.md and shared/types.ts on origin/aptitude, especially "AI-first".

Tools are helpers the agent may call to check itself. They return information and never block:
- **Shopify:** validate a GraphQL document against a version's Admin schema; look up the REST-to-GraphQL mapping.
- **Stripe:** API version info; check params against the OpenAPI spec at a version.
- **Meta:** look up fields and edges in the version change table.
- **OpenAI:** model retirement and replacement lookup; request-shape check.
- **Twilio:** endpoint and version lookup.
- **Every provider:** searchDocs(provider, query), returning relevant docs passages.

Playbooks: one short markdown per MigrationKind per provider, drafted by AI from the provider docs with links, then reviewed by you. Each covers what usually changes, how to spot it in code, what to check, and common pitfalls. Write them as advice to a smart engineer, not rules.

Unit-test every tool. Use one subagent per provider. Branch `aptitude/toolpacks`, draft PR into `aptitude`. Edit only providers/*/tools.ts and providers/*/playbooks/. Never push to main. No AI attribution lines. AI spend cap: $3.
```

### F3: evals and the benchmark harness

```text
Build Aptitude's evals in evals/. Read APTITUDE-PLAN.md and shared/types.ts on origin/aptitude.

Deliver:
- Repo sets: recover the frozen Refit repo lists from git history as data only (`git log --all -- 'subsets/*.json' 'docs/benchmarks/*-repos.json'`). Recover the dev sets (shopify-dev-60, meta-dev-60, the Stripe dev lists). Keep the blind sets frozen and unopened; record only their paths and hashes.
- A runner: understand → match → harness → score, one repo per GitHub Actions shard. Concurrency and a dollar cap are required inputs; it refuses to start without an explicit cap.
- Scoring:
  - verified, needs-review and not-affected rates;
  - cost per repo;
  - an "attempted" rate, which must be 100%: any task that ended without an attempt is a bug;
  - a hand-check log (evals/reviews.json) for every verified PR.
- An AI reviewer as a second opinion on each PR. It is advisory only and never changes the grade.
- A one-command local smoke test on 3 dev repos with a fake model.

Do not run a real benchmark tonight; the founders approve the first one with a budget.

Use subagents for the repo-set recovery, the runner and the scoring. Branch `aptitude/evals`, draft PR into `aptitude`. Edit only evals/. Never push to main. No AI attribution lines. AI spend: $0.
```

---

## Morning checklist (founders)

1. Review the draft PRs into `aptitude`. For each one, check the AI-first rule: reject any new rule that stops or skips a task.
2. Merge in this order:
   1. F1 providers;
   2. F2 tool packs;
   3. P2 inventory;
   4. O3 memory;
   5. O2 harness;
   6. O1 orchestrator;
   7. P1 app;
   8. P3 website;
   9. F3 evals.
3. Regenerate the lockfile if needed, then run F3's smoke test end to end.
4. Approve a budget for the first real dev benchmark (suggestion: 20 repos, $40), and read the hand-checks before trusting any number.
5. Register the Aptitude GitHub App and install it on a test org first.
