---
provider: openai
kind: endpoint-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/docs/deprecations
  - https://developers.openai.com/api/docs/assistants/migration
  - https://developers.openai.com/api/docs/guides/migrate-to-responses
---

OpenAI removes whole endpoints less often than models, but it has happened several times. All of them are on the [deprecations page](https://developers.openai.com/api/docs/deprecations):

- **Assistants API** (`/v1/assistants`, `/v1/threads`, runs, run steps, `OpenAI-Beta: assistants=v2`): sunset 2026-08-26. The replacement is Responses + Conversations. The concept map is Assistants to Prompts, Threads to Conversations, Runs to Responses, Run steps to Items ([migration guide](https://developers.openai.com/api/docs/assistants/migration)). Thread history can't be read back after the sunset, so use messages the app stored. Prompt objects are themselves deprecated (shutdown 2026-11-30), so keep instructions and tools in code ([prompts](https://developers.openai.com/api/docs/deprecations#2026-06-03-reusable-prompts)).
- **Completions** (`/v1/completions`) is legacy, and the models it served (`gpt-3.5-turbo-instruct`, `babbage-002`, `davinci-002`) were shut down 2026-09-28 ([entry](https://developers.openai.com/api/docs/deprecations#2025-09-26-legacy-gpt-model-snapshots)). Move `prompt` strings to Responses `input` (or Chat `messages`).
- **Edits** (`/v1/edits`), the original **fine-tunes** (`/v1/fine-tunes`) and **Engines** / search / classifications / answers were removed in 2024 and 2022 ([edits](https://developers.openai.com/api/docs/deprecations#2023-07-06-gpt-and-embeddings), [engines](https://developers.openai.com/api/docs/deprecations#2022-06-03-legacy-endpoints)).
- **Videos API** and Sora 2 were removed 2026-09-24 with no replacement. `/v1/audio/translations` shuts down 2027-02-26 (use `v1/realtime/translations`). The Realtime beta (`OpenAI-Beta: realtime=v1`) was removed 2026-05-12.

**Spot it.** Grep for SDK namespaces (`beta.assistants`, `beta.threads`, `completions.create(` without `chat.`, `edits.create`, `Engine`, `fine_tunes`), raw paths (`/v1/assistants`, `/v1/completions`, `/v1/edits`, `/v1/engines`), and `OpenAI-Beta` headers.

**Check and migrate.** `openai_check_request` with the old endpoint prints its status and replacement, and for Chat to Responses it maps each parameter in the body (messages to input, response_format to text.format, reasoning_effort to reasoning.effort, max_completion_tokens to max_output_tokens) ([guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)). Use `openai_search_docs` for the target API's shape.

**Pitfalls.** Responses returns typed output Items, not `choices`. Tool results need the matching `call_id`. `previous_response_id` doesn't carry `instructions`. Stored-by-default behavior differs, so set `store: false` if the old flow relied on no storage ([guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)).
