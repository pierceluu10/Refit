<!-- refit-report -->
# What `fogbender/b2b-saaskit` depends on

Counted on 2026-10-22 at commit `148385ddf8a0`, from files only: Refit ran no code and contacted no provider.

## Next step

Move off `gpt-3.5-turbo` before 2026-10-23 (1 day left). Replacement: `gpt-5.6-terra`; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call. 1 more deadline is past due or within 30 days; see Deadlines.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| Stripe | `stripe` in `package.json` | `^12.12.0` | `12.12.0` | Agent available: migrates breaking changes once added |
| OpenAI | API hosts only |  |  | Agent available: migrates breaking changes once added |

## Deadlines

- **2026-10-23** (1 day left): OpenAI shuts down gpt-3.5-turbo, gpt-3.5-turbo-0125, o4-mini. Replacement: `gpt-5.6-terra`. [Source](https://developers.openai.com/api/docs/deprecations)
  - `src/components/app/Prompt.tsx:224`
  - `src/lib/trpc/routers/prompts.ts:352`
- **2026-10-23** (1 day left): OpenAI shuts down gpt-4, gpt-4-0613, gpt-4-turbo, gpt-4-turbo-2024-04-09, gpt-4o-2024-05-13, o1, o1-2024-12-17, o1-pro, o3-mini. Replacement: `gpt-5.6-sol`. [Source](https://developers.openai.com/api/docs/deprecations)
  - `src/db/schema.ts:55`
  - `src/lib/trpc/routers/prompts.ts:352`
  - `src/lib/trpc/routers/settings.ts:42`

## AI model calls

No OpenAI or Anthropic text-generation calls traced.

## Hosts Refit does not track

None.
