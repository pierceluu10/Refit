# Phase 3: Application benchmark sets - Context

**Gathered:** 2026-10-21
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase freezes two benchmark sets of real application repositories, 100 that declare `openai` and 50 that declare `@anthropic-ai/sdk`, chosen through GitHub code search with a reproducible script. It also labels every live retiring-model pin in those sets in one AI-assisted pass. Phase 4 runs the benchmark against them. The 2026-10-20 npm sets stay unchanged and become library baselines. This phase changes no code in `pipeline/`.

</domain>

<decisions>
## Implementation Decisions

### Selection (BENCH-01)
- **D-01:** A new script, `scripts/ai-app-select.mjs`, runs GitHub code search through `gh api` with the user's existing `gh` login. It never prints or stores a token, and its options mirror `scripts/ai-sdk-select.mjs`. The queries look for `package.json` files that declare the SDK (`"openai"` / `"@anthropic-ai/sdk"` in dependencies) and for source files that import it. The exact queries, the run date, every filter and the sort order are recorded in the frozen file.
- **D-02:** A repository counts as an application only if all of these hold:
  - It is not a fork and not archived.
  - It was pushed on or after 2025-10-21.
  - Its root or workspace `package.json` is `"private": true`, or it has no `main`/`exports`/`bin`/`files` publish fields, or it has app markers: `next.config.*`, `vite.config.*`, `app/`/`pages/` routes, a server entry with `express`/`fastify`/`hono`/`koa`, or `wrangler.toml`.
  - At least one non-test source file imports the SDK and makes a model call (`chat.completions`, `responses`, `messages`, `images`, `audio`, `embeddings`).
  - The repository passes Refit's scan limits (`readRepository`).
  - It is not an SDK, wrapper or framework package. Exclude names or topics matching `sdk|wrapper|client|langchain|llamaindex|provider|plugin|adapter|framework|boilerplate-generator`, plus repositories already in any frozen list.
- **D-03:** Exposure is not used to select repositories, because that would bias the fix rate. Each entry instead records `hasChecks` (a `test`/`typecheck`/`build` script exists) and `manager` (npm, pnpm or yarn), so Phase 4 can report "of those with runnable checks".
- **D-04:** Order is deterministic: candidates are sorted by stars descending, ties broken by full name, and the first 100 (OpenAI) and 50 (Anthropic) that pass are taken. A repository can be in both sets. Each entry records owner/repo, the default-branch commit SHA at selection time, stars, pushedAt, and the reason it qualified.
- **D-05:** Outputs are `docs/benchmarks/2026-10-21-openai-app-repos.json` and `docs/benchmarks/2026-10-21-anthropic-app-repos.json`, in the same shape as the 2026-10-20 lists plus the new fields. The 2026-10-20 list files are marked as library baselines with a note in `docs/BENCHMARKS.md`; their contents are not edited.
- **D-06:** If code search cannot yield enough qualifying repositories, freeze what qualifies and record the shortfall. Never loosen D-02 silently.

### Labels (BENCH-02)
- **D-07:** Labels are a single AI-assisted pass, stated as such in the labels file and in the docs. Candidates come from an independent grep for exact registry model IDs (`data/deadlines.json`, models with `kind: model`) inside quotes, in non-`node_modules` files at the frozen commit. They must NOT come from Refit's scanner or tracer output, so the traced fraction is not circular.
- **D-08:** For each candidate the labeler reads the surrounding code and records:
  - `file`, `line`, `model`
  - `live`: true when the value can be sent to an OpenAI or Anthropic API request at runtime
  - `via`: `sdk-text`, `sdk-non-text`, `raw-http`, `wrapper:<package>` (Vercel AI SDK, LangChain…) or `other`
  - `replacement`: the correct registry replacement, followed through chains
  - `notes`: one line
  Non-live candidates (catalogs, tests, comments, comparisons, docs) are labelled `live: false` with a reason class.
