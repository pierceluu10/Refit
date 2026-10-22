<!-- refit-report -->
# What `rohitg00/manim-video-generator` depends on

Counted on 2026-10-22 at commit `9c41982e620b`, from files only: Refit ran no code and contacted no provider.

## Next step

Move off `claude-sonnet-4-20250514` now: its sunset was 2026-06-15 (passed 129 days ago). Replacement: `claude-sonnet-5-5`; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call. 2 more deadlines are past due or within 30 days; see Deadlines.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| OpenAI | `openai` in `package.json` | `^4.50.0` | `4.104.0` | Agent available: migrates breaking changes once added |
| Anthropic | `@anthropic-ai/sdk` in `package.json` | `^0.71.2` | `0.71.2` | Proposes model replacements |
| Gemini | `@google/generative-ai` in `package.json` | `^0.21.0` | `0.21.0` | Reports only |

## Deadlines

- **2025-11-30** (passed 326 days ago): Google ends all support for the @google/generative-ai package, including bug fixes, on 2025-11-30 and recommends @google/genai, whose call shapes differ. Google does not say that requests through the old package stop working. The README in its last npm release (0.24.1) gave 2025-08-31; the repository README now gives 2025-11-30. Replacement: `@google/genai`. [Source](https://github.com/google-gemini/deprecated-generative-ai-js/blob/main/README.md)
  - `package.json:15`
- **2026-06-15** (passed 129 days ago): Anthropic retires claude-sonnet-4-20250514 on the Claude API; requests to a retired model fail. Replacement: `claude-sonnet-5-5`. [Source](https://platform.claude.com/docs/en/about-claude/model-deprecations)
  - `src/vision/providers/anthropic-vision.ts:40`
- **2026-10-23** (1 day left): OpenAI shuts down gpt-4.1-nano, gpt-4.1-nano-2025-04-14. Replacement: `gpt-5.6-luna`. [Source](https://developers.openai.com/api/docs/deprecations)
  - `src/agents/math-enricher.step.ts:29`
  - `src/agents/narrative-composer.step.ts:19`
  - `src/agents/prerequisite-explorer.step.ts:19`
  - `src/agents/visual-designer.step.ts:23`
  - `src/api/refine.step.ts:92`
  - …and 3 more lines.
- **2026-11-30** (39 days left): Anthropic retires claude-sonnet-4-5-20250929 on the Claude API; requests to a retired model fail. The claude-sonnet-4-5 alias resolves to that snapshot (Claude Sonnet 4.5 model page). Replacement: `claude-sonnet-5-5`. [Source](https://platform.claude.com/docs/en/about-claude/model-deprecations)
  - `src/providers/anthropic-provider.ts:13`

## AI model calls

- Computed model (anthropic, 3 calls)
  - `src/providers/anthropic-provider.ts:56` `messages.create`
  - `src/providers/anthropic-provider.ts:76` `messages.create`
  - `src/providers/anthropic-provider.ts:118` `messages.create`
- Computed model (openai, 6 calls)
  - `src/providers/deepseek-provider.ts:57` `chat.completions.create`
  - `src/providers/deepseek-provider.ts:79` `chat.completions.create`
  - `src/providers/deepseek-provider.ts:124` `chat.completions.create`
  - `src/providers/openai-provider.ts:57` `chat.completions.create`
  - `src/providers/openai-provider.ts:79` `chat.completions.create`
  - `src/providers/openai-provider.ts:123` `chat.completions.create`

## Hosts Refit does not track

None.