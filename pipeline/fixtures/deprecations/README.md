# Deprecation page fixtures

Byte-exact copies of the providers' deprecation pages, as `refit deadlines --sync` fetches them, saved on 2026-10-22 for `pipeline/deadline-sync.test.ts`. They are listed in `.prettierignore`; replace a file with a fresh download rather than editing it, and update the tests that count its rows.

| File           | Fetched from                                                     |
| -------------- | ---------------------------------------------------------------- |
| `anthropic.md` | https://platform.claude.com/docs/en/about-claude/model-deprecations.md |
| `openai.md`    | https://developers.openai.com/api/docs/deprecations.md          |
| `gemini.md`    | https://ai.google.dev/gemini-api/docs/deprecations.md.txt       |
