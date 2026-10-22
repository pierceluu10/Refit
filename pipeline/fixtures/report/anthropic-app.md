<!-- refit-report -->
# What `yayasoumah/pocket-server` depends on

Counted on 2026-10-22 at commit `10854b5ebc20`, from files only: Refit ran no code and contacted no provider.

## Next step

Move off `claude-sonnet-4-20250514` now: its sunset was 2026-06-15 (passed 129 days ago). Replacement: `claude-sonnet-5-5`; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| OpenAI | `openai` in `package.json` | `^5.19.1` | `5.19.1` | Agent available: migrates breaking changes once added |
| Anthropic | `@anthropic-ai/sdk` in `package.json` | `^0.67.0` | `0.67.0` | Proposes model replacements |

## Deadlines

- **2026-06-15** (passed 129 days ago): Anthropic retires claude-sonnet-4-20250514 on the Claude API; requests to a retired model fail. Replacement: `claude-sonnet-5-5`. [Source](https://platform.claude.com/docs/en/about-claude/model-deprecations)
  - `src/agent/anthropic/streaming.ts:127`: `model: 'claude-sonnet-4-20250514',`
  - `src/agent/providers/anthropic/adapter.ts:45`: `model: 'claude-sonnet-4-20250514',`
- **2026-11-30** (39 days left): Anthropic retires claude-sonnet-4-5-20250929 on the Claude API; requests to a retired model fail. The claude-sonnet-4-5 alias resolves to that snapshot (Claude Sonnet 4.5 model page). Replacement: `claude-sonnet-5-5`. [Source](https://platform.claude.com/docs/en/about-claude/model-deprecations)
  - `src/agent/anthropic/anthropic.ts:80`: `model: 'claude-sonnet-4-5',`
  - `src/agent/anthropic/anthropic.ts:274`: `model: 'claude-sonnet-4-5',`
  - `src/agent/anthropic/anthropic.ts:720`: `model: 'claude-sonnet-4-5',`
  - `src/agent/core/title.ts:21`: `model: 'claude-sonnet-4-5',`

## AI model calls

- `claude-sonnet-4-5` (anthropic, 1 call)
  - `src/agent/core/title.ts:20` `messages.create`

## Hosts Refit does not track

None.