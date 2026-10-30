# AI-provider benchmark sets

Frozen on October 29 for the OpenAI, Anthropic and Gemini agents, chosen with the same rigor as the Stripe holdout sets (`docs/BENCHMARKS.md#holdout-sets`). Each provider has one measurement-only set and one dev set, drawn from the same population and disjoint.

| Set                             | Use              | Repositories | JS/TS | Python |
| ------------------------------- | ---------------- | ------------ | ----- | ------ |
| `subsets/openai-100.json`       | measurement only | 100          | 70    | 30     |
| `subsets/openai-dev-30.json`    | debugging        | 30           | 21    | 9      |
| `subsets/anthropic-100.json`    | measurement only | 100          | 70    | 30     |
| `subsets/anthropic-dev-30.json` | debugging        | 30           | 21    | 9      |
| `subsets/gemini-30.json`        | measurement only | 30           | 21    | 9      |
| `subsets/gemini-dev-15.json`    | debugging        | 15           | 11    | 4      |

## Rules (integrity)

The Stripe holdout rules apply to the three measurement sets:

- Never open, clone, trace or debug a measurement repository, its row, its logs or its diff to design a fix. Diagnose on the provider's dev set only.
- Run them only at milestones and record each run's id, commit and command. Report whole-set numbers, never a slice. A repository that later fails to clone stays in the denominator.
- Hand-checked verdicts on fixes a measurement run produced are measurement too. Record them under `docs/benchmarks/ai-provider-results/`, and report wrong fixes by count and change type. A wrong fix found there is reproduced and fixed on a dev set, never on the measurement repository.
- Measurement repositories may be named only in their own lists, in `docs/benchmarks/ai-provider-selection/` and in `docs/benchmarks/ai-provider-results/`. `pipeline/ai-provider-integrity.test.ts` fails `npm test` otherwise. It also checks the sizes, language splits, full commits and change-type tags, and that no list shares a repository with any other benchmark list.
- Dev sets are never measured: no dev repository is in any measurement set, for any provider. Within a provider the two sets share nothing. A repository that uses two SDKs can be measured once per provider (7 do: 4 in OpenAI and Anthropic, 2 in OpenAI and Gemini, 1 in Anthropic and Gemini), because each provider's selection runs independently.
- Never add, drop or replace a repository. To refresh, freeze new sets with a new seed.

## Change types

Every entry has `changeTypes`, read from its application code at the frozen commit (tests, examples, specs, fixtures and mocks excluded):

| Type                    | What tags it                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retired-model`         | A quoted model that `data/deadlines.json` dates before October 29, or one retired before the registry starts (`UNREGISTERED_RETIRED` in the script, each with its deprecation page: `text-davinci-003`, the `gpt-3.5-turbo-0301`/`0613`/`16k` snapshots, `gpt-4-32k`, `gpt-4-vision-preview`, `claude-2`, `claude-instant-1`, PaLM `text-bison-001`, Gemini 1.0 and 1.5). |
| `parameter-change`      | OpenAI `functions`/`function_call`, or `max_tokens` beside an o-series or GPT-5 model. Anthropic `max_tokens_to_sample`, `top_k`, or `temperature` and `top_p` together. Gemini `thinkingBudget`.                                                                                                                                                                         |
| `legacy-endpoint`       | OpenAI Completions (`completions.create` outside chat, `createCompletion`, `Completion.create`), Edits and the Assistants API (`beta.assistants`, `beta.threads`, vector stores). Anthropic Text Completions (`completions.create`, `HUMAN_PROMPT`, `client.completion`). Gemini PaLM (`@google-ai/generativelanguage`, `generateText`, `v1beta2`).                       |
| `old-sdk-major`         | The locked SDK (else the declared range) is below the newest major on October 29: openai-node 7, Python openai 3, `@anthropic-ai/sdk` 1, Python anthropic 2, `@google/genai` 2 and google-genai 2. Gemini's deprecated `@google/generative-ai` and `google-generativeai` always count.                                                                                    |
| `response-parsing`      | OpenAI v3 `.data.choices`, dictionary `['choices'][0]`, Completions `.choices[0].text`, `beta.chat.completions.parse` and `response_format`. Anthropic `.completion`, and `content[0].text` read without a block-type check. Gemini's old `response.text()` method and raw `candidates[0].content.parts`.                                                                 |
| `beta-header`           | `OpenAI-Beta`; `anthropic-beta`, `client.beta.*` and `betas`; Gemini `v1alpha`, or `v1beta` pinned in the client.                                                                                                                                                                                                                                                         |
| `embeddings-fine-tunes` | OpenAI `embeddings.create`, `createEmbedding`, fine-tuning jobs and `FineTune`. Gemini `embedContent`, `embedding-001`, `text-embedding-004` and tuned models. Anthropic has neither API, so its sets hold none.                                                                                                                                                          |

Tags are what the code shows, not what Refit finds. `old-sdk-major` is the widest: 85 of `openai-100` and 82 of `anthropic-100` lock an older major, most of them openai 4.x and `@anthropic-ai/sdk` 0.x.

|                                                      | openai-100           | openai-dev-30      | anthropic-100       | anthropic-dev-30   | gemini-30          | gemini-dev-15     |
| ---------------------------------------------------- | -------------------- | ------------------ | ------------------- | ------------------ | ------------------ | ----------------- |
| retired-model                                        | 63                   | 18                 | 50                  | 14                 | 21                 | 11                |
| parameter-change                                     | 21                   | 3                  | 24                  | 8                  | 5                  | 4                 |
| legacy-endpoint                                      | 33                   | 14                 | 16                  | 5                  | 5                  | 2                 |
| old-sdk-major                                        | 85                   | 27                 | 82                  | 28                 | 25                 | 14                |
| response-parsing                                     | 41                   | 13                 | 66                  | 18                 | 17                 | 9                 |
| beta-header                                          | 9                    | 3                  | 28                  | 6                  | 3                  | 2                 |
| embeddings-fine-tunes                                | 24                   | 6                  | 0                   | 0                  | 8                  | 3                 |
| no tag                                               | 1                    | 2                  | 1                   | 0                  | 2                  | 0                 |
| npm / pnpm / Yarn / several / none lockfiles (JS/TS) | 37 / 9 / 0 / 11 / 13 | 16 / 0 / 2 / 1 / 2 | 50 / 6 / 0 / 4 / 10 | 17 / 1 / 0 / 1 / 2 | 15 / 1 / 0 / 2 / 3 | 9 / 2 / 0 / 0 / 0 |
| Median stars                                         | 0                    | 0                  | 0                   | 0                  | 0                  | 0                 |

Gemini's sets mix both SDK generations: `gemini-30` has 13 `@google/generative-ai`, 9 `@google/genai`, 7 `google-generativeai` and 2 `google-genai` declarations.

## How they were selected

`scripts/ai-provider-sets-select.mjs` (tested in `pipeline/ai-provider-sets-select.test.ts`):

1. **Search.** GitHub code search, with one stratum of queries per change type plus a general stratum of plain SDK use, in TypeScript, JavaScript and Python. That is 30 queries for OpenAI, 26 for Anthropic and 25 for Gemini, each taking up to 500 results. The hits were 10,712 OpenAI, 7,947 Anthropic and 7,943 Gemini repositories (`ai-provider-selection/<provider>-search.json`, with each repository's strata).
2. **Exclude what Refit has seen.** Every `owner/name` that any tracked file mentions at `origin/main` or any other `origin` branch (`candidates.json` `namesAt`, 532 refs), plus the dev hand-check lists in the ai-surfaces worktree that were not pushed yet (`named-additions.json`). The search record lists only unnamed hits and counts the rest (`namedHits`).
3. **Order.** By SHA-256 of the seed `refit-ai-providers-2026-10-29`, a newline and the lower-cased name. The seed was fixed before any candidate was seen (`candidates.json`).
4. **Metadata, lazily in that order.** Filtering then ordering selects the same repositories as ordering then filtering, so only the candidates a walk reached were fetched (`metadata.json`). The Stripe holdout filters apply: not archived or a fork, under 50 MB, pushed since 2024-01-01, and the SDK declared in a root manifest (`package.json`, `requirements.txt`, `pyproject.toml`, `setup.py`, `setup.cfg` or `Pipfile`; wrappers such as `langchain-openai` do not count).
5. **Clone checks.** A shallow clone at the default-branch HEAD, read only for SDK use, language, SDK version and change types, then deleted (`checks.json`, with every walked candidate's outcome). A repository is kept when an application file imports the SDK and one constructs a client. It counts as JS/TS when that holds for its JS/TS code, else as Python.
6. **Fill.** For each set and language, every change type first gets its minimum: 6 JS/TS and 3 Python for a 100 set; 2 and 1 for a 30 set; 1 and 1 for `gemini-dev-15`. The fill walks that type's search stratum in seeded order and keeps only clones whose code shows the type. The remaining slots follow plain seeded order, so most of each set (63 of 100 for OpenAI, 75 for Anthropic, 18 of 30 for Gemini) is a plain random draw. Measurement sets fill first, then dev sets. Each set's `selection.shortfall` lists any minimum the population could not meet; only Anthropic's embeddings type, which has no API, falls short.

|                                                                 | OpenAI         | Anthropic      | Gemini         |
| --------------------------------------------------------------- | -------------- | -------------- | -------------- |
| Search hits                                                     | 10,712         | 7,947          | 7,943          |
| Already named in Refit                                          | 254            | 307            | 153            |
| Metadata fetched                                                | 559            | 630            | 360            |
| Not pushed since 2024 / over 50 MB / SDK not in a root manifest | 64 / 150 / 174 | 25 / 177 / 254 | 19 / 101 / 145 |
| Cloned                                                          | 171            | 174            | 95             |
| No SDK client in application code                               | 17             | 11             | 9              |
| Kept, in sets                                                   | 130            | 130            | 45             |
| Clone failures                                                  | 0              | 0              | 0              |

The "already named" row counts both search hits Refit names and renamed repositories whose new name it names.

Rerun with `node scripts/ai-provider-sets-select.mjs --work <dir>`. GitHub's index moves, so the committed inputs are the record; `seededOrder` recomputes the order from `candidates.json` without GitHub.

## Caveats

- **Python is detection only.** Refit never edits Python (decision 3 in `docs/ARCHITECTURE.md`), so an affected Python row can be found but never validated. Report validated over affected JS/TS rows beside the whole-set outcomes.
- **Few stars.** Earlier AI benchmarks took the most-starred and most-downloaded projects, so these are mostly small applications. The median is 0 stars; the largest have 12,182 (OpenAI), 3,471 (Anthropic) and 407 (Gemini).
- **Not affected-filtered.** As with the Stripe holdouts, some rows will be unaffected; never filter the lists.

## Run them

`pipeline/ai-provider-benchmark-cli.ts` runs a list. Each repository is fetched at its commit and goes through `refit deadlines --propose-model-fixes` (findings, model replacements, stops, alerts) and, on commits that have it, `refit ai-migrations --review` plus `--edits-only`, or `--validate` with Docker. Each row gets one outcome: `validated`, `validation-failed`, `no-checks`, `proposed`, `needs-review`, `detection-only` (affected Python), `unaffected`, `error` or `infrastructure`. A row is `validated` only when every lane that proposed a fix validated. `--parameter-changes <file>` passes the parameter-changes table through.

On refit-bench, `ai-providers.yml` (refit-dev/refit-bench#12) shards a list, writes the `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` secrets only into a private env file when `ai=true`, and refuses less than $0.50 of AI budget per shard:

```sh
gh workflow run ai-providers.yml -R refit-dev/refit-bench \
  -f commit=<full Refit SHA> -f list=subsets/openai-100.json -f offset=0 -f size=5
```

Results go in `docs/benchmarks/ai-provider-results/` and `AI-PROVIDER-RESULTS.md`.
