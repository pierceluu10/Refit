# Phase 3: Application benchmark sets - Research

**Researched:** 2026-10-21
**Domain:** Reproducible GitHub code-search selection of application repositories, plus an AI-assisted model-pin labelling pass (Node ESM scripts, no `pipeline/` changes)
**Confidence:** MEDIUM (yield figures come from 30-repository samples per query; everything else was read or run this session)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
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
- **D-07:** Labels are a single AI-assisted pass, stated as such in the labels file and in the docs. Candidates come from an independent grep for exact registry model IDs (`data/deadlines.json`, models with `kind: model`) inside quotes, in non-`node_modules` files at the frozen commit. They must NOT come from Refit's scanner or tracer output, so the traced fraction is not circular.
- **D-08:** For each candidate the labeler reads the surrounding code and records `file`, `line`, `model`; `live` (true when the value can be sent to an OpenAI or Anthropic API request at runtime); `via` (`sdk-text`, `sdk-non-text`, `raw-http`, `wrapper:<package>` or `other`); `replacement` (the correct registry replacement, followed through chains); `notes` (one line). Non-live candidates (catalogs, tests, comments, comparisons, docs) are labelled `live: false` with a reason class.
- **D-09:** Output is `docs/benchmarks/2026-10-21-ai-app-labels.json`: per repository and commit, plus a header stating the method (an independent grep plus one AI-assisted reading pass, not hand labelling), the date and the registry `checkedAt`.
- **D-10:** Cloning follows the existing benchmark pattern: shallow fetch at the frozen commit into a scratch root outside the repository. Files are only read. Nothing in the fetched repositories is installed or run.

### Claude's Discretion
- How labelling is batched across subagents, and how the 150 checkouts are cached.
- Small extra exclusion rules, provided each is recorded in the frozen file.

### Deferred Ideas (OUT OF SCOPE)
- Tracers for wrapper libraries. Their volume is measured through the `via: wrapper:*` labels first.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BENCH-01 | Frozen set of 100 OpenAI + 50 Anthropic application repos from GitHub code search with a documented, reproducible selection script; npm sets kept as library baselines | Sections "Code search reality check", "Filter cost", "Recommended script design" |
| BENCH-02 | Every live model pin on the new sets labelled in a single AI-assisted pass with file, line, replacement, documented as AI-assisted | Sections "Label pass design", "Candidate extraction", "Batching" |
</phase_requirements>

## Project Constraints (from AGENTS.md and ~/.claude/CLAUDE.md)

- No AI attribution anywhere (commits, docs, comments). No Co-Authored-By trailers. Conventional commits.
- Never print or store a token. Never run a live vendor operation or paid model evaluation unless the task authorizes it (the label pass is subagent reading, not a Refit AI run; the OpenAI-key memory applies to AI runs only).
- Open PRs / push branches only when the user asks.
- `npm test` after JS/TS changes; run format check (`prettier --check ... scripts ...`, `package.json:23`) because `scripts` is in the formatted set. Report what actually passed.
- Frozen lockfile fixtures stay byte-exact; `docs/benchmarks/*.json` is not in `.prettierignore` (only 5 lines, none mention benchmarks) [VERIFIED: grep -n benchmarks .prettierignore returned nothing], so write the frozen files with `JSON.stringify(x, null, 2)` exactly like `scripts/ai-sdk-select.mjs` and format-check is a no-op for `docs/` (the format script covers `src pipeline bin scripts ...`, not `docs`).
- Hard-coded data needs a source and date comment (the query list, the cut-off date 2025-10-21).
- Update `docs/BENCHMARKS.md`, `docs/READINESS.md` honestly; do not claim traced/validated numbers in this phase (Phase 4 measures them).
- No `pipeline/` changes in this phase (CONTEXT.md domain).

## Summary

GitHub code search works with the user's `gh` login, returns 100 items per page and hard-stops at 1,000 results per query (`HTTP 422 "Cannot access beyond the first 1000 results"` at page 11, reproduced). The reported `total_count` values (e.g. 99,328 for `"openai" filename:package.json path:/ next`) are rounded/estimated and far above what is retrievable, so the only way to enlarge the pool is to partition one logical query into many disjoint ones. `size:` buckets on `package.json` partition cleanly (each bucket returned a full 100-item page) and are deterministic; `path:`/`language:` and an extra co-term (`next`, `express`) are the other splitters. The code-search ranking is "best match", not recency or stars, so about half of every page is repos with no push since 2025-10-21.

Measured yield on 30-repository samples after D-02 metadata filters (not fork, not archived, pushed >= 2025-10-21, root `package.json` declares the SDK in `dependencies`, app-like): OpenAI about 12% (11 of 90 over three size buckets), Anthropic about 30% (18 of 60 over two buckets). Extrapolating, one 1,000-result bucket yields roughly 120 OpenAI and 300 Anthropic passing candidates before the source-call check, scan-limit check and name exclusions. Reaching 100 OpenAI with a safety margin therefore needs about 5-6 disjoint buckets; 50 Anthropic needs 1-2. Both targets look reachable, but the OpenAI one is the tight one, and the script must record a shortfall (D-06) if pools run dry.

