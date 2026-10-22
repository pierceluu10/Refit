<!-- refit-report -->
# What `kgoedecke/doop` depends on

Counted on 2026-10-22 at commit `0f274ac01b21`, from files only: Refit ran no code and contacted no provider.

## Next step

Plan to move off `v21.0` before 2027-01-21 (91 days left). Replacement: a newer Graph API version.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| Stripe | `stripe` in `package.json` | `21.0.1` |  | Agent available: migrates breaking changes once added |
| OpenAI | API hosts only |  |  | Agent available: migrates breaking changes once added |
| Anthropic | `@anthropic-ai/sdk` in `package.json` | `^0.115.0` |  | Proposes model replacements |
| Gemini | API hosts only |  |  | Reports only |
| Meta Graph API | API hosts only |  |  | Reports only |

Stripe API versions pinned in code: 4 computed.

## Deadlines

- **2027-01-21** (91 days left): Meta Graph API v21.0 stops being available on this date. Replacement: a newer Graph API version. [Source](https://developers.facebook.com/docs/graph-api/changelog)
  - `server/meta.ts:23`: `const GRAPH = 'https://graph.facebook.com/v21.0'`

## AI model calls

- Computed model (anthropic, 4 calls)
  - `server/backgrounds.ts:577` `beta.messages.create`
  - `server/agentModel.ts:104` `messages.stream`
  - `server/distill.ts:46` `messages.create`
  - `server/distill.ts:159` `messages.create`

## Hosts Refit does not track

None.
