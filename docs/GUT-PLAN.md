# Gutting Refit's deterministic engine

Written 2026-10-31. Founder decision: Refit's goal changes from "never be wrong" to "get the migration done, with as much AI as possible, and prove it".

## Why

- On the blind sets, Shopify validated 0 of 100 and Meta 6 of 100.
- About 3 in 4 repos stopped at a rule before any fix was attempted, and the AI was mostly told to decline.
- On 5 stuck Shopify dev repos, Refit validated 0. Raw Claude, given the repo and Refit's checker errors, cleared 2 or 3 of the 5 for $3.93 (2026-10-31).

## The new rule

AI does everything except grade its own work.

| Stage     | Who does it                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| Watch     | Changelogs, versions and deadlines kept as checked data, quoted from the docs |
| Find      | Deterministic tracing first, AI for anything it can't read                    |
| Fix       | Codemods first as a free head start, then a Claude agent working in the repo  |
| Judge     | Deterministic checks only (below)                                             |
| Feed back | Every failed check goes back to the agent with the exact error                |
| Ship      | A validated PR, a needs-review PR, or nothing to fix                          |

Judge checks:

- the provider schema or contract (Shopify GraphQL schema, Shopify REST contract, Meta change tables);
- type check, build and tests, run before and after the change, counting only new failures;
- a live call against the Shopify dev store or the Meta test app, where one is available.

**There are no stops.** Every repo ends in exactly one of these:

- **`validated`** — the checks pass at proof level A–C.
- **`needs-review`** — a patch exists, and the PR says exactly what is unproven or what behaviour changes.
- **`no-change`** — the repo isn't affected.
- **`infrastructure`** — clone or sandbox failure only.

## Keep

- **Judges:**
  - `pipeline/shopify-schemas*`
  - the REST contract (`data/shopify-rest-contract.json` and its prover)
  - Meta change tables
  - the validation sandbox
  - live proof (#435)
  - the proof levels A–D
- **Provider data:** `data/deadlines.json`, rules quoted from docs, schemas and changelogs. This data is what the agent is told about the change.
- **Finders:** tracing and pin detection.
- **Codemods:** the SDK upgrade codemods (#434) and rule edits, run first as a head start.
- **Plumbing:** PR writing, the budget ledger and the Anthropic backend (#431).
- **Benchmarking:**
  - refit-bench
  - frozen dev and blind sets
  - `docs/benchmarks/fix-reviews.json`, with every new validated row still hand-checked

## Gut

- **Every stop and refusal rule.** Each one becomes a hand-off to the agent fixer, with the stop's reason and findings as context. Examples:
  - "SDK upgrade is a separate change"
  - "already fails, fix it first"
  - "can't read the document"
  - "can't prove this REST call"
  - "no single pinned version"
- **Hand-written long-tail fix logic** that the agent fixer replaces.
- **Single-shot structured AI calls** (`requestStructuredOutput` used as "fix this snippet or decline"). Keep that function only where it is a narrow extraction for a judge.
- **Config, docs and tests** that only serve deleted code.

## Agent fixer interface

Every pipeline codes against this interface, in `pipeline/agent-fix.ts`:

```ts
export type AgentFixInput = {
  repoDir: string; // sandbox copy; the agent edits it in place
  provider: 'shopify' | 'meta-graph' | 'stripe';
  target: string; // e.g. Admin API '2026-10', Graph 'v24.0'
  change: string; // what changed, quoted from Refit's provider data
  context: string; // the old stop's reason and findings, files and lines
  check: (repoDir: string) => Promise<{ passed: boolean; errors: string[] }>; // deterministic judge
  attempts?: number; // best-of-N, default 3
  rounds?: number; // feedback rounds per attempt, default 3
};
export type AgentFixResult = {
  outcome: 'passed' | 'unproven' | 'no-change' | 'failed';
  diff: string;
  errors: string[]; // remaining judge errors when not passed
  summary: string; // what the agent changed, what it could not verify, behaviour changes
  costUsd: number;
};
export async function fixWithAgent(input: AgentFixInput): Promise<AgentFixResult>;
```

How it runs:

- Claude (`claude-sonnet-5-5`, escalating to `claude-opus-5-5`) runs through the Claude Agent SDK or the `claude` CLI in headless mode.
- It has the repo, file tools, installs, `tsc`, and the provider's docs domain.
- Attempts run in parallel. The attempt with the fewest judge errors wins.
- Spend goes into the existing budget ledger.

## Waves

- **Wave 1:**
  - GUT0: the base branch `refit/gut`, which is `bench/iter1-shopify-meta` + #434 + this plan.
  - GUT-INV: an inventory of every stop, gate, fixer and AI call site.
- **Wave 2,** in parallel and owning separate files:

  | Agent | Work                                                                                                                                                                                             | Owns                                                          |
  | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
  | GUT1  | The agent fixer core                                                                                                                                                                             | `pipeline/agent-fix*.ts`                                      |
  | GUT2  | Shopify: every stop becomes the agent fixer, and replaced fix logic is deleted                                                                                                                   | `pipeline/shopify-pipeline.ts` and the Shopify fixers         |
  | GUT3  | Meta: the same                                                                                                                                                                                   | `pipeline/meta-graph-*.ts`                                    |
  | GUT4  | The Shopify judge's blind spots: the installed-SDK `LATEST_API_VERSION`, AI extraction of unreadable documents and computed REST URLs for deterministic validation, and the live call as a judge | Shopify schema, tracing, REST-contract and live-proof modules |
  | GUT5  | The sandbox on refit-bench: install scripts in the container, the agent runtime available, and the before/after type check, build and tests                                                      | the `validation-*` modules and the refit-bench workflows      |

- **Wave 3:**
  - delete leftovers;
  - Stripe gets the same treatment;
  - head-to-head on Shopify dev-60 and meta-dev-60 against the recorded old-engine numbers;
  - then each blind-100 once.

## Rules for every agent

- Branch from `refit/gut` with `--no-track`. Open draft PRs into `refit/gut`. Never merge to main and never push to main.
- Never open the blind sets: `subsets/shopify-blind-100.json`, `subsets/meta-blind-100.json`, `progress-30`.
- Run typecheck, format, tests and build before each commit. Use conventional commits, with no AI attribution lines.
- Never print keys. Untrusted repo code runs only in the sandbox or on refit-bench, never on a developer machine with scripts enabled.
- Measure the validated percentage end to end, and hand-check every new validated row.
