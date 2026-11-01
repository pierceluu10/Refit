---
provider: openai
kind: sdk-major
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/openai/openai-python/discussions/742
  - https://github.com/openai/openai-node/discussions/217
  - https://github.com/openai/openai-node/blob/main/MIGRATION.md
  - https://github.com/openai/openai-python/blob/main/CHANGELOG.md
  - https://github.com/openai/openai-node/blob/main/CHANGELOG.md
---

The official SDKs follow semver ([backwards compatibility](https://developers.openai.com/api/reference/overview)). On 2026-11-01 the latest were openai-python v3.42.0 and openai-node v7.47.0. The two big rewrites were python v0 to v1 and node v3 to v4. Later majors are narrower.

**Spot the version.** Check `requirements*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock` or `package.json` and the lockfile for `openai`. Old python looks like `import openai; openai.ChatCompletion.create(...)`, `openai.api_key = ...`, `response["choices"]`, `openai.error.*`, `acreate`. Old node looks like `new OpenAIApi(new Configuration({...}))`, `openai.createChatCompletion(...)`, `res.data.choices`.

**What changed.**

- python 1.0.0 (2023-11-06): explicit `client = OpenAI()`, pydantic responses (no dict indexing; use `.model_dump()`), `AsyncOpenAI` instead of `a*` methods, `openai.InvalidRequestError` became `BadRequestError`, auto-paginating `list()` ([guide](https://github.com/openai/openai-python/discussions/742)).
- python 2.0.0 (2025-09-30): tool call output items' `output` can be a string or an array of parts. python 3.0.0 (2026-08-12): HTTPX2 is the default client and `httpx` is no longer installed, so custom `http_client=httpx.Client(...)` must move ([changelog](https://github.com/openai/openai-python/blob/main/CHANGELOG.md), [v3.0.0](https://github.com/openai/openai-python/releases/tag/v3.0.0)).
- node 4.0.0 (2023-08-16): `import OpenAI from 'openai'`, `chat.completions.create`, no `.data`, `OpenAI.APIError` ([guide](https://github.com/openai/openai-node/discussions/217)).
- node 5.0.0 (2025-05-29): built-in fetch, `del()` became `delete()`, named path params for multi-ID methods, `httpAgent` became `fetchOptions`, `beta.chat` and `runFunctions` removed ([MIGRATION.md](https://github.com/openai/openai-node/blob/main/MIGRATION.md)). node 6.0.0 widened tool output types the same way as python 2. node 7.0.0 (2026-07-27) requires Node.js 22 ([changelog](https://github.com/openai/openai-node/blob/main/CHANGELOG.md)).

**Tools.** `openai_sdk_migration` scans a snippet or repo file for these shapes and prints replacements. The official grit codemods (`openai migrate`, `npm exec openai migrate`) did most of the v1/v4 work. Review their diffs carefully.

**Pitfalls.** A major SDK bump often lands alongside model retirements and removed endpoints (e.g. `edits`, `fine_tunes`, assistants). Run `openai_model_lookup` and `openai_check_request` on what the calls send. Mocks in tests often encode the old dict or `.data` shapes, so update fixtures too. Check that the CI runtime meets the new minimum (Node 22 for v7).
