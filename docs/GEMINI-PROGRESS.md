# Gemini progress (2026-10-22)

Lane FP10. Before: Gemini was 20% on its checklist in [Provider goals](PROVIDER-GOALS.md#gemini-progress-checklist-2026-10-21), with no model dates because ai.google.dev could not be read on 2026-10-21. PP10 folds the percentages below into that file.

## Model dates

- **Gemini API: read.** `https://ai.google.dev/gemini-api/docs/deprecations` answered on 2026-10-22. `refit deadlines --sync gemini` (new, `pipeline/deadline-sync.ts`) reads its model tables and adds one registry entry per shutdown date and replacement: 31 entries covering 52 dated models, `checkedAt` 2026-10-22. Undated rows ("No shutdown date announced", "N/A") are left out, and so is the managed agents table (agents, not models). A row with several replacements, or none, gets `replacement: null`. The page calls its dates the earliest possible shutdowns, so each summary says "no earlier than this date". A changed table layout fails the read instead of skipping rows. Like `--sync anthropic`, it never deletes an entry.
- **Vertex AI: read, not entered.** `https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions` now redirects to the Gemini Enterprise Agent Platform's "Model versions and lifecycle" page, which answered on 2026-10-22. Its dates differ from the Gemini API's for the same model IDs: for example `gemini-2.5-pro`, `gemini-2.5-flash` and `gemini-2.5-flash-lite` retire on Vertex AI on October 20, 2026 (replacements "gemini-3.8-flash or …"), while the Gemini API lists no shutdown for them; `gemini-3.7-flash` retires on Vertex AI on January 28, 2027 and `gemini-3.6-flash` on November 19, 2026. The registry keys models by provider and ID, and the matcher cannot yet tell a Vertex AI call from a Gemini API call on the same ID, so entering these dates under `gemini` would be wrong. They need a separate provider with platform attribution (`vertexai: true`, `@google-cloud/vertexai`), listed under "Requests" below.

## Report-only call sites

`proposeModelReplacements` (and so `refit deadlines --propose-model-fixes` and the hosted inventory) now traces Gemini model sites through the same resolver as OpenAI and Anthropic, and stops every one with a reason. Nothing is edited (AGENTS.md; pinned by `pipeline/model-retirements.test.ts`):

- `@google/genai`: `models.generateContent`, `models.generateContentStream`, `models.countTokens`, `chats.create` on a `GoogleGenAI` client: "Gemini is report only, so Refit never edits its models (an owner decision); change it by hand to …". Other calls with a model (embeddings, images) stop as calls Refit does not edit.
- `@google/generative-ai`: `genAI.getGenerativeModel({ model })` on a held `GoogleGenerativeAI` client, same reason.
- `@google-cloud/vertexai`: `vertexAI.getGenerativeModel({ model })`: "The client is Vertex AI, whose model retirement dates differ from the Gemini API's; …".
- Constants, `??` and `||` environment fallbacks and the other indirect sources the resolver already follows reach the literal. An inline `new GoogleGenerativeAI(key).getGenerativeModel(...)` is not traced; its literal is listed as not sent by a traced request.

## Benchmark

Set: `docs/benchmarks/2026-10-21-gemini-repos.json` (50 repositories, unchanged). Labels: `docs/benchmarks/2026-10-22-gemini-labels.json`, 20 repositories (seeded order, at most 60 candidate lines each; two larger ones skipped), 395 candidate lines: 60 sent (40 through a Google SDK), 321 not sent, 14 ambiguous. They were committed before either run below. Run: `node scripts/gemini-benchmark.mjs --list … --root … --output …`; score: `npx tsx pipeline/gemini-labels.ts --labels … --results …` (tested in `pipeline/gemini-labels.test.ts`). Results at f067ac1: `docs/benchmarks/2026-10-22-gemini-results.json`.

| Measure (17 labelled repositories Refit can scan)       | Before (main 7b2c86a)   | After (f067ac1) |
| ------------------------------------------------------- | ----------------------- | --------------- |
| Matcher live class, precision                           | 34/59 (57.6%)           | 34/59 (57.6%)   |
| Matcher live class, recall                              | 34/39 (87.2%)           | 34/39 (87.2%)   |
| Pins sent through a Google SDK reached by a traced call | 0/35 (no Gemini tracer) | 13/35 (37.1%)   |
| Traced sites that are labelled sent                     | none                    | 13/14 (92.9%)   |

| Whole set (50 repositories, shipped registry) | Before                          | After                               |
| --------------------------------------------- | ------------------------------- | ----------------------------------- |
| Repositories with a Gemini exposure           | 6 (old SDK end of support only) | 22 (17 with a dated model shutdown) |
| Repositories Refit could not scan             | 6                               | 6                                   |

Read these honestly:

- Three labelled repositories (mastra, xcsh, warlock) exceed Refit's scan limits (10,000 files or 50 MiB of JS/TS), and so do three unlabelled ones; nothing is measured there. One more (code-yeongyu/senpi) crashed the tracer pass on this branch (a Node process abort during `--propose-model-fixes`); its matcher numbers are counted, its tracer numbers are not.
- The matcher was not changed, so its numbers are the same. Ten of its 25 false live pins are end-to-end tests in `system_test/` directories and a `test-integration.ts` file, which `TEST_PATH` does not treat as tests; the rest are option and capability lists, an npm package name (`gemini-zod`), messages built in template strings and example data. All 5 missed live pins are provider-default maps with three or more models, which the matcher reads as catalogs.
- The tracers miss SDK pins mostly where the client or model is out of the resolver's reach: clients stored in nullable class fields set outside the constructor, `https://esm.sh/@google/genai` imports, models picked from maps by an enum key, default options objects, and models passed through the libraries' own provider abstractions.
- The one wrong traced site is a census artefact: the census registry lists every quoted `gemini-…` string, including the server name `gemini-mcp`.

## Checklist

The same ten items as in Provider goals.

| #   | Item                                                                 | Before                         | After                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Catalog entry                                                        | Yes                            | Yes                                                                                                                                                                                                                                     |
| 2   | Reviewed adapter for the calls real code makes                       | No: contract source unverified | No. A contract source now exists and was read: Google's Discovery document for `generativelanguage` v1beta (revision 20261019, 224 schemas). Refit compares OpenAPI with oasdiff, so an adapter needs a Discovery-to-OpenAPI step first |
| 3   | Deadline entries with `source` and `checkedAt`                       | Partly (old SDK only)          | **Yes**: 31 entries from Google's page, kept current by `refit deadlines --sync gemini`                                                                                                                                                 |
| 4   | Deterministic replacement rule with named stops                      | No: owner decision             | No: owner decision. Every Gemini site now stops with a named reason                                                                                                                                                                     |
| 5   | Automatic validated draft pull requests                              | No: owner decision             | No: owner decision                                                                                                                                                                                                                      |
| 6   | Frozen benchmark set                                                 | Yes                            | Yes                                                                                                                                                                                                                                     |
| 7   | Hand-labelled live pins                                              | No                             | **Yes**: 20 repositories                                                                                                                                                                                                                |
| 8   | At least 90% of labelled pins traced                                 | No                             | No: 13/35 (37%)                                                                                                                                                                                                                         |
| 9   | At least 70% of affected repositories with runnable checks validated | No                             | Not applicable while Gemini is report only                                                                                                                                                                                              |
| 10  | No wrong fix on hand review                                          | Not applicable                 | Not applicable                                                                                                                                                                                                                          |
|     | **Done**                                                             | **20%**                        | **40%** (items 1, 3, 6 and 7)                                                                                                                                                                                                           |

## Python

FP10's "Keep going" item, Python `google-genai` patterns, depends on FG1 (#187), which is not merged. FG1 already traces `genai.Client()` calls (`models.generate_content`, `models.generate_content_stream`, `chats.create`, including `client.aio`) as report only, so once both PRs merge, Python Gemini call sites are reported against these registry entries with no further work. Recorded as a request for FG1: confirm after merging that its Gemini reason reads well beside this registry.

## Requests

- Owner: whether Vertex AI dates get their own registry provider, with call-site attribution (`vertexai: true` on `@google/genai`, `@google-cloud/vertexai`). Until then they are only in this document.
- Owner: Gemini replacements stay report only (AGENTS.md); the old-to-new SDK swap too.
- PP10: fold the checklist above into `docs/PROVIDER-GOALS.md` (Gemini 20% → 40%) and the results into `docs/BENCHMARKS.md`.
- Matcher (whoever owns `pipeline/deadline-exposure.ts` next): `TEST_PATH` misses `system_test/` directories and `test-*.ts` files; changing it shifts every provider's measured numbers, so it was not changed in this lane.
