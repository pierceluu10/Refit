<!-- refit-report -->
# What `getmaxun/maxun` depends on

Counted on 2026-10-22 at commit `4347a8f96b48`, from files only: Refit ran no code and contacted no provider.

## Next step

Move off `claude-3-5-haiku-20241022` now: its sunset was 2026-02-19 (passed 245 days ago). Replacement: `claude-haiku-4-5-20251001`; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| OpenAI | API hosts only |  |  | Agent available: migrates breaking changes once added |
| Anthropic | `@anthropic-ai/sdk` in `package.json` | `^0.71.2` |  | Proposes model replacements |

## Deadlines

- **2026-02-19** (passed 245 days ago): Anthropic retires claude-3-5-haiku-20241022 on the Claude API; requests to a retired model fail. Replacement: `claude-haiku-4-5-20251001`. [Source](https://platform.claude.com/docs/en/about-claude/model-deprecations)
  - `server/src/workflow-management/classes/DocumentInterpreter.ts:1478`: `const model = config.model || 'claude-3-5-haiku-20241022';`

## AI model calls

- Computed model (anthropic, 6 calls)
  - `server/src/sdk/aiExtract/llmClient.ts:114` `messages.create`
  - `server/src/sdk/browserAgent.ts:409` `messages.create`
  - `server/src/sdk/browserAgent.ts:537` `messages.create`
  - `server/src/workflow-management/classes/DocumentInterpreter.ts:1481` `messages.create`
  - `server/src/sdk/anthropicToolHelper.ts:81` `messages.create`
  - `server/src/utils/summarizer.ts:73` `messages.create`

## Hosts Refit does not track

None.
