# AI provider migrations

`refit ai-migrations` moves an OpenAI or Anthropic JavaScript SDK to its current major and rewrites the calls whose shape changed, using only the mappings in the provider's own migration guides. It covers SDK majors (item 4 of the AI provider goals); API surface migrations, response formats and beta features build on the same rule tables.

## Rule tables

Each rule lives in `data/rules/<provider>/<kind>.json` (`openai`, `anthropic`, `gemini`; kinds `sdk-major`, `api-surface`, `response-format`, `beta-feature`). A rule names the provider page it comes from, quotes it verbatim, and has a status:

- `auto`: Refit may apply it under every gate.
- `review`: Refit finds and explains the site, and never edits it.
- `report`: the language is report only (Python, see AGENTS.md). Gemini `auto` rules are limited to the documented SDK swap (`gemini-swap-*` families).

The pages are saved under `docs/ai-docs/pages`. `npm run ai-rules:check` proves every quote is on its saved page; `refit ai-migrations --check-rules --live` reads every page again and fails when a quote is gone or a page cannot be read.

## What an SDK major upgrade does

- openai 3.x, 4.x and 5.x move to the newest 6.x release (6.x has no runtime dependencies; 7.0.0 only adds a Node.js 22 requirement). The v3 client (with `apiKey`, `organization` and `basePath`, which becomes `baseURL`; quoted from the v3 and v4 sources' option docs), imports, renamed methods, `createTranscription(file, model)` and `.data` reads are rewritten from the v3-to-v4 guide; the v5 renames (`del` to `delete`, `beta.chat.completions` to `chat.completions`, runner events, import paths) from the v5 guide.
- `@anthropic-ai/sdk` 0.5 and later move to the newest 1.x release, the first major that sends API version 2026-10-21. `client.models.list/retrieve` with `betas` moves to `client.beta.models`. Platform packages declared at the root (`@anthropic-ai/bedrock-sdk`, `vertex-sdk`, `foundry-sdk`, `aws-sdk`, `google-cloud-sdk`) move to their newest v1 in the same upgrade, as the 2026-10-21 guide says, and the lockfile guard covers them too; a platform client given a credential option stops, since v1 throws on one its platform does not take.
- `@google/generative-ai` is replaced by the newest `@google/genai` 2.x (owner decision of 2026-10-29: Gemini edits need a quoted source and a passing request-level proof, otherwise the draft is `[Needs review]`). Only the guide's one-to-one JavaScript shapes are rewritten: `new GoogleGenerativeAI(key)` → `new GoogleGenAI({ apiKey: key })`; a `const` model from `getGenerativeModel({ model })`, used in the same file only for `generateContent(prompt)` or `generateContentStream(prompt)`, becomes `ai.models.generateContent({ model, contents: prompt })`; `result.response.text()` → `result.text`; a stream is iterated directly and `chunk.text()` becomes `chunk.text`. Generation config, safety settings, system instructions, tools, chat, files, caches, embeddings, request objects, other response reads and models shared across files block the swap.
- The package moves in `package.json`, and the project's own package manager re-resolves its committed lockfile in networked Docker with lifecycle scripts off (`pipeline/lockfile-resolution.ts`). The lockfile change touches only the moved packages and their own dependencies:
  - **npm** (`package-lock.json` v3) re-resolves as of the repository's last commit, so only the SDK resolves later. Re-resolving the whole tree also re-hoists packages the old SDK pulled up, adds other platforms' optional binaries the committed lockfile left out and repairs unrelated drift. When it moves anything outside the upgrade, Refit keeps every other entry as committed and takes only the moved packages' own dependencies from npm's result (`pipeline/scoped-lockfile.ts`): a release the project already locks where Node looks is reused when the range takes it; otherwise npm's release is added at the top, or nested below the package that needs it when another release holds that place. Every dependency of the added entries must then resolve, as Node resolves it, to a release its range accepts. A peer is never nested, so a peer the project locks below the new SDK's range (an optional one that is installed, too: `zod` or `ws` for openai 6) stops with the peer, the range and the locked release. Lockfile version 2 stops: its npm 6 tree is not grafted.
  - **pnpm, Yarn 1, Yarn Berry and Bun** run the release preparation installs with: the `packageManager` pin, else preparation's default for the lockfile. The project is read as preparation reads it (the same lockfile choice among several, the same refusals), and pnpm keeps its committed `autoInstallPeers` and `excludeLinksFromLockfile`. The result is compared as a graph (`pipeline/lockfile-graph.ts`, from #417): it is kept only when every importer's other declarations, every package they reach and the lockfile settings are unchanged, and every locked copy of the SDK is the target major. Workspaces and patched pnpm dependencies stop.
  - When several lockfiles are committed, only the one the documented rule picks (`docs/DEPENDENCIES.md`) is upgraded, and the draft names the others as left on the older SDK. Other registries refuse.

## What stops

A stop is blocking when the site would break on the new SDK as it stands. Any blocking stop means no patch at all: Refit never proposes a partial upgrade.

- openai: v3 calls Refit cannot trace to the client, a Configuration with options other than `apiKey` or used elsewhere, results used other than through `.data`, request options (a second argument), v3 type exports, removed endpoints (`createEdit`, fine-tunes, engines), `downloadFile`, positional uploads, unguarded `error.response` reads, `runFunctions`, `fileFromPath`, `httpAgent`, `openai/shims`, old path-parameter forms and `withResponse`/`asResponse`.
- Anthropic: a request that sends `temperature`, `top_p` or `top_k`, which 2026-10-21 rejects. Decision A (2026-10-29): the code works on 0.x and 2023-06-01, so the upgrade is not proposed and the result is `upgrade-optional`, reported as "SDK upgrade available, not required (would change outputs)" with the count; never a failure, never hidden. The guide's removal is built behind `--remove-sampling` and applies only once the rule table quotes an Anthropic sunset notice for 0.x or 2023-06-01. Also: a body Refit cannot read, an assistant document block, user citations, Text Completions and its prompt markers, `MessageParam` heritage, two credentials, `X-Api-Key` headers, `compactionControl` and a platform package imported without a root declaration, a platform client given a credential option.
- Non-blocking: a guarded `error.response` read (it finds nothing on the new SDK and takes the other branch). It is listed in the draft, which is then `[Needs review]`.

## Proof

Every draft reports three levels separately and never claims the new SDK behaves the same; it says outputs may differ and asks for a quality check.

- (a) Code: the repository's approved checks before and after, in offline Docker. Benchmarks and the model-fix CLI run the tests, the build and the type check as separate checks (`pipeline/check-gate.ts`, `checkGate`, shared with the AI fallback): a check that passed on the original code must pass on the patch; one that already failed is reported in the draft and not counted, except that failing tests are compared test by test where the runner's output is readable (`pipeline/test-outcomes.ts`: Vitest, Jest, Mocha, Node's test runner; every test that passed before must pass after, and no fewer may pass) and a type check that reported errors fails only on errors the patch introduced. The tests or the type check must count; a build alone is not enough. A check that errors is an error. Nothing else is loosened.
- (b) Request: the smallest request of each migrated call shape, sent with the newest release of the target major (openai 6.x, @anthropic-ai/sdk 1.x, @google/genai 2.x) and Refit's own key in refit-bench Actions (`refit ai-migrations --prove-table`), stored in `data/sdk-request-proofs.json`. A call without a stored proof keeps the draft `[Needs review]` with the reason; The refit-bench workflow (`sdk-proof.yml`) reads the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` secrets.
- (c) Output shape: the same requests parse their text, stream, tool call and JSON output where the migrated call uses them.

Run locally with `refit ai-migrations --repository <root> --edits-only` to list the edits and stops without Docker.

## API surfaces, response formats and beta features

`refit ai-migrations --review [--kind api-surface|response-format|beta-feature|sdk-major]` lists the sites whose change has no documented one-to-one mapping, each with its rule, the quoted page and whether it breaks today. Nothing is edited.

- API surfaces (`data/rules/*/api-surfaces.json`): OpenAI Assistants (shut down 2026-08-26) and legacy Completions (every model shut down 2026-09-28), Anthropic Text Completions, Google PaLM (report only).
- Response formats (`response-formats.json`): Anthropic Admin and Analytics field renames on 2026-10-21, `BetaSkill` renamed `BetaContainerSkill`, Gemini `response.text()` (report only).
- Beta features (`beta-features.json`): OpenAI `realtime=v1` (removed 2026-05-12) and `assistants=v1`, Anthropic's retired `context-1m-2025-08-07`, and graduated Anthropic betas (listed as cleanups, which still work).
- SDK swaps that are report only: Python openai 0.x, `@google/generative-ai` and `google-generativeai`.

Python sites, including beta names in Python strings, are always report only. When a file imports both SDKs and a call matches both providers' rules, the finding says the client is unclear. What a fix for these would need is in `docs/proposals/ai-surface-migrations.md`.

## AI lane for shut-down OpenAI surfaces

Decision (main session on Furqan's delegation, 2026-10-29): legacy Completions and Assistants calls, which OpenAI shut down and documents no one-to-one mapping for, get an AI-drafted migration under the D1 gates. `refit ai-migrations --ai-surfaces` (`pipeline/ai-surface-lane.ts`) runs only in GitHub Actions (refit-bench), with Refit's `OPENAI_API_KEY` and the AI budget.

- The model sees only the flagged calls, the files that hold them and the JavaScript parts of OpenAI's two migration guides. It is told which model each site must send: the original, or for a retired model the replacement the deadline registry quotes from OpenAI. With no named replacement, nothing is sent.
- Its output is kept only if every changed file parses, it changes no other file and no line outside the statements holding the flagged calls (imports aside), no legacy call remains, every new call exists in openai 6 (`data/sdk-surfaces`), and every model string is the original or its registry replacement. A rejected answer is never used; its cost is recorded.
- The SDK major upgrade runs first when one is due; the AI works on its result.
- It is validated only when the repository's checks run code and pass, every new call shape has an accepted request proof (`data/sdk-request-proofs.json`) and every flagged site moved. Otherwise the draft is `[Needs review]` with each reason. Every draft lists the AI-written lines, the model, response ID and cost, and says outputs may differ.
- Anthropic Text Completions is not in the lane yet.
