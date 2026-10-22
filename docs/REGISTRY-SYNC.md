# Registry sync

`data/deadlines.json` lists the dates providers retire models and API versions. Refit keeps the AI providers' entries current by reading each provider's official deprecations page, and a scheduled workflow proposes every change as a pull request for a person to review. Matching, CI checks, alerts and model replacements still read only the committed registry; nothing at run time fetches a provider page.

## Run a sync

```sh
refit deadlines --sync anthropic          # list what would change
refit deadlines --sync openai
refit deadlines --sync gemini
refit deadlines --sync openai --write     # save it to data/deadlines.json
refit deadlines --sync openai --json      # the same report as JSON
```

Each sync fetches one page as Markdown, parses its tables, checks the current registry, merges the page into it and checks the result before anything is written. It prints the entries it would add, update or recheck, the entries the page no longer lists, and every row it skipped with the reason.

| Provider  | Page read                                                              | Entries it maintains        |
| --------- | ---------------------------------------------------------------------- | --------------------------- |
| Anthropic | https://platform.claude.com/docs/en/about-claude/model-deprecations.md | `anthropic` `model` entries |
| OpenAI    | https://developers.openai.com/api/docs/deprecations.md                 | `openai` `model` entries    |
| Gemini    | https://ai.google.dev/gemini-api/docs/deprecations.md.txt              | `gemini` `model` entries    |

A sync only touches its provider's `model` entries. SDK entries, such as the `@google/generative-ai` end of support, and every other provider stay as they are.

## How each page is read

Every parser fails the whole sync on a table or row it does not recognize, so a changed page layout is noticed rather than half-read. A page that answers with anything other than HTTP 200, including a bot-protection page, fails the sync with the status.

- **Anthropic.** Every table headed `Retirement date | Deprecated model | Recommended replacement`. Other tables, such as the model status table, are ignored.
- **OpenAI.** Every table that starts with `Shutdown date`, names its models in a model column and ends with a replacement column; price columns between them are ignored. Timeline tables (`Date | Update`) are product notices and are skipped. A model cell can be a snapshot and its aliases (`` `gpt-4-0613` | `gpt-4`, `gpt-4-completions` ``), a display name around snapshots (``GPT-4o (`gpt-4o-2024-08-06`, `gpt-4o-2024-11-20`)``), or a snapshot with the aliases that point to it. A model listed by several announcements takes the most recent announcement's row.
- **Gemini.** Every `Model | Release date | Shutdown date | Recommended replacement` table. Rows with no shutdown date announced, and rows marked `N/A` because the endpoint keeps working and routes to a newer model, retire nothing. Group labels such as "Preview models" are ignored. Google gives shutdown dates as the earliest possible date, and the entry summaries say so.

Rows that name nothing Refit can match are skipped and listed with their reason:

- APIs, endpoints and request headers, such as the Assistants API, `/v1/edits` or `OpenAI-Beta: assistants=v1`. They are not models.
- OpenAI's `ft-…` rows, which stand for fine-tuned models whose IDs start with `ft:`, and rows that only stop new fine-tuning training.
- Plain-word model IDs such as `ada` or `davinci`. Refit matches registry models as quoted strings anywhere in a repository, and these words also name unrelated things.
- Rows whose only date is "at earliest", unless another announcement gives the model a firm date.
- Gemini's managed agents, which are not model IDs.

## How entries are merged

The page's rows are grouped by shutdown date and recommendation. Each group becomes one registry entry, found by any model it shares with an existing entry.

- **Unchanged entries** (same date, replacement and models) are left exactly as they are, including aliases a person added from another page and a summary a person wrote. Their `checkedAt` moves to today only once it is more than 30 days old, so a quiet page does not produce a daily diff.
- **Changed entries** keep their ID and gain the page's models; nothing is removed from `versions`. They get a regenerated summary and today's `checkedAt`.
- **New entries** are appended in date order, with an ID made from the provider, the date and the first model.
- **Entries the page no longer lists** are kept and reported as missing. A sync never deletes an entry.
- **Split entries stop the sync.** When the page now gives one entry's models different dates or recommendations, the sync stops with the entry's ID. A person splits the entry by hand, then runs the sync again.

An entry names a `replacement` only when the page recommends exactly one model and nothing else. When the page offers alternatives (`gpt-live-transcribe` or `gpt-transcribe`), the replacement is empty, unless a person already chose one of the offered models, which is then kept. When the recommendation carries anything beyond model IDs, such as `gpt-5.6-sol` with `reasoning.mode: pro`, a wildcard (`gpt-4.1*`) or prose, the replacement is always empty. In every such case the summary ends with "The page recommends: …". An empty replacement means `refit serve --model-fixes` and `--propose-model-fixes` stop for review instead of editing, because swapping only the model ID would drop the rest of the recommendation.

Gemini entries are report only. `--propose-model-fixes` and `refit serve --model-fixes` never edit Gemini code, whatever the registry's replacement says.

## Stale entries

`npm run deadlines:check` (the same as `refit deadlines --check-registry`) warns on every entry whose `checkedAt` is more than 30 days old:

```text
  stale     meta-graph-v21-0 (checked 2026-09-01, 51 days ago; read its source again)
```

A warning does not fail the check. For a synced provider, the next sync rechecks the entry if the page still lists it unchanged. For every other provider, a person reads the entry's `source` again and updates `checkedAt`.

## The scheduled workflow

`.github/workflows/registry-sync.yml` runs every day at 06:17 UTC, and on demand from the Actions tab:

1. It runs every sync with `--write`, then `npm run deadlines:check`.
2. When `data/deadlines.json` changed, it commits the file to the `registry-sync` branch, rebuilt from `main`, and opens a pull request from it, or updates the open one's description. The description lists each sync's output.
3. A provider whose page could not be read or parsed fails the run, after the other providers are synced and the pull request is updated.

The workflow uses only `GITHUB_TOKEN`. The workflow's default permissions are empty; the job has `contents: write` to push the branch and `pull-requests: write` to open or edit the pull request. Actions are pinned by commit SHA.

The `registry-sync` branch belongs to the workflow, which force-pushes it on each run. If a person pushes a commit to it, for example to fix an entry before merging, the workflow leaves the branch alone and warns until that pull request is merged or closed.

Two repository settings affect it:

- **Allow GitHub Actions to create and approve pull requests** (Settings → Actions → General) must be enabled for the workflow to open the pull request. Without it the run pushes the branch, fails, and prints a link to open the pull request by hand.
- A pull request opened with `GITHUB_TOKEN` does not start other workflows, so CI does not run on it by itself. Close and reopen the pull request, or push a commit to it, to run the checks before merging.

## Providers without a sync

Meta Graph API and Shopify entries are maintained by hand from the pages in their `source`. PayPal has no deadline entries (see [PayPal](PAYPAL.md)).
