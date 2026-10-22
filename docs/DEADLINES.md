# API deadlines

Providers retire API versions and models, and end support for SDK packages, on published dates. Refit keeps a reviewed registry of those dates, finds where a repository pins an affected version or model or declares an affected package, and can alert the repository before the date. Alerts are advice: they never change code. A migration still runs only through the normal flow, with the same approval, validation and draft pull request gates.

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

It covers five providers, each checked against its own documentation:

| Provider  | Covers                                                                                                                                                                                                                                                              | Source                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Shopify   | Admin API versions 2025-04 to 2026-10 and when each stops being accessible, checked 2026-10-15                                                                                                                                                                      | [API versioning](https://shopify.dev/docs/api/usage/versioning)                                                        |
| Meta      | Graph API v13.0 to v25.0 and when each stops being available, checked 2026-10-15                                                                                                                                                                                    | [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog)                                        |
| OpenAI    | Model shutdowns from July 2025 to April 2027, checked 2026-10-15                                                                                                                                                                                                    | [Deprecations](https://developers.openai.com/api/docs/deprecations)                                                    |
| Anthropic | Claude API model retirements from November 2024 to November 2026, checked 2026-10-20                                                                                                                                                                                | [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)                              |
| Gemini    | Only the end of support for the old `@google/generative-ai` package, 2025-11-30, checked 2026-10-21. No Gemini model dates yet: Google's deprecations page on ai.google.dev could not be reached from Refit's build environment, and no date is entered from memory | [deprecated-generative-ai-js README](https://github.com/google-gemini/deprecated-generative-ai-js/blob/main/README.md) |

An entry's `kind` is `api-version`, `model` or `sdk`. An `sdk` entry lists npm package names in `versions`: the date is when the provider ends support for those packages, not when its API stops answering, and its summary says which.

Some entries are **report only**: `refit deadlines` lists them, marked `Report only`, but they never fail `--fail-within` and never open a `--deadline-alerts` issue (owner decision, 2026-10-22). That covers:

- an entry with `"derivedDate": true`, whose date the provider never announced as a shutdown, such as one taken from a release date or an OpenAPI `eol` field. Its summary says where the date comes from;
- every entry whose `kind` is `method`, `endpoint`, `field` or `feature`.

Past-due entries stay in the registry on purpose: a repository still pinning a retired version is the most urgent case. To change the registry, edit the file from the provider's page, set `checkedAt` to the day you checked, and run:

```sh
npm run deadlines:check
```

This is the same as `refit deadlines --check-registry`. It fails on shape errors, such as unknown fields, invalid dates, duplicate IDs or a version listed under two deadlines. It also flags entries that are past due or have no source. An entry without a source still loads but is never matched or alerted: a deadline nobody can verify must not open an issue in someone's repository. Matching, CI checks, alerts and model replacements never fetch provider pages or call provider APIs; they read only the committed registry.

### Keep the registry current

Anthropic, OpenAI, Google, Shopify and Meta publish their retirement dates as tables, so Refit maintains those entries itself:

```sh
refit deadlines --sync openai          # list what would change (also anthropic, gemini, shopify, meta-graph)
refit deadlines --sync openai --write  # save it to data/deadlines.json
```

A model sync groups the page's rows by shutdown date and recommendation, one registry entry each; an API version sync writes one entry per version. Unchanged entries keep their aliases, summary and `checkedAt` until it is more than 30 days old; new and changed entries get today's `checkedAt`. An entry the page no longer lists is kept and reported, never deleted, and a row the parser does not recognize fails the whole sync. The result must pass the registry check before it is written. The `Registry sync` workflow runs every sync daily and opens or updates one pull request for review. [Registry sync](REGISTRY-SYNC.md) covers how each page is read, when an entry names a replacement, and the workflow's settings.

`deadlines --check-registry` also warns on entries whose `checkedAt` is more than 30 days old.

## Check a repository

```sh
refit deadlines --repository /path/to/app
refit deadlines --repository /path/to/app --json
```

Each exposure lists the deadline, days left, the replacement, the source and `file:line` evidence from live code. It also lists what can happen next (see [the migration path](#the-migration-path)). Refit reads JavaScript and TypeScript source, `package.json` files, lockfiles and `.refit.json`, without running code. It matches:

- **OpenAI:** a quoted string that equals a registry model ID exactly, such as `'gpt-4'`. `'gpt-4o'` does not match `gpt-4`. A string passed to a tokenizer (`encoding_for_model`) or a prefix or membership check (`startsWith`, `endsWith`, `includes`, `indexOf`) is not a pin. Model lists, tests and other uses are classified [below](#live-and-non-live-evidence).
- **Anthropic:** a quoted string that equals a Claude API model ID in the registry exactly, such as `'claude-3-7-sonnet-20250219'`, with the same use classes as OpenAI. The registry lists the dated IDs from Anthropic's page plus the `claude-sonnet-4-5` alias, which Anthropic documents as pointing to the retiring snapshot. Amazon Bedrock IDs (`anthropic.claude-…-v1:0`) and Google Cloud IDs (`claude-…@20250929`) do not match: those platforms set their own retirement dates.
- **Gemini:** a quoted string that equals a Gemini API model ID in the registry exactly, such as `'gemini-1.5-flash'`, or the same ID after `models/`, which both Gemini SDKs send as the same model. It has the same use classes as OpenAI. This covers both SDK shapes, `ai.models.generateContent({ model })` on `@google/genai` and `genAI.getGenerativeModel({ model })` on `@google/generative-ai`, and any other place the ID is written. Router IDs (`google/gemini-…`), Vertex AI resource names (`publishers/google/models/gemini-…`) and other snapshots do not match. The registry has no Gemini model entries yet, so this matcher finds nothing with the shipped registry until someone adds dated entries from Google's page.
- **SDK end of support:** a `package.json` that declares a registry `sdk` package, such as `@google/generative-ai`, in any dependency section, read only when some source file names the package. Its line in the manifest is the evidence, with the locked version. A manifest in a test or example path is listed as `test`.
- **Shopify:** `/admin/api/2025-10` URLs, with or without a path after the version, and `ApiVersion.October25`. It also matches `apiVersion: '2025-10'`, but only in files that import a Shopify package or name `myshopify.com`, so a Stripe `apiVersion` is not mistaken for one.
- **Meta Graph API:** `graph.facebook.com/v20.0/` URLs, and quoted `'v20.0'` strings in files that use the Graph API. It also reads `facebook-nodejs-business-sdk` from manifests and lockfiles, since SDK release 20.x targets v20.0 and a locked version wins over the declared range.
- **Refit configuration:** an integration's `apiVersion` in `.refit.json` whose adapter covers one of these providers.

### Live and non-live evidence

Each match is classified by how the code uses it. Only **live** matches make a repository exposed, appear as its evidence and open or update an alert. Everything else is still shown, separately, so nothing is hidden:

| Use         | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Providers                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `live`      | The default: a call argument, a default or env-var fallback, a constant, an alias map's value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | all                                                |
| `catalog`   | One entry in a list naming three or more models (an array, enum or tuple, counting OpenAI- and Claude-shaped IDs, with or without an `openai/` or `anthropic/` prefix, and for a Gemini match also Gemini-shaped IDs); any type position, such as a union or `model: 'gpt-4'` in an interface; a table keyed or indexed by model, such as `PRICES['gpt-4']` or `{ 'gpt-4': { input: 30 } }` (also behind `satisfies` or `as`), and everything inside that entry; an object with constant-case keys naming three or more models, such as `{ GPT_4: 'gpt-4', GPT_4O: 'gpt-4o', O3: 'o3' }`; a model record's `id` or `name` beside a metadata field (`contextWindow`, `context_window`, `contextLength`, `maxOutputTokens`, `max_output_tokens`, `maxInputTokens`, `inputTokenLimit`, `outputTokenLimit`, `knowledgeCutoff`, `pricing`, `cost` or `owned_by`), such as `{ id: 'gpt-4', contextWindow: 8192 }`; a model reference's `versions: [...]` list; one model's IDs on several platforms, an object with two or more model-shaped values of which one is a Bedrock (`anthropic.claude-…`) or Vertex AI (`claude-…@20250514`) form, such as Claude Code's `{ firstParty: 'claude-sonnet-4-5-20250929', bedrock: 'us.anthropic.claude-…', vertex: 'claude-sonnet-4-5@20250929' }`; a membership collection of any size, a list passed to `new Set(...)` or the keys of `new Map([...])`; an HTML or JSX `<option>` | OpenAI, Anthropic, Gemini                          |
| `test`      | Test, spec, story, fixture and example files: `*.test.*`, `*.spec.*`, `*.stories.*`, and `test/`, `tests/`, `__tests__/`, `spec/`, `e2e/`, `cypress/`, `fixtures/`, `examples/` directories                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | OpenAI, Anthropic, Gemini, SDK manifests           |
| `check`     | A comparison, `case 'gpt-4':`, or a prefix or membership call (`startsWith`, `endsWith`, `includes`, `indexOf`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | comparisons: OpenAI, Anthropic, Gemini; calls: all |
| `tokenizer` | An argument of `encoding_for_model` or `encodingForModel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | all                                                |
| `comment`   | Comments, including JSDoc and commented-out code. Each file is parsed, and anything outside a source token is a comment. For model providers (OpenAI, Anthropic, Gemini), a model ID quoted inside a longer plain string with spaces (a description, an error message, embedded markdown) is also a comment. Template literals with substitutions, concatenated pieces and JSX text stay live, and so does a string where the model ID directly follows a key or flag: any name ending in `model`, optionally followed by `id` or `name` (`model`, `model_id`, `modelId`, `OPENAI_MODEL`) and then `:` or `=`, a flag such as `--model` or `-m`, or an upper-case name ending in `MODEL`. A string whose trimmed text starts with `{` or `[`, or that holds a quoted key such as `"engine":`, is data and stays live whatever precedes the ID. Other text before the ID, for example "the model setting: use", leaves it prose. Model IDs are matched only when quoted                                                                                                                                                                                                                                                                                                                                                                                                                                                | all                                                |

Gemini-shaped IDs count toward a list only when the match being classified is a Gemini model, so a list of two OpenAI models and one Gemini model still leaves the OpenAI matches live, as before.

Meta and Shopify matches are classified only as comments, tokenizer arguments and prefix checks. Those were dropped before and are now listed as non-live; nothing else about Meta and Shopify matching changed. On the [benchmark](DEADLINE-BENCHMARK.md) their reported lines were already 100% and 79% live.

The terminal output lists live evidence first, then one collapsed `Not live` line per use, with the count for that use and each file's line numbers. A deadline the repository names only outside live code is not an exposure; it is listed at the end under "Named only outside live code".

`--json` keeps every earlier field and adds new ones:

- Each exposure's `evidence` holds only live matches, and `more` counts live matches past the limit.
- `nonLive` and `nonLiveMore` hold the other matches. `nonLiveCounts` gives the exact number of non-live matches per use, taken before the 20-item cap.
- The benchmark script's results add `nonLive` (counts by use), `nonLiveTotal` and `mentionedOnly`, and keep the 2026-10-20 keys.
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

Only live evidence counts, and report-only deadlines (see [The registry](#the-registry)) never fail it. A model named in a list, a test, an example or a comment never fails a build. The output ends with the result, and on failure it lists each failing deadline with its date and days left.

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

The lead times default to 90, 30 and 7 days. Alerts rest on live evidence only, and a report-only deadline (see [The registry](#the-registry)) never opens one. A deadline named only in a model list, a test or a comment never opens an issue, and an issue lists only live lines plus a count of the matches it did not count. With alerts on, after each poll the service checks every **enrolled** repository, meaning a target approved with `refit enroll` whose managed checkout synced in that poll. Operator workflow targets are not alerted. For each exposure, Refit opens one GitHub issue per repository and deadline when the first lead time is reached. At each tighter lead time, and once the date passes, it updates that issue's title, body and evidence and adds a comment so watchers are notified. If several lead times pass between polls, only one alert is sent, at the tightest. Each repository and deadline's last stage and issue number are saved in the service state's `registry.json` under `deadlineAlerts`, so restarts don't repeat alerts. Turning alerts on or off does not require fresh state.

A committed `.refit-deadlines-ignore.json` in the repository also applies to alerts. An exposure it accepts opens or updates no issue until the entry expires. An invalid ignore file accepts nothing: the service logs that the ignores were not applied and alerts as if the file were absent, so a broken exception never silences an alert.

A failed GitHub request is recorded in status and retried at the next lead time rather than on every poll, so a partially completed request cannot open a second issue. If the registry fails validation, the service logs that alerts were skipped and keeps running. A closed issue stays closed; later stages comment on it but do not reopen it.

Issue alerts need the App's **Issues: Read and write** permission. Add it under the App's permissions, then have each installation accept the update. The alert token is scoped to the repository with exactly Contents read and Issues write. It cannot push, open pull requests or comment on them.

## Propose model replacements

```sh
refit deadlines --propose-model-fixes --repository /path/to/app
refit deadlines --propose-model-fixes --output model.patch
```

For OpenAI and Anthropic models, Refit can propose the registry replacement as a patch. Gemini models and the old Gemini SDK are never proposed, even when an entry names a replacement: widening replacements to a new provider, and swapping `@google/generative-ai` for `@google/genai`, whose call shapes differ, are owner decisions. From the CLI this is a review aid only: nothing is applied, installed, validated or published, and no provider is contacted. The service applies the same rule on its own, with validation and a draft pull request (see [Automatic model fixes](#automatic-model-fixes)).

A replacement is proposed only when all of these hold:

- The call is a traced SDK text-generation call: OpenAI `chat.completions.create`, `.parse` or `.stream` (also under `beta`), `responses.create`, `.parse` or `.stream`, `createChatCompletion` on an openai v3 or `openai-edge` `OpenAIApi` client, or Anthropic `messages.create`, `.stream` or `.countTokens` (also under `beta`). Clients are traced like any adapter's, including class fields and imported clients, using `examples/openai.provider.json` and `examples/anthropic.provider.json`.
- Or the call is a raw HTTP request to `api.openai.com/v1/chat/completions`, `api.openai.com/v1/responses` or `api.anthropic.com/v1/messages`: `fetch(url, { body: JSON.stringify(request) })`, Apps Script's `UrlFetchApp.fetch(url, { payload: JSON.stringify(request) })` or `axios.post(url, request)`, or the request-config forms `axios({ url, data })`, `axios.request({ url, data })` and the same calls on an `axios.create(...)` instance, with the URL written inline or in a `const`.
- Its request is an object literal, or a `const` holding one that only this call uses (`const params = { model: 'gpt-4', messages }`).
- Its `model` is a string literal naming a registry model, or one of these, followed through imports across files:
  - the default of a `??` or `||` fallback, such as `process.env.MODEL ?? 'gpt-4'`;
  - a `const` or enum member holding such a literal and used only by this request (`model: MODEL`, `{ model }`, `model: Model.Default`), edited where it is declared, even in another module;
  - a parameter of the helper function that makes the call, such as `ask(messages, model = 'gpt-4')`. Its default and each caller that passes a literal (`ask(messages, 'o1-mini')`) are edited separately, each to its own replacement.

The rule also traces the sources below. Until the owner decision on editing them (D-06 to D-08) lands, a model reached only through one of them stops for review, and the reason says where it comes from: "The model reaches this request through the class field `model` (src/chat.ts:4), which Refit reports but does not edit yet; change it by hand to gpt-5.6-sol." A request in the axios request-config form stops the same way.

- a class field: an initializer (`model = 'gpt-4'`), `this.model = …` assignments, or a constructor parameter followed to the literal its `new` callers pass, even in another module;
- a `const` object member, with or without `as const` (`CONFIG.model`, `CONFIG['model']`), a default-exported literal (`export default 'gpt-4'`) or object (`export default { chat: 'gpt-4' }`), and a function or method that returns a literal (`getModel()`), a conditional (`cond ? 'gpt-4' : x`), or an env fallback on either side;
- a destructuring default (`const { model = 'gpt-4' } = options`) and a default or literal on an options-object parameter (`ask({ model })`);
- the callers of a method or constructor, and of a default-exported helper in another file.

- The file is not a test, spec, story, fixture or example file, and not build output committed with the sources: `out/` and `ts-out/` directories, `*.min.js` and `*.bundle.js`, and JavaScript whose TypeScript source sits beside it or in a sibling `src/` directory (`lib/ask.js` next to `src/ask.ts`). The next build would overwrite an edit there. `dist/`, `build/` and `.next/` are never read.
- The registry entry names a concrete model ID. When that replacement retires too, Refit follows the registry to a model that does not, for example `o1-mini` to `o4-mini` to `gpt-5.6-terra`.

These cases stop for review and are listed with a reason, with no edit:

- The request sets a parameter the replacement may reject: `temperature`, `top_p`, `top_k` or `thinking` for Anthropic (Anthropic returns a 400 for non-default sampling values on Claude 4.7 and later models, and for `thinking: { type: 'enabled', budget_tokens }`, the only thinking mode of the models now retiring, per its [extended thinking page](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), read 2026-10-22), and `temperature`, `top_p`, `max_tokens`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs` or `top_logprobs` for OpenAI (support on its newer models is unverified).
- The request spreads other options (`{ ...options, model: 'gpt-4' }`).
- The request has no `model` of its own and takes it from a `const` object it spreads (`create({ ...params, messages })`, where `params` holds `model`), as tool-use loops often do: "The request takes its model from the options it spreads (`...params`), which Refit reports but does not edit; change it by hand to <to>."
- The call is made on a client the analyzer cannot trace to the SDK constructor, in a file that imports the SDK: a `let` variable (`let client: OpenAI | null = null; try { client = new OpenAI() } …`), a typed parameter or field (`client: Anthropic`, `constructor(private client: Anthropic)`), an object member (`clients.claude`) or `client!`. The client counts only when one of its declarations names an SDK export (a type annotation or a `new` expression), so an ORM table such as `db.messages.create(...)` does not, and neither does a name a repository file shadows. Reason: "The client `<client>` is not one Refit can trace to the SDK constructor (a `let` variable, a typed parameter or field, or an object member), so this request is listed but not edited; change it by hand to <to>."
- The call is an Anthropic Message Batches request (`messages.batches.create`, `beta.messages.batches.create`); the model of each literal entry's `params` is reported: "`messages.batches.create` is a Message Batches request, which Refit reports but does not edit; change it by hand to <to>."
- The call is an Anthropic Messages helper or retired beta path: the SDK's `beta.messages.toolRunner`, or `beta.tools.messages.create`/`.stream` and `beta.promptCaching.messages.create`/`.stream` from SDK versions before 0.30. Reason: "`<call>` is a Messages API helper or retired beta path, which Refit reports but does not edit; change it by hand to <to>." Editing them would widen which uses `--model-fixes` replaces (#120).
- The client is Claude on Amazon Bedrock (`AnthropicBedrock` from `@anthropic-ai/bedrock-sdk`) or Google Cloud Vertex AI (`AnthropicVertex` from `@anthropic-ai/vertex-sdk`), or the model is a dated Bedrock ID (`us.anthropic.claude-3-5-haiku-20241022-v1:0`) or Vertex AI ID (`claude-3-5-sonnet-v2@20241022`) on any traced request. Those IDs are matched to the Claude API ID they contain, and the stop names the Claude API's date, but the platform sets its own: "The client is Claude on Amazon Bedrock, where model IDs and retirement dates are Amazon Bedrock's, not the Claude API's (the Claude API retires <model> on <date>); check Amazon Bedrock's model lifecycle and change it by hand to its ID for <to>." Undated Bedrock IDs (`anthropic.claude-v2:1`, `anthropic.claude-instant-v1`) are not matched. `refit deadlines` still does not report platform IDs as exposure.
- The request sets a computed property name (`['temperature']: 0.5`, `[KEY]: 5`), which may be a sampling or length parameter the name check cannot see.
- The model comes from a constant, enum or object member, field, helper, parameter or destructured binding, or the request from a `const` object, that is used more than once, even when every use is a traced request: editing a shared source (D-09) is on hold until an application benchmark measures the wrong-edit rate. Object and enum members are counted per member, so reading `MODELS.fast` and `MODELS.slow` uses each once. Uses are matched by symbol, so a use under another name counts: a renamed import (`import { MODEL as LEGACY }`), a renamed re-export (`export { MODEL as DEFAULT_MODEL }`) and a default import under any name. For a parameter, the default and a caller's literal are edited only when every other read of the parameter is a traced request too; when the model is a property of an options object, reads of other properties do not count.
- The module that declares the source is loaded in a way the tracer cannot follow: by `import()`, by `require()` in any file type (including `import x = require()`), by `import.meta.glob` or `require.context`, by `export *` or `export * as`, or through a namespace import used for anything but `ns.name` (a computed key such as `ns[k]` or `(ns as any)[k]`, a destructuring, passing `ns` along). A module that re-exports an opaque module's names is opaque too. A load whose specifier is not a string literal makes every module opaque. Reason: "The module that declares this model is also loaded dynamically or through a namespace the tracer cannot follow; change it by hand to <to>." A static `import { NAME }`, `import NAME` or `import * as ns` read only as `ns.NAME` is followed. Because `require()` makes a module opaque, constants in CommonJS modules that other files `require` are never edited.
- The enum, or the class a field belongs to (with its subclasses), is used as a whole somewhere: `Object.values/entries/keys(E)`, `const X = E`, `E[k]`, a spread, a destructuring, `for … in`, `JSON.stringify(instance)`, `this` used as a value, an instance passed on, or the class passed as a value. Only `E.member`, `E['member']`, `this.member` and an instance read through `.member` are not. Reason: "The model comes from the enum member or field `<name>` (<place>), and its enum or class is also used as a whole, so a change shows up elsewhere; change it by hand to <to>."
- A member is assigned elsewhere: `o.M = …` on an object member or a static field, an instance field assigned through a receiver other than `this`, and, through the shared-use check, `o['M'] = …`, `Object.assign(o, …)`, `delete o.M` and assignments to enum members. Reason: "The `<name>` member is also assigned to elsewhere, so a request may send another value; change it by hand to <to>." `this.field = value` inside the class stays a traced source.
- The model is held in a class that is part of an inheritance tree: a method, field, getter or setter of the same name is declared in another class of the tree or beside it in the same class (an abstract declaration with an override, a subclass field override, an accessor, an overload), the constructor's arguments come through `super(...)` or an inherited constructor, or any class in the repository extends something that is not a plain identifier naming a class declaration (a mixin call, a class expression, an alias such as `const Base = A`, a parameter). With such a base anywhere, every class member and constructor default stops, and the same-named members of those classes are followed to their literals and stop. A getter, including an object-literal getter, is followed through its `return` statements and stops. Reason: "The method, field, accessor or class `<name>` is declared or overridden in another class, is an accessor, or sits in a class tree the tracer cannot fully resolve, so the model cannot be traced through class inheritance; change it by hand to <to>." An `extends` of a global or uninstalled package name (`extends Error`) is ignored.
- Any source file, or any `.env*`, JSON or YAML file outside `node_modules`, contains (case-insensitively) `baseURL`, `baseUrl`, `base_url`, `basePath`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_API_BASE`, `withOptions(` or `AzureOpenAI`, where `base` starts a word or a camel-case part, so `firebase_url`, `DATABASE_URL` and `databasePath` do not count. `tsconfig*.json`, `jsconfig*.json` and lockfiles are skipped, because a compiler `baseUrl` configures no client. The text is not traced to a client, so a match, even in a comment, stops every SDK request in the repository; an oversized or unreadable file or more than 5,000 such files also counts as a match: "The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to <to>." Raw HTTP requests to the official hosts are not affected. Where Refit can follow the request's client to its constructors (through variables, including a `let` through each assignment, class fields and their `this.x = …` assignments, object members, and the returns of a function called with no arguments, such as a lazy `getClient()`), the reason is more precise. A constructor option that sets the endpoint (`baseURL`, `baseUrl`, `basePath`, `fetch`, `defaultQuery`, `defaultHeaders`) is named: "The client sets `baseURL` (src/chat.ts:3), …". A client whose constructors pass only literal options without one, in a repository where no match sets every client's endpoint (the `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` or `OPENAI_API_BASE` variables the SDKs read, `withOptions(`, `AzureOpenAI`, or an assignment such as `client.baseURL = …`), stops with where the mention is: "The repository mentions a custom endpoint (src/proxy.ts:1), but this request's client (src/a.ts:2) sets none; editing it waits on an owner decision on endpoint tracing; change it by hand to <to>." Editing those requests is behind `endpoints: true` in `proposeModelReplacements`, off by default and not exposed by any command until an owner decides.
- The call is not a text-generation call (see below).
- A trace was cut by the depth limit of 10 or the work budget of 2,000 steps. Every retiring model the cut hid and a bounded follow-up can find stops, and the reason names the limit: "Tracing this model stopped at the work budget of 2,000 steps (or depth limit of 10), so not every source and use could be checked; change it by hand to <to>."
- The helper carrying the model is passed around as a value, or called with spread arguments.
- The model comes from a class property read as `this.model`: its field initializer, constructor parameter default or an assignment such as `this.model = options.model ?? 'gpt-4'`. The stop names where the model is written. Class properties are reported, not edited: editing them would widen which uses `--model-fixes` replaces, which needs an owner decision first.
- The call is a `fetch` to a host other than the official API that sets the `anthropic-version` header inline and sends `model` and `messages`: an Anthropic request through a proxy or configurable base URL. Reason: "The request goes to a host other than the official API, so the model may name another provider's model or a deployment; change it by hand to <to>."
- The SDK import sits under a `tsconfig.json` or `jsconfig.json` Refit cannot fully read, for example one extending a file a framework generates on install (`./.svelte-kit/tsconfig.json`) that is not checked in. The import could then be an alias, so the call is traced and listed but not edited. A bare import under a catch-all `paths` entry such as `"*": ["*"]` is the installed package when no mapped target is a scanned source, as TypeScript resolves it.
- The registry has no concrete replacement.

Every live OpenAI or Anthropic match that none of the above reaches is listed under **Not sent by a traced request** (`unresolved` in `--json`) with its file, line, replacement and where it is written, for example "No traced request sends it as its model; it is the `defaultModel` value of an object", or "No file imports `@anthropic-ai/sdk`, so the model may reach the API through another library or a wrapper". So every live match ends in a replacement, a stop or a reason; unresolved matches are never edited.

Every traced SDK call outside the text-generation list stops with a named reason and is not edited: "`<call>` is not a call Refit edits; <to> may change formats or parameters; change it by hand to <to>." This covers images, audio, embeddings, moderations, legacy completions (`completions.create`, v3 `createCompletion`), v3 methods other than `createChatCompletion`, assistants and others. Raw JSON-body requests to the matching OpenAI endpoints (images, audio speech, embeddings, moderations, completions) and to Anthropic's `POST /v1/complete` stop the same way. Multipart bodies are not read. A call that sends no `model` object stays silent. In `refit serve --model-fixes`, a repository whose only retiring uses are in such calls now moves from `no-change` to `needs-review`. A model sent through another host (such as the app's own proxy) or a Deno re-export, or held in settings objects, UI state or CLI option defaults, is not traced and stays an ordinary exposure. A model sent through the Vercel AI SDK, LangChain JS or LlamaIndex TS is detected by [`pipeline/model-wrappers.ts`](MODEL-WRAPPERS.md): it stops with the wrapper call that sends it ("The model is sent through @ai-sdk/openai openai() (src/ai.ts:3), a Vercel AI SDK call Refit reports but does not edit; change it by hand."), and a gateway or registry ID such as `'openai/gpt-4o'` or `'anthropic:claude-…'` counts as exposure to the bare ID.

`--json` returns `replacements` (each with the call's `file`, `line` and `call`, `edited`, the place the string changes, `from`, `to`, the deadline and `via`, the registry entries followed), `stops` (each with `at`, where the model is written, and a `reason`), `unresolved` (each with `file`, `line`, `model`, `to` and a `reason`) and `patch`.

On the 34 OpenAI repositories of the [deadline benchmark](DEADLINE-BENCHMARK.md), 22 send a registry model from live code (2026-10-21 run, with the registry as of that day). The rule proposed 6 replacements in 2 of them, 4 through the v3 SDK or `openai-edge`. Every proposal was read by hand, and each is the registry replacement in a plain request. It stopped for review, with a reason, in 4 more:

- a helper whose request sets `max_tokens`;
- a raw `fetch` that sets `temperature`;
- spread options;
- a reused request object.

The other 16 hold the model in settings or UI defaults, a CLI option default, an alias map, a request to the app's own proxy, an Apps Script options variable, a Deno library or a configuration object, or name only non-text models. Results are in [`benchmarks/2026-10-21-model-replacement-results.json`](benchmarks/2026-10-21-model-replacement-results.json); the 2026-10-20 run is in [`benchmarks/2026-10-20-model-replacement-results.json`](benchmarks/2026-10-20-model-replacement-results.json).

## Automatic model fixes

```sh
refit serve --env .env --config service.json --state /path/outside/repo \
  --model-fixes --publish-draft
```

With `--model-fixes`, the service maintains retiring OpenAI and Anthropic models in every **enrolled** repository without asking first (never Gemini; see above): enrollment with `refit enroll` is the approval. It is off by default. After each poll, for each enrolled repository whose managed checkout synced:

1. Refit applies the [model replacement rule](#propose-model-replacements) to the committed snapshot. Uses that stop for review are never edited.
2. It runs the repository's approved check command (its `.refit.json` `image`, `command`, `baselineCommand`, `prepareDependencies` and `compareTypeErrors`) before and after the change, in the same offline Docker sandbox and limits as contract migrations.
3. When both runs pass and `--publish-draft` is set, it opens a draft pull request as Refit Agent. The description lists each replacement with its deadline and registry source, the check results, every use left for review, and what the checks cannot show. Without `--publish-draft`, the run is recorded as `validated`.

Refit never merges the pull request or marks it ready. A failing check publishes nothing. The outcome of each repository is saved in the service state under `modelFixes`, keyed by the replacements themselves (file, model and replacement). While their pull request stands, the same replacements are not validated or published again, even after new commits. A pull request a developer closes is not reopened for the same replacements. A new retiring model, or a registry change, starts a new run.

The checks run without network access, so no request reaches OpenAI or Anthropic. A passing check does not show how the new model answers, what it costs, or whether it accepts every parameter; that is for the reviewer to try. Operator workflow targets are not changed.

## The migration path

Every alert and CLI result states one of three outcomes:

- **Configured:** an integration in the repository's `.refit.json` covers the provider. When the provider publishes the change in the contract Refit monitors, that integration's normal migration run handles it.
- **Agent available:** Refit ships an agent for the provider, currently OpenAI's preview adapter and the built-in Shopify agent. The alert gives `refit agents --add <id>` and the enrollment steps.
- **No agent yet:** currently Meta, Anthropic and Gemini. The alert says so and points to the provider's guide. Anthropic's adapter exists for model replacement proposals, but it is not in the agent catalog because Anthropic publishes no contract that `refit run` could compare.

### Sourced model parameters

`data/model-parameters.json` records, per replacement model, what an official provider page read on `checkedAt` says it accepts. Each entry has `provider`, `model`, `parameters` (per parameter `accepts` of `any`, `default-only` or `none`, with `min` and `max`, `default`, or `renamedTo` where they apply), a `source` and, whenever a default is given, a `defaultSource`. Every URL must be https on an official OpenAI or Anthropic host. The table is off by default (owner decision, 2026-10-22): only `refit deadlines --propose-model-fixes --parameters <path>` reads it, and without it the heuristic below applies to every replacement. Any error rejects the whole file, and that command then stops instead of falling back to an empty table. Check it with `npm run model-parameters:check`. Nothing runs, installs or contacts a provider.

Only a number written directly in the request, optionally signed, is compared with the table. Constants and expressions are not followed. A renamed parameter, such as `max_tokens` on `o3`, stops with a reason naming the new parameter and is never rewritten.

With the shipped table passed, only a literal `temperature: 1` on a `claude-sonnet-5-5` replacement continues. For replacements with a table entry, the table decides each parameter, and everything it does not prove keeps stopping (`top_p` and `top_k` on `claude-sonnet-5-5`, for example). For replacements without an entry the earlier heuristic is unchanged: Claude 4.7-and-later replacements, such as Opus 4.8, stop on `temperature`, `top_p` and `top_k`; earlier ones, such as `claude-haiku-4-5-20251001`, continue; every OpenAI replacement stops on its sensitive parameters. A computed property name in the request stops in both paths. Entries come only from official pages someone read. See AGENTS.md.

A deadline starts a code change only through [automatic model fixes](#automatic-model-fixes), which the service runs when `--model-fixes` is on. Every other migration starts from contract changes, approved configuration and the existing gates.

## Limits

- Parameter values are read only as numeric literals. Renamed parameters are never rewritten. Fixture tests of the parameter rule do not exercise a live provider.
- Only JavaScript and TypeScript source is scanned. Models named in environment files, YAML or other languages are not found. Values built at runtime are invisible.
- Shopify package versions are not mapped to the API version they default to, and Shopify versions older than 2025-04 are not in the registry yet.
- A version held in a constant or an environment-variable fallback, such as `SHOPIFY_API_VERSION = '2025-07'`, and the Meta JS SDK's `FB.init({ version })` are not read.
- Live is the default, so some catalogs still count as live. These include lists of one or two models, preset data that repeats one model, catalogs built through function calls such as `modelRef({ name: 'gpt-4' })` without a metadata field, separate exported constants, and alias maps or code nobody imports. Code is not traced, so an unused file counts like a used one. On the [benchmark](DEADLINE-BENCHMARK.md), 4 of 23 reported OpenAI lines are of this kind.
- A match counts as a test or an example from its path alone. A live pin kept under `examples/` or `fixtures/` is listed as non-live.
- A model ID sent to another provider's OpenAI-compatible endpoint matches the OpenAI deadline. A Claude API model ID sent through Claude Platform on AWS or Microsoft Foundry matches the Anthropic deadline, which Anthropic's page says applies there too.
- Gemini model retirements are not in the registry, because Google's page could not be read from Refit's build environment. A Gemini model ID sent through Vertex AI (`@google/genai` with `enterprise: true` or `vertexai: true`) would match the same Gemini API entry once one exists, although Google Cloud may set its own dates there (unverified).
- An `sdk` entry matches a declared package only when some source file names it; a package that is declared but never imported is not reported.
- Anthropic's page lists dated model IDs. Aliases of models that are already retired, such as `claude-3-5-sonnet-latest`, are not in the registry, because no current Anthropic page documents them; only `claude-sonnet-4-5` is.
- Files under a `tsconfig` whose path aliases cannot be verified get no traced requests and no stop.
- Not traced: request objects built by functions; clients the analyzer does not recognize (`let` clients, factories, typed parameters, dependency injection); CommonJS namespace members (`exports.MODEL`); URLs built from a base constant in a template; a field read through `{ ...this }` or destructuring of `this`; anonymous `export default function () {}` callers; and `got` and other HTTP libraries besides `fetch`, axios and `UrlFetchApp`.
- A non-call use of a class (`Chat.create()`) stops that class's constructor-default site, conservatively. `extends Chat` is followed through the subclasses' `super(...)` calls and `new` calls, and stops.
- Untraced shapes, which stay silent. The list is complete for the shapes known: a `let` or `var` model variable; array iteration and callbacks (`['gpt-4'].forEach((m) => …)`, `.map`); numeric index access (`L[0]`); array destructuring (`const [A] = …`); rest parameters and `arguments`; `this` in an object-literal method or in a function called through `.call`, `.apply` or `.bind`; a getter or setter read through anything but `obj.name` (a destructuring, a computed key); computed access with a non-literal key (`MODELS[key]`); an `export =` or `module.exports` value read through `require`; and any value assembled by a function the trace cannot follow. Getters read as `obj.name` are followed and stop. A custom `fetch` option on a client constructor (`new OpenAI({ fetch })`) is not detected as an endpoint override. The `&&` operator is followed: in `flag && 'gpt-4'` the right side is the model.
- A trace cut by a limit reports nothing when the bounded follow-up finds no retiring model to name or reaches its 20,000-expression cap. The follow-up ignores property keys, so it can stop on a retiring model in a sibling property of the same object, but it never edits.
- Evidence is capped at 20 live and 20 non-live matches per deadline, plus a count of the rest.
- Issues are not closed automatically once the repository stops depending on a deadline.
- `--fail-within` checks only what Refit can see; the limits above apply. A passing check does not prove the repository uses no retiring version or model.
- The registry follows the provider pages listed above through a daily sync that a person reviews, and changes only when that pull request is merged. Recheck an entry's `source` before relying on a date.
