---
provider: upgrades
kind: model-retirement
reviewed: false
drafted: 2026-11-06
sources:
  - https://platform.claude.com/docs/en/about-claude/model-deprecations
  - https://ai.google.dev/gemini-api/docs/deprecations
  - https://developers.openai.com/api/docs/deprecations
  - https://platform.claude.com/docs/en/api/migration-2026-10-21
---

When a provider retires a model, requests start failing, or, on some providers, quietly move to another model. Changing the string is the easy part. The replacement can reject parameters the old model took, count tokens differently, and answer differently. Provider folders have their own notes; these apply to all of them.

**What usually breaks.** Requests that return a 400 because of sampling parameters, thinking settings, forced tool choice or prefill. Code that assumes the first content block is the answer. `max_tokens` limits and budgets tuned to the old model. Stored embeddings, when the embedding model changes. Prompts and evals tuned to the old model's habits.

**How to spot it in code.** Model IDs are plain strings. Search code, config, env templates, prompts, tests, fixtures and database seeds, and look for IDs assembled from parts or read from settings. Check wrappers such as LangChain too. Record every parameter sent alongside the model, since those are what a new generation rejects.

**What to check.**

- `model_replacement` gives the recommended replacement, the retirement date and the request-shape differences for a provider and model, from a dated snapshot and the live page.
- Read the provider's migration guide for the target model. These guides list each rejected setting.
- Update the SDK if the replacement needs it; `registry_diff` shows what that upgrade changes. A new SDK major may move the API version too, as [Anthropic's 2026-10-21 version](https://platform.claude.com/docs/en/api/migration-2026-10-21) does.
- If a test key is available, make one real call. Otherwise say the request shape was only checked against the docs.

**Common pitfalls.**

- Treating a date as firm or as far off. Google says listed dates are the [earliest possible](https://ai.google.dev/gemini-api/docs/deprecations), and that some endpoints route to a replacement and bill at its rates, so nothing fails but behaviour and cost change. Anthropic gives [at least 60 days' notice](https://platform.claude.com/docs/en/about-claude/model-deprecations), and OpenAI [varies its notice by model type](https://developers.openai.com/api/docs/deprecations).
- Platform differences. Anthropic's dates don't cover [Amazon Bedrock or Google-managed Claude models](https://platform.claude.com/docs/en/about-claude/model-deprecations), which set their own schedules and use different IDs.
- Snapshot tests of model output. Never hand-write new snapshots to make them pass; flag them instead.
- Moving down a tier by accident, or up in cost. Check price and limits for the replacement and mention the change.
- Mocks. A test suite that stubs the provider proves nothing about the request shape.

**When you're unsure.** Move to the replacement the provider names. Remove what its guide says is rejected, keep everything else, and list possible output differences under behaviour changes so a person checks them on real prompts.
