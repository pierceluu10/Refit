## Retiring AI models

Refit replaced model IDs that their provider retires, using the replacement in its reviewed deadline registry. Requests to a retired model fail.

| Call | Changed at | Model | Retires | Source |
|---|---|---|---|---|
| `lib/openai.ts:41` `chat.completions.create` | `lib/openai.ts:42` | `gpt-3.5-turbo` → `gpt-5.6-terra` | 2026-10-23 | [provider page](https://developers.openai.com/api/docs/deprecations), checked 2026-10-15 |
| `app/api/chat/route.ts:50` `chat.completions.create` | `app/api/chat/route.ts:51` | `gpt-3.5-turbo` → `gpt-5.6-terra` | 2026-10-23 | [provider page](https://developers.openai.com/api/docs/deprecations), checked 2026-10-15 |
| `app/api/journal/completion/route.ts:14` `createChatCompletion` | `app/api/journal/completion/route.ts:15` | `gpt-3.5-turbo` → `gpt-5.6-terra` | 2026-10-23 | [provider page](https://developers.openai.com/api/docs/deprecations), checked 2026-10-15 |
| `app/api/pdfs/message/route.ts:70` `createChatCompletion` | `app/api/pdfs/message/route.ts:71` | `gpt-3.5-turbo` → `gpt-5.6-terra` | 2026-10-23 | [provider page](https://developers.openai.com/api/docs/deprecations), checked 2026-10-15 |

## Checks

Refit ran the repository's approved checks on `4dadd4021c2d` in offline Docker (`node:22-alpine`), before and after this change:

- Baseline `npm run build`: passed
- Patched `npm run build`: passed

## Not Verified

- A passing check is evidence about that command only. The checks ran without network access, so no request reached OpenAI or Anthropic, and they cannot show how the new model answers.
- A replacement model can change answers, cost, rate limits and supported parameters.

## Rollback

Revert this pull request. It changes only the model IDs in the table above: no dependency, configuration or environment variable.

## Reviewer Checklist

- [ ] Try each changed call against the provider and compare its answers.
- [ ] Confirm `npm run build` exercises the changed calls.

Refit opened this as a draft and never merges it.
