---
provider: generic
kind: model-retirement
reviewed: false
drafted: 2026-11-02
sources:
  - https://semver.org/
---

# A model is retired (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** An AI provider retires a model ID (or a dated snapshot of one) and names a replacement. Requests with the old ID start failing after the retirement date. The replacement may differ in price, context window, output limits, supported parameters (temperature, tools, JSON modes, reasoning settings), response format and latency.

**How to spot it in code.** Search for the model ID string in code, config, env templates, database seeds, prompts and tests. IDs are often built from parts (`${family}-${size}`) or passed in from config, so search for the family name too. Note every parameter sent with the model.

**What to check.**

- Read the provider's deprecations or models page with `fetch_changelog` (`query`: the model ID) and `search_docs` for the replacement's parameters and limits.
- If the provider publishes an OpenAPI spec, `openapi_check` the changed request to catch parameters the new model's endpoint does not take.
- If an SDK is used, `package_lookup` shows whether a newer SDK is needed for the new model or its parameters.

**Pitfalls.** Output changes are behaviour changes even when the code compiles: tone, length, JSON adherence and tool-calling style can all differ. Token limits and pricing change cost. Some parameters are rejected by newer model families. Tests that snapshot model output will need new snapshots, which must not be invented.

**When you're unsure.** Move to the replacement the provider names, keep the other parameters unless the docs say they are not supported, and put the model's possible output differences under behaviour changes in the PR so a human checks them.