All D-02 metadata filters can be done without cloning: one GraphQL query for 20 repositories returns fork/archived/pushedAt/stars/diskUsage/HEAD oid plus `package.json` text and marker-file existence; `git/trees/<sha>?recursive=1` returns per-blob sizes for the scan-limit check. The "imports SDK and makes a model call" check needs file content, so do it on the shallow checkout that D-10 requires anyway (measured 0-10 s per repo, 14 repos in 30 s). The label candidate grep for exact registry IDs over 14 sampled checkouts found 0 candidates in 9, 2-11 in four, and 258 in one 67,383-source-file repo that readRepository would reject (limit 10,000 files). Expect roughly 1-3 candidates per qualifying repo on average (many zero), a few hundred candidates in total, which one pass of 6-10 subagents can label.

**Primary recommendation:** Build `scripts/ai-app-select.mjs` as a staged, cached pipeline (code search by disjoint `size:` buckets -> GraphQL metadata and `package.json` at HEAD -> tree-size scan-limit check -> shallow checkout and import/model-call check -> sort by stars desc, name asc, take first N), and a separate `scripts/ai-app-label-candidates.mjs` that does the independent quoted-ID grep and emits a fixed-schema candidates file; labelers fill the D-08 fields per repository batch.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Candidate discovery (code search) | Local Node script (`scripts/`) | GitHub REST search | Needs `gh` auth; offline-reproducible from the recorded query list |
| Metadata and manifest filters | GitHub GraphQL/REST (pinned by SHA) | Local script | Avoids cloning rejected repos |
| Source and scan-limit filters | Local shallow checkout | GitHub trees API (sizes) | Content check needs files; D-10 mandates fetch-by-SHA |
| Frozen lists and labels | `docs/benchmarks/*.json` | `docs/BENCHMARKS.md`, `docs/READINESS.md` | Matches existing frozen-set convention |
| Label candidates | Local grep script | — | Independent of `pipeline/` (D-07) |
| Labelling | Subagents reading checkouts | Human spot-check | AI-assisted by decision |

## Standard Stack

No new packages. Everything uses Node built-ins and CLIs already present.

| Tool | Version | Purpose | Notes |
|------|---------|---------|-------|
| Node | v24.14.0 local (CI runs 22 and 24) | Scripts are `.mjs`; `node:util parseArgs`, `node:child_process execFile`, global `fetch` | [VERIFIED: node -v] |
| `gh` CLI | 2.100.0 | `gh api search/code`, `gh api graphql`, `gh auth token` | [VERIFIED: gh --version] |
| git | 2.50.1 | `git init` + `git fetch --depth 1 <url> <sha>` + `checkout FETCH_HEAD` | [VERIFIED: works for arbitrary SHA in this session, 14 repos] |

**Package Legitimacy Audit:** none. This phase installs no external packages and nothing from the fetched repositories is installed or run.

**Token handling choice.** Two existing patterns: `stripe-active-select.mjs:59` reads `GITHUB_TOKEN` or `gh auth token` and calls `fetch` itself (the token lives in a variable, never printed); `ai-sdk-select.mjs` uses `execFile`. D-01 says `gh api`. Use `execFile('gh', ['api', ...])` for everything (it handles auth, retries on its own, and the token never enters the script). For GraphQL use `gh api graphql -f query=...`. Do not log argv that could contain a token (none does).

## Existing analogs (file:line)

