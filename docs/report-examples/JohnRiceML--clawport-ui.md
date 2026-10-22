<!-- refit-report -->
# What `JohnRiceML/clawport-ui` depends on

Counted on 2026-10-22 at commit `40db84d69b79`, from files only: Refit ran no code and contacted no provider.

## Next step

Plan to move off `tts-1` before 2027-01-06 (76 days left). Replacement: `gpt-realtime-2.1-mini`; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| OpenAI | `openai` in `package.json` | `^6.25.0` | `6.25.0` | Agent available: migrates breaking changes once added |
| Anthropic | API hosts only |  |  | Proposes model replacements |

## Deadlines

- **2027-01-06** (76 days left): OpenAI shuts down tts-1, tts-1-hd. Replacement: `gpt-realtime-2.1-mini`. [Source](https://developers.openai.com/api/docs/deprecations)
  - `app/api/tts/route.ts:18`: `model: 'tts-1',`
- **2027-02-26** (127 days left): OpenAI shuts down whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe. Replacement: `gpt-transcribe`. [Source](https://developers.openai.com/api/docs/deprecations)
  - `app/api/transcribe/route.ts:21`: `model: 'whisper-1',`

Named only outside live code (tests, comments, catalogs): `anthropic-2026-11-30-claude-sonnet-4-5`.

## AI model calls

- Computed model (openai, 2 calls)
  - `app/api/chat/[id]/route.ts:90` `chat.completions.create`
  - `app/api/kanban/chat/[id]/route.ts:88` `chat.completions.create`

## Hosts Refit does not track

None.
