# AI provider migrations

`refit ai-migrations` moves an OpenAI or Anthropic JavaScript SDK to its current major and rewrites the calls whose shape changed, using only the mappings in the provider's own migration guides. It covers SDK majors (item 4 of the AI provider goals); API surface migrations, response formats and beta features build on the same rule tables.

## Rule tables

Each rule lives in `data/rules/<provider>/<kind>.json` (`openai`, `anthropic`, `gemini`; kinds `sdk-major`, `api-surface`, `response-format`, `beta-feature`). A rule names the provider page it comes from, quotes it verbatim, and has a status:

- `auto`: Refit may apply it under every gate.
- `review`: Refit finds and explains the site, and never edits it.
- `report`: the provider or language is report only (Gemini and Python, see AGENTS.md); Gemini tables refuse `auto` rules.

The pages are saved under `docs/ai-docs/pages`. `npm run ai-rules:check` proves every quote is on its saved page; `refit ai-migrations --check-rules --live` reads every page again and fails when a quote is gone or a page cannot be read.

## What an SDK major upgrade does

- openai 3.x, 4.x and 5.x move to the newest 6.x release (6.x has no runtime dependencies; 7.0.0 only adds a Node.js 22 requirement). The v3 client, imports, renamed methods, `createTranscription(file, model)` and `.data` reads are rewritten from the v3-to-v4 guide; the v5 renames (`del` to `delete`, `beta.chat.completions` to `chat.completions`, runner events, import paths) from the v5 guide.
- `@anthropic-ai/sdk` 0.5 and later move to the newest 1.x release, the first major that sends API version 2026-10-21. `client.models.list/retrieve` with `betas` moves to `client.beta.models`.
- The package moves in `package.json`, and npm re-resolves `package-lock.json` from the committed one in networked Docker as of the repository's last commit (only the SDK resolves later). The lockfile is kept only when nothing changes outside the SDK and the packages only it reaches. pnpm, Yarn and Bun lockfiles, workspaces and other registries refuse.

## What stops

A stop is blocking when the site would break on the new SDK as it stands. Any blocking stop means no patch at all: Refit never proposes a partial upgrade.

- openai: v3 calls Refit cannot trace to the client, a Configuration with options other than `apiKey` or used elsewhere, results used other than through `.data`, request options (a second argument), v3 type exports, removed endpoints (`createEdit`, fine-tunes, engines), `downloadFile`, positional uploads, unguarded `error.response` reads, `runFunctions`, `fileFromPath`, `httpAgent`, `openai/shims`, old path-parameter forms and `withResponse`/`asResponse`.
- Anthropic: a request that sends `temperature`, `top_p` or `top_k` (2026-10-21 rejects them; removing them is a parameter decision), a body Refit cannot read, an assistant document block, user citations, Text Completions and its prompt markers, `MessageParam` heritage, two credentials, `X-Api-Key` headers, `compactionControl` and a declared platform package.
- Non-blocking: a guarded `error.response` read (it finds nothing on the new SDK and takes the other branch). It is listed in the draft, which is then `[Needs review]`.

## Proof

Every draft reports three levels separately and never claims the new SDK behaves the same; it says outputs may differ and asks for a quality check.

- (a) Code: the repository's approved checks before and after, in offline Docker.
- (b) Request: the smallest request of each migrated call shape, sent with the newest release of the target major and Refit's own key in refit-bench Actions (`refit ai-migrations --prove-table`), stored in `data/sdk-request-proofs.json`. A call without a stored proof keeps the draft `[Needs review]` with the reason; Anthropic proofs stay pending until an `ANTHROPIC_API_KEY` secret exists.
- (c) Output shape: the same requests parse their text, stream, tool call and JSON output where the migrated call uses them.

Run locally with `refit ai-migrations --repository <root> --edits-only` to list the edits and stops without Docker.

## API surfaces, response formats and beta features

`refit ai-migrations --review [--kind api-surface|response-format|beta-feature|sdk-major]` lists the sites whose change has no documented one-to-one mapping, each with its rule, the quoted page and whether it breaks today. Nothing is edited.

- API surfaces (`data/rules/*/api-surfaces.json`): OpenAI Assistants (shut down 2026-08-26) and legacy Completions (every model shut down 2026-09-28), Anthropic Text Completions, Google PaLM (report only).
- Response formats (`response-formats.json`): Anthropic Admin and Analytics field renames on 2026-10-21, `BetaSkill` renamed `BetaContainerSkill`, Gemini `response.text()` (report only).
- Beta features (`beta-features.json`): OpenAI `realtime=v1` (removed 2026-05-12) and `assistants=v1`, Anthropic's retired `context-1m-2025-08-07`, and graduated Anthropic betas (listed as cleanups, which still work).
- SDK swaps that are report only: Python openai 0.x, `@google/generative-ai` and `google-generativeai`.

Python sites, including beta names in Python strings, are always report only. When a file imports both SDKs and a call matches both providers' rules, the finding says the client is unclear. What a fix for these would need is in `docs/proposals/ai-surface-migrations.md`.