- `scripts/ai-sdk-select.mjs:1-164` is the structural analog: header comment explaining method (`:1-6`), constants and `PROVIDERS` table (`:13-27`), `parseArgs` with `--provider/--count/--output/--help` and usage exit (`:29-45`), retry helper (`:47-55`), candidate map -> rejected-counter object (`:94-101`) -> ranked loop with early `break` at `count` (`:102-110`), `git ls-remote HEAD` commit freeze (`:134-145`), output JSON with `formatVersion: 1`, `provider`, `sdk`, `selectedAt`, `method`, `rejected`, `repos` (`:150-163`). Mirror these option names; add `--work <dir>` (cache) as in `stripe-active-select.mjs`.
- `scripts/stripe-active-select.mjs` is the GitHub-search analog: `QUERIES` array (`:35-48`), `USED` frozen lists excluded (`:49-53`), token via `GITHUB_TOKEN` or `gh auth token` (`:59`), `github()` with retry on 403/429/502 using `retry-after` (`:61-82`), `cached(name, compute)` phase cache in `--work` so interruption resumes (`:84-90`), code-search loop of 10 pages x `per_page=100` with `pause(6500)` and early break at `< 100` (`:92-108`), GraphQL batch of 20 repositories with `isArchived isFork diskUsage stargazerCount defaultBranchRef{...oid}` and `object(expression: "HEAD:package.json")` (`:118-133`). Reuse all of this; swap `fetch` for `gh api`.
- `scripts/ai-model-benchmark.mjs:35-52` is the checkout pattern to reuse for D-10: `git init -q`, `git fetch -q --depth 1 https://github.com/<repo> <sha>` with `GIT_TERMINAL_PROMPT=0` and a 300 s timeout, `git checkout -q FETCH_HEAD`, directory name `repo.replace('/', '__')`, skip if `.git` already exists (that is the cache). The same root can be shared between the selector, the candidate script and Phase 4's benchmark.
- `scripts/deadline-benchmark-grep.mjs:1-30` is the independence analog for D-07: "An independent, deliberately loose string search" over JS/TS files with a `SKIP` directory set, reading `data/deadlines.json`. Reuse its walk and skip set rather than inventing one.
- Frozen list shape: `docs/benchmarks/2026-10-20-openai-repos.json` has `formatVersion`, `provider`, `sdk`, `selectedAt`, `method`, `rejected{}`, `repos[]` each `{provider, repo, commit, package, version, declared, monthlyDownloads, publishedAt}` [VERIFIED: read]. New files keep `provider`, `sdk`, `repo`, `commit`, and replace npm-only fields with `stars`, `pushedAt`, `reason`, `hasChecks`, `manager`, plus a header `queries[]`, `filters`, `sortOrder`, `shortfall`. `ai-model-benchmark.mjs:30,56` only reads `frozen.repos[].repo/.commit` and `frozen.provider`, so extra fields are safe. Note `scripts/ai-model-benchmark.mjs` calls `refit deadlines` which filters to `frozen.provider` (`:76-78`); a repo in both sets is run once per set, fine.
- Labels shape precedent: `docs/benchmarks/2026-10-20-meta-graph-call-labels.json` header has `formatVersion`, `labeller` ("single AI-assisted pass, ... not yet second-labelled"), `labelledAt`, `list`, `scope` [VERIFIED: read]. Follow that voice for D-09; other label files exist (`2026-10-16-deadline-labels.json`, `2026-10-15-deadline-pilot-labels.json`).
- `docs/BENCHMARKS.md`: the summary table (`:5-14`) lists sets with frozen dates; the PayPal section (`:178`) already states honestly "the set is libraries and plugins, not applications"; `docs/PROVIDER-GOALS.md:259` and `docs/READINESS.md:27` describe the 2026-10-20 npm sets ("npm returns published packages: mostly SDK wrappers ... not applications"). D-05's baseline note goes in `docs/BENCHMARKS.md`; link new lists the way line `:83` links the fresh Stripe list. Neither new list is in `.prettierignore`-relevant paths.
- Registry: `data/deadlines.json` is `{formatVersion, deadlines:[...]}`; 39 entries have `kind: "model"` (27 OpenAI, 12 Anthropic) covering 88 distinct `versions[]` IDs; every entry carries `source` and `checkedAt` (e.g. `"checkedAt": "2026-10-15"`) [VERIFIED: node script over data/deadlines.json]. Header field "registry checkedAt" in D-09 should be the max (or the set) of these, read from the file at run time, not typed by hand. Entry shape: `{id, provider, kind, versions[], date, summary, replacement, source, checkedAt}`.
- Scan limits: `pipeline/repository.ts:30-34` `MAX_FILES = 10_000`, `MAX_FILE_BYTES = 2 * 1024 * 1024`, `MAX_TOTAL_BYTES = 50 * 1024 * 1024`; counted files are only JS/TS sources (not `.d.ts`), `package.json` and root lockfiles (`:92-104`); excluded directories are in the set above `:25`. Error text: `Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).` A root lockfile above 2 MiB alone trips the limit (pnpm-lock.yaml often does). Mirror this exactly in the selector's size check (read the `EXCLUDED_DIRECTORIES` set from `pipeline/repository.ts:~15-26` when implementing; I did not read lines 1-24).

## Code search reality check

All run 2026-10-21 with the user's `gh` login; code_search limit shown by `gh api rate_limit` as 10/min, core 5,000/h, graphql 5,000 points/h [VERIFIED: gh api rate_limit]. I slept 8 s between search calls and never hit a secondary limit (about 22 search calls).

| Query (all with `-f per_page=100`) | Page-1 uniq repos | Of first 30 repos: pushed >= 2025-10-21 | Passing (metadata + app) | Notes |
|---|---|---|---|---|
| `"openai" filename:package.json path:/ next` | 98 | 14 | 14 (no SDK-dependency check yet) | `filename:` matches `package.json.bak`, `.backup` |
| `"from 'openai'" language:TypeScript path:app` | 96 | 3 | 3 | best-match returns mostly old repos |
| `"chat.completions.create" "gpt-4"` | 100 | 23 | 5 (18 of 30 have no root `package.json`) | source search; unusable for the manifest filters alone |
| `"@anthropic-ai/sdk" filename:package.json path:/ next` | 100 | 21 | 20 | |
| `"@anthropic-ai/sdk" "messages.create" language:TypeScript` | 100 | 17 | 8 (9 look like libraries) | |
| `"openai" filename:package.json path:/ express` | 96 | 14 | 6 | |
| `"openai" filename:package.json extension:json path:/ size:800..1500` (pages 1,2) | 100 each | 15/30 each | 2, 5 (after SDK-in-dependencies check; 10 and 8 had no runtime dependency) | |
| same, `size:1500..3000` | 100 | 16/30 | 4 (6 libraries, 6 no dependency) | |
| `"@anthropic-ai/sdk" ... extension:json path:/ size:800..1500` | 100 | 25/30 | 10 | |
| same, `size:1500..3000` | 100 | 22/30 | 8 | |

Findings:

