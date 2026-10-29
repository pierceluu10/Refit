# Proposal: AI provider changes Refit cannot fix safely yet

Refit (`refit ai-migrations`, `docs/AI-MIGRATIONS.md`) upgrades OpenAI and Anthropic SDK majors where the provider's guide gives a one-to-one mapping, and lists everything else for review. This lists the classes it lists but cannot fix, what a fix would need, and the decision each one waits on. The model-retirement and parameter classes are in ai-models' proposal beside this file.

## 1. Surfaces with no one-to-one mapping (AI under the existing gates)

Found on DEV repositories (`docs/benchmarks/ai-surfaces/review-hand-checks.json`), and all failing today:

- OpenAI Assistants API (shut down 2026-08-26): assistants become dashboard Prompts, threads become Conversations, runs become Responses, and the tool loop moves into the caller.
- OpenAI legacy Completions: every model it served shut down on 2026-09-28. The Responses guide covers Chat Completions only.
- Anthropic Text Completions: removed from the v1 SDK and its models retired. Anthropic no longer publishes the mapping.
- OpenAI Realtime beta (`OpenAI-Beta: realtime=v1`, removed 2026-05-12): the session and event shapes differ.

**Proposed feature:** an AI patch per site, as Stripe's coverage AI does (decisions D2, D2a, D2b): the rules' context and the provider guide as evidence, the target SDK installed, the type oracle with zero new errors, the repository's tests offline, request-level proof of the new call shape, and only traced sites touched. These patches always ship `[Needs review]`. A new model is part of every one of these moves, so the model comes from the deadline registry's replacement, never from the AI.
**Status (2026-10-29):** decided for OpenAI legacy Completions and Assistants and built (`--ai-surfaces`, Actions only, unmeasured). Anthropic Text Completions and the Realtime beta remain open.

## 2. Python SDK majors (openai 0.x → 1.x, google-generativeai, Anthropic Python)

The openai Python v1 guide maps module calls to a client one-to-one (`openai.ChatCompletion.create()` → `client.chat.completions.create()`). Python is report only (language tracer decision, 2026-10-22).
**Proposed feature:** Python edits through the tree-sitter tracer for the mapped calls, under the same blocking-stop rule as JavaScript.
**Decision needed:** let one non-JS/TS tracer produce edits.

## 3. Gemini edits (`@google/generative-ai` → `@google/genai`)

The Gemini migration guide gives the client and call mapping (`getGenerativeModel` + `generateContent` → `ai.models.generateContent`; `response.text()` → `response.text`). Gemini is report only (AGENTS.md).
**Decision needed:** the owner decision named in AGENTS.md.

## 4. SDK upgrades that need a parameter decision

An `@anthropic-ai/sdk` 1.x upgrade sends API version 2026-10-21, which rejects `temperature`, `top_p` and `top_k`. Today the upgrade blocks on them.
**Proposed feature:** run the upgrade after ai-models' parameter rule removes them, in one draft.
**Status (2026-10-29):** decided and built: literal parameters in traced calls are removed with the upgrade; untraceable ones still stop.

## 5. Lockfiles and packages the upgrade refuses

- pnpm, Yarn and Bun lockfiles have no as-of-date resolution, so the upgrade is refused (the same reason as the Stripe lockfile resolution).
- Anthropic platform packages (`@anthropic-ai/bedrock-sdk`, `vertex-sdk`, …) must move to v1 together with the SDK.

**Proposed feature:** pnpm's `minimumReleaseAge` as a relative cutoff, and co-upgrading the platform family as Shopify's SDK family moves together.
**Decision needed:** widen lockfile resolution beyond npm.

## 6. Response fields that need response-read tracing

Anthropic's Admin and Analytics responses rename fields on 2026-10-21 (`roles` → `role_ids`, `group_id` → `rbac_group_id`, …). The mapping is one-to-one, but Refit does not yet trace Anthropic response objects to their endpoint. Stripe's response-read tracing (#378) is the model to follow.

## 7. Graduated betas

Sending a beta name that graduated (such as `files-api-2025-04-14`) still works. Refit lists it as a cleanup and never opens a pull request for it. **Question:** should graduated betas ever produce drafts, or stay in reports?

## 8. Proof keys

Request-level proof needs `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` as refit-bench secrets. Until then every Anthropic draft says its request proof is pending, and why.
