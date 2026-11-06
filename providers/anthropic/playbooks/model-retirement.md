---
provider: anthropic
kind: model-retirement
reviewed: false
drafted: 2026-11-06
sources:
  - https://platform.claude.com/docs/en/about-claude/model-deprecations
  - https://platform.claude.com/docs/en/about-claude/models/migration-guide
  - https://platform.claude.com/docs/en/api/migration-2026-10-21
  - https://platform.claude.com/docs/en/models/opus-5-5/migration-guide
  - https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
  - https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
---

Anthropic lists every model's state and retirement date on its [deprecations page](https://platform.claude.com/docs/en/about-claude/model-deprecations), with a recommended replacement once a model is deprecated. Requests to a retired model fail. Customers get at least 60 days' notice for publicly released models. Those dates cover Anthropic-operated platforms. Amazon Bedrock and Google-managed Claude models set their own schedules, so check the platform before relying on a date.

**Finding usages.** Search for `claude-` in code, config, env templates and tests. IDs differ by platform: `anthropic.claude-haiku-5-5` on Bedrock, `claude-haiku-4-5@20251001` on Google-managed ([table](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)). Note every parameter sent with the model, plus the SDK version and any `anthropic-version` header. The Console's Usage export breaks usage down by key and model, if a person can reach it.

**Checking.** `model_replacement` gives the status, date, replacement and request-shape notes. A status of "Active" with a date reads "not sooner than", which is an earliest date and not a deadline.

**Migrating.** Replacements are often a generation or more ahead, so read the [migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide) for the target:

- Sampling: `temperature`, `top_p` and `top_k` return a 400 on [API version `2026-10-21`](https://platform.claude.com/docs/en/api/migration-2026-10-21#sampling-parameters), even at default values, and on Claude 4.7 and later on earlier versions at non-default values.
- Thinking: [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide) rejects `{"type": "disabled"}` and `budget_tokens`, and effort controls depth. [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide) rejects budgets and `disabled` too.
- Forced tool choice (`any` or a named `tool`) and assistant prefill are rejected on Opus 5.5 and Sonnet 5.5. Prefill is also rejected on [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide). Structured outputs or system prompt instructions are the suggested replacement.
- Reading responses: thinking blocks can come first, so select text by block `type`, not by position.
- Haiku 5.5: the same text produces about 30 percent more tokens than on Haiku 4.5, so recheck `max_tokens` and cost. Handle `stop_reason: "refusal"`.

**SDK and API version.** Moving to `2026-10-21` needs [`anthropic` 2.0.0 or `@anthropic-ai/sdk` 1.0.0](https://platform.claude.com/docs/en/api/migration-2026-10-21), which have code changes of their own; `registry_diff` shows them. On Bedrock, that version is available only for Claude 4.7 and later models. Document blocks directly in assistant messages and citations in user messages also return a 400.

**Pitfalls.** Tests that mock the client prove nothing about request shape. Don't invent output snapshots. Note in the PR that output should be checked on real prompts, and name any change in price tier.
