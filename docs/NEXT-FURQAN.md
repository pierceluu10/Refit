# Refit round 2: Furqan's laptop (F4, F5, F6)

> **Update, 2026-11-02:** every other round 2 PR is merged into `main` (#470–#477). Start each worktree from the current `origin/main`. `anyProviderWatcher` and `loadToolPack` still come from `orchestrator/stubs.ts`: when F4's or F5's real function exists, that session swaps it into `orchestrator/deps.ts` itself (one import each) and deletes its stub. F6 uses the real `anyProviderWatcher` if F4 is ready, and otherwise keeps it injectable.

**Furqan, before you paste this:**

1. Open Claude Code in your clone of `pierceluu10/Refit`, on **Opus 5.5 at max effort**, in **auto** permission mode, so it never stops to ask you anything.
2. Make sure `ANTHROPIC_API_KEY` is exported in your shell profile, `gh auth status` passes and Docker is running.
3. Plug the laptop in, paste this whole file as one message and leave it. When it's done you'll have three draft PRs and `ROUND2-FURQAN.md` in the repo root.

## Coordinator: the session this file is pasted into

You run Furqan's three round 2 sessions, F4, F5 and F6, until each has a draft PR. Don't ask Furqan anything: decide, note the decision in a PR body or your report, and keep going.

1. **Check the setup.** Fetch `origin` and confirm `origin/main` contains `1e85a07d` (#469 and #470). Check `gh auth status`, `docker info`, Node 24 or later, and that `ANTHROPIC_API_KEY` is set, without printing it. Fix what you can. If the key or Docker is missing, the sessions still do their $0 work and say in their PR bodies which real runs they couldn't make. On macOS, keep the machine awake with `caffeinate -dims -t 21600` in the background.
2. **Save the brief.** Write everything from `## The brief` to the end of this file, unchanged, to `docs/NEXT-FURQAN.md`.
3. **Start the sessions.** Start three separate Claude Code sessions, one each for F4, F5 and F6, each in its own git worktree from `origin/main`, on Opus 5.5 at max effort, in auto permission mode. If you can't start sessions, use three background subagents, each in its own worktree. Give each this prompt, with its own name:

   > Read `docs/NEXT-FURQAN.md` in full and follow it. You are F4. Work on your own for about 4 hours: your deliverables first, then your stretch goals. Never ask the user anything: decide, note the decision in your PR body, and keep going. If you're truly blocked, message the session that started you. Finish with a draft PR into `main`, then reply with its link, your AI spend, and what's done and what isn't.

4. **Keep them going.** Whenever a session reports or stops, check its branch and PR yourself rather than trusting the report.
   - If it stopped with deliverables left, send it the next one.
   - If its deliverables are done and time is left, point it at its stretch goals.
   - Answer its questions from the brief's rules.
   - If it's stuck (the same failure again and again, or no new commit for an hour), stop it and start a fresh session with what's left.
   - Stop a session whose AI spend has reached its cap.
   - At about 4 hours, tell any session still working to commit, push and open its draft PR with what it has.
5. **Check the work.** For each branch: the four checks pass, the diff stays inside the folders its section lists, and no commit or PR has a `Co-Authored-By` line, a "Generated with" line or a secret. Then merge the three branches onto `origin/main` in a throwaway worktree and run the four checks there. Don't push that merge; record the result.
6. **Report and stop.** Write `ROUND2-FURQAN.md` in the repo root and never commit it. Include each PR link, what works as you checked it, what's stubbed and who wires it, the AI each session spent, any AI-first exception, the test-merge result and what should happen next.

Never merge a PR, never push to `main`, and leave the founders' steps at the end of the brief to the founders.

## The brief

Three sessions run on this laptop, F4, F5 and F6, each in its own git worktree, on Opus 5.5 at max effort. Each does only its own section, follows the shared rules and contracts, and works for about 4 hours: its deliverables first, then its stretch goals.

Sessions with a real-AI cap above $0 need `ANTHROPIC_API_KEY` and `REFIT_AI_BUDGET_USD=<cap>` in their environment.

| Session | Work                                   | Branch        | Real-AI cap |
| ------- | -------------------------------------- | ------------- | ----------- |
| F4      | Watch any provider the inventory finds | `r2/watchers` | $4          |
| F5      | Tools and playbooks for any provider   | `r2/toolkit`  | $1          |
| F6      | Evals: the first real benchmark        | `r2/evals`    | $8          |

Caps across all three laptops: $34 (Otabek $16, Pierce $5, Furqan $13).

## Where things stand (2026-11-01)

- `main` has all of Refit: the nine overnight PRs (#457 to #465), the wiring that connects them (#466), the benchmark-runner fix (#468), Pierce's loop-budget fixes (#469) and this round's contract types (#470).
- With `ANTHROPIC_API_KEY` set, the loop runs on the real parts under one run budget. Without it, offline stubs stand in.
- The GitHub App (ID 5275879) is now **Refit Agent** (`refit-agent`, owned by `refit-dev`) and is installed on a test org. On 2026-11-01 it had no event subscriptions and no Checks permission, though `app/SETUP.md` asks for both; `gh api apps/refit-agent` shows what it has now.
- Typecheck, format check, tests and build pass. The CLI runs offline end to end, and the evals smoke test passes at $0.
- **Nothing is proven on real repos yet.** No benchmark has run. Pierce's 3-repo dev run on 2026-11-01 got 0 verified and 3 needs-review with empty diffs, at about $3.75 a repo. #469 fixed the four causes it found:
  - The six changelog reads cost about $2.60. They're now cached for the UTC day, and `refit run` takes several `--repo` flags.
  - The harness keeps a $1 reserve under its cap (`TURN_RESERVE_USD`), and a task starts only with $2 of the run left (`MIN_TASK_USD`). Below that it is recorded as `failed`, "not attempted".
  - A failed match marks its changes `failed` instead of running the harness on every one.
  - A harness run with no edit and no report is `failed`, not needs-review.
- **Known gaps, which are this round's work:**
  - The app doesn't run the loop, and the loop's PR step is a stand-in.
  - Human verdicts on PRs don't reach memory.
  - Only six providers have changelog watchers and five have tool packs, so the Anthropic and Gemini eval sets can't run.
  - AI calls run one at a time to protect the cap.
  - The dashboard shows example data.
  - The evals reviewer has no real model client.

## Rules for every session

1. Read `REFIT-PLAN.md` (especially "AI-first") and `AGENTS.md` on `origin/main` before you start.
2. **AI-first.** The model reads, decides and edits. Code gives it tools, context and checks, never gates. Every task ends in a PR or a "not affected" verdict with reasons, never a silent stop. When the agent is unsure, it tries anyway and says so in the PR.
3. **Reject these in your own work:**
   - a rule that decides whether a repo, file or change is "supported";
   - any branch that ends a task without an attempt;
   - a fixed list of provider names or patterns as the only way to find or watch an API;
   - a model call shaped as "answer yes or no, decline if unsure";
   - cautious defaults that make the agent do less.
4. **Hard limits, enforced in code:**
   - Untrusted repo code runs only in the sandbox, with install scripts off.
   - A run-level dollar cap.
   - PRs only: never push to a default branch, never merge.
   - Never print or commit secrets. Read env templates (`.env.example` and the like) only, never a real `.env`, `.env.*` or `.envrc`.
5. **Git:**
   - Branch from `origin/main` with `--no-track`, using the name in your section, and open a draft PR into `main`.
   - Never push to `main`, never merge.
   - Use conventional commits. No AI attribution lines anywhere: no `Co-Authored-By`, no "Generated with".
6. Before every commit, run `npm run typecheck`, `npm run format:check`, `npm test` and `npm run build`.
7. **Folders:** edit only the folders your section lists. Add dependencies to your folder's `package.json`, never the root. If `package-lock.json` conflicts, regenerate it with `npm install --ignore-scripts`.
8. **AI spend:**
   - Stop spending at your cap and report what you got.
   - Real runs use repos from `evals/sets/dev/` or public repos you pick, never the sealed sets.
   - Only F6 runs a benchmark.
9. **Honest numbers:** don't invent customers, metrics or passing checks. Label example data as examples, and hand-check before you trust a number.
10. **Subagents:** split your work across subagents; your main session plans, integrates and checks.
11. **Your PR body says:**
    - what works;
    - what's stubbed, and who wires it after merging;
    - the AI you spent;
    - any AI-first exception;
    - what you'd do next.

## Contracts between sessions

All nine sessions start at once and none waits on another. Each codes against these contracts and uses a local stub until the owner's PR merges.

**1. Shared types.** These are on `main` (#470): the block below ends `shared/types.ts`, and `ApiUsage` ends with `hints?: ProviderHints;`. Don't edit them; propose changes in your PR body.

```ts
// Round 2 contracts (2026-11-01). Additive only.

// Opens the PR for one finished task and returns its URL. The app implements it (P4).
export type OpenPullRequest = (
  task: MigrationTask,
  record: RunRecord,
  repoDir: string,
) => Promise<string>;

// Runs the whole loop on one checked-out repo. The orchestrator implements it (O4); the app calls it (P4).
export type RunRepoJob = (input: {
  repo: string; // owner/name
  dir: string; // a fresh checkout to read; repo code never runs on the host
  openPullRequest: OpenPullRequest;
  dryRun?: boolean; // stop before opening PRs
}) => Promise<RunRecord[]>;

// Where to look for a provider's changes. The inventory fills it (P5); the watchers read it (F4).
export type ProviderHints = { packages?: string[]; hosts?: string[]; docsUrls?: string[] };

// One run as the dashboard shows it. Memory produces it (O6), the app serves it (P4), the site renders it (P6).
export type RunView = {
  id: string;
  repo: string;
  taskId: string;
  provider: string;
  changeId: string;
  outcome: RunRecord['outcome'];
  pr?: string;
  costUsd: number;
  summary: string; // one line: what changed, or why nothing did
  finishedAt: string;
};
```

**2. Entry points.**

| Contract                                                                           | Where                                 | Owner | Used by |
| ---------------------------------------------------------------------------------- | ------------------------------------- | ----- | ------- |
| `runRepoJob: RunRepoJob`                                                           | `orchestrator/index.ts` (new)         | O4    | P4      |
| `chargeRun?: (usd: number, label: string) => void` on `HarnessDeps`                | `harness/types.ts`                    | O5    | O4      |
| `listRunViews(filter?: { repo?: string; limit?: number }): Promise<RunView[]>`     | `memory/index.ts`                     | O6    | P4      |
| `recordVerdict(prUrl, verdict)` (exists)                                           | `memory/index.ts`                     | O6    | P4      |
| `GET /api/runs` returning `RunView[]`                                              | the app's server                      | P4    | P6      |
| `ApiUsage.hints` filled from code and config                                       | `inventory/`                          | P5    | F4, O4  |
| `anyProviderWatcher(provider: string, hints: ProviderHints, deps?): WatchProvider` | `providers/core/any-watcher.ts` (new) | F4    | O4, F6  |
| `loadToolPack(provider: string): Promise<ToolPack>`                                | `providers/toolkit/pack.ts` (new)     | F5    | O4      |

---

## F4: watch any provider the inventory finds

**Branch** `r2/watchers`. **Folders** `providers/core/` (including the new `any-watcher.ts`). **Real-AI cap** $4.

**Goal:** watching isn't limited to the six provider folders. This is the biggest Refit-style trap left.

**Deliver:**

1. **`anyProviderWatcher(provider, hints, deps?)`**, returning a `WatchProvider`. An agent finds the provider's changelog, deprecation and release-note pages from the hints and the web, and reads them with the page tools in `providers/core/page-tools.ts`. It writes `ProviderChange[]` with exact source quotes, like the folder watchers. When a provider folder exists, it uses that folder's prompt and knowledge as a head start. Done when tests on saved pages produce quoted changes for a provider with no folder.
2. **SDK releases.** For each package in the hints, read its registry (npm or PyPI) and the release notes of every major version. Each breaking major release becomes an `sdk-major` change, with the versions it applies to in `affects.versions`, so the match agent can compare them with the version a repo pins.
3. **Live reads** within your cap on 3 providers with no folder: Anthropic and Gemini, which unblocks their eval sets, plus one smaller API you pick. Save them as fixtures.

**Stretch:**

- The six folder watchers use the same page-discovery step, so a new provider folder needs only a prompt and hints.

**Not yours:** tool packs and playbooks (F5), the loop and `deps.ts` (O4).

## F5: tools and playbooks for any provider

**Branch** `r2/toolkit`. **Folders** `providers/toolkit/` (including the new `pack.ts` and `playbooks/`). **Real-AI cap** $1.

**Goal:** a provider without its own tool pack still gets useful tools and guidance.

**Deliver:**

1. **Generic tools**, building on what's already in `providers/toolkit/` (`searchDocs`, `fetch`, `graphql`). They return information and never block:
   - search the provider's fetched docs pages;
   - look up a package on npm or PyPI: versions, release notes, deprecations;
   - fetch and check against an OpenAPI spec or GraphQL schema when its URL is known;
   - fetch a changelog page.
2. **`loadToolPack(provider)`** in `providers/toolkit/pack.ts`: the provider's own pack plus the generic tools. An unknown provider gets the generic pack.
3. **Generic playbooks**, one per `MigrationKind`, in `providers/toolkit/playbooks/`. Write them as advice for any provider, not rules.
4. **Tests:** unit-test every tool with recorded responses.

**Stretch:**

- The five existing packs reuse the generic tools where they duplicate them.

**Not yours:** `orchestrator/deps.ts` (O4 wires `loadToolPack` after merging), the watchers (F4).

## F6: evals: the first real benchmark

**Branch** `r2/evals`. **Folders** `evals/`. **Real-AI cap** $8.

**Goal:** the first honest numbers on real repos.

**Deliver:**

1. **A real reviewer client.** Implement `ModelClient` in `evals/reviewer/model.ts` with the Anthropic SDK, charging the run's meter. It stays advisory.
2. **The first real benchmark, on current `main`.** First, make the runner count a task the run can't afford as unrun: since #469, `deps.runTask` returns a `failed` record with an empty diff when less than `MIN_TASK_USD` ($2) of the run is left, and scoring counts that as an attempt bug. Then run `stripe-dev-30` and `openai-dev-30` with `--budget-usd 4 --concurrency 1` each; each run stops when its cap is spent. Then:
   - Hand-check every verified and needs-review PR in `evals/reviews.json`.
   - Write `evals/reports/2026-11-01.md` with the rates, the cost per repo, and what failed and why. Include no number you didn't measure.
3. **A long-tail dev set**, `evals/sets/dev/longtail-dev-20.json`: 20 public repos that use smaller providers, raw HTTP, GraphQL or webhooks. Pin each to a commit with a pending change you checked by hand. Never open the sealed sets.
4. **Ready for F4.** Today the runner stops a provider with no folder before any spend. Let it take a watcher for those providers as an injected dependency, so wiring `anyProviderWatcher` after F4 merges is one line. Then the Anthropic, Gemini and long-tail sets can run.

**Stretch:**

- Each repo's cost broken down by part (inventory, watch, match, harness), from the meter's labels.

**Not yours:** the watchers (F4), the harness (O5).

---

## When everyone is done (founders)

1. **Merge producers before consumers:** F5, F4, P5, O5, O6, O4, P4, P6, F6. Regenerate `package-lock.json` with `npm install --ignore-scripts` when it conflicts.
2. **Wire the stubs.** Each owner does it in one follow-up PR after the merges:
   - **O4:** in the orchestrator, pass the harness `chargeRun` (and stop charging `record.costUsd` a second time), and use `anyProviderWatcher` and `loadToolPack`.
   - **P4:** in the app, use `runRepoJob` and `listRunViews`.
   - **F6:** in the evals runner, use `anyProviderWatcher` so the Anthropic and Gemini sets run.
3. **Check `main`:** run the four checks, the offline CLI and the evals smoke test on a clean checkout. Then read F6's report and hand-checks before deciding the next benchmark.
