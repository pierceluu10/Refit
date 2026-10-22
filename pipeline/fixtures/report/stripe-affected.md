<!-- refit-report -->
# What `JiantaoFu/insightly` depends on

Counted on 2026-10-22 at commit `e752d3c31178`, from files only: Refit ran no code and contacted no provider.

## Next step

Move off `gpt-3.5-turbo` before 2026-10-23 (1 day left). Replacement: `gpt-5.6-terra`; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call. 1 more deadline is past due or within 30 days; see Deadlines.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| Stripe | `stripe` in `package.json` | `^18.2.1` | `18.2.1` | Agent available: migrates breaking changes once added |
| OpenAI | `openai` in `package.json` | `^4.28.4` | `4.80.1` | Agent available: migrates breaking changes once added |
| Gemini | `@google/generative-ai` in `package.json` | `^0.21.0` | `0.21.0` | Reports only |

Stripe API versions pinned in code: `2023-10-16`.

## Deadlines

- **2025-11-30** (passed 326 days ago): Google ends all support for the @google/generative-ai package, including bug fixes, on 2025-11-30 and recommends @google/genai, whose call shapes differ. Google does not say that requests through the old package stop working. The README in its last npm release (0.24.1) gave 2025-08-31; the repository README now gives 2025-11-30. Replacement: `@google/genai`. [Source](https://github.com/google-gemini/deprecated-generative-ai-js/blob/main/README.md)
  - `package.json:27`: `@google/generative-ai 0.21.0 (locked in package-lock.json) is declared in dependencies`
- **2026-10-23** (1 day left): OpenAI shuts down gpt-3.5-turbo, gpt-3.5-turbo-0125, o4-mini. Replacement: `gpt-5.6-terra`. [Source](https://developers.openai.com/api/docs/deprecations)
  - `server/llmProviders.js:102`: `defaultModel: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',`
  - `src/components/ProviderModelSelector.tsx:10`: `defaultModel: 'gpt-3.5-turbo',`

Named only outside live code (tests, comments, catalogs): `openai-2026-10-23-gpt-4`.

## AI model calls

No OpenAI or Anthropic text-generation calls traced.

## Hosts Refit does not track

None.