- **D-09:** Output is `docs/benchmarks/2026-10-21-ai-app-labels.json`: per repository and commit, plus a header stating the method (an independent grep plus one AI-assisted reading pass, not hand labelling), the date and the registry `checkedAt`.
- **D-10:** Cloning follows the existing benchmark pattern: shallow fetch at the frozen commit into a scratch root outside the repository. Files are only read. Nothing in the fetched repositories is installed or run.

### Resolutions after research (2026-10-21)
- **D-11:** Workspaces are included. Besides the root `package.json`, one level of `apps/*` and `packages/*` manifests is read through the trees API, and a repository qualifies when any of those manifests declares the SDK in `dependencies`. Deeper nesting is skipped, and the skip is recorded.
- **D-12:** Recency is judged by the frozen commit's `committedDate` (on or after 2025-10-21), not by the repository-level `pushedAt`. Both dates are recorded.
- **D-13:** Search mechanics: `filename:package.json extension:json path:/`, with `size:` buckets as the splitter, and no more than 10 search calls a minute with backoff on 403/429. Metadata comes through GraphQL in batches of 20, and scan limits are checked with one trees call per repository. The model-call check runs lazily on shallow checkouts, in stars order, and stops at N. Results are cached so a run can resume.
- **D-14:** Helper tests may live under `pipeline/` (for example `pipeline/ai-app-select.test.ts`), following the `ai-model-benchmark-summary` precedent. No production code under `pipeline/` changes.
- **D-15:** Label quality check: a separate subagent re-labels a random 10% sample of candidates (seeded, the seed recorded), without seeing the first labels. Agreement on `live` and `via` is reported in the labels header. Disagreements are adjudicated by reading the code again, and the adjudication is recorded. The method statement in the header stays "a single AI-assisted pass with a 10% independent re-read", never "hand-labelled".
- **D-16:** The labels file commits no code text, only names, SHAs, paths, lines, models and classifications. Repository names and paths are validated before they reach any shell command (no injection, no traversal).

- **D-17 (plan check, 2026-10-21):** Both the first labelling pass and the 10% re-read are done by fresh-context subagents that the orchestrator launches. Each one receives only its batch or sample plus the rules. Executors extract, merge and score, but never label. This keeps the re-read blind to the first labels by construction.
- **D-18:** No cap on candidates. Every candidate gets exactly one label, and a missing batch is re-dispatched.
- **D-19:** Search `size:` buckets use exclusive upper bounds, and the pool is de-duplicated by lower-cased `full_name` before ranking.
- **D-20:** The candidate grep covers every text file except `node_modules/`, `.git/`, lockfiles, binaries and files over 2 MiB. Each candidate records `language` and `generated` (for build output). Phase 4 reports BENCH-04 over JS/TS live pins as the headline and over all live pins as a secondary figure.
- **D-21:** The candidate and batch JSON schemas are fixed in the plan text.

### Claude's Discretion
- How labelling is batched across subagents, and how the 150 checkouts are cached.
- Small extra exclusion rules, provided each is recorded in the frozen file.

</decisions>

<code_context>
## Existing Code Insights

- `scripts/ai-sdk-select.mjs` (the npm-based 2026-10-20 selector) and `scripts/ai-model-benchmark.mjs` (checkout and run) are the analogs to follow.
- `scripts/paypal-select.mjs` and `scripts/stripe-active-select.mjs` may already use GitHub search; reuse their patterns.
- `docs/BENCHMARKS.md` consolidates the frozen sets.

</code_context>

<specifics>
## Specific Ideas

- Verified on 2026-10-21: `gh api search/code` works with the user's login. A query for `"@anthropic-ai/sdk" filename:package.json` returned 78,848 hits.
- Code search returns at most 1,000 results per query. Split queries (by `path:`, by `language`, or by additional terms such as `next` or `express`) to reach enough application candidates.

</specifics>

<deferred>
## Deferred Ideas

- Tracers for wrapper libraries. Their volume is measured through the `via: wrapper:*` labels first.

</deferred>
