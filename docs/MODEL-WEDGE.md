# Model-retirement wedge: Anthropic parity and launch measurements (2026-10-22)

Lane FG9. This page records what changed in the TypeScript and JavaScript model-retirement rule (`pipeline/model-retirements.ts`), the rerun of both frozen application sets before and after, Docker validation of every current proposal, and what still blocks a launch. It is the input PP10 folds into `docs/PROVIDER-GOALS.md` and `docs/READINESS.md`.

Nothing here contacted OpenAI, Anthropic or any other provider. Repositories were read at their frozen commits; validation ran their own checks in offline Docker (`node:22-alpine`).

## What changed

Every change below reports more precisely. None widens what `refit serve --model-fixes` or `--propose-model-fixes` replaces, except where marked off by default.

| Shape                                                                                                                                                       | Before                                                        | After                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages.create({ stream: true })`, `messages.stream(...).on(...).finalMessage()`, `beta.messages.create`, `beta.messages.stream`, a `while` tool-use loop | Edited                                                        | Edited, now pinned by tests                                                                                                                       |
| Model only in a spread `const` object (`create({ ...params, messages })`, the usual tool-loop shape)                                                        | Silent: not even unresolved                                   | Stop: "takes its model from the options it spreads"                                                                                               |
| `messages.batches.create({ requests: [{ params: { model } }] })`                                                                                            | Unresolved                                                    | Stop: "a Message Batches request"                                                                                                                 |
| `beta.messages.toolRunner`, `beta.tools.messages.*`, `beta.promptCaching.messages.*`                                                                        | Stop with a wrong reason ("may change formats")               | Stop: "a Messages API helper or retired beta path"                                                                                                |
| `AnthropicBedrock` (`@anthropic-ai/bedrock-sdk`) and `AnthropicVertex` (`@anthropic-ai/vertex-sdk`) clients                                                 | Not traced: unresolved, "No file imports `@anthropic-ai/sdk`" | Stop naming the platform and the Claude API date                                                                                                  |
| Dated Bedrock (`us.anthropic.claude-3-5-haiku-20241022-v1:0`) and Vertex AI (`claude-3-5-sonnet-v2@20241022`) IDs on any traced request                     | Silent                                                        | Stop, matched to the Claude API ID inside                                                                                                         |
| A client in a `let`, a typed parameter or field, an object member, or `client!` (`let c: OpenAI \| null`, `constructor(private client: Anthropic)`)         | Unresolved                                                    | Stop: "is not one Refit can trace to the SDK constructor"                                                                                         |
| An Anthropic request that sets `thinking` when the replacement is Claude 4.7 or later                                                                       | **Edited** (would return a 400)                               | Stop: "sets thinking, which <to> may reject"                                                                                                      |
| Custom-endpoint stop                                                                                                                                        | One repository-wide reason                                    | Names the request's own client option (`The client sets \`baseURL\` (src/chat.ts:3)`), or says the mention is elsewhere and this client sets none |
| Requests whose own client sets no endpoint, in a repository that mentions one elsewhere                                                                     | Stop                                                          | Stop by default; edited only with `endpoints: true` (Needs owner decision)                                                                        |

The `thinking` change fixes a wrong-edit class. Anthropic's [extended thinking page](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), read 2026-10-22, says Claude 4.7 and later models reject `thinking: { type: "enabled", budget_tokens }` with a 400 error, and that this is the only thinking mode on Claude 4.5 and earlier. So a retiring model's thinking request cannot move to a 4.7+ replacement unchanged. On the 2026-10-21 Anthropic SDK set, all six sites proposed in `antra-tess/membrane` send exactly that request to `claude-sonnet-5-5`: they would have been wrong fixes. Main already stops them, for an unrelated reason (a custom base URL elsewhere in the repository); this change stops them for the right one.

A report-only hook (`ReportOnlySource`, tag `ready/FG9`) lets other detectors (FP3 wrapper SDKs, FP4 cloud-hosted models) list their sites as stops instead of unresolved.

## Frozen application sets, before and after

Sets: `docs/benchmarks/2026-10-21-openai-app-repos.json` (100) and `2026-10-21-anthropic-app-repos.json` (50). Command: `node scripts/ai-model-benchmark.mjs --list <set> --root <checkouts> --output <results>`, from a detached worktree at each commit, never from a working tree. Before is main `7b2c86a`; after is this branch at `263d88f`. Results: [`benchmarks/2026-10-22-openai-app-results.json`](benchmarks/2026-10-22-openai-app-results.json) and [`benchmarks/2026-10-22-anthropic-app-results.json`](benchmarks/2026-10-22-anthropic-app-results.json), each with its baseline summary.

