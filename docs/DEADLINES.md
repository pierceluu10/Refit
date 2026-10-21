# API deadlines

Providers retire API versions and models on published dates. Refit keeps a reviewed registry of those dates, finds where a repository pins an affected version or model, and can alert the repository before the date. Alerts are advice: they never change code. A migration still runs only through the normal flow, with the same approval, validation and draft pull request gates.

## The registry

`data/deadlines.json` lists each sunset with the provider page it came from and the day someone checked it:

```json
{
  "id": "openai-2026-10-23-gpt-4",
  "provider": "openai",
  "kind": "model",
  "versions": ["gpt-4", "gpt-4-0613"],
  "date": "2026-10-23",
  "summary": "OpenAI shuts down gpt-4, gpt-4-0613.",
  "replacement": "gpt-5.6-sol",
  "source": "https://developers.openai.com/api/docs/deprecations",
  "checkedAt": "2026-10-15"
}
```

It covers four providers, each checked against its own documentation:

| Provider | Covers | Source |
|---|---|---|
| Shopify | Admin API versions 2025-04 to 2026-10 and when each stops being accessible, checked 2026-10-15 | [API versioning](https://shopify.dev/docs/api/usage/versioning) |
| Meta | Graph API v13.0 to v25.0 and when each stops being available, checked 2026-10-15 | [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog) |
| OpenAI | Model shutdowns from July 2025 to April 2027, checked 2026-10-15 | [Deprecations](https://developers.openai.com/api/docs/deprecations) |
| Anthropic | Claude API model retirements from November 2024 to November 2026, checked 2026-10-20 | [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) |

Past-due entries stay in the registry on purpose: a repository still pinning a retired version is the most urgent case. To change the registry, edit the file from the provider's page, set `checkedAt` to the day you checked, and run:

```sh
npm run deadlines:check
```

This is the same as `refit deadlines --check-registry`. It fails on shape errors, such as unknown fields, invalid dates, duplicate IDs or a version listed under two deadlines. It also flags entries that are past due or have no source. An entry without a source still loads but is never matched or alerted: a deadline nobody can verify must not open an issue in someone's repository. Matching, CI checks, alerts and model replacements never fetch provider pages or call provider APIs; they read only the committed registry.

### Keep the registry current

Anthropic publishes its retirements as tables on its model deprecations page, so Refit can maintain those entries itself:

```sh
refit deadlines --sync anthropic          # list what would change
refit deadlines --sync anthropic --write  # save it to data/deadlines.json
```

The sync groups the page's rows by retirement date and replacement, one registry entry each. An entry whose date, replacement and models are unchanged is left exactly as it is, including aliases a person added from another page and its `checkedAt`. A new retirement gets a new entry, and a changed date or replacement updates the existing entry in place, both with today's `checkedAt`. An entry the page no longer lists is kept and reported, never deleted. A table row it cannot parse fails the whole sync, so a changed page layout is noticed rather than skipped. The result must pass the same registry check before it is written.

The repository's `Deadline registry sync` workflow (`.github/workflows/deadlines-sync.yml`) runs the sync every day and opens a pull request when the registry should change, unless a sync pull request is already open. Nothing is merged automatically. It needs **Allow GitHub Actions to create and approve pull requests** enabled in the repository's Actions settings. A pull request opened with the workflow's token does not start CI by itself, so push a commit or re-run CI on it before merging.

Other providers' entries are still maintained by hand: OpenAI's deprecations page could not be read from Refit's build environment, and Shopify and Meta publish prose, not tables.

## Check a repository

```sh
refit deadlines --repository /path/to/app
refit deadlines --repository /path/to/app --json
```

Each exposure lists the deadline, days left, the replacement, the source and `file:line` evidence from live code. It also lists what can happen next (see [the migration path](#the-migration-path)). Refit reads JavaScript and TypeScript source, `package.json` files, lockfiles and `.refit.json`, without running code. It matches:

- **OpenAI:** a quoted string that equals a registry model ID exactly, such as `'gpt-4'`. `'gpt-4o'` does not match `gpt-4`. A string passed to a tokenizer (`encoding_for_model`) or a prefix or membership check (`startsWith`, `endsWith`, `includes`, `indexOf`) is not a pin. Model lists, tests and other uses are classified [below](#live-and-non-live-evidence).
- **Anthropic:** a quoted string that equals a Claude API model ID in the registry exactly, such as `'claude-3-7-sonnet-20250219'`, with the same use classes as OpenAI. The registry lists the dated IDs from Anthropic's page plus the `claude-sonnet-4-5` alias, which Anthropic documents as pointing to the retiring snapshot. Amazon Bedrock IDs (`anthropic.claude-…-v1:0`) and Google Cloud IDs (`claude-…@20250929`) do not match: those platforms set their own retirement dates.
- **Shopify:** `/admin/api/2025-10` URLs, with or without a path after the version, and `ApiVersion.October25`. It also matches `apiVersion: '2025-10'`, but only in files that import a Shopify package or name `myshopify.com`, so a Stripe `apiVersion` is not mistaken for one.
- **Meta Graph API:** `graph.facebook.com/v20.0/` URLs, and quoted `'v20.0'` strings in files that use the Graph API. It also reads `facebook-nodejs-business-sdk` from manifests and lockfiles, since SDK release 20.x targets v20.0 and a locked version wins over the declared range.
- **Refit configuration:** an integration's `apiVersion` in `.refit.json` whose adapter covers one of these providers.

### Live and non-live evidence

Each match is classified by how the code uses it. Only **live** matches make a repository exposed, appear as its evidence and open or update an alert. Everything else is still shown, separately, so nothing is hidden:

| Use | What it covers | Providers |
|---|---|---|
| `live` | The default: a call argument, a default or env-var fallback, a constant, an alias map's value | all |
| `catalog` | One entry in a list naming three or more models (an array, enum or tuple, counting OpenAI- and Claude-shaped IDs, with or without an `openai/` or `anthropic/` prefix); any type position, such as a union or `model: 'gpt-4'` in an interface; a table keyed or indexed by model, such as `PRICES['gpt-4']` or `{ 'gpt-4': { input: 30 } }`, and everything inside that entry; an HTML or JSX `<option>` | OpenAI, Anthropic |
| `test` | Test, spec, story, fixture and example files: `*.test.*`, `*.spec.*`, `*.stories.*`, and `test/`, `tests/`, `__tests__/`, `spec/`, `e2e/`, `cypress/`, `fixtures/`, `examples/` directories | OpenAI, Anthropic |
| `check` | A comparison, `case 'gpt-4':`, or a prefix or membership call (`startsWith`, `endsWith`, `includes`, `indexOf`) | comparisons: OpenAI, Anthropic; calls: all |
| `tokenizer` | An argument of `encoding_for_model` or `encodingForModel` | all |
| `comment` | Comments, including JSDoc and commented-out code. Each file is parsed, and anything outside a source token is a comment | all |

Meta and Shopify matches are classified only as comments, tokenizer arguments and prefix checks. Those were dropped before and are now listed as non-live; nothing else about Meta and Shopify matching changed. On the [benchmark](DEADLINE-BENCHMARK.md) their reported lines were already 100% and 79% live.

The terminal output lists live evidence first, then one collapsed `Not live` line per use with each file's line numbers. A deadline the repository names only outside live code is not an exposure; it is listed at the end under "Named only outside live code".

`--json` keeps every earlier field and adds new ones:

- Each exposure's `evidence` holds only live matches, and `more` counts live matches past the limit.
- `nonLive` and `nonLiveMore` hold the other matches.
- Every evidence item has a `use`.
- A top-level `mentions` array lists deadlines with no live match, in the same shape with an empty `evidence`.
- Each exposure has `ignored` (the [ignore entries](#accept-an-exposure-for-a-while) that accept it, or `null`) and `ignoreNote` (why an ignore for that deadline did not apply, or `null`).
- A top-level `ignores` object names the ignore file read and lists `expired` and `unknown` entries.
- With `--fail-within`, a top-level `check` holds `failWithin`, `status` (`pass` or `fail`), `failing` and `ignored` deadline IDs.

## Fail a CI build before a deadline

```sh
refit deadlines --fail-within 30
```

With `--fail-within <days>`, the command exits **2** when the repository has a live exposure whose deadline has passed, is today or is within that many days. It exits **0** when there is none, and **1** on any error. `0` fails only on past-due deadlines and today; the maximum is 3650. Without the flag, `refit deadlines` only reports and always exits 0 unless it hits an error.

Only live evidence counts. A model named in a list, a test, an example or a comment never fails a build. The output ends with the result, and on failure it lists each failing deadline with its date and days left.

Run it on pull requests to block new uses, and on a schedule so a quiet repository still notices an approaching date:

```yaml
name: API deadlines
on:
  pull_request:
  schedule:
    - cron: '0 9 * * 1' # Mondays
jobs:
  deadlines:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --global ./refit-X.Y.Z.tgz # the CLI archive from a Refit release
      - run: refit deadlines --fail-within 30
```

### Accept an exposure for a while

Sometimes an exposure is known and accepted. For example, a retired Graph API version keeps answering on a newer version while a migration is planned. Record that in `.refit-deadlines-ignore.json` at the repository root, and commit it so the decision is reviewed like code:

```json
{
  "formatVersion": 1,
  "ignore": [
    {
      "deadline": "meta-graph-v19-0",
      "reason": "Calls fall forward to v21.0; migration tracked in #142.",
      "until": "2026-12-31"
    },
    {
      "deadline": "openai-2026-10-23-gpt-3-5-turbo",
      "reason": "Legacy summarizer, deleted in the next release.",
      "until": "2026-11-15",
      "paths": ["src/legacy"]
    }
  ]
}
```

`deadline` is the registry ID, as shown in the failing check and in `--json`. The file is strict, because an exception that silently applies too widely defeats the check:

- **Every entry needs a `reason` and an `until` date.** `until` is the last day the entry applies, and it must be at most 365 days away. Nothing stays accepted without someone looking again.
- **An expired entry stops applying** and is listed as expired. If the exposure is still due, the build fails again.
- **`paths` is optional.** Without it, the entry covers the whole repository. With it, the entry covers only those repository-relative directories or files, matched by whole path segments, so `src/legacy` does not cover `src/legacy-old`. An exposure is accepted only when every live match is covered. Path-scoped entries cannot accept an exposure that has more matches than Refit lists (20 per deadline), because the unlisted matches cannot be checked.
- **Accepted exposures stay in the output,** marked with their reason and expiry. An entry naming a deadline the registry does not have is reported as unknown, which usually means a typo.
- **Any problem rejects the whole file and the command exits 1.** That covers unknown fields, a missing reason, a bad date, an expiry over a year away, a path with `..` or an absolute path, more than 100 entries, a file over 64 KiB, and a symbolic link or directory in its place. A CI job never passes because its exceptions were misread.

`--ignore-file <path>` reads another file instead, such as a stricter one for a release branch. A missing file named this way is an error, unlike a missing default file.

## Alerts from the service

Alerts are off by default. Turn them on for `refit serve` with their own flag:

```sh
refit serve --env .env --config service.json --state /path/outside/repo \
  --deadline-alerts --deadline-lead-days 90,30,7
```

The lead times default to 90, 30 and 7 days. Alerts rest on live evidence only. A deadline named only in a model list, a test or a comment never opens an issue, and an issue lists only live lines plus a count of the matches it did not count. With alerts on, after each poll the service checks every **enrolled** repository, meaning a target approved with `refit enroll` whose managed checkout synced in that poll. Operator workflow targets are not alerted. For each exposure, Refit opens one GitHub issue per repository and deadline when the first lead time is reached. At each tighter lead time, and once the date passes, it updates that issue's title, body and evidence and adds a comment so watchers are notified. If several lead times pass between polls, only one alert is sent, at the tightest. Each repository and deadline's last stage and issue number are saved in the service state's `registry.json` under `deadlineAlerts`, so restarts don't repeat alerts. Turning alerts on or off does not require fresh state.

A committed `.refit-deadlines-ignore.json` in the repository also applies to alerts. An exposure it accepts opens or updates no issue until the entry expires. An invalid ignore file accepts nothing: the service logs that the ignores were not applied and alerts as if the file were absent, so a broken exception never silences an alert.

A failed GitHub request is recorded in status and retried at the next lead time rather than on every poll, so a partially completed request cannot open a second issue. If the registry fails validation, the service logs that alerts were skipped and keeps running. A closed issue stays closed; later stages comment on it but do not reopen it.

Issue alerts need the App's **Issues: Read and write** permission. Add it under the App's permissions, then have each installation accept the update. The alert token is scoped to the repository with exactly Contents read and Issues write. It cannot push, open pull requests or comment on them.

## Propose model replacements

```sh
refit deadlines --propose-model-fixes --repository /path/to/app
refit deadlines --propose-model-fixes --output model.patch
```

For OpenAI and Anthropic models, Refit can propose the registry replacement as a patch. From the CLI this is a review aid only: nothing is applied, installed, validated or published, and no provider is contacted. The service applies the same rule on its own, with validation and a draft pull request (see [Automatic model fixes](#automatic-model-fixes)).

A replacement is proposed only when all of these hold:

- The call is a traced SDK text-generation call: OpenAI `chat.completions.create`, `.parse` or `.stream` (also under `beta`), `responses.create`, `.parse` or `.stream`, `createChatCompletion` on an openai v3 or `openai-edge` `OpenAIApi` client, or Anthropic `messages.create`, `.stream` or `.countTokens` (also under `beta`). Clients are traced like any adapter's, including class fields and imported clients, using `examples/openai.provider.json` and `examples/anthropic.provider.json`.
- Or the call is a raw HTTP request to `api.openai.com/v1/chat/completions`, `api.openai.com/v1/responses` or `api.anthropic.com/v1/messages`: `fetch(url, { body: JSON.stringify(request) })`, Apps Script's `UrlFetchApp.fetch(url, { payload: JSON.stringify(request) })` or `axios.post(url, request)`, with the URL written inline or in a `const`.
- Its request is an object literal, or a `const` holding one that only this call uses (`const params = { model: 'gpt-4', messages }`).
- Its `model` is a string literal naming a registry model, or one of these, followed through imports across files:
  - the default of a `??` or `||` fallback, such as `process.env.MODEL ?? 'gpt-4'`;
  - a `const` or enum member holding such a literal and used only by this request (`model: MODEL`, `{ model }`, `model: Model.Default`), edited where it is declared, even in another module;
  - a class field: an initializer (`model = 'gpt-4'`), `this.model = …` assignments, or a constructor parameter followed to the literal its `new` callers pass, even in another module;
  - a parameter of the helper function that makes the call, such as `ask(messages, model = 'gpt-4')`. Its default and each caller that passes a literal (`ask(messages, 'o1-mini')`) are edited separately, each to its own replacement.
- The file is not a test, spec, story, fixture or example file.
- The registry entry names a concrete model ID. When that replacement retires too, Refit follows the registry to a model that does not, for example `o1-mini` to `o4-mini` to `gpt-5.6-terra`.

These cases stop for review and are listed with a reason, with no edit:

- The request sets a parameter the replacement may reject: `temperature`, `top_p` or `top_k` for Anthropic (Anthropic returns a 400 for non-default values on Claude 4.7 and later models), and `temperature`, `top_p`, `max_tokens`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs` or `top_logprobs` for OpenAI (support on its newer models is unverified).
- The request spreads other options (`{ ...options, model: 'gpt-4' }`).
- The model comes from a constant or enum member, or the request from a `const` object, that is used more than once in the repository, so it may feed other code.
- The helper carrying the model is passed around as a value, or called with spread arguments.
- The registry has no concrete replacement.

Embeddings, images, audio and moderation calls are never proposed, because their replacements change vector sizes, formats or parameters. Legacy completions (`completions.create`, v3 `createCompletion`) are never proposed either, because the replacements are chat models. A model sent through another host (such as the app's own proxy), LangChain, the Vercel AI SDK or a Deno re-export, or held in settings objects, UI state or CLI option defaults, is not traced and stays an ordinary exposure.

`--json` returns `replacements` (each with the call's `file`, `line` and `call`, `edited`, the place the string changes, `from`, `to`, the deadline and `via`, the registry entries followed), `stops` (each with `at`, where the model is written, and a `reason`) and `patch`.

On the 34 OpenAI repositories of the [deadline benchmark](DEADLINE-BENCHMARK.md), 15 send a model retiring on 2026-10-23 from live code. The rule proposed 6 replacements in 2 of them, 4 through the v3 SDK or `openai-edge`. Every proposal was read by hand, and each is the registry replacement in a plain request. It stopped for review, with a reason, in 4 more:
- a helper whose request sets `max_tokens`;
- a raw `fetch` that sets `temperature`;
- spread options;
- a reused request object.

The other 9 hold the model in settings or UI defaults, a CLI option default, an alias map, a request to the app's own proxy, an Apps Script options variable, a Deno library or a configuration object. Results are in [`benchmarks/2026-10-20-model-replacement-results.json`](benchmarks/2026-10-20-model-replacement-results.json).

## Automatic model fixes

```sh
refit serve --env .env --config service.json --state /path/outside/repo \
  --model-fixes --publish-draft
```

With `--model-fixes`, the service maintains retiring OpenAI and Anthropic models in every **enrolled** repository without asking first: enrollment with `refit enroll` is the approval. It is off by default. After each poll, for each enrolled repository whose managed checkout synced:

1. Refit applies the [model replacement rule](#propose-model-replacements) to the committed snapshot. Uses that stop for review are never edited.
2. It runs the repository's approved check command (its `.refit.json` `image`, `command`, `baselineCommand`, `prepareDependencies` and `compareTypeErrors`) before and after the change, in the same offline Docker sandbox and limits as contract migrations.
3. When both runs pass and `--publish-draft` is set, it opens a draft pull request as Refit Agent. The description lists each replacement with its deadline and registry source, the check results, every use left for review, and what the checks cannot show. Without `--publish-draft`, the run is recorded as `validated`.

Refit never merges the pull request or marks it ready. A failing check publishes nothing. The outcome of each repository is saved in the service state under `modelFixes`, keyed by the replacements themselves (file, model and replacement). While their pull request stands, the same replacements are not validated or published again, even after new commits. A pull request a developer closes is not reopened for the same replacements. A new retiring model, or a registry change, starts a new run.

The checks run without network access, so no request reaches OpenAI or Anthropic. A passing check does not show how the new model answers, what it costs, or whether it accepts every parameter; that is for the reviewer to try. Operator workflow targets are not changed.

## The migration path

Every alert and CLI result states one of three outcomes:

- **Configured:** an integration in the repository's `.refit.json` covers the provider. When the provider publishes the change in the contract Refit monitors, that integration's normal migration run handles it.
- **Agent available:** Refit ships an agent for the provider, currently OpenAI's preview adapter and the built-in Shopify agent. The alert gives `refit agents --add <id>` and the enrollment steps.
- **No agent yet:** currently Meta and Anthropic. The alert says so and points to the provider's guide. Anthropic's adapter exists for model replacement proposals, but it is not in the agent catalog because Anthropic publishes no contract that `refit run` could compare.

A deadline starts a code change only through [automatic model fixes](#automatic-model-fixes), which the service runs when `--model-fixes` is on. Every other migration starts from contract changes, approved configuration and the existing gates.

## Limits

- Only JavaScript and TypeScript source is scanned. Models named in environment files, YAML or other languages are not found. Values built at runtime are invisible.
- Shopify package versions are not mapped to the API version they default to, and Shopify versions older than 2025-04 are not in the registry yet.
- A version held in a constant or an environment-variable fallback, such as `SHOPIFY_API_VERSION = '2025-07'`, and the Meta JS SDK's `FB.init({ version })` are not read.
- Live is the default, so some catalogs still count as live. These include lists of one or two models, preset data that repeats one model, catalogs built through function calls such as `modelRef({ … })`, and alias maps or code nobody imports. Code is not traced, so an unused file counts like a used one. On the [benchmark](DEADLINE-BENCHMARK.md), 4 of 23 reported OpenAI lines are of this kind.
- A match counts as a test or an example from its path alone. A live pin kept under `examples/` or `fixtures/` is listed as non-live.
- A model ID sent to another provider's OpenAI-compatible endpoint matches the OpenAI deadline. A Claude API model ID sent through Claude Platform on AWS or Microsoft Foundry matches the Anthropic deadline, which Anthropic's page says applies there too.
- Anthropic's page lists dated model IDs. Aliases of models that are already retired, such as `claude-3-5-sonnet-latest`, are not in the registry, because no current Anthropic page documents them; only `claude-sonnet-4-5` is.
- Evidence is capped at 20 live and 20 non-live matches per deadline, plus a count of the rest.
- Issues are not closed automatically once the repository stops depending on a deadline.
- `--fail-within` checks only what Refit can see; the limits above apply. A passing check does not prove the repository uses no retiring version or model.
- The registry is maintained by hand from the provider pages listed above. Recheck it before relying on a date.
