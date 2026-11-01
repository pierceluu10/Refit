---
provider: openai
kind: model-retirement
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/docs/deprecations
  - https://developers.openai.com/api/docs/models/all
  - https://developers.openai.com/api/docs/guides/latest-model
---

OpenAI retires models on a published schedule. Every retirement is a row on the [deprecations page](https://developers.openai.com/api/docs/deprecations) with a shutdown date and a recommended replacement. Generally available models get at least 6 months notice, specialized variants (chat-latest, codex, deep-research) at least 3 months, and anything with `preview` in the name can go with about 2 weeks notice ([notice periods](https://developers.openai.com/api/docs/deprecations#model-deprecation-notice-periods)). After shutdown, calls fail rather than silently falling back.

**Finding usages.** Model ids are plain strings, so grep for them: `model=`, `model:`, `"model"`, env vars like `OPENAI_MODEL`, config files (YAML/JSON/.env.example), LangChain/LlamaIndex wrappers (`ChatOpenAI(model_name=...)`), tests and fixtures, and fine-tuned ids (`ft:gpt-4o-mini-2024-07-18:org::id`), which follow the base model's schedule. Also look for aliases: `gpt-4o` pointed to `gpt-4o-2024-08-06` on 2026-11-01 and inherits its 2027-01-14 shutdown ([model page](https://developers.openai.com/api/docs/models/gpt-4o)).

**Checking.** Call `openai_model_lookup` with each id (it handles aliases, snapshots, `ft:` ids and unknown ids) to get status, dates, replacement and supported endpoints. `GET /v1/models` also returns a `shutdown_date` per model ([monitoring note](https://developers.openai.com/api/docs/deprecations)).

**Migrating.** The replacement is often a different generation, so the request shape may change too:

- Newer GPT-5/6 models are reasoning models. When reasoning effort is not `none`, drop `temperature`, `top_p`, `top_logprobs` (and `logprobs` on Chat), and use `max_completion_tokens` / `max_output_tokens` instead of `max_tokens` ([GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model)). Run `openai_check_request` with the new model.
- GPT-6 Astra and 6.1 Sol reject effort `none`; tool calling on Astra / 6.1 Sol / 6.1 Terra needs the Responses API ([same guide](https://developers.openai.com/api/docs/guides/latest-model)).
- Embedding replacements change vector dimensions, so stored vectors need re-embedding, not just a string swap.
- Transcription and TTS models are moving to Realtime-family replacements (`gpt-transcribe`, `gpt-realtime-2.1-mini`), which can be a different API surface ([2026-08-26](https://developers.openai.com/api/docs/deprecations#2026-08-26-transcription-models), [2026-10-01](https://developers.openai.com/api/docs/deprecations#2026-10-01-text-to-speech-models)).

**Pitfalls.** Pin a dated snapshot rather than an alias if behavior matters. Cost and context limits differ between models. Note in the PR that output quality should be checked on real prompts; a string swap that compiles is not proof the behavior is the same.