|                                                                    | OpenAI before   | OpenAI after        | Anthropic before | Anthropic after |
| ------------------------------------------------------------------ | --------------- | ------------------- | ---------------- | --------------- |
| Repositories (scan errors)                                         | 100 (1)         | 100 (1)             | 50 (0)           | 50 (0)          |
| Exposed: live use of a registry model                              | 32              | 32                  | 28               | 28              |
| A replacement proposed                                             | 2               | 2                   | 2                | 2               |
| Stopped for review only                                            | 18              | **21**              | 12               | 12              |
| Unresolved only (every live match listed with where it is written) | 11              | **8**               | 14               | 14              |
| Replacements / stops / unresolved sites                            | 3 / 44 / 68     | 3 / **52** / **60** | 3 / 16 / 58      | 3 / 16 / 58     |
| Live lines reaching an edit or a named stop                        | 47 of 116 (41%) | **55 of 116 (47%)** | 19 of 77 (25%)   | 19 of 77 (25%)  |

On the OpenAI set the gain is the untraced-client stop: `rohitg00/manim-video-generator` (six files with `let openaiClient: OpenAI | null` set in a `try`), `kirill-markin/chatgpt-telegram-bot-telegraf` (a typed `openai: OpenAI` parameter) and one more. The Anthropic set has none of the new shapes, so nothing moved: none of its 50 applications uses Bedrock or Vertex AI clients outside the twelve copies of one leaked Claude Code tree, where those IDs sit in model tables rather than requests, and none uses batches, spreads or the tool runner. The new shapes are covered by tests on real-shaped snippets instead.

What stays unresolved is mostly not a request. By where the model is written (the `unresolved` reason), the 60 OpenAI sites are: 27 values of an object (settings defaults, seed rows, UI state, model tables), 12 not where a request reads a model (JSX options, string checks), 9 assigned to a variable no traced request reads, 7 passed to another function (one is the Vercel AI SDK's `openai(...)`, FP3's area; four are a model updater's lists), and 5 others. Of the 58 Anthropic sites, 24 are `return 'claude-…'` lines in the Claude Code copies' name normalizers, 11 are a model ID inside a prompt template in the same copies, and 20 are values in state objects, converters and model tables.

## Stop reasons ranked by repositories blocked

`blocked` counts exposed repositories where the reason stops a site and no replacement is proposed; `repositories` counts every exposed repository where it stops a site. From `stopReasons` in `scripts/ai-model-benchmark-summary.mjs`, now written into every results file.

After, both sets (OpenAI + Anthropic):

| Stop reason                                                                        | Blocked | Repositories |
| ---------------------------------------------------------------------------------- | ------- | ------------ |
| A custom endpoint mentioned somewhere, not tied to the request's client            | 4 + 6   | 4 + 6        |
| The call is not one Refit edits (images, audio, realtime, embeddings)              | 9 + 0   | 9 + 0        |
| The request's own client sets `baseURL`, `fetch` or similar (named, with its line) | 5 + 1   | 5 + 1        |
| The client is not one Refit can trace to the SDK constructor                       | 3 + 0   | 3 + 0        |
| A custom endpoint is mentioned elsewhere, but this client sets none                | 2 + 1   | 2 + 1        |
| A module loaded dynamically or through an opaque namespace                         | 0 + 1   | 0 + 2        |
| Sampling or length parameters the replacement may reject                           | 1 + 0   | 2 + 0        |
| Raw request to another host, a reused request object, an unreadable tsconfig       | 0 + 3   | 0 + 3        |

Before, the custom-endpoint stop was one reason for all of these: 10 OpenAI and 8 Anthropic repositories. It is still the largest blocker. In 6 repositories the request's own client really does set another endpoint (for example the Goofish bots' user-configured `baseURL`), so the stop is right. In 3 the mention is elsewhere and the request's client sets none. In 10 the client is built in a way the attribution cannot follow (a getter with arguments, a constructor parameter, a factory), so the old wording stays. A repository with several requests can appear under two of these.

## Docker validation of every current proposal

Each repository's current proposal (main's rule; the changes above do not touch these sites) was validated one repository per lock hold, with `validateSourcePatch` and the repository's own checks, offline, image `node:22-alpine`. Every diff was read in full.

Record: [`benchmarks/2026-10-22-model-wedge-validation.json`](benchmarks/2026-10-22-model-wedge-validation.json).

| Repository (set)                                                                             | Sites | Check that ran                                                                                  | Result                                                                   | Label                                                                                           |
| -------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Langdock/assignment (OpenAI apps)                                                            | 1     | `npx tsc --noEmit`                                                                              | passed before and after                                                  | correct                                                                                         |
| freshfriedfish/claude-tokenizer (Anthropic apps)                                             | 1     | `npx tsc --noEmit`                                                                              | passed before and after                                                  | correct; its token counts now come from the replacement's tokenizer                             |
| JaleelB/readium-x (OpenAI apps)                                                              | 2     | `npx tsc --noEmit` and `npm test` (vitest), with the operator's `REFIT_VALIDATION_WORKSPACE=4g` | both passed before and after                                             | correct                                                                                         |
| RiP3rQ/AI-Butler (deadline set)                                                              | 4     | `npx tsc --noEmit` with type-error comparison                                                   | no error added; one pre-existing syntax error unchanged                  | correct                                                                                         |
| Koifman/LUMEN (Anthropic apps)                                                               | 2     | none                                                                                            | Blocked: validation does not accept submodules                           | correct (read only)                                                                             |
| arunpattnaik/damngood.tools (deadline set)                                                   | 2     | none                                                                                            | Blocked: conflicting lockfiles need a custom image                       | correct (read only)                                                                             |
| AnyVM-Tech/AnyGPT (OpenAI apps; an Anthropic proposal the per-provider benchmark leaves out) | 1     | none                                                                                            | Not run: Bun lockfile in a pnpm workspace                                | correct (read only)                                                                             |
| webgptorg/promptbook (OpenAI SDK set)                                                        | 1     | none                                                                                            | Blocked: committed source exceeds the 50 MiB archive limit, also at `4g` | correct (read only)                                                                             |
| antra-tess/membrane (Anthropic SDK set)                                                      | 6     | not proposed now                                                                                | proposed on 2026-10-21; now stopped                                      | **wrong**: each sends `thinking: { type: 'enabled' }` to `claude-sonnet-5-5`, which returns 400 |

So 8 sites in 4 repositories validated, all correct; 6 more read and correct but not runnable; 6 earlier proposals were wrong and no longer proposed. The goal of 15 validated fixes is not reachable: every current proposal across both app sets, both SDK sets and the deadline set is 14 sites, and 6 of them cannot run under the current sandbox.

The default checks failed for reasons outside the change. Both Next.js 14 apps' `npm run build` baselines died with `spawn /usr/local/bin/node EAGAIN` while collecting page data: Next's worker pool against the sandbox's 128-process limit. `npx tsc --noEmit` was used instead. readium-x's prepared dependencies exceed the default 1 GiB archive.

## Off-by-default options measured

`proposeModelReplacements` was run on each of the 60 exposed app-set repositories and the four extra checkouts with four option sets: default, `endpoints: true`, `indirect: true` (D-06 to D-08) and both, one process per repository with a 2-minute cap, at `263d88f`.

| Option set        | Repositories with a proposal | Sites |
| ----------------- | ---------------------------- | ----- |
| default           | 7                            | 13    |
| `endpoints: true` | 7                            | 13    |
| `indirect: true`  | 7                            | 13    |
| both              | 7                            | 13    |

16 repositories did not finish all four runs inside the cap (the 12 Claude Code copies, both lobe-chat-pro entries, CraftingComputer and promptbook) and are not counted. On the other 48, neither option adds a proposal. Where the endpoint attribution clears a request, the next stop is a sampling or length parameter (Emineon's `temperature` and `max_tokens`) or the request was already blocked by another rule. So on these sets the evidence does not support turning either option on: the larger gate is the sampling-parameter stop (an owner decision) and the non-text calls.

## Requests for other lanes

- **Validation sandbox (OP4, OG3, OP9):** `next build` fails every Next.js 14 baseline here with `spawn EAGAIN` under the 128-process cap (seen on 2 of 2 tried). A worker limit for Next builds (for example `NEXT_PRIVATE_WORKER_THREADS` or `experimental.cpus` passed by the check, or a higher process cap for builds) would make the default `npm run build` check usable. Submodules, conflicting lockfiles and the fixed 50 MiB source archive block 3 more repositories.
- **ai-model-validation-cli (whoever owns it):** it picks `npm test` or `npm run build` only and keeps no check output, so a baseline failure gives no cause. A `tsc --noEmit` fallback with `compareTypeErrors`, and the output tail in its record, would have validated 3 of these 4 repositories directly.
- **PP10:** fold the tables above into the OpenAI and Anthropic checklist in `docs/PROVIDER-GOALS.md`. Item 8 (labelled pins traced) moves only on OpenAI, 41% to 47% of live lines on the app set, measured against live evidence, not hand labels. Item 9 stays below target. Item 10 changes: one wrong-fix class (thinking) found and closed.
- **OG7 (labels):** the AI-assisted labels in `2026-10-21-ai-app-labels.json` are not hand labels; precision and recall here are not measured.
- **FP3, FP4:** the `ReportOnlySource` hook is on `ready/FG9`.
- **PG6:** no registry entry was edited.

## Not verified

- No result here exercised a provider: the checks ran offline and cannot show how a replacement model answers.
- Bedrock and Vertex AI model IDs are matched to the Claude API ID inside them only when dated; their own retirement dates are not in the registry (no Amazon or Google page was read), so `refit deadlines` still does not report them.
- The custom-endpoint attribution follows clients statically; a client changed through an alias Refit cannot see is treated as unknown only when the change is written as `x.baseURL = …`, an environment variable the SDK reads, `withOptions` or Azure.
- CI did not run on this branch (GitHub Actions billing; see the PR). All checks above ran locally.
