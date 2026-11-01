---
provider: openai
kind: field-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/docs/guides/latest-model
  - https://github.com/openai/openai-openapi/blob/main/openapi.json
  - https://developers.openai.com/api/docs/guides/migrate-to-responses
---

On OpenAI, a "removed field" is usually a parameter that a newer model or API rejects, not one deleted from the API as a whole. Typical cases:

- **Sampling params on reasoning models.** When reasoning effort isn't `none`, `temperature`, `top_p` and `top_logprobs` must go. On Chat, `logprobs` must go too. On Responses, drop `message.output_text.logprobs` from `include` ([GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model)). Sending them can return HTTP 400.
- **Unsupported effort values.** GPT-6 Astra and GPT-6.1 Sol reject `none` ([same guide](https://developers.openai.com/api/docs/guides/latest-model)).
- **Image params for retired DALL-E models.** `response_format` and `style` on images are legacy and unsupported for GPT image models, which always return base64 (spec descriptions in the [OpenAPI spec](https://github.com/openai/openai-openapi)).
- **`n` (multiple choices)** has no Responses equivalent ([migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)).
- **Response fields.** Moving to Responses removes `choices[]`. Read `output_text` or the typed `output` Items instead.

**Spot it.** Look at the request builder next to each model string: `temperature=`, `top_p=`, `logprobs=`, `n=`, `style=`, `response_format=` on images, and code that reads `choices[0]` or `data[0].url` (base64 vs URL).

**Check.** `openai_check_request` with the new model id and body reports which keys a reasoning model will reject, and which keys aren't in the spec. `openai_model_lookup` confirms which endpoints the model supports.

**Pitfalls.** Removing `temperature` changes behavior, and that's intended. Mention it in the PR. If code returned image URLs to a client, switching to base64 changes the response contract downstream. Feature flags or config may inject these params at runtime, so search config as well as code.
