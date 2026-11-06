---
provider: google
kind: model-retirement
reviewed: false
drafted: 2026-11-06
sources:
  - https://ai.google.dev/gemini-api/docs/deprecations
  - https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6
  - https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8
  - https://ai.google.dev/gemini-api/docs/thinking
---

Google tracks Gemini API shutdowns on its [deprecations page](https://ai.google.dev/gemini-api/docs/deprecations), and announces them in the release notes. Two things differ from other providers:

- The listed shutdown dates are "the earliest possible dates", with the exact date communicated in advance. Treat them as the point to be ready by.
- Some models route rather than shut down. From December 1, 2026, `gemini-2.5-pro` requests go to `gemini-3.8-flash`, and `gemini-2.5-flash` requests go to `gemini-3.5-flash-lite`, billed at the new model's rates. `gemini-3.7-flash` and `gemini-3.5-flash` already route. Nothing fails, so the repo may look fine while behaviour and cost change. Those routed requests also inherit the breaking API changes.

**Finding usages.** Search for `gemini-`, `imagen-`, `veo-`, `lyria-`, `embedding-` and `text-embedding-` in code, config, env templates and tests, including the `@google/genai` and `google-genai` clients and any wrappers. Note parameters sent with the model, such as `generation_config`, `thinking_budget` and `candidate_count`. Check whether calls use `generateContent` or the Interactions API, since the guides treat them differently. Preview model IDs tend to have much shorter lives than stable ones, so look for `preview` in the ID.

**Checking.** `model_replacement` gives the shutdown date, replacement and request-shape notes from a dated snapshot and the live page.

**Migrating.** Read the guide for the target ([3.8 Flash](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8#migrate-to-gemini-3-8-flash), [3.6 Flash and 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6#migration-checklist)):

- [Sampling parameters](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6#api-changes-and-parameter-updates): `temperature`, `top_p` and `top_k` are deprecated and ignored, and future generations return a 400. Remove them, and add a system instruction if determinism mattered. `candidate_count` also goes.
- Prefill: a request whose last non-empty turn is a `model` turn returns a 400. Use `system_instruction` or structured outputs.
- Thinking: replace `thinking_budget` with `thinking_level`. `gemini-3.8-flash` takes `low`, `medium` or `high`, and `minimal` errors. `gemini-3.5-flash-lite` defaults to `minimal`; the guide suggests `medium` or `high` for tool-using agents.
- Function calling: on `generateContent`, each `FunctionResponse` needs `call_id` and `name`. Check [thought signatures](https://ai.google.dev/gemini-api/docs/thinking#signatures) if the code replays history.

**Pitfalls.** Embedding replacements usually mean re-embedding stored vectors, so flag that for a person rather than swapping the string. Image and video models move to different families: `veo-*` replacements point to `gemini-omni-1.2-flash`, which may be a different API surface, so read its docs. 3.8 Flash can use more tokens on long tasks by design, so note cost. Don't invent output snapshots, and say in the PR that quality needs checking on real prompts.
