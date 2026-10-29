# AI-provider benchmark results

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
- **Gemini is unchanged.** `gemini-swap-target` blocks the same 12 rows (89 stops, up from 77), and the sampled swap still keeps `gemini-pro`, which is not in the registry.
- **Hand-check re-verified at after-4.** The 15 sampled fixes still proposed are identical to the ones reviewed below: 14 correct, 1 partial (the Gemini swap that keeps `gemini-pro`), **0 wrong**. The old OpenAI partial no longer produces a fix.
- **Alerts are unchanged:** 19 `ft:` and 4 configuration (OpenAI), 12 configuration (Anthropic), 10 embedding (Gemini). **AI cost: $0.** The new `ai-migrations --ai-surfaces` lane for OpenAI Completions and Assistants runs only on Actions with `ai=true`, so it is not in these numbers.

Updated ranking (each item is designed on the dev sets): (1) merge refit-bench #12, #10 and #11 and run validation; (2) the 19 Anthropic rows still blocked by sampling on untraced bodies; (3) Gemini `gemini-swap-target` (12 rows) plus `gemini-pro` and Gemini 1.0 in the registry; (4) custom-endpoint and base-URL stops (owner decision, held for Furqan); (5) the 16 OpenAI `fileFromPath` forms that are not mapped yet; (6) measure the Completions/Assistants AI lane on Actions.

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
