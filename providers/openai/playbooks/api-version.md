---
provider: openai
kind: api-version
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/reference/overview
  - https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
---

OpenAI's own API has **no dated version header or query parameter to pin**. The REST API is `v1` in the path, and OpenAI promises to avoid breaking changes within it. Responses do carry an `openai-version` header (currently `2020-10-01`), but you don't set it ([API overview](https://developers.openai.com/api/reference/overview)). Backwards-compatible changes include new endpoints, new optional params, new response properties, reordered properties, longer opaque ids and new stream event types ([same page](https://developers.openai.com/api/reference/overview)).

So an "API version" migration on OpenAI is really one of:

- a **model** retirement (see the model-retirement playbook and `openai_model_lookup`),
- an **endpoint** removal or replacement (endpoint-removed, e.g. Assistants to Responses),
- a **parameter** deprecation (field-renamed / field-removed, `openai_check_request`),
- an **`OpenAI-Beta` header** generation change, e.g. `assistants=v1` to `v2` (shut down 2024-12-18) or `realtime=v1` removed 2026-05-12 ([deprecations](https://developers.openai.com/api/docs/deprecations)),
- an **SDK major** (sdk-major).

**Robustness checks.** Parsers should tolerate unknown properties and unknown stream event types, since adding them isn't a breaking change by OpenAI's definition. Strict schemas (e.g. zod `.strict()`, pydantic `extra="forbid"`) on API responses can break when OpenAI adds a field.

**Azure OpenAI is different.** It historically required a dated `api-version` query parameter with the `AzureOpenAI` client. Since August 2025 Azure also offers a v1 API at `<endpoint>/openai/v1/` that drops `api-version` and works with the plain `OpenAI()` client ([Azure docs](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)). Treat Azure code (`AzureOpenAI`, `azure_endpoint`, `api_version=`, deployment names as `model`) as its own provider. OpenAI's deprecations page doesn't govern Azure retirement dates.
