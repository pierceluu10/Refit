---
provider: openai
kind: product-shutdown
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/docs/deprecations
---

Besides models and endpoints, OpenAI has been shutting down whole platform products. All dates are from the [deprecations page](https://developers.openai.com/api/docs/deprecations):

- **Reusable prompts** (`v1/prompts`, `prompt: { id, version }` in Responses): shut down 2026-11-30. Move the prompt text, tools and settings into application code ([entry](https://developers.openai.com/api/docs/deprecations#2026-06-03-reusable-prompts)).
- **Evals platform** (dashboard and `/v1/evals`): read-only from 2026-10-31, shut down 2026-11-30. OpenAI points to Promptfoo as a migration path ([entry](https://developers.openai.com/api/docs/deprecations#2026-06-03-evals-platform)).
- **Agent Builder**: shut down 2026-11-30. ChatKit stays; move to the Agents SDK or ChatGPT Workspace Agents ([entry](https://developers.openai.com/api/docs/deprecations#2026-06-03-agent-builder)).
- **Self-serve fine-tuning**: new jobs are gradually unavailable, and active customers lose job creation on 2027-01-06. Inference on existing fine-tunes continues until the base model retires ([entry](https://developers.openai.com/api/docs/deprecations#update-to-openais-self-serve-fine-tuning)).
- **Videos API / Sora 2**: removed 2026-09-24, no replacement. **Assistants API**: removed 2026-08-26 (see endpoint-removed).

**Spot it.** Grep for `prompt={"id"`, `prompt: { id`, `pmpt_` ids, `client.evals`, `/v1/evals`, graders, `fine_tuning.jobs.create`, `client.videos`, `sora-2`, and Agent Builder workflow ids or exported configs.

**What to do.** There is often no drop-in API replacement, so the migration is a design change: inline the prompts, move eval suites to another harness, replace video generation, or freeze fine-tuning pipelines. Where nothing replaces a feature, the honest outcome may be a PR that removes or feature-flags the dead path, with a clear note on what the team must decide.

**Check.** `openai_check_request` reports endpoint status for paths it knows (`/evals`, `/prompts`, `/videos`, `/assistants`). `openai_search_docs` finds the migration guides. Re-check the live deprecations page close to the date, since timelines can move.
