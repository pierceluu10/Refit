<!-- refit-report -->
# What `viperrcrypto/Siftly` depends on

Counted on 2026-10-22 at commit `b25daa45b858`, from files only: Refit ran no code and contacted no provider.

## Next step

Move off `gpt-4` before 2026-10-23 (1 day left). Replacement: `gpt-5.6-sol`; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| OpenAI | `openai` in `package.json` | `^6.27.0` | `6.27.0` | Agent available: migrates breaking changes once added |
| Anthropic | `@anthropic-ai/sdk` in `package.json` | `^0.78.0` | `0.78.0` | Proposes model replacements |

## Deadlines

- **2026-10-23** (1 day left): OpenAI shuts down gpt-4, gpt-4-0613, gpt-4-turbo, gpt-4-turbo-2024-04-09, gpt-4o-2024-05-13, o1, o1-2024-12-17, o1-pro, o3-mini. Replacement: `gpt-5.6-sol`. [Source](https://developers.openai.com/api/docs/deprecations)
  - `lib/vision-analyzer.ts:68`

Named only outside live code (tests, comments, catalogs): `openai-2026-10-23-gpt-3-5-turbo`, `openai-2026-10-23-gpt-4-1-nano`.

## AI model calls

No OpenAI or Anthropic text-generation calls traced.

## Hosts Refit does not track

None.
