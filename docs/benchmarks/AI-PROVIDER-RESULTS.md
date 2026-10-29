# AI-provider benchmark results

## October 29, Actions: first validated passes (engine-only, AI effectively unavailable)

These are the first runs with validation in Docker, on refit-bench `ai-providers.yml` with `ai=true`. They are the baseline for the current engine, before the AI fallback (#420).

- **Before:** `c010f67f` is the sets branch with main merged in (#399, the preparation fallbacks).
- **After:** `2e40086c` (`bench/ai-provider-after-8`) is after-7 with that merge. The after passes add `--parameter-changes data/model-parameter-changes.json`.

The rows are in `ai-provider-results/2026-10-29-*-actions.json`.

| Set           | Before run  | After run   |
| ------------- | ----------- | ----------- |
| openai-100    | 40931460055 | 40930402266 |
| anthropic-100 | 40926760667 | 40926766539 |
| gemini-30     | 40929121548 | 40929126592 |

The two runs on each 100-repository set had 10 shards; gemini-30 had 3. OpenAI before ran with `ai=false`.

**Void, not results:**

- **Anthropic runs 40923495655 and 40923500278.** A workflow bug kept `umask 077` set for the harness, so the Docker sandboxes could not read Refit's inputs; refit-dev/refit-bench#13 fixes it. On after-8, 19 SDK upgrades failed with `Permission denied` and never ran.
- **Gemini run 40926159255.** It was cancelled for the same reason.

**AI was effectively unavailable.** Until the key was fixed, the refit-bench OpenAI project answered 403 for every model. It now allows only `gpt-6.1-sol`. The AI lane exists only for OpenAI on after-8. Anthropic and Gemini have no AI lane, so they are engine-only. An OpenAI fix whose replacement model the key cannot call is counted as **Needs review ("replacement model not provable with Refit's key")**, never as validated.

|                                      | openai-100 before → after | anthropic-100 before → after | gemini-30 before → after |
| ------------------------------------ | ------------------------- | ---------------------------- | ------------------------ |
| **Validated fix**                    | 1 → **1** (re-scored)     | 2 → **2**                    | 0 → **1**                |
| Tests pass, replacement not provable | 0 → 0 (was 1 → 1)         | –                            | –                        |
| Validation failed                    | 5 → 7                     | 5 → 5                        | 0 → 0                    |
| Needs review                         | 29 → 43                   | 19 → 33                      | 16 → 15                  |
| SDK upgrade available, not required  | –                         | 0 → 2                        | –                        |
| No checks                            | 2 → 10                    | 2 → 10                       | 0 → 1                    |
| Detection only (Python)              | 20 → 24                   | 13 → 17                      | 7 → 7                    |
| Error                                | 3 → 6                     | 7 → 16                       | 1 → 1                    |
| Unaffected                           | 40 → 9                    | 52 → 15                      | 6 → 5                    |
| Rows with a model-fix stop           | 32 → 39                   | 18 → 14                      | 4 → 4                    |
| AI attempted / succeeded             | 0 / 0 → **3 / 0**         | – (no AI lane)               | – (no AI lane)           |
| AI cost                              | $0 → **$0.0746**          | $0                           | $0                       |
| **Validated / set**                  | **1%**                    | **2%**                       | **3%**                   |

**Against the 90% target: 1%, 2% and 3%.** All four validated fixes are model swaps with request proof:

- Two are Anthropic Haiku 3 → `claude-haiku-4-5-20251001`. The proof passed the request, tools and stream checks.
- One is Gemini `gemini-2.0-flash` → `gemini-3.6-flash`. The proof passed the request, tools and stream checks; its JSON check is pending on a 503.
- One is OpenAI `gpt-3.5-turbo` → `gpt-5.6-terra` (re-scored, see below).

No SDK-major migration validated in any set.

**What stops the rest (after pass, whole-set counts):**

1. **Baseline failures.** Validation failed on 5 Anthropic and 7 OpenAI rows. For 4 and 6 of them, the repository's own checks already fail before the patch, so a fix cannot be shown to work.
2. **Lockfiles Refit cannot re-resolve.** Refit re-resolves only npm's `package-lock.json`.
   - SDK upgrades stopped because the project commits a pnpm, yarn or bun lockfile: 18 OpenAI, 6 Anthropic. One more OpenAI upgrade failed npm resolution (ERESOLVE).
   - Upgrades that would change other packages in `package-lock.json` (for example `zod`, `ws`, `@opentelemetry/api`): 15 OpenAI, 12 Anthropic, 1 Gemini.
3. **Sites with no documented mapping.** OpenAI: 6 rows (`v5-web-response` 7 stops, v4 response data, untraced calls). Anthropic: 13 rows. The sampling rule holds 14 rows (43 stops), and removed Text Completions holds 4. Gemini: `gemini-swap-target` blocks 12 rows (97 stops). There, 11 swaps produced 56 edits, but no row is free of stops.
4. **A new engine error.** In 3 OpenAI and 8 Anthropic rows, `refit ai-migrations` fails with "The proposed patch changes no committed source file." It shows up now that lockfile re-resolution works on Actions. It is reported by count only, for reproduction on a dev set.
5. **No checks:** 10 OpenAI, 10 Anthropic and 1 Gemini rows have no test or build script.
6. **The AI lane did not help.**
   - Of the 64 OpenAI rows it ran on, 61 ended before any AI call. 16 had no flagged site, and the rest stopped on a lockfile or another stop first.
   - The 3 rows that did call the AI are legacy Completions sites. The prescribed replacement, `gpt-3.5-turbo-instruct`, supports only Completions, so the AI rightly left them unchanged.
7. **Model-fix stops unchanged:** custom endpoints and base URLs (held for Furqan), untraceable clients, and Python (detection only).

**Re-score after full-access proofs (later on October 29).** Pierce enabled every model on the refit-bench OpenAI project. Substantive AI work still runs only on `gpt-6.1-sol`; the other models get only the minimal proof requests.

- **Proofs:** model proof run 40940798473 and SDK proof run 40940802357, both on `bench/ai-provider-after-9` (`836dedb5` = after-8 + ai-models `fcb5ef9e` and `b8453fb2` + ai-surfaces `92876b34`, which includes `e2767280`).
- **One row moves.** The only row held back by "replacement model not provable with Refit's key" is the `gpt-3.5-turbo` → `gpt-5.6-terra` swap. Its tests passed in both passes.
  - Both edited calls are openai v3 `createChatCompletion` with only `model` and `messages`. They have no tools and none of the parameters the model rejects.
  - `gpt-5.6-terra` on Chat Completions passed the request, JSON, schema and stream checks.
  - So it is now **validated** in both passes. The hand-check verdict, correct, is in `ai-provider-results/2026-10-29-actions-rescore.json`.
- **No other row depended on that proof**, so nothing else moves.

**Proofs, on Refit's own keys:**

- **Model proof:** run 40923057757 on `2e40086c`, with a Gemini retry, run 40932922473.
  - Passed: Anthropic `claude-haiku-4-5-20251001` (request, tools, stream). `claude-opus-4-8` passed the same checks and rejects `temperature`, `top_p` and `top_k`. `claude-sonnet-5-5` passed request and stream but failed tools (HTTP 400), and rejects the same sampling parameters.
  - Passed: Gemini `gemini-3.5-flash-lite` (all four checks) and `gemini-3.6-flash` (JSON pending on a 503).
  - Pending: `gemini-3.1-pro-preview` (429) and `gemini-3.8-flash` (503, then a timeout), after one retry. All OpenAI replacement models other than `gpt-6.1-sol`, because the project cannot call them.
- **SDK proof:** run 40928850584 on `100d7937`.
  - Accepted: openai 6.49.0 `chat.completions.create`, `responses.create`, `models.list` and `models.retrieve` on `gpt-6.1-sol`; `@anthropic-ai/sdk` 1.3.0 `messages.create`, with a stream and tools, and `models.list`; `@google/genai` 2.32.0 `generateContent` and its stream.
  - Pending: Chat with tools plus `reasoning_effort` (HTTP 400 on `gpt-6.1-sol`), moderations (403 for the project), embeddings (no embedding model in the project) and Completions (no minimal request yet).
  - The run's logs and artifacts contain no project or organization IDs.
- **Full-access model proof:** run 40940798473 on `836dedb5`, 135 requests.
  - `gpt-4.1` and `gpt-4o` passed every check (request, JSON, schema, tools, stream) on Chat Completions and Responses.
  - `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-luna` and `gpt-6-sol` passed every check on Responses, where they reject `temperature` and `top_p`.
  - The same five on Chat Completions passed request, JSON, schema and stream, but failed tools (HTTP 400). There they also reject `max_tokens`.
  - Pending: `gpt-5-codex-mini` (404 on both APIs). Anthropic and Gemini are unchanged, except that `gemini-3.6-flash` now passes JSON and failed tools on a 503.
- **Full-access SDK proof:** run 40940802357 on `836dedb5`.
  - Newly accepted: openai `moderations.create`.
  - Pending: Chat with a stream and tools, because the proof's `reasoning_effort: "none"` is rejected by `gpt-6.1-sol`, which supports `low` or higher. Also embeddings, because the proof is not yet wired to an embedding model, and Completions.
  - No project or organization IDs in the log or artifact.

**Alerts:** OpenAI after raised 19 fine-tune and 4 configuration alerts, and Gemini after raised 10 embedding alerts.

**AI spend this round:** $0.0746 in the benchmark, plus a few dozen minimal proof requests.

**Where to improve, ranked by rows it would move:**

1. Baseline-failed checks (10 rows): validate against the checks that pass at baseline, not the whole suite.
2. Non-npm lockfile re-resolution and SDK-only lockfile changes (52 rows).
3. The "patch changes no committed source file" error (11 rows).
4. Anthropic sampling on unreadable bodies (14 rows).
5. Gemini swap forms (12 rows).
6. A chat-compatible replacement for legacy Completions models, so the AI lane can act (proposal 2).

## October 29, final: after-7 (last scan-only pass before Actions)

This is the same scan-only harness (no validation, no AI) on `bench/ai-provider-after-7` (`bf702822`): ai-models #402 `8b0f6fb6`, #403 `df0b070b`, #404 `c5dd595f` and #406 `3d615602`, and `feat/ai-gemini-swap` `f14dd20b`, ai-surfaces' final head. That head adds two mappings the owner approved: companion platform packages move to v1 with the Anthropic SDK, and openai v3 `Configuration` `organization` and `basePath` map to v4 client options. Rows: `ai-provider-results/2026-10-29-*-after7-scan.json`. This is the engine the Actions passes will measure.

|                                                   | openai-100   | anthropic-100 | gemini-30  |
| ------------------------------------------------- | ------------ | ------------- | ---------- |
| Fix proposed (before → after-7)                   | 8 → **19**   | 10 → **12**   | 0 → **2**  |
| SDK upgrade available, not required               | 0            | **3**         | 0          |
| Needs review / Python detection only / unaffected | 40 / 24 / 14 | 29 / 16 / 33  | 14 / 7 / 6 |
| Error / infrastructure                            | 3 / 0        | 6 / **1**     | 1 / 0      |
| Affected, without optional upgrades               | 83           | 57            | 23         |
| **Upper bound: proposed / affected**              | **23%**      | **21%**       | **9%**     |
| Upper bound: proposed / affected JS/TS            | 32%          | 29%           | 12%        |

- **OpenAI +1 from after-6.** One row's v3 → v6 migration now maps its `Configuration` options and has no stop left (3 → 4 edits). `openai-node-v4-client` stops fall from 6 to 2, and rows with a blocking migration stop from 10 to 7. `v5-web-response` (7) is now the largest OpenAI blocker. Those are reads of the raw response's headers, which are real stops.
- **Anthropic is unchanged in rows.** The 7 `anthropic-ts-companions` stops are now 7 `anthropic-ts-platform-credentials` stops on the same rows: those platform clients pass a credential option that v1 rejects. Sampling stays at 36 blocking (unknown bodies) and 32 optional. No Anthropic SDK migration produces edits.
- **One new infrastructure row (Anthropic, Python).** A detection-only row could not be fetched this run ("unable to access" from GitHub). Per the integrity rules it stays in the denominator as a failure. A clone failure is not a Refit result, so the Actions pass will show whether it persists.
- **Gemini is unchanged** (12 rows blocked by `gemini-swap-target`).
- **The sampled fixes are unchanged:** 14 correct, 1 partial (not fixable from a provider source), 0 wrong. **Alerts are unchanged. AI cost: $0.**

**Against the 90% target: not reachable on this engine.** Even if every proposed fix validates and passes request proof, the bound is 23% / 21% / 9% of affected rows. What holds the rest, in rows (from the stop counts above):

- OpenAI: legacy Completions and Assistants (the AI lane is not measured until Actions), custom-endpoint and base-URL stops (held for Furqan), and `v5-web-response`.
- Anthropic: sampling on bodies Refit cannot read, Text Completions removal, and platform credentials.
- Gemini: unmapped swap forms.
- All three: affected Python rows, which are detection only.

## October 29, night: after-6 re-run (ai-surfaces' stable head)

This is the same scan-only harness (no validation, no AI) on `bench/ai-provider-after-6` (`9a3b3372`). It holds the same ai-models heads as after-4 and `feat/ai-gemini-swap` `ec1a22bc`, which ai-surfaces named as its stable head for the night. Rows: `ai-provider-results/2026-10-29-*-after6-scan.json`.

**No row changes outcome from after-4**, on any set. Proposed fixes stay at 18 / 12 / 2, and optional Anthropic upgrades at 3. The upper bounds stay at 22% / 21% / 9% (31% / 29% / 12% of affected JS/TS). The sampled fixes are unchanged (14 correct, 1 partial, 0 wrong). The rule-level fixes landed, but every row they touched is still held by another blocker:

|                                                       | after-4 | after-6                                                                                           |
| ----------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| OpenAI `openai-node-v5-file-from-path` blocking stops | 16      | **0**                                                                                             |
| OpenAI rows with a blocking migration stop            | 10      | 10 (`v5-web-response` 7, `v4-client` 6, `v4-response-data` 2, untraced v3 or renamed calls 4)     |
| Anthropic sampling stops: blocking / optional         | 42 / 26 | **36 / 32**                                                                                       |
| Anthropic rows with a blocking migration stop         | 19      | 17 (sampling on unknown bodies, `text-completions-removed` 9, `companions` 7, `one-credential` 3) |
| Anthropic SDK migrations with edits                   | 0       | 0                                                                                                 |
| Gemini migration edits / blocked rows                 | 51 / 12 | 56 / 12 (`gemini-swap-target` 97 stops)                                                           |

Where to look next, for row movement, not stop counts: (1) OpenAI `v5-web-response` and `v4-client` in the same 10 rows; (2) Anthropic: rows whose only remaining blockers are `text-completions-removed` or `companions`; (3) Gemini: the swap-target forms still unmapped (`systemInstruction`, request objects, `candidates` reads, lazily built clients). Each would be measured on the dev sets first.

## October 29, later: after-4 re-run (latest engine heads)

This is the same scan-only harness (no validation, no AI) on `bench/ai-provider-after-4` (`27ad6393`). It holds the before commit with #402 `8b0f6fb6`, #403 `df0b070b`, #404 `c5dd595f` and #406 `3d615602` (ai-models), and `feat/ai-gemini-swap` `2bf68181` (ai-surfaces, carrying #407 and #412). Per owner decision A, an Anthropic SDK upgrade blocked only by sampling parameters is now reported as **"SDK upgrade available, not required (would change outputs)"** (`optional-upgrade`). It is neither a failure nor a stop, and it is left out of the affected denominator. All earlier passes were recounted with the same outcome rule (`rowOutcome`), and nothing changed for them. Rows: `ai-provider-results/2026-10-29-*-after4-scan.json`.

|                                              | openai-100 after → after-4 | anthropic-100 | gemini-30 |
| -------------------------------------------- | -------------------------- | ------------- | --------- |
| Fix proposed (JS/TS)                         | 19 → 18                    | 12 → 12       | 2 → 2     |
| Needs review                                 | 40 → 41                    | 32 → 29       | 14 → 14   |
| **SDK upgrade available, not required**      | 0                          | **0 → 3**     | 0         |
| Detection only (Python) / unaffected / error | 24 / 14 / 3                | 17 / 33 / 6   | 7 / 6 / 1 |
| Affected, without optional upgrades          | 83                         | 58            | 23        |
| **Upper bound: proposed / affected**         | **22%**                    | **21%**       | **9%**    |
| Upper bound: proposed / affected JS/TS       | 31%                        | 29%           | 12%       |

- **OpenAI 19 → 18** is the earlier partial verdict fixed as intended. A legacy `functions`/`function_call` flow now stops as a whole instead of swapping only its follow-up call.
- **Anthropic.** The `anthropic-ts-x-api-key-header` blocker is gone (10 → 0). 26 sampling stops are now optional upgrades, and 3 rows move from needs-review to optional upgrade. 42 sampling stops still block 19 rows, because their bodies are untraced or opaque, so it is unknown whether they send the parameters. No Anthropic SDK migration produces edits yet.
- **OpenAI SDK migrations are unchanged** (16 rows, 72 edits, 10 blocked). `openai-node-v5-file-from-path` still blocks 16 times, so these sites are not the one-argument `fileFromPath(p)` form that is now mapped. `v5-web-response` blocks 7 times (it was 5).
- **Gemini is unchanged.** `gemini-swap-target` blocks the same 12 rows (89 stops, up from 77), and the sampled swap still keeps `gemini-pro`. That partial is **not fixable from a provider source**: no Google page names `gemini-pro` or a Gemini 1.0 model ID as shut down (the changelog says only, in prose, that Gemini 1.0 Pro is no longer supported), and the registry takes quoted IDs only (#404). The planned next step is a review note in drafts that lists untracked model IDs in changed files.
- **Hand-check re-verified at after-4.** The 15 sampled fixes still proposed are identical to the ones reviewed below: 14 correct, 1 partial (the Gemini swap that keeps `gemini-pro`), **0 wrong**. The old OpenAI partial no longer produces a fix.
- **Alerts are unchanged:** 19 `ft:` and 4 configuration (OpenAI), 12 configuration (Anthropic), 10 embedding (Gemini). **AI cost: $0.** The new `ai-migrations --ai-surfaces` lane for OpenAI Completions and Assistants runs only on Actions with `ai=true`, so it is not in these numbers.

Updated ranking (each item is designed on the dev sets): (1) merge refit-bench #12, #10 and #11 and run validation; (2) the 19 Anthropic rows still blocked by sampling on untraced bodies; (3) Gemini `gemini-swap-target` (12 rows); (4) custom-endpoint and base-URL stops (owner decision, held for Furqan); (5) the 16 OpenAI `fileFromPath` forms that are not mapped yet; (6) measure the Completions/Assistants AI lane on Actions.

## October 29: scan-only before and after passes

The first runs of the measurement sets in `AI-PROVIDER-SETS.md`: `openai-100`, `anthropic-100` and `gemini-30`. Rows, verdicts and harness records are in `ai-provider-results/`.

**What ran, and what did not.** Both passes are **scan-only, with no validation and no AI**. Each repository was fetched at its frozen commit and read; nothing was installed, built or tested, and no provider was called. Docker validation needs refit-bench's `ai-providers.yml` (refit-dev/refit-bench#12), which can only be dispatched once it is on the default branch. Request-level proof needs refit-bench #10 and #11. All three wait on the owner's merge.

So **no row is validated yet**. The after numbers are **pre-request-proof**: what would validate if every proposed fix passed its checks and its request proof (an upper bound), and what stays `[Needs review]` for other reasons. The validated rate against the 90% target is not measured yet; the bound below shows it cannot reach 90% on this engine.

| Pass   | Refit                                               | Engine                                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before | `7746f968` (openai, anthropic), `030e886e` (gemini) | `origin/main` at `6161f020`, plus the benchmark harness only                                                                                                                                                                                                                     |
| After  | `412963ef` (`bench/ai-provider-after`)              | the before commit with #402 `fc0ad7ea`, #403 `4e84abba`, #404 `ca0afa63`, #406 `b7613b64` and #414 `4f67fa42` (which carries #407 and #412) merged locally. Only docs conflicted, resolved to the engine side. Run with `--parameter-changes data/model-parameter-changes.json`. |

Command (each list in halves of at most 50 on the Mac, `NODE_OPTIONS=--max-old-space-size=3072`):

```sh
npx tsx pipeline/ai-provider-benchmark-cli.ts --list <list or half> --root <dir> --output <results.json> [--parameter-changes data/model-parameter-changes.json]
```

### Outcomes

|                                        | openai-100 before | after   | anthropic-100 before | after   | gemini-30 before | after  |
| -------------------------------------- | ----------------- | ------- | -------------------- | ------- | ---------------- | ------ |
| Fix proposed (JS/TS)                   | 8                 | **19**  | 10                   | **12**  | 0                | **2**  |
| Needs review (JS/TS)                   | 29                | 40      | 20                   | 32      | 16               | 14     |
| Detection only (affected Python)       | 20                | 24      | 13                   | 17      | 7                | 7      |
| Unaffected                             | 40                | 14      | 51                   | 33      | 6                | 6      |
| Error                                  | 3                 | 3       | 6                    | 6       | 1                | 1      |
| Affected (all)                         | 57                | 83      | 43                   | 61      | 23               | 23     |
| Affected JS/TS                         | 37                | 59      | 30                   | 44      | 16               | 16     |
| **Upper bound: proposed / affected**   | 14%               | **23%** | 23%                  | **20%** | 0%               | **9%** |
| Upper bound: proposed / affected JS/TS | 22%               | 32%     | 33%                  | 27%     | 0%               | 12%    |

**Against the 90% target:** even if every proposed fix validated and passed request proof, the after engine would validate at most 23% of affected OpenAI rows, 20% of Anthropic rows and 9% of Gemini rows. The engine PRs find far more (affected rows go up from 57 to 83 and from 43 to 61, and unaffected rows go down from 40 to 14 and from 51 to 33). They also more than double OpenAI's proposals. But most of what they find is review-only or blocked.

Anthropic's bound falls from 23% to 20% because the after pass finds 18 more affected rows and proposes only 2 more fixes. No row lost a proposal it had before.

Errors are the same rows before and after:

- OpenAI: two repositories exceed the scan limits, and one has an invalid `package.json` in a test fixture.
- Anthropic: two local timeouts, two Node out-of-memory crashes at the Mac's 3 GB heap, one unterminated template literal and one over the scan limits.
- Gemini: one out-of-memory crash.

Actions shards get an 8 GB heap, so the timeouts and out-of-memory crashes may clear there.

### Findings per change type (after pass)

A row counts under every type its code shows (`changeTypes`), so columns overlap.

| Change type           | OpenAI rows: proposed / needs review / Python / unaffected | Anthropic        | Gemini         |
| --------------------- | ---------------------------------------------------------- | ---------------- | -------------- |
| retired-model         | 12 / 25 / 20 / 4                                           | 10 / 17 / 14 / 3 | 2 / 11 / 7 / 0 |
| parameter-change      | 2 / 7 / 9 / 3                                              | 2 / 10 / 7 / 1   | 0 / 2 / 0 / 2  |
| legacy-endpoint       | 6 / 19 / 6 / 1                                             | 2 / 6 / 4 / 0    | 2 / 2 / 1 / 0  |
| old-sdk-major         | 19 / 38 / 17 / 8                                           | 12 / 30 / 9 / 25 | 2 / 13 / 7 / 3 |
| response-parsing      | 12 / 14 / 11 / 2                                           | 9 / 19 / 15 / 17 | 2 / 11 / 0 / 4 |
| beta-header           | 0 / 4 / 2 / 2                                              | 0 / 10 / 3 / 10  | 1 / 0 / 0 / 1  |
| embeddings-fine-tunes | 3 / 9 / 7 / 3                                              | none (no API)    | 1 / 5 / 2 / 0  |

What each lane produced (after):

|                                     | OpenAI                                                                             | Anthropic                    | Gemini                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| Model replacements (rows)           | 18 (10)                                                                            | 26 (12)                      | 3 (1)                                                |
| Model-fix stops                     | 107                                                                                | 58                           | 8                                                    |
| SDK-migration proposals with edits  | 16 rows, 72 edits                                                                  | 0                            | 11 rows, 51 edits                                    |
| Rows with a blocking migration stop | 10                                                                                 | 25                           | 12                                                   |
| `ai-migrations --review` findings   | 224 (129 API surface for review, 60 API surface report-only, 29 SDK major, 6 beta) | 46 (30 API surface, 16 beta) | 79 (49 SDK major, 23 response format, 7 API surface) |

Before the engine PRs, `origin/main` had no migration or review lane, so these were 0, and model-fix stops were 85, 63 and 11.

### Proof levels reached

| Level                                               | Rows                                       |
| --------------------------------------------------- | ------------------------------------------ |
| Found (live finding, stop, alert or review finding) | 83 + 61 + 23 = 167 affected rows           |
| Fix proposed by a rule                              | 19 + 12 + 2 = 33 rows                      |
| Repository checks before and after (offline Docker) | 0: not run (needs refit-bench#12)          |
| Request-level proof                                 | 0: not run (needs refit-bench #10 and #11) |
| Validated                                           | 0                                          |

Every model-fix and SDK-migration draft without stored request proof is `[Needs review]` by design (#402, #407), so until #10 and #11 run, even a passing row publishes as `[Needs review]`.

### Hand-checked verdicts on produced fixes

`ai-provider-results/2026-10-29-fix-reviews.json`. The sample is the first proposed rows in list (seeded) order: 8 of 19 OpenAI, 6 of 12 Anthropic and both Gemini rows. Only the edited sites were read. It is a single pass; a second labeler is pending.

| Verdict                                                    | Rows  |
| ---------------------------------------------------------- | ----- |
| Correct                                                    | 14    |
| Partial (the edits are right, but the request still fails) | 2     |
| **Wrong**                                                  | **0** |

- **Correction (same day).** The first version of this review counted one wrong fix: a raw `fetch` to `/v1/messages` that sends `temperature: 0.7`, swapped to `claude-sonnet-5-5`. That was a review error. The proposal also removes the `temperature` line (`replacements[].parameters`, change `anthropic-sampling-4-7`), which the first review script did not print. The fix is correct, and the review script now prints parameter edits.
- **Partial (2).**
  - OpenAI: only the follow-up call of a legacy `functions`/`function_call` flow was swapped, and the first call still sends the retired model.
  - Gemini: the `@google/generative-ai` → `@google/genai` swap maps the client correctly, but it keeps the retired `gemini-pro`, which Refit's registry does not cover.
- **Correct (14):** 10 model swaps (one with a parameter removal) and 4 SDK migrations (openai v3 → v6 client and response shape, `files.del` → `files.delete`, `beta.chat.completions.parse` → `chat.completions.parse`, and one Gemini default swap).

### Alerts raised

0 before (that lane did not exist). After: 23 OpenAI (19 `ft:` fine-tuned models, 4 models set in configuration files), 12 Anthropic (configuration) and 10 Gemini (embedding models). Alerts are reported, never edited (#402).

### AI cost

**$0.** No AI ran: neither lane calls a model, and provider keys are read only by the request-proof workflows (#10, #11). `ai-providers.yml` passes `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` from secrets only with `ai=true`, and refuses less than $0.50 a shard, for any later AI lane.

### Where to improve, ranked by rows it would move toward validated

Each item comes from aggregate stop and outcome counts on these runs. Each is to be designed and checked on the dev sets (`openai-dev-30`, `anthropic-dev-30`, `gemini-dev-15`), never on the measurement rows.

1. **Run validation and request proof (refit-bench #12, #10, #11).** Without them nothing can be validated. This is a merge, not engine work, and it gives the first real validated rate on 33 proposed rows.
2. **Anthropic SDK-major migrations: the `anthropic-2026-10-21-sampling` stop (68 blocking stops in 25 rows).** No Anthropic migration got through. The sampling rule blocks the whole patch wherever a call sets sampling parameters. Next most common are `anthropic-ts-x-api-key-header` (10), `anthropic-ts-text-completions-removed` (9) and `anthropic-ts-companions` (7). A per-call sampling fix (keep the parameter when the target model accepts it, per `data/model-parameters.json`) would unblock most of the 25.
3. **Custom endpoints and base URLs (about 35 OpenAI and 38 Anthropic model-fix stops).** These are the largest single model-fix stop. 40 of the 53 "custom endpoint" stops cite a file under an app route, page, client or service path (`/api/`, `app/`, `client/`, `services/api`), which suggests an app's own backend URL, not a provider proxy. That is a path heuristic and still needs checking on the dev sets. Narrowing "mentions a custom endpoint" to configuration that actually reaches the client would turn many stops into fixes. Safety matters here, so this is an owner decision (`docs/proposals/ai-provider-benchmark-features.md`).
4. **Legacy endpoints are never edited (OpenAI `completions.create` 8 and `createCompletion` 7 stops; 19 legacy-endpoint rows need review).** Completions and Assistants have no rule-based migration. Product proposal: a Completions-to-Chat mapping for single-prompt calls, and Assistants as report-only with a guide.
5. **Gemini `gemini-swap-target` (77 blocking stops in 12 rows) and retired Gemini 1.x models missing from the registry.** The swap blocks when the target cannot be proven, and a successful swap still keeps `gemini-pro` (the partial verdict above). Registry entries for `gemini-pro`, `gemini-1.0-*` and `gemini-1.5-*` from Google's deprecations page, plus a replacement during the swap, would turn swaps into whole fixes.
6. **OpenAI v5 `openai-node-v5-file-from-path` (16 blocking) and `v5-web-response` (5).** File uploads through `fileFromPath` block the migration. A documented mapping to `fs.createReadStream` or `toFile` would unblock them.
7. **Python is detection only (24 + 17 + 7 affected rows).** By decision 3 these can never validate. Report Python separately, or take a decision on Python edits for literal model swaps (`docs/proposals/`).
8. **Robustness: invalid JSON and parse errors in fixture or unrelated files fail the whole scan (2 rows).** Skip unreadable fixture manifests and unparsable files with a stop, as for `.d.ts`. The scan-limit and heap failures (3 rows) should be checked on Actions first.
