---
provider: openai
kind: field-renamed
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/openai/openai-openapi/blob/main/openapi.json
  - https://developers.openai.com/api/docs/guides/latest-model
  - https://developers.openai.com/api/docs/guides/migrate-to-responses
---

OpenAI rarely deletes a request parameter outright. Usually it adds a replacement and marks the old one deprecated in the [public OpenAPI spec](https://github.com/openai/openai-openapi), and the old one keeps working for a while. Renames you will meet:

- Chat `functions` / `function_call` became `tools` / `tool_choice`. Each function moves under `{type: "function", function: {...}}` (spec descriptions).
- `max_tokens` became `max_completion_tokens` on Chat, and is not compatible with o-series and reasoning models. Responses uses `max_output_tokens` ([reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)).
- `user` became `safety_identifier` (a hashed end-user id) plus `prompt_cache_key` for cache bucketing ([safety identifiers](https://developers.openai.com/api/docs/guides/safety-best-practices)).
- `prompt_cache_retention` became `prompt_cache_options.ttl` ([GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model)).
- Fine-tuning `hyperparameters` moved under `method` (spec).
- Moving Chat to Responses renames a lot: `messages` to `input` / `instructions`, `response_format` to `text.format`, `reasoning_effort` to `reasoning.effort`, `verbosity` to `text.verbosity` ([migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)).

**Spot it.** Grep for the old keys in request bodies, SDK kwargs, and typed param objects (`ChatCompletionCreateParams`, `ChatCompletionNewParams` in Go). Also check wrapper libraries that set them for you, e.g. LangChain's `max_tokens`.

**Check.** `openai_check_request` lists deprecated keys with their replacements, flags unknown keys with did-you-mean, and with `live: true` reads the current spec. `openai_search_docs` finds the guide text.

**Pitfalls.** Some renames change meaning, not just the name: `max_completion_tokens` counts hidden reasoning tokens, so an old small `max_tokens` value can produce empty output on reasoning models. Responses tools are internally tagged and strict by default. Nested shapes aren't validated by the tool, so read the reference for those.
