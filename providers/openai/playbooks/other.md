---
provider: openai
kind: other
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/docs/deprecations
  - https://developers.openai.com/api/docs/changelog
---

Most OpenAI changes fit model-retirement, endpoint-removed, field-renamed or sdk-major. Other changes worth knowing: `OpenAI-Beta` header generations (e.g. Realtime beta removed 2026-05-12), stored-by-default behavior in Responses, and prompt-caching pricing changes ([deprecations](https://developers.openai.com/api/docs/deprecations), [changelog](https://developers.openai.com/api/docs/changelog)). Start with `openai_search_docs`, then use `openai_model_lookup` / `openai_check_request` to check concrete ids and bodies.
