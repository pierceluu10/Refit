<!-- refit-report -->
# What `pdovhomilja/nextcrm-app` depends on

Counted on 2026-10-22 at commit `ade5fcfb8137`, from files only: Refit ran no code and contacted no provider.

## Next step

Add the OpenAI agent with `refit agents --add openai` and approve the repository, so Refit can propose migrations for its breaking changes.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| OpenAI | `openai` in `package.json` | `^6.25.0` | `6.32.0` | Agent available: migrates breaking changes once added |
| Resend | `resend` in `package.json` | `6.9.2` | `6.9.2` | Reports only |

## Deadlines

No live code depends on a deadline in the registry.

Named only outside live code (tests, comments, catalogs): `openai-2026-10-23-gpt-4`.

## AI model calls

- `gpt-4o-mini` (openai, 3 calls)
  - `actions/crm/targets/suggest-mapping.ts:107` `chat.completions.create`
  - `inngest/functions/documents/enrich-document.ts:174` `chat.completions.create`
  - `inngest/functions/documents/enrich-document.ts:197` `chat.completions.create`
- `gpt-5` (openai, 5 calls)
  - `lib/enrichment/services/openai.ts:141` `chat.completions.create`
  - `lib/enrichment/services/openai.ts:375` `chat.completions.create`
  - `lib/enrichment/services/openai.ts:836` `chat.completions.create`
  - `lib/enrichment/services/openai.ts:1068` `chat.completions.create`
  - `lib/enrichment/agent-architecture/core/agent-base.ts:80` `chat.completions.create`
- `gpt-5-mini` (openai, 4 calls)
  - `lib/enrichment/services/openai.ts:766` `chat.completions.create`
  - `lib/enrichment/services/openai.ts:903` `chat.completions.create`
  - `lib/enrichment/services/openai.ts:975` `chat.completions.create`
  - `lib/enrichment/services/openai.ts:1009` `chat.completions.create`

## Hosts Refit does not track

None.