1. **Use `filename:package.json extension:json path:/`.** Without `extension:json`, `filename:package.json` returns `package.json.backup/.bak`; for the OpenAI query only 46 of 100 results were exactly `package.json`; with `extension:json` it was 100 of 100 [VERIFIED: tested both]. `path:/package.json` returns nothing (total 2) [VERIFIED]. Also post-filter `item.path === 'package.json'` as a safety net, since `path:/` restricts to the root.
2. **1,000-result cap is hard**: page 10 returns 100 items, page 11 returns HTTP 422 `Cannot access beyond the first 1000 results` [VERIFIED]. `total_count` is rounded and not usable as a size estimate.
3. **`size:` partitions work** (`size:<800`, `800..1500`, `>1500` all returned a full page 1 [VERIFIED]). They are deterministic for a given index state and disjoint, so they are the recommended splitter. Suggested OpenAI buckets over `package.json` bytes: `<600`, `600..900`, `900..1300`, `1300..1800`, `1800..2500`, `2500..4000`, `>4000` (adjust after seeing counts; the script should log each bucket's collected count and stop adding buckets once the *passing* pool reaches 3x target). Anthropic: `<1500`, `1500..3000`, `>3000`.
4. **Ranking is best-match, not recency.** About half of each page is stale (pushed before 2025-10-21). There is no `pushed:`/`stars:` qualifier in code search, so recency can only be filtered after the fact.
5. **Yield per 1,000-result bucket** (extrapolated from 30-repository samples, treat as +/-50%): OpenAI about 12% x 1,000 = ~120 pass metadata+dependency+app; Anthropic about 30% = ~300. Before the source-call check, the scan-limit check and the name/topic exclusions (not measured yet; expect another 10-30% loss, mostly name exclusions like `client|provider|plugin`). Gross OpenAI pool needed for 100 qualifying with margin: ~400-600 passing, so 4-6 buckets. Anthropic: 1-2 buckets.
6. **The 1,000-per-query cap is per query string**, so source-import queries (`"from 'openai'" language:TypeScript`, `"chat.completions.create"`) can add further candidates, but their manifests may sit in subfolders (18 of 30 `chat.completions.create` hits had no root `package.json`) and best-match returns old repos; use them only as a supplement (monorepo / workspace case from D-02) after the `package.json` buckets, with `path:` splits (`path:src`, `path:app`, `path:pages`, `path:server`, `path:lib`). Recommended split to reach 150 total: OpenAI = 6 `size:` buckets of the root-manifest query (6 queries x 10 pages x ~7 s = ~7 min), Anthropic = 2 buckets (~2.5 min), plus optional supplements.
7. **Same-repo overlaps are real** (`Superexpert/superexpert-ai`, `xuanyuanzhifeng/code-panorama` appeared in several queries). Deduplicate by lower-cased full name; a repo may legitimately be in both provider sets (D-04), so run each provider's pool separately.
8. **Sample stars are low** (most < 500, many 0). Selection-by-stars picks the top of whatever pool code search surfaced, not the top of GitHub; say so in the frozen file ("stars-ranked within the retrievable pool").

## Filter cost: reading at a pinned commit without cloning

- **GraphQL (recommended for metadata + manifest):** one query holds 20 repositories (the script uses 15-20 per call; `stripe-active-select.mjs:109` uses 20). Per repo it returns `isFork isArchived pushedAt diskUsage stargazerCount owner/primaryLanguage topics defaultBranchRef{target{... on Commit{oid}}}`, `object(expression:"HEAD:package.json"){... on Blob{text}}` and `oid` existence checks for `next.config.js|mjs|ts`, `vite.config.ts|js`, `app`, `pages`, `src/app`, `wrangler.toml`. This ran for 30-repository batches here at about 2 points per query (graphql remaining 4,995 -> 4,989 after about 11 queries) [VERIFIED: gh api rate_limit]. To pin to a SHA instead of HEAD, replace `HEAD:` with `<oid>:`; but since the commit is *taken* from `defaultBranchRef` at selection time, reading `HEAD:` and the oid in the same query is already consistent. Cost: ~1 call per 20 repos, so 1,500 candidates = 75 calls. Missing repos (deleted/renamed) come back as `null` in the response; count them as `unreachable`.
- **Contents API with `ref=`:** `gh api repos/{r}/contents/package.json?ref=<sha>` returns base64 content and `size` [VERIFIED: returned `size`]; 1 core call per file. Use only for workspace `package.json` files found via the tree (`packages/*/package.json`, `apps/*/package.json`), not for the root.
- **Trees API for scan limits and workspace discovery:** `git/trees/<sha>?recursive=1` returns every path with `size` for blobs, and a `truncated` flag [VERIFIED: 173-entry response with `size`; did not hit truncation]. 1 core call per repo. Sum sizes of `*.{js,jsx,ts,tsx,mjs,cjs}` (not `.d.ts`) outside the excluded directories, plus root lockfile and `package.json` sizes, then compare with `MAX_FILES/MAX_FILE_BYTES/MAX_TOTAL_BYTES`. If `truncated: true`, reject as "exceeds scan limits" (GitHub truncates at 100,000 entries / 7 MB, far above 10,000 source files). Optional: do it only for the candidates that survive stars ordering (lazy loop), not for the whole pool, to cut calls.
- **Shallow fetch:** `git fetch --depth 1 <url> <sha>` measured 0-10 s for 14 repos (30 s total), 553 MB for 14 repos including one 136 MB outlier [VERIFIED]; no API quota used, but disk and time scale with repo size. Required anyway by D-10 for the model-call check and the label grep, so do the lazy loop in stars order and stop once N repos have passed: about N + rejects checkouts, probably 150-250 total across both providers, 10-30 min.
- Budget for the whole selection: ~100 search calls (10/min => ~12 min with 7 s sleeps), ~75 GraphQL calls, up to ~300 tree calls, ~250 shallow fetches. Well inside 5,000/h core and graphql limits.

Recommendation: GraphQL for D-02 metadata/manifest/markers, trees API for the scan-limit check, shallow fetch only for the lazy "imports SDK + makes a model call" check on candidates in stars order.

**D-02 details to pin down in the script (all recorded in the frozen file):**
- "Application" via `package.json` `private: true` OR no `main/exports/bin/files` OR app markers. Note this OR is permissive: in samples `lib` (publish fields and no markers and not private) was only ~20-40% of dependency-declaring repos. The rule excludes a repo only when it has publish fields, is not private and has no markers; record the matched rule in `reason` (`private`, `no-publish-fields`, `marker:next.config.mjs`, ...).
- "Not an SDK/wrapper/framework": apply the regex to the repo name and `topics[]` (GraphQL `repositoryTopics(first:20)`), not description. Record the exact regex. Beware false rejects like `client` inside an app name; D-02 says exclude them, so accept and report the count in `rejected`.
- Model-call check: a non-test file (exclude paths matching `/(test|tests|__tests__|spec|e2e|fixtures?)/` and `\.(test|spec)\.`) that imports the SDK (`from 'openai'`, `require('openai')`, `@anthropic-ai/sdk`) AND contains `\.(chat\.completions|responses|messages|images|audio|embeddings)\.\w+\(` (also `beta.` forms). A dependency declared but never imported is rejected (this is why 10 of 30 "nodep"/unused repos matter). Count as `rejected.noModelCall`.
- Workspace `package.json`: root `package.json` may not declare the SDK (monorepos). For the first release handle root plus `workspaces`/`packages/*`, `apps/*` one level via the tree; record `workspace: "apps/web"` in the entry. If time-boxed, document "root manifest only" as a recorded filter and a recorded shortfall driver rather than hiding it.
- `pushedAt >= 2025-10-21` use GraphQL `pushedAt` (repo-level; can be bumped by non-code pushes. Record that).
- `hasChecks`: any of `scripts.test|typecheck|build|lint`? CONTEXT says `test`/`typecheck`/`build`. `manager`: lockfile at root (`pnpm-lock.yaml` -> pnpm, `yarn.lock` -> yarn, `package-lock.json` -> npm; else `packageManager` field; else `null`). GraphQL `lock0..2: object(...) { oid }` already does this in the analog (`stripe-active-select.mjs:129-131`).

## Label pass design (BENCH-02)

### Candidate extraction script: `scripts/ai-app-label-candidates.mjs`
Inputs: `--list docs/benchmarks/2026-10-21-openai-app-repos.json` (and the Anthropic list), `--root <checkout dir>`, `--registry data/deadlines.json`, `--output <candidates.json>`. Output (deterministic, sorted by repo, file, line, then model):

```json
{ "formatVersion": 1, "generatedAt": "...", "registry": {"path": "data/deadlines.json", "checkedAt": ["2026-10-15"]},
  "method": "quoted exact registry model ID, any .js/.jsx/.ts/.tsx/.mjs/.cjs file outside node_modules, at the frozen commit; independent of the Refit scanner",
  "repos": [ { "repo": "o/r", "commit": "<sha>", "provider": "openai",
      "candidates": [ { "file": "lib/x.ts", "line": 52, "model": "o4-mini", "deadline": "openai-...", "replacement": "gpt-5.6-terra", "text": "        id: 'o4-mini'," } ] } ] }
```

Rules (verified by prototype in the scratch directory, not in the repo):
- Build one alternation from every `versions[]` entry whose registry entry has `kind === "model"` for the list's provider, sorted longest first so `gpt-4-turbo-2024-04-09` is tried before `gpt-4-turbo`; regex-escape `.`. Match `["'\`]ID["'\`]` exactly (D-07: "inside quotes"). Prototype found the 88 distinct IDs; note `claude-sonnet-4-5` (an alias) is in the registry but plain aliases like `gpt-4o`, `claude-3-5-sonnet-latest` are not, so they are by design not candidates.
- Walk files with the `deadline-benchmark-grep.mjs` skip set, but do NOT apply the Refit `EXCLUDED_DIRECTORIES` beyond `node_modules` and `.git` (D-07 says non-`node_modules` files; `dist`/`build`/`.next` content is not source so exclude those too, state it in the header). Include test files and `.d.ts`? Include tests (they become `live:false, reason: test`); skip `.d.ts`.
- Emit one candidate per occurrence with `line` (1-based) and the trimmed line text so the labeler need not re-grep. Also emit `context` (3 lines before and after) only into per-batch work files, not the committed output, to keep the committed file small.
- Do not read `refit` output. Do not import from `pipeline/`. A unit test (or an assert-based self-check) on a fixture string covers the quoting and longest-first behaviour.

Sampled yield (14 qualifying-looking repos, shallow checkouts, prototype): 9 had 0 candidates; the others had 2, 8, 9, 11 and 258 (the last is `SoullabTech/MAIA-PAI`, 67,383 JS/TS files, which `readRepository` would reject at the 10,000 file limit, so it never reaches labelling) [VERIFIED: prototype grep]. Real hits looked like: a model catalog (`id: 'o4-mini'`, `id: 'gpt-4.5-preview'` in `lib/adapters/llm-adapters/system-adapters.ts`), commented-out entries (`// id: 'o1'`), a test filter (`model.id !== 'claude-3-7-sonnet-20250219'`), Vercel AI SDK calls (`openai("gpt-3.5-turbo")`, `anthropic("claude-3-haiku-20240307")`), and prompt text naming a model. Expect on the order of 100-400 candidates across ~150 repos, with only a fraction live; the labeler must read context for each. Realistic estimate, [ASSUMED] until the full run.

### Batching across subagents (D-08)
1. Run the candidate script on all 150 checkouts; write `candidates.json` and per-repo work files `work/<owner>__<repo>.json` containing candidates plus 8 lines of context each, and a list of files to open when the context is insufficient.
2. Split repositories into batches by candidate count (target <= 40 candidates per subagent, never split a repository across subagents), 6-10 subagents in parallel. Each subagent gets: the label schema, the reason-class vocabulary, the registry replacement chain rule, and read-only access to the checkout root. No network, no code execution.
3. Fixed JSON schema each subagent must return (validate with a small script before merge; reject the batch on schema failure):
```json
{ "repo": "o/r", "commit": "<sha>",
  "labels": [ { "file": "", "line": 0, "model": "", "live": true,
     "via": "sdk-text|sdk-non-text|raw-http|wrapper:<package>|other",
     "reason": "only when live=false: catalog|test|comment|comparison|doc|prompt-text|config-default-unused|other",
     "replacement": "registry replacement or null",
     "notes": "one line" } ] }
```
   `replacement` must come from `data/deadlines.json` `replacement`, followed while the replacement itself is a retiring model (the registry has chains such as `gpt-4.1-nano` -> `gpt-5.6-luna`; check the target against all `versions[]` and follow). Subagents are given the precomputed `deadline` and `replacement` in the candidate file and only need to confirm the chain, which prevents invented models. `live:false` entries have `replacement: null`? The D-08 text lets non-live items still carry the reason class; keep `replacement` anyway so Phase 4 can check a wrongly-skipped site. Recommend: set it for every candidate (it is a registry lookup), meaningful only when live.
4. Merge by sorting `(repo, file, line, model)`; the merge script checks: every candidate has exactly one label, no extra labels, fields valid, `via` allowed, `replacement` equals registry or the followed chain.
5. Output `docs/benchmarks/2026-10-21-ai-app-labels.json` with header `{formatVersion, labeller: "independent quoted-ID grep (scripts/ai-app-label-candidates.mjs) plus one AI-assisted reading pass; not hand labelling and not second-labelled", labelledAt, lists: [...], registry: {path, checkedAt}, scope}` and per-repo `{repo, commit, provider, labels[]}` (a repo in both sets appears once per provider list, or once with both providers; pick one shape and keep it consistent with the lists). Optionally add a 10% random reread by a second subagent to report agreement; not required by D-09 and not claimed unless done.
6. Honesty boundary: do not say "hand labelled". State that live/via/replacement come from an AI reading of the code, that unlisted models (aliases like `gpt-4o`) are out of scope because the registry does not name them, and that `raw-http`, `wrapper:*` and `other` are counted but not traced in this milestone (wrapper tracers are deferred).

Caching of 150 checkouts: reuse `ai-model-benchmark.mjs:35-37` (skip when `<dir>/.git` exists), `--root` outside the repository (for example `~/Repos/refit-bench-checkouts` or the scratch directory), same root used by the selector, the candidate script and Phase 4's benchmark. Shallow checkouts of the 14-repo sample took 553 MB with one outlier; budget a few GB for 150, avoid vendored `node_modules` (not present in a fresh checkout) and delete checkouts of rejected repos after the filter.

## Recommended script design: `scripts/ai-app-select.mjs`

Options (mirror `ai-sdk-select.mjs`): `--provider openai|anthropic`, `--count N`, `--output <frozen.json>`, plus `--work <dir>` (phase cache, as in `stripe-active-select.mjs:84-90`), `--root <checkout dir>`, `--exclude <list.json>` repeated (or hard-code the frozen lists like `USED` at `stripe-active-select.mjs:49-53` including the two 2026-10-20 lists and the other frozen lists named in AGENTS.md; D-02 says "repositories already in any frozen list"; the 2026-10-20 npm lists (100+50) are frozen lists too, so they ARE excluded), `--help`.

Phases (each cached in `--work`): 1 search (per bucket: pages 1-10, `sleep 7000` ms between, stop on `<100` or 422; store `{query, bucket, count}` and the unique `full_name` list with a path check `path === 'package.json'`) -> 2 GraphQL metadata (20 per call) -> 3 rank by `stars desc, nameWithOwner asc` (use a plain comparison, not locale-sensitive `localeCompare`; note `ai-sdk-select.mjs:98` uses `localeCompare`, which can vary by ICU/locale; prefer `a < b`) -> 4 lazy loop over ranked candidates: tree scan limits, shallow checkout, SDK import + model call check, name/topic exclusion -> stop at `count` -> 5 write frozen file.

Frozen file header: `formatVersion`, `provider`, `sdk`, `selectedAt` (ISO), `runDate`, `cutoff: "pushedAt >= 2025-10-21"`, `queries[]` (exact strings with bucket parameters), `filters[]` (each D-02 rule and the regex strings), `sortOrder: "stars desc, full name asc"`, `rejected{fork, archived, old, noManifest, noDependency, library, scanLimits, noModelCall, excludedName, alreadyFrozen, unreachable}`, `poolSize`, `shortfall` (target minus selected, with the reason, D-06), `repos[]`. Per repo: `provider, repo, commit, stars, pushedAt, reason, hasChecks, manager` (+ `workspace` if not root). The commit is the default-branch oid from GraphQL at selection time (not `git ls-remote`, which `ai-sdk-select.mjs:134` used; both are acceptable, but one oid read at metadata time and used for the fetch avoids races; if the shallow fetch of that SHA fails count as `unreachable`).

Add a small test (vitest picked up by `npm test`, see `package.json:20`) only for pure helpers exported from a sibling module (filter predicates, sorter, publish-field/app-marker rule, model-call regex) if the helpers are extracted, following the `scripts/ai-model-benchmark-summary.mjs` + `pipeline/ai-model-benchmark-summary.test.ts` precedent (tests sit in `pipeline/`, importing a `scripts/` module; a `.d.mts` file next to it, see `scripts/ai-model-benchmark-summary.d.mts`). Adding a test under `pipeline/` is not a behaviour change to `pipeline/` code but touches that folder; the user said "no code changes in pipeline/", so flag this for the planner to decide: either put helper tests there like the precedent, or rely on a self-check run that asserts on fixtures.

## Architecture Patterns

```
queries[]+size buckets --gh api search/code (10 pages, 7s gap)--> unique repo pool (cached search.json)
   --> exclude frozen lists --> GraphQL x20: fork/archived/pushedAt/stars/topics/oid/package.json/markers/lockfiles
   --> drop fork, archived, old, no root dependency, library-shaped, excluded name
   --> sort stars desc, name asc
   --> lazy loop: trees API scan limits --> shallow fetch at oid --> import + model-call check
   --> first N pass --> docs/benchmarks/2026-10-21-<provider>-app-repos.json
                                   |
   checkouts --> ai-app-label-candidates.mjs (quoted exact registry IDs) --> candidates.json
   --> batches (<=40 candidates, never split a repo) --> subagents (fixed JSON schema) --> validate+merge
   --> docs/benchmarks/2026-10-21-ai-app-labels.json
```

Recommended structure: `scripts/ai-app-select.mjs`, `scripts/ai-app-label-candidates.mjs` (+ optional `scripts/ai-app-label-merge.mjs` for the schema validator), data under `docs/benchmarks/`; scratch work and checkouts outside the repo.

### Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---|---|---|---|
| GitHub auth | token handling | `gh api` | D-01, nothing to leak |
| Retry/backoff | custom loop | copy `github()` retry on 403/429/502 using `retry-after` (`stripe-active-select.mjs:61-82`) | secondary limits |
| Resume | custom state | `cached(name, compute)` (`stripe-active-select.mjs:84-90`) | interrupted runs |
| Checkout | clone | shallow fetch by SHA (`ai-model-benchmark.mjs:35-52`) | pinned commit, small |
| Model ID list | hand-typed list | read `data/deadlines.json` `kind==="model"` `versions[]` | single source of truth |
| Repository limits | a different check | the numbers in `pipeline/repository.ts:30-34` | must match `readRepository` |

## Common Pitfalls

1. **`filename:package.json` matches backups** (`package.json.bak`, `.backup`): add `extension:json` and check `path === 'package.json'`. Without it, half of OpenAI results are noise.
2. **`total_count` is not a pool size**: it is rounded and capped by 1,000 retrievable items. Judge yield by sampled passes, not totals.
3. **Selection by best-match then stars**: the final order is stars within the retrievable pool; state it. It biases toward repos that code search ranks high for the chosen terms (short `package.json`, `next`/`express` mentioned). Mixing buckets reduces but does not remove this.
4. **Selection-time drift**: the code search index and `pushedAt` change between runs; the frozen file (queries, date, pool size, SHAs) is the reproducible artefact, not a rerun. Say so.
5. **Rate limits**: 10 code-search requests per minute; the analog sleeps 6.5 s, use 7-7.5 s and honour `retry-after` on 403/429; resume from cache. GraphQL cost grows with objects per query; 20 repos x ~10 objects each worked.
6. **Monorepos**: a root `package.json` without the SDK but `apps/web/package.json` with it. Either search `path:` subfolders and record `workspace`, or document "root manifest only" as a filter. Do not silently drop and do not silently include.
7. **Huge repos**: `diskUsage` > 50 MB is not the limit; the limit counts only JS/TS sources, the root lockfile and package.json. A 67k-file repo was found in the sample; use the trees API sums so a 200 MB repo that is mostly assets is not wrongly rejected, and a small repo with a 3 MiB `pnpm-lock.yaml` is correctly rejected (`MAX_FILE_BYTES` applies to the root lockfile too).
8. **Name/topic exclusion regex over-matches** (`client` in `client-portal`): D-02 says so; accept it and count in `rejected.excludedName`.
9. **Test and docs mentions of model IDs**: the independent grep deliberately includes them; the labeller classifies them `live:false` with a reason class. Don't pre-filter tests in the candidate script (that would hide recall errors).
10. **Dated registry**: the registry is a hand-checked snapshot (`checkedAt` 2026-10-15). Labels are "correct replacement as of that registry". If `data/deadlines.json` changes before Phase 4, record the registry file hash or commit in the labels header.
11. **Circularity**: the candidate script must not import Refit code or parse Refit output (D-07).
12. **Licensing and privacy**: the committed files contain only `owner/repo`, SHAs, stars, dates, filter reasons, file paths, line numbers, model IDs and one-line notes; no code excerpts. Keep the `text`/`context` fields in scratch work files only. Fetched code stays outside the repo and is never executed or installed (D-10). Do not copy `.env`-like content; the candidate grep reads only JS/TS files, but note that some checkouts may contain secrets in JS files; never print them (the candidate script's `text` field is the trimmed matching line only, and should be omitted from the committed output).

## State of the Art

| Old | Current | Impact |
|---|---|---|
| npm search sets (2026-10-20): wrappers, plugins, catalogs | GitHub code search sets of applications | `docs/BENCHMARKS.md` marks the npm sets as library baselines (D-05) |
| Tracing measured against traced output | Independent grep plus AI label pass | The traced fraction (BENCH-04) is not circular |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | OpenAI yield extrapolates to ~120 passing per 1,000-result bucket and Anthropic ~300 (30-repo samples) | Code search reality check | Needs more buckets, or shortfall must be reported (D-06) |
| A2 | Name/topic exclusion and the model-call/scan-limit checks cost another 10-30% of the pool | same | Same |
| A3 | 100-400 label candidates across the final ~150 repos | Label pass | Subagent batch count changes |
| A4 | `size:` bucket boundaries stay stable across runs (index state) | same | Rerun not bit-identical; frozen file is the record |
| A5 | I did not read `pipeline/repository.ts` lines 1-24 (the `EXCLUDED_DIRECTORIES` set start); only `:25-34` and `:92-104` were read | Existing analogs | Implementer must read it before mirroring |
| A6 | Whether adding a helpers test under `pipeline/` conflicts with the "no `pipeline/` changes" decision | Script design | Planner to decide |

## Open Questions (RESOLVED)

Resolved by D-11..D-16 in 03-CONTEXT.md (2026-10-21).

1. **Workspaces:** include `apps/*`/`packages/*` manifests for D-02 or root-only? Recommend root plus one-level workspaces via the trees API, recorded per entry; if cut for time, record "root manifest only" as a filter and a shortfall cause.
2. **Both-sets repos:** one entry per provider list, as in D-04. In the labels file prefer per (repo, provider) so a repo present in both appears twice with provider-specific candidates.
3. **`pushedAt` semantics:** repo-level, can be bumped by non-code activity. Alternative is the default-branch head commit date (`committedDate` in GraphQL, as `stripe-active-select.mjs:122` requests); recommend using `committedDate` of the selected oid as the recency evidence and recording it, since it is the commit being frozen. This differs slightly from D-02's wording ("pushed on or after"); confirm or record both.
4. **Second labeller sample:** optional 10% reread; user decision.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| `gh` with login | search, GraphQL, trees | yes | 2.100.0 | `GITHUB_TOKEN` + fetch (analog) |
| git | shallow fetch | yes | 2.50.1 | none needed |
| Node | scripts | yes | v24.14.0 (CI 22/24) | — |
| GNU `timeout` | not available on macOS | no | — | use `execFile` `timeout` option (as `ai-model-benchmark.mjs:50`) |
| Disk for ~150 shallow checkouts | label pass | yes (14 repos = 553 MB with one 136 MB outlier) | — | delete rejected repos, `--filter=blob:limit` not needed |

## Security Domain

| ASVS Category | Applies | Control |
|---|---|---|
| V2 Authentication | no | `gh` holds the credential; scripts never read, print or store it |
| V5 Input validation | yes | Treat search results, `package.json` text and fetched files as untrusted: JSON.parse in try/catch, regex-only inspection, never `eval`/`import`/install/run |
| V6 Cryptography | no | — |

Threat patterns: command injection through repo names (use `execFile` with argv arrays, validate `owner/name` against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` before building URLs/paths; directory name `repo.replace('/', '__')`); path traversal in candidate `file` values (resolve under the checkout root and refuse symlinks, as `readRepository` does at `:78`); malicious repo content read only as text; secret leakage in logs (omit line text from committed outputs); subagents get read-only access and no network.

## Validation Architecture

Skipped: `workflow.nyquist_validation` is `false` in `.planning/config.json` [VERIFIED: read]. Suggested checks the planner may still use: `npm test`, `npm run format:check`, a dry run with `--count 5` per provider, a merge-script schema check on the labels, and `node -e` assertions that each frozen file has `repos.length` equal to the target or a recorded `shortfall`.

## Sources

### Primary (read or run this session)
- Repository files: `.planning/phases/03-application-benchmark-sets/03-CONTEXT.md`, `.planning/REQUIREMENTS.md` (BENCH-01/02), `AGENTS.md`, `scripts/ai-sdk-select.mjs`, `scripts/stripe-active-select.mjs:1-135`, `scripts/ai-model-benchmark.mjs`, `scripts/deadline-benchmark-grep.mjs:1-30`, `pipeline/repository.ts:25-125`, `data/deadlines.json`, `docs/benchmarks/2026-10-20-openai-repos.json`, `docs/benchmarks/2026-10-20-meta-graph-call-labels.json` (header), `docs/BENCHMARKS.md`, `docs/PROVIDER-GOALS.md:259`, `docs/READINESS.md:27`, `package.json`, `.prettierignore`.
- `gh api search/code`, `gh api graphql`, `gh api repos/.../git/trees` and `.../contents?ref=`, `gh api rate_limit`, `git fetch --depth 1 <sha>`: run 2026-10-21 against live GitHub (prototype scripts and 14 shallow checkouts in the session scratch directory, outside the repository).

### Tertiary
- Yield numbers are small-sample extrapolations (A1-A3).

## Metadata

**Confidence breakdown:**
- Search mechanics and caps: HIGH (reproduced)
- Yield extrapolation: LOW-MEDIUM (30-repo samples)
- Filter cost and checkout pattern: HIGH
- Label-candidate counts: MEDIUM (14-repo sample)

**Research date:** 2026-10-21
**Valid until:** 2026-10-28 (the code search index and registry move; rerun the yield sample before the real selection)
