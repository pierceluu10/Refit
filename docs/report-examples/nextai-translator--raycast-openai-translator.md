<!-- refit-report -->
# What `nextai-translator/raycast-openai-translator` depends on

Counted on 2026-10-22 at commit `13b28b08661a`, from files only: Refit ran no code and contacted no provider.

## Next step

Move off `claude-3-haiku-20240307` now: its sunset was 2026-04-20 (passed 185 days ago). Replacement: `claude-haiku-4-5-20251001`; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call. 1 more deadline is past due or within 30 days; see Deadlines.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| OpenAI | API hosts only |  |  | Agent available: migrates breaking changes once added |
| Anthropic | `@anthropic-ai/sdk` in `package.json` | `^0.19.0` | `0.19.2` | Proposes model replacements |
| Gemini | API hosts only |  |  | Reports only |

## Deadlines

- **2026-04-20** (passed 185 days ago): Anthropic retires claude-3-haiku-20240307 on the Claude API; requests to a retired model fail. Replacement: `claude-haiku-4-5-20251001`. [Source](https://platform.claude.com/docs/en/about-claude/model-deprecations)
  - `src/providers/claude/config.ts:6`
  - `src/providers/claude/config.ts:7`
- **2026-10-23** (1 day left): OpenAI shuts down gpt-3.5-turbo, gpt-3.5-turbo-0125, o4-mini. Replacement: `gpt-5.6-terra`. [Source](https://developers.openai.com/api/docs/deprecations)
  - `src/providers/openai/config.ts:8`
  - `src/providers/openai/config.ts:9`
  - `src/providers/raycast/index.ts:7`

Named only outside live code (tests, comments, catalogs): `anthropic-2024-11-06-claude-1`, `anthropic-2025-07-21-claude-2`, `anthropic-2025-07-21-claude-3-sonnet`, `anthropic-2026-01-05-claude-3-opus`.

## AI model calls

- Computed model (anthropic, 1 call)
  - `src/providers/claude/index.ts:33` `messages.create`

## Hosts Refit does not track

None.
