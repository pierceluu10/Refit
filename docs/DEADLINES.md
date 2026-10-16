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

It starts with three providers, checked on 2026-10-15 against their own documentation:

| Provider | Covers | Source |
|---|---|---|
| Shopify | Admin API versions 2025-04 to 2026-10 and when each stops being accessible | [API versioning](https://shopify.dev/docs/api/usage/versioning) |
| Meta | Graph API v13.0 to v25.0 and when each stops being available | [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog) |
| OpenAI | Model shutdowns from July 2025 to April 2027 | [Deprecations](https://developers.openai.com/api/docs/deprecations) |

Past-due entries stay in the registry on purpose: a repository still pinning a retired version is the most urgent case. To change the registry, edit the file from the provider's page, set `checkedAt` to the day you checked, and run:

```sh
npm run deadlines:check
```

This is the same as `refit deadlines --check-registry`. It fails on shape errors, such as unknown fields, invalid dates, duplicate IDs or a version listed under two deadlines. It also flags entries that are past due or have no source. An entry without a source still loads but is never matched or alerted: a deadline nobody can verify must not open an issue in someone's repository. Refit never fetches provider pages or calls provider APIs to refresh the registry.

## Check a repository

```sh
refit deadlines --repository /path/to/app
refit deadlines --repository /path/to/app --json
```

Each exposure lists the deadline, days left, the replacement, the source and `file:line` evidence from live code. It also lists what can happen next (see [the migration path](#the-migration-path)). Refit reads JavaScript and TypeScript source, `package.json` files, lockfiles and `.refit.json`, without running code. It matches:

- **OpenAI:** a quoted string that equals a registry model ID exactly, such as `'gpt-4'`. `'gpt-4o'` does not match `gpt-4`. A string passed to a tokenizer (`encoding_for_model`) or a prefix or membership check (`startsWith`, `endsWith`, `includes`, `indexOf`) is not a pin. Model lists, tests and other uses are classified [below](#live-and-non-live-evidence).
- **Shopify:** `/admin/api/2025-10` URLs, with or without a path after the version, and `ApiVersion.October25`. It also matches `apiVersion: '2025-10'`, but only in files that import a Shopify package or name `myshopify.com`, so a Stripe `apiVersion` is not mistaken for one.
- **Meta Graph API:** `graph.facebook.com/v20.0/` URLs, and quoted `'v20.0'` strings in files that use the Graph API. It also reads `facebook-nodejs-business-sdk` from manifests and lockfiles, since SDK release 20.x targets v20.0 and a locked version wins over the declared range.
- **Refit configuration:** an integration's `apiVersion` in `.refit.json` whose adapter covers one of these providers.

### Live and non-live evidence

Each match is classified by how the code uses it. Only **live** matches make a repository exposed, appear as its evidence and open or update an alert. Everything else is still shown, separately, so nothing is hidden:

| Use | What it covers | Providers |
|---|---|---|
| `live` | The default: a call argument, a default or env-var fallback, a constant, an alias map's value | all |
| `catalog` | One entry in a list naming three or more models (an array, enum or tuple, counting `openai/`-prefixed IDs); any type position, such as a union or `model: 'gpt-4'` in an interface; a table keyed or indexed by model, such as `PRICES['gpt-4']` or `{ 'gpt-4': { input: 30 } }`, and everything inside that entry; an HTML or JSX `<option>` | OpenAI |
| `test` | Test, spec, story, fixture and example files: `*.test.*`, `*.spec.*`, `*.stories.*`, and `test/`, `tests/`, `__tests__/`, `spec/`, `e2e/`, `cypress/`, `fixtures/`, `examples/` directories | OpenAI |
| `check` | A comparison, `case 'gpt-4':`, or a prefix or membership call (`startsWith`, `endsWith`, `includes`, `indexOf`) | comparisons: OpenAI; calls: all |
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

## The migration path

Every alert and CLI result states one of three outcomes:

- **Configured:** an integration in the repository's `.refit.json` covers the provider. When the provider publishes the change in the contract Refit monitors, that integration's normal migration run handles it.
- **Agent available:** Refit ships an agent for the provider, currently OpenAI's preview adapter. The alert gives `refit agents --add <id>` and the enrollment steps.
- **No agent yet:** currently Shopify and Meta. The alert says so and points to the provider's guide.

A deadline never starts a migration by itself. Migrations start from contract changes, approved configuration and the existing gates.

## Limits

- Only JavaScript and TypeScript source is scanned. Models named in environment files, YAML or other languages are not found. Values built at runtime are invisible.
- Shopify package versions are not mapped to the API version they default to, and Shopify versions older than 2025-04 are not in the registry yet.
- A version held in a constant or an environment-variable fallback, such as `SHOPIFY_API_VERSION = '2025-07'`, and the Meta JS SDK's `FB.init({ version })` are not read.
- Live is the default, so some catalogs still count as live. These include lists of one or two models, preset data that repeats one model, catalogs built through function calls such as `modelRef({ … })`, and alias maps or code nobody imports. Code is not traced, so an unused file counts like a used one. On the [benchmark](DEADLINE-BENCHMARK.md), 4 of 23 reported OpenAI lines are of this kind.
- A match counts as a test or an example from its path alone. A live pin kept under `examples/` or `fixtures/` is listed as non-live.
- A model ID sent to another provider's OpenAI-compatible endpoint matches the OpenAI deadline.
- Evidence is capped at 20 live and 20 non-live matches per deadline, plus a count of the rest.
- Issues are not closed automatically once the repository stops depending on a deadline.
- `--fail-within` checks only what Refit can see; the limits above apply. A passing check does not prove the repository uses no retiring version or model.
- The registry is maintained by hand from the provider pages listed above. Recheck it before relying on a date.
