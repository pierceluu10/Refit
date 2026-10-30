# Meta Graph API

Refit has no Meta agent yet. This page covers the review-only groundwork toward one: finding the Graph API requests a repository makes, with the version each pins and what each asks for. Nothing here changes code, and nothing contacts Meta. The goal and its milestones are in [Provider goals](PROVIDER-GOALS.md#meta-graph-api).

Why it matters: every Graph API version has an end date in Refit's [deadline registry](DEADLINES.md), and calls to a retired version "will be defaulted to the next oldest, usable version" ([versioning](https://developers.facebook.com/docs/graph-api/guides/versioning), as cited by the [deadline benchmark](DEADLINE-BENCHMARK.md)). `refit deadlines` already reports those pins. Every one of the 11 labelled Meta repositories in that benchmark pins a retired version, so its behaviour has already changed without an outage.

## List the Graph API requests

```sh
refit meta-graph --repository /path/to/app
refit meta-graph --repository /path/to/app --json
```

Refit reads JavaScript and TypeScript source and `package.json` files, without installing or running anything. It reports two kinds of request:

- **Raw HTTP to `graph.facebook.com`.** A URL is a string, template or `+` concatenation that starts with `https://graph.facebook.com`, or with a constant that holds one: `` `${GRAPH_BASE}/me/accounts` ``, including a base exported from another file and imported by name (`import { GRAPH_BASE } from './graph.js'` or `const { GRAPH_BASE } = require('./graph')`), and aliases such as `const API = GRAPH_BASE`. A URL kept in a `const` and passed to a call later is followed to that call.
- **Raw HTTP to `graph.instagram.com`**, read the same way: the Instagram API with Instagram Login on Graph versions, and the retired Instagram Basic Display API, unversioned. Each request has a `host` field naming graph.facebook.com or graph.instagram.com.
- **The browser JavaScript SDK.** `FB.api(path, method?, params?, callback?)` with the version `FB.init({ version: 'v20.0' })` sets, pinned at that `FB.init`. Several `FB.init` calls with different versions, or one built at runtime, leave the version unknown. An `FB.init` with no `FB.api` request anywhere is reported on its own, as a pin with no traced request.
- **`facebook-nodejs-business-sdk` resource classes.** `new AdAccount(id).getCampaigns(fields, params)`, or a variable holding `new AdAccount(id)`, where `AdAccount` comes from the SDK through a named import, `bizSdk.AdAccount`, or a destructured `require`. The SDK's generated methods are mapped to Graph API edges by [`data/meta-business-sdk-edges.json`](../data/meta-business-sdk-edges.json), built from the SDK's own source (see [below](#the-business-sdk-edge-map)). `get` and `read` read the node, `update` posts to it and `delete` deletes it. `FacebookAdsApi.init` is set-up, not a request.

Each request lists:

| Field                             | Meaning                                                                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`, `line`                    | Where the request is made: the `fetch`, `axios` or helper call, or the SDK call. A URL no call uses is reported at the URL.                                                                                                                                                       |
| `client`, `method`                | The function the URL is passed to and the HTTP method. `fetch` without a `method` is a GET; `axios.post` is a POST.                                                                                                                                                               |
| `version`, `versionSource`, `pin` | The Graph API version, and where it is written: in the URL, in a constant (`pin` names the constant's line, even in another file), or, for the SDK, the manifest or lockfile (SDK release 20.x calls v20.0; a locked version wins). `unversioned` means the URL names no version. |
| `path`, `edge`                    | `/{pageId}/photos`: literal segments as written, runtime segments named in braces. `edge` is the last literal segment after a node; it is null for a node read such as `/{postId}`.                                                                                               |
| `fields`, `metrics`               | The requested `fields` and insights `metric` values, as written (`picture.type(large)`, `instagram_business_account{id,username}`). `[]` means the request names none, so a read returns the node's default fields.                                                               |
| `parameters`                      | Names of the query and body parameters.                                                                                                                                                                                                                                           |
| `unknown`                         | Each thing Refit could not read, and why.                                                                                                                                                                                                                                         |
| `use`                             | `test` for test, spec, story, fixture and example files, which the text output lists separately.                                                                                                                                                                                  |

### What is read, and what stays unknown

Values are read only from literal code. Anything built at runtime is reported as unknown with its reason and never guessed:

- **Request options** are read from `fetch(url, { method, body })`, `axios.get(url, { params })`, `axios.post(url, data, { params })` and `axios({ url, method, params, data })`, including a `const` object or `new URLSearchParams({...})` and `JSON.stringify({...})` around one. A spread (`{ ...defaults }`), a computed key, a `FormData`, or a `const` changed after its declaration (`params.set(...)`, `body.link = ...`, `Object.assign(options, ...)`) makes the parameters unknown, and with them `fields` and `metrics`.
- **Parameters set step by step** on a `const` holding `new FormData()`, `new URLSearchParams(...)` or an object literal are read when every change names a literal key: `form.append('source', file)`, `params.set('fields', 'id')`, `body.link = url` or `body['link'] = url`. A `fields` or `metric` value set under an `if`, a loop or `cond && ...` is unknown, since the request may not send it. `qs.stringify(params)`, `querystring.stringify(params)` and `params.toString()` carry the same parameters. A computed key, `delete` or `Object.assign` still makes them unknown.
- **Helpers.** A project helper whose body makes exactly one `fetch` call with its URL parameter, and no options or another parameter as options, both unchanged, such as `metaFetch(ctx, url, init)` calling `ctx.fetch(url, init)`, is read like `fetch`: its method and options come from the arguments at the call. It is found in the same file or through a relative import, including an alias (`metaFetch as fb`). A Graph URL passed to any other function is reported with that function as the client. Its HTTP method and extra options are unknown, so its parameters are too; `fields` written in the URL itself are still reported.
- **axios instances.** Requests made on `const graph = axios.create({ baseURL: 'https://graph.facebook.com/v20.0' })` in the same file, such as `graph.get('/me', { params })`, are read with the base's version and pin. Any other use of the instance (exported, passed to a function, stored) is listed as unknown on each request, since it may make requests the scan cannot see.
- **Versions and paths.** `` `https://graph.facebook.com/${version}/…` `` has an unknown version, unless `version` is a `const` holding a literal such as `'v21.0'`, or the fallback of an environment variable (`process.env.GRAPH_VERSION || 'v21.0'`, also `??` and `import.meta.env`), reported as `env-default`. A base held as `process.env.GRAPH_URL ?? 'https://graph.facebook.com/v19.0'` is read the same way. The value deployed in the variable can differ; Refit reports and moves the version the code ships. A runtime segment after the node (`` `/${id}/${edge}` ``), or one named like a path (`${path}`, `${endpoint}`), makes the rest of the path unknown. A substitution that is a whole `fields` or `metric` value is read when it resolves to a literal list (`fields=${FIELDS.join(',')}` with `const FIELDS = ['id', 'caption']`); any other substitution inside a query value is unknown.
- **URL objects, conditionals and builders.** `const url = new URL(graphUrl)` sends the parameters added with `url.searchParams.set('name', value)` or `.append(...)` with a literal name, and reaches its request as `url`, `url.toString()`, `url.href` or `String(url)`; any other change to the URL (`url.search = …`, a computed name) makes its parameters unknown. Each branch of `cond ? urlA : urlB` is its own request at the call it reaches. A function that returns a Graph URL, declared in the file and not exported, is followed to every call of it; if one call's result reaches no request, or the function is used any other way, none is. `encodeURIComponent(pageId)` is the node `{pageId}`.
- **Wrappers.** A helper that sends `fetch(url, { ...options, signal })` (the caller's options spread first, then only transport options) is read like a passthrough, and a fetch passed in as a parameter named for it (`fetcher`, `fetchImpl`, typed as fetch or untyped) like `fetch`.
- **Reassigned URLs.** A `let` assigned again, such as a pagination loop's `next = data.paging.next`, may hold another URL by the time of the request, so its path, edge, fields and parameters are unknown.
- **URL objects, conditionals and returned URLs.** `new URL(graphUrl)` is read like the string it wraps, with `url.searchParams.set('fields', 'id')` and `append` calls on a literal name as query parameters; any other change to the object (`url.search = …`, a computed name, `searchParams` passed on) is unknown. `url.toString()`, `url.href` and `String(url)` are the same URL. Each branch of `cond ? urlA : urlB` is its own request. A URL a file-local, unexported function returns is followed to where that function's calls go. Bases are not followed through any of these.
- **More helpers.** A helper that sends `{ ...init, signal, headers }` (only transport options added after the caller's options) reads the caller's options; a helper declared as a `const` inside another function is found; and a paging helper whose `let next = startUrl` is only ever assigned Meta's own `response.paging.next` is read with the first URL it is given. A body spread that adds an object conditionally (`...(cond ? { link } : {})`) adds its names; a `fields` or `metric` set that way is unknown.
- **Imports through path aliases.** Helpers, bases and exported version constants (`export const GRAPH_VERSION = 'v21.0'`, also an environment variable's fallback) are followed through relative imports and through the repository's tsconfig or jsconfig `paths` and `baseUrl`. A version imported from another file pins the file that declares it. A move edits it only when every file that imports it by name uses it only where the scan reads it; a namespace or default import of that module, a re-export, or a whole-module `require` or `import()` stops the move.
- **Bases.** A versioned base URL passed to a function, such as `createClient('https://graph.facebook.com/v18.0')`, is reported once with no request, since the requests built from it are not traced. An unversioned base says nothing about a version and is not reported.
- **Comments never count**, and neither do other hosts (`api.instagram.com`, `b-graph.facebook.com`) or a bare host name used as an object key.

## The business SDK edge map

`data/meta-business-sdk-edges.json` lists the SDK's 948 resource classes and, for each of its 648 generated method names, the HTTP method and Graph API edge it calls. It is generated from facebook-nodejs-business-sdk 24.0.1 (Graph API v24.0) by reading the SDK's `src/objects/*.js` as text; the package is downloaded with `npm pack --ignore-scripts` and never installed or run:

```sh
npm pack facebook-nodejs-business-sdk@24.0.1 --ignore-scripts
tar xzf facebook-nodejs-business-sdk-24.0.1.tgz
node scripts/meta-business-sdk-edges.mjs --package package --output data/meta-business-sdk-edges.json
```

Six method names map to different edges on different classes (for example `getAdAccounts` is `/adaccounts` on `User` and `/ad_accounts` on `CPASBusinessSetupConfig`); those are listed per class. The map comes from one SDK release. An older SDK can lack a method, which is then not reported, and the map is not evidence of what any Graph API version accepts.

## Measured on the deadline benchmark

All 33 Meta repositories of the frozen [deadline benchmark](DEADLINE-BENCHMARK.md) were scanned at their pinned commits on 2026-10-20 with no code run ([results](benchmarks/2026-10-20-meta-graph-call-results.json)). Every request reported in live code was read in context and labelled ([labels](benchmarks/2026-10-20-meta-graph-call-labels.json)):

| Measure                                                                                       | Result                                                        |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Repositories with a reported request                                                          | 31 of 33                                                      |
| Requests reported in live code                                                                | 162                                                           |
| Real Graph API requests or endpoints                                                          | 162/162                                                       |
| Requests whose every reported value matches the code                                          | 162/162                                                       |
| Version pinned and read                                                                       | 157 (the other 5 are unversioned URLs)                        |
| Path and edge read                                                                            | 158                                                           |
| `fields` read                                                                                 | 113 (70%)                                                     |
| HTTP method read                                                                              | 136 (the other 26 go through helpers or have no request call) |
| Labelled live Graph pins from the deadline benchmark with a request on or pinned at that line | 62/63 (98%)                                                   |

- **No reported value was wrong.** One was, before labelling finished: a template split over three lines put a line break into the edge (`access_token\n  `). Path segments are now trimmed, a test covers it, and the scan was rerun before the labels were written.
- **The missed pin** is `FB.init({ version: 'v20.0' })` for the browser JavaScript SDK in `shreevalikushe/facebook-test`, which neither `refit deadlines` nor this command reads.
- **Against a loose search** of every `graph.facebook.com` line in live code (143), 134 lines carry a reported request or its pin. The other 9 are three comments, another host, a host name used as an object key, two unversioned base constants (one feeds a reported request; the other, in `dogalyir/whatsapp-cloud-api-types`, is a configurable base its client joins with a runtime version, so those requests are not found), and a URL whose request is reported on the line above.
- **Where `fields` stays unknown (49):** 28 requests send options built at runtime (`FormData`, `URLSearchParams` filled in step by step, `qs.stringify`, spreads, objects changed after they are declared); 16 go through project helpers, 15 of them in `manypost/manypost-app`; 4 are OAuth token endpoints held in configuration for a library to call; 1 is a pagination loop that reassigns its URL.
- **The business SDK is barely used here.** One repository declares it and only calls `FacebookAdsApi.init`. SDK mapping is covered by the fixture tests, not by this benchmark.

The labels were made in a single AI-assisted pass and have not been checked by a second labeller. To reproduce:

```sh
node scripts/meta-graph-benchmark.mjs --root <dir> --refit <pinned worktree>
node scripts/meta-graph-benchmark.mjs --root <dir> --score
# or score the committed results
node scripts/meta-graph-benchmark.mjs --root . --score --results docs/benchmarks/2026-10-20-meta-graph-call-results.json
```

## The per-version change list

`data/meta-graph/changes.json` is the versioned list of what each Graph API version, and each out-of-cycle or platform change, removes or changes, built from Meta's changelogs in the style of the [deadline registry](DEADLINES.md#the-registry). Meta publishes prose changelogs, not a contract, so every record names the page it came from, the day it was read and the passage that states it; `refit rules check` finds each passage in the saved page. How it is built, its kinds, its rules and its coverage: [Meta Graph change table](META-GRAPH-CHANGES.md).

```json
{
  "formatVersion": 1,
  "provider": "meta-graph",
  "versions": [
    {
      "version": "v21.0",
      "status": "reviewed",
      "source": "https://developers.facebook.com/docs/graph-api/changelog/version21.0",
      "checkedAt": "2026-10-20",
      "note": null
    }
  ],
  "changes": [
    {
      "id": "meta-graph-v21-0-page-example",
      "version": "v21.0",
      "kind": "field-removed",
      "node": "Page",
      "edge": null,
      "path": null,
      "name": "example_field",
      "summary": "The example_field field on Page is removed.",
      "source": "https://developers.facebook.com/docs/graph-api/changelog/version21.0#pages",
      "checkedAt": "2026-10-20"
    }
  ]
}
```

(The change above illustrates the format; it is not a real Meta change.)

- **`versions`** has one record per Graph API version. `reviewed` means every removal or change on that version's changelog page that names an edge, field, metric, parameter or endpoint is in `changes`. `unread` means nobody could read the page, and `note` must say why. `checkedAt` is the day someone read the page, or tried to.
- **`changes`** lists what a version introduces. A change applies to requests pinned to that version and every later one. `kind` is one of `endpoint-removed`, `edge-removed`, `edge-changed`, `field-removed`, `field-changed`, `metric-removed`, `metric-changed`, `parameter-removed` or `parameter-changed`. `edge` is the edge in `/{id}/<edge>`, `path` a root endpoint such as `/instagram_oembed`, `name` the field, metric or parameter, and `node` the node type as the changelog names it (`Page`, `IG Media`).

Check it after every edit:

```sh
npm run meta-graph:check
```

This is the same as `refit meta-graph --check-changes`, and `--changes <path>` checks another file. The whole file is rejected, and the command exits 1, on any of these:

- an unknown or missing field, a duplicate version or ID, or an invalid or future date;
- a source that is not an `https://developers.facebook.com/` page;
- a change whose version has no record, or whose version is not `reviewed`, since a change can only come from a page someone read;
- a change that does not name what its kind needs, such as a field removal with no field name;
- an `unread` version with no note.

It also lists the `unread` versions, since a version move across them must stop for review, and any Meta version in the deadline registry that has no record. Nothing fetches Meta's pages or calls Meta's API.

### What the list holds today

**v10.0 to v26.0 are `reviewed`, with 816 changes and 105 rules (2026-10-29).** The Graph API and Marketing API changelogs of every version, the Graph API out-of-cycle changes since 2021 and the Instagram Platform, WhatsApp Business Platform and Messenger Platform changelogs were saved and mined; see [Meta Graph change table](META-GRAPH-CHANGES.md) for the method, the coverage and what is still missing. Out-of-cycle and platform changes that apply to every version at once have `version: null` and the date in `appliesToAll`, so no version move crosses them.

- **WhatsApp and Messenger.** Their changelogs are in the list (the WhatsApp page from 2021-10-21, the Messenger page from 2020-12-01), and their requests are matched against it like any other (founder mandate relayed 2026-10-29, `feat/meta-changelogs`). Only a move across a version released before 2021-10-21 still stops for them.
- **WhatsApp On-Premises API.** Meta shut it down on 2025-10-23 ([sunset page](https://developers.facebook.com/docs/whatsapp/on-premises/sunset/), saved as `whatsapp-on-premises-sunset`). A client is found by its `/v1/users/login` endpoint in a file that names WhatsApp; it is listed as a product migration with an alert, never edited.
- **Node-wide changes.** Some changes remove a whole node type, such as `GET /{offline-event-set-id}` or the Instagram v1.0 nodes. An opaque ID cannot reveal its node type, so these are recorded as a single placeholder path, and they stop every request to a single opaque node (a placeholder or numeric ID) whose version range crosses them. They never match a literal path such as `/me`.
- **v26.0** has a record although the deadline registry, which lists sunsets only, does not list it.

To update the list, read the new version's changelog page in full, add every removal or change that names an edge, field, metric, parameter or endpoint, set the version to `reviewed` with the day you read it, and run `npm run meta-graph:check`.

## Propose version moves (review only)

```sh
refit meta-graph --propose-version-moves --target v25.0 --repository /path/to/app
refit meta-graph --propose-version-moves --target v25.0 --output graph.patch
```

Refit can propose moving a pinned Graph API version to `--target`, as a patch for review, following the pattern of [model replacement proposals](DEADLINES.md#propose-model-replacements). Nothing is applied, installed, validated or published, and nothing is sent to Meta. This is not part of `refit run`, validation or draft pull requests.

> **Owner decision.** Whether a hand-maintained change list is enough evidence for Refit to edit a version automatically is an open owner decision. Until it is made, a version move exists only as this review-only patch.

A version is often written once and used by many requests: a base constant feeds every URL built from it. So moves are decided per **pin**, the place the version is written, and a pin moves only when every one of these holds:

- **Every request through the pin is fully known:** a request call was traced, and its path, HTTP method, `fields`, `metric` values and parameters were all read. A request through a project helper, or one with options built at runtime, stops.
- **A WhatsApp or Messenger request crosses only versions their changelogs cover.** Both are mined into the list; a version released before the WhatsApp changelog starts (2021-10-21) stops the move. A request belongs to them by its edge (`messages`, `message_templates`, `phone_numbers`, `whatsapp_business_profile`, `subscribed_apps`, `conversations`, `messenger_profile`, the thread-control edges and the like) or by a parameter only their send APIs take (`messaging_product`, `messaging_type`, `recipient`, `sender_action`).
- **Every changelog crossed is reviewed.** That means each version after the current one up to and including the target. The versions checked are the change list's, the deadline registry's, and every whole major version in between, so a version missing from both lists still stops the move.
- **No reviewed change between the two versions touches a request:** the request's edge, its path or an endpoint it is under, a field it requests (at any depth, so `posts{message}` names `posts` and `message`), a metric (compared regardless of case, since some pages print metric names in capitals), or a parameter. A GET that names no `fields` receives the node's default fields, so a field change in range stops it where the code reads that field (`.name`, `'name'` or a destructured `{ name }`). A changed error code stops only where the code names the code. A parameter change recorded on an edge or path matches only requests to it, and a change Meta records on another node type (the Page `messages` edge) never matches a WhatsApp Cloud API send (`messaging_product`). A node-wide change stops every request to a single opaque node. A change introduced by the version the code already uses does not count; it already applies, and so does a change whose `appliesToAll` date has passed: the pinned version already has it, so the fix plan lists it with the out-of-cycle changes.
- **Changing the pin changes nothing else:**
  - The version is written once on that line, inside a string.
  - If a variable holds it, that variable is a `const` the file does not export.
  - Every use of the variable is one the request scan follows: the start of a URL, the version segment of a URL, a call argument, `{ url }` in a request config, or a file-local `const` alias whose uses qualify too. `axios.create({ baseURL: GRAPH })` or `FB.init({ version: VERSION })` stops the move.
- **The target is valid:** it has a record in the change list, and the deadline registry does not show it retired. Otherwise the command exits 1.

Business SDK requests always stop, because their version follows the `facebook-nodejs-business-sdk` package and a package upgrade is not proposed. So do pins used only by tests and examples, and requests whose URL names no version or builds it at runtime. Every stop lists each reason with its `file:line`.

`--json` returns `moves` (each with the pin, `from`, `to`, the versions `crossed` and its requests), `stops` (each with `reasons`), `current` (requests already on the target) and `patch`.

### Measured on the deadline benchmark

The rule was run on the 33 Meta repositories of the [deadline benchmark](DEADLINE-BENCHMARK.md) with target v25.0, the newest version in the deadline registry ([results](benchmarks/2026-10-20-meta-graph-move-results.json)):

| Change list                                                  |                            Pins moved | Pins stopped | Requests without a pinned version |
| ------------------------------------------------------------ | ------------------------------------: | -----------: | --------------------------------: |
| Every changelog unread (the list before this change)         |                                     0 |          148 |                                 7 |
| **Reviewed v14.0 to v26.0, 281 changes (2026-10-20 list)**   | **35 (35 requests, 13 repositories)** |          113 |                                 7 |
| Hypothetical: every version marked reviewed, with no changes |   100 (101 requests, 26 repositories) |           48 |                                 7 |

- **With the reviewed list, 35 pins move** in 13 repositories: 23 from v19.0, 8 from v18.0, 3 from v20.0 and 1 from v21.0. Every moved request was checked by hand against the list. They are Instagram content publishing (`/media`, `/media_publish`), Instagram media reads that name their fields, ads insights and `/me/adaccounts` reads that name their fields, Page feed posts, Conversions API events and `/me`. No version-gated change in range touches any of them, and none is a WhatsApp or Messenger request.
- **Why the other 113 pins stop** (a pin can have several reasons):
  - **44** have a request with an unknown part.
  - **32** are crossed by a node-wide change (v20.0 offline event sets, v22.0 Instagram v1.0 nodes and recommendations, v24.0 custom audiences, custom conversions and Messenger lead templates) while a request goes to a single opaque node.
  - **26** have a WhatsApp or Messenger request.
  - **22** use an edge a recorded change removes or changes.
  - **21** have a request a recorded field change touches, mostly a GET without `fields`, which any field change in range stops.
  - **17** are used only by tests and examples.
  - **4** hold the version in a `let`, an exported constant or another place the move cannot edit safely.
  - **2** stop only because v22.0 removed the Instagram v1.0 `comments` edge, and the same edge name is used for Page post comments. The list cannot tell the two apart from the request, so it errs toward stopping.
- **The hypothetical run is still the upper bound.** The gap from 100 to 35 is what Meta's real changes, the WhatsApp and Messenger guard and node-wide changes cost.
- **The hypothetical run is an upper bound, not a result.** It shows how far the request-side conditions alone let moves go if every changelog in range were reviewed and listed nothing these requests use. It says nothing about what Meta actually changed. 100 of the 131 pins used by live code would move, mostly from v19.0 (59), v18.0 (21) and v20.0 (15). Each of the 100 hypothetical edits was checked: it changes exactly one line, and only the version text in it.
- **The 31 live pins that stop in the hypothetical run:**
  - **31** have a request with an unknown part: project helpers, mostly in `manypost/manypost-app`, and options built from `FormData`, `URLSearchParams` filled in step by step, or objects changed after they are declared.
  - **3** hold the version in a `let`; two of them are a `let endpoint` in `stlafit02-dev/STLAF-Marketing-Planner`.
  - **1** is in an exported constant.
  - A pin can have more than one reason, so the counts overlap.
  - The other 17 stopped pins are used only by tests and examples.

## Fix plans

```sh
refit meta-graph --fix --target v25.0 --repository /path/to/app
refit meta-graph --fix --target v25.0 --output graph.patch --json
```

`--fix` builds on [the version moves](#propose-version-moves-review-only) and adds what Refit knows how to change, or must hand to a person. The command itself applies nothing; [`refit run`](#run-meta-graph-fixes-with-refit-run) validates the same plan and writes the draft.

- **Documented rules.** Rules live in `data/rules/meta-graph/<version>.json`, one file per Graph API version. Each names its `family`, the `name` it changes, an optional `edge`, a `replacement` or documented `value`, the developers.facebook.com `source`, the `quote` and `checkedAt`, and a `status` of `auto` or `review`. A rule applies to a request whose move crosses its version.
  - An `auto` field or metric rename edits the one literal list item the request sends (`fields=id,old_field{name}` becomes `fields=id,new_field{name}`) in the same patch as the version move, and the change it settles no longer stops the move.
  - The rename stops when the item is not written exactly once in a literal the request reads, or when another request outside the move shares the literal. It also stops when the old name appears anywhere else in the code, since that may be a read of the renamed response field. Response reads are never edited.
  - Edge renames, parameter renames, newly required parameters (`parameter-required`, listed with the documented value) and every `review` rule stop the move with the rule and its source.
  - No rule files are committed yet. Until they are, the plan's moves equal `--propose-version-moves`.
- **Tests follow live moves.** A pin only test or example files use, such as a mocked `fetch`'s expected URL, moves with the live requests it describes: every URL it holds names the path of a live request on the same version that moves (`/123456/media` describes `/{userId}/media`). None of them may name the path of a live request that stays, and no live request on that version may have an unknown path. Otherwise it stops as before.
- **Product migrations.** Instagram Basic Display use is identified by the `user_profile` and `user_media` permissions, which no Instagram API with Instagram Login permission is named. It is listed with every place it is used and the documented plan: the API stopped working on 2024-12-04 ([Meta](https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api)); move to the Instagram API with Instagram Login ([Business Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login)), which needs a professional account. That is not a mechanical edit, so it is never applied. WhatsApp on-premises requests run on the customer's own host and no reachable Meta page documents their shape, so they are not detected.
- **Alerts.** `data/meta-platform-alerts.json` lists permission, product and policy changes. Each entry quotes a developers.facebook.com page read on 2026-10-29, with the date it takes effect when the page gives one. An alert matches:
  - requested permissions, read as separate items of any string in code that mentions Facebook, Instagram, `FB` or a scope;
  - an insights `metric` a request sends;
  - a request path;
  - a recognised product.

  Each hit is `in-effect`, `upcoming` or `undated` on the day of the check, with the replacement Meta names. Alerts never edit code, and test files are not matched. The entries cover the 2018 `publish_actions` removal, `manage_pages` and `publish_pages`, the 2025 Instagram Login scope renames, the Basic Display shutdown, the 2024 and 2025 Page Insights metric removals, and the 2025 oEmbed Read change.

## Run Meta Graph fixes with `refit run`

```sh
refit meta-graph --snapshot v19.0 --output before.json
refit meta-graph --snapshot v25.0 --output after.json
refit run --repository /path/to/app --before before.json --after after.json --image node:22-alpine --prepare-dependencies --command '["npm","test"]'
```

A Meta snapshot is the contract of a Meta Graph run: a Graph API version and the reviewed change table, pinned by its SHA-256. `refit run` checks the hash and refuses a table edited after the snapshot was taken. Both snapshots must come from the same table. The `after` snapshot is the target. Each pin is checked from its own version, so the `before` version is only a label.

- **The run:** `refit run` runs the [fix plan](#fix-plans) as its pipeline. Each moved request is a confirmed finding. Each request that stays on its version, and each use of a product that needs a migration, is a review finding with every reason. Alerts are report warnings.
- **The patch:** the version moves and their rules, validated like any other patch (dependency preparation, baseline and patched checks offline in Docker, AI repair when enabled, grades). Meta's proof (`pipeline/meta-graph-proof.ts`, #405) grades it from the change table. Under owner decision 1, a patch that leaves requests on their version is a `[Needs review]` draft; its Left Unchanged section lists each request with why it stays.
- **The checks:** `writeMetaGraphRun` (`pipeline/meta-graph-workflow.ts`) writes the snapshots and the `run.json` a benchmark or worker runs. The check comes from the same `selectCheck` as Stripe's, over the files that make Graph API requests:
  - the repository's tests, only the files that reach those requests where the runner takes file arguments;
  - and a type check, scoped to those files when `tsconfig.json` leaves them out;
  - with neither, the no-op check and grade D.
- **Not changed:** the `meta-graph` catalog entry keeps `adapter: null`, so enrollment and the hosted worker do not yet generate Meta configurations.

### Measured on the deadline benchmark, 2026-10-29

The 33 Meta repositories of the deadline benchmark (not the blind set) were scanned offline at their pinned commits, on `bench/combined-final` and on this change, with target v25.0:

| Measure                  |  Before |   After |
| ------------------------ | ------: | ------: |
| Requests in live code    |     162 |     168 |
| `fields` read            |     113 |     155 |
| Pins moved (requests)    | 35 (35) | 53 (57) |
| Pins stopped             |     120 |     109 |
| Basic Display migrations |       – |       1 |
| Alerts                   |       – |       2 |

- **Every changed request (52) was checked by hand against the code, and every value was right.** Most of the gain came from three things:
  - `metaFetch` pass-throughs in manypost/manypost-app;
  - `FormData`, `URLSearchParams` and `qs.stringify` bodies in the STLAF repositories, EzekielClervo/BOOSTING, receevi/receevi, AnkitPandeyIT/lorry and zak01Z/app-ch;
  - graph.instagram.com requests in manypost and savarkavi/instagram-profile-test.
- **The 11 new moves were each read.** Every one changes only the version in a URL, on Page photo and feed posts, Instagram media and media_publish, `/{user}/subscribers` and `/me/feed`. No move from before was lost.
- **The migration and the alerts:**
  - savarkavi/instagram-profile-test links to the Basic Display authorize URL with `user_profile,user_media`, so it is listed as a migration and alerted.
  - icekidtech/social-snap calls `/instagram_oembed`, so it gets the 2025-11-03 oEmbed alert.
- **Tests that follow live moves** add 5 more pins in ericlyfan/auto_portfolio: its tests assert the exact URL of each mocked request. That makes 51 pins moved (55 requests). With ME2's change table (#413), whose `/search` changes no longer match every request that sends `type`, EzekielClervo/BOOSTING's two reaction posts move too: 53 pins (57 requests). No request uses an out-of-cycle change that Refit lists: a field or metric removed or replaced, or a parameter removed, on every version.
- **`refit run`** was run offline in Docker on the 13 repositories with a move, through `writeMetaGraphRun` with no AI:
  - 13 of 13 produced a patch and a draft.
  - 3 validated with no request left: adilzhanshukenov/quiz-forma, carlosechale/echale-dashboard and maplewing/nopicnic.
  - 9 passed their checks and are `[Needs review]` only for requests that stay on their version.
  - 1 (mchantosa/smooth-kitty) has tests that fail before any change.
  - Grades: B 1, C 11, D 1.
  - Every patch changes only version text to v25.0, and every moved request was read by hand.
  - Without the test rule, ericlyfan/auto_portfolio's patch failed its own tests and was kept unpublished.
  - With ME4's proof merged in a scratch copy, stlafit02-dev/STLAF-Marketing-Planner's 19 changed requests were proven valid at v25.0.
- **Not measured:** ME1's meta-dev-60 set was not frozen when this was measured.

## Proof

`pipeline/meta-graph-proof.ts` grades a Meta Graph patch inside `validateMigration` whenever the report's provider is `meta-graph`. Meta publishes no machine-readable contract, so proof comes from the reviewed change table and, where Refit has one, its own test app. Levels follow [Proof decides, not caution](PROOF-BASED-VALIDATION.md):

| Level | What proves it                                                                                                                                                                                                                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Everything for C or B, and read-only calls with Refit's test app token at the target version: the Graph API accepted every changed request and returned every top-level field it asks for. With an app token this is reachable only for app-level reads.                                       |
| B     | Every changed request is valid at the target in the change table, and the repository's tests reach every changed file.                                                                                                                                                                         |
| C     | Every changed request is valid at the target in the change table, and either the type check covers the changed files with no new errors, or, where the checks prove nothing but did not fail, a checkJs check types every name on the changed lines or the patch changes only request strings. |
| D     | The change table does not prove a changed request, or no passing check covers the changed files. The draft is `[Needs review]` and names each reason.                                                                                                                                          |

**Field-table proof (offline).** Both sides are scanned with `scanGraphCalls`. A changed request is one whose version, method, path, fields, metrics, parameters or line differs from the request at the same place in the original code (same file, same position; a file whose request count changed pairs nothing, so every request in it is checked against the whole table up to the target). Each changed request must:

- send the target version, which is the one version every changed request sends;
- have a known version, method, path, fields, metrics and parameters;
- not be a WhatsApp Business Platform or Messenger Platform request that crosses a version released before their changelogs start;
- cross only versions the table marks `reviewed`;
- use no entry the table lists between the original request's version and the target (`changesUsedBy`, the same matching as version moves). Out-of-cycle entries (no version) apply before and after a move alike; the fix plan lists the requests they reach, and they are not part of the patch's proof.

Requests in test and example files send nothing, so what Refit cannot read in them is listed but does not stop the proof.

The entries the original request used are recorded as what the patch fixed. The table is `data/meta-graph/changes.json` when it exists, else `data/meta-graph-changes.json`. A table that fails its own checks proves nothing.

**Live proof.** Only where Refit's own environment holds `META_TEST_TOKEN`, which a customer never sets; a customer's token is never read. The refit-bench secret is an **app access token** (`app_id|app_secret`) of a development-mode test app with no user permissions, because Meta issues no user token without a product use case. The token goes in the `Authorization` header, never a URL, and is redacted from every recorded message, and no workflow input or log carries it.

- First, `GET /{target}/app?fields=id` checks that the Graph API serves the target version. A refusal there makes the patch grade D, since the provider itself rejects the version. An unreachable API changes nothing.
- Then each changed request the app token can read is sent: `GET` on the app's own node (`/app` and its edges) whose only parameters are `fields`, `access_token` and `appsecret_proof`. Grade A needs every changed request sent, accepted, and returning every top-level field it asks for.
- Requests on user, page or business objects need permissions the test app does not hold, so they are not sent and the offline field-table proof stands (B or C). The same goes for writes, object IDs from the customer's code, metrics and other parameters. With a test user token (`EA…`) instead, `/me` reads are sent too.
- Responses are recorded as status and missing field names, never values.

**Where the checks prove nothing** (no tests, no type check, or plain JavaScript), and they did not fail (validation `passed` or `untested`), two offline proofs can still give grade C. Founder instruction (2026-10-29, relayed by the coordinating session under "proof decides"); `pipeline/meta-graph-code-proof.ts`:

- **Request strings.** Original and patched files are parsed and compared token by token, ignoring comments. Every difference must be the text of a string literal or template piece. Each changed string must sit on a changed request's version pin, or reach a changed request's call as an argument (through templates, concatenation, `??`/`||` and option objects) or the constant on that call's line. Any other change counts as a change to logic or response handling: an added statement, a changed name, a manifest, an added or deleted file, or a string that builds no changed request. Those still need a type check or tests.
- **checkJs.** TypeScript checks the changed JavaScript files with `allowJs`, `checkJs` and the ES2022 and DOM libraries, reading the repository from memory with no packages installed. It counts only when the patch adds no checkJs error and TypeScript types every name on the changed lines. A name typed `any`, such as a parsed JSON response, an untyped parameter or an import from an uninstalled package, proves nothing (the approach of owner decision D2c for Stripe). TypeScript files are left to the repository's own type check.

A live call that refuses a changed request, or a target version the Graph API refuses, gives grade D whatever else passed. With A to C proof, a Meta draft is validated even where no check ran or dependencies could not be prepared, since the proof does not come from those checks (`metaGraphProven` in `pipeline/publication.ts`).

**Hand-check (2026-10-29).** ME3's `refit meta-graph --fix --target v25.0` patches were checked on the 33 non-blind deadline-benchmark Meta repositories (ME3's list at their pinned commits, merged with feat/meta-fixes and ME2's 805-entry table; no blind repository was opened). 13 repositories get a patch, and every changed line in all 13 was read: each one changes only the `vNN.N` segment of a Graph URL. The field table proves all 13 (61 changed requests) and the request-string proof holds for all 13, a correct verdict on each. checkJs proves none of them, because every changed line holds names TypeScript cannot type (`PAGE`, `userId`, `axios` from an uninstalled package), so it never counted where it should not have. Before the out-of-cycle and test-file corrections, 7 of 13 stopped on entries that do not depend on the version (iOS 14 insights, `like_count`, oEmbed `thumbnail_url`, `media_type` VIDEO) or on a test assertion's URL.

**AI reconstruction of unread requests** (`pipeline/meta-graph-ai.ts`). With AI enabled (`refit run --ai-patch`, `benchmark:meta --ai`), every live request the scan left partly unread (no request call, a helper's options, a runtime path, fields or parameters, or a runtime version) is sent to the model with its file and the files it imports, which returns each request the site sends and where its version is written. A reconstruction is kept only when every path segment, field, metric and parameter name is written in that code, it agrees with every part the scan did read, `fields` and `metric` appear exactly when fields and metrics are named, and a version the scan could not read is written on the line the model names (an unversioned URL never gains one). Kept requests then go through the same change table, version-move stops, `pinEdit` checks and proof as traced ones; the AI's word never moves a pin by itself. The draft names each reconstructed request and asks the reviewer to confirm it. `refit run` asks once: the workflow's scan reconstructs, and every validation scan reuses those reconstructions, so the validated patch is the one the scan proposed. The benchmark's scan and its child `refit run` each reconstruct, so a row's AI spend is recorded per stage (`ai.scan.costUsd`, `ai.run.costUsd`) and in total (`ai.costUsd`) from the run's ledger. Parameter changes, like field changes, match only requests on their own edge or path.

**Second-opinion AI review.** With AI enabled (`--assess` or `--ai-patch`), every Meta patch gets one advisory review: verdict, summary and concerns, recorded with its model, response id and cost in `validation.metaGraph.review`. It never changes the grade or the publication decision, and a failed review is recorded, not raised.

What this does not do yet: AI-written behaviour tests that run the repository's own code against the test app (the #386 harness needs a Graph adapter for its proxy, which reads the token from the query string and has no version header), and recorded responses replayed offline.

### Census of non-blind Meta repositories, 2026-10-29

Scope: the 68 Meta repositories of every earlier list (the deadline benchmark, its fresh list and the Meta platform list), offline at their pinned commits with target v25.0, through `benchmark:meta --validate`, no AI. The candidates ME1's selector is still searching were not cloned, since the blind set will be drawn from them. 3 rows did not run: 2 no longer clone and novuhq/novu exceeds the scan limits. 6 make no Graph request.

|                                  | `4ecb0cbd` | After this change |
| -------------------------------- | ---------: | ----------------: |
| Repositories with a patch        |         18 |                22 |
| Pins moved                       |         67 |                85 |
| Proven by the change table (ME4) |   18 of 18 |          22 of 22 |
| Validated with nothing left      |          5 |                10 |
| Grades (B / C / D)               | 1 / 15 / 2 |        1 / 19 / 2 |

Every patch changes only version text, and every new moved request was read by hand. Both fixes are general:

- A GET that names no `fields` counted every field change in range. Token endpoints (`/oauth/access_token`, `/debug_token`, Instagram's `/access_token` and `/refresh_access_token`) return no node. A change recorded on an edge's objects reaches only reads of that edge. A plain `/me` read returns the token's User or Page. These three cases no longer match; 15 OAuth token exchanges and a `/me` read move.
- Helpers that write their own `fetch` options (`headers`, a literal `method`, `body` from one parameter) are read like `fetch`.

**What holds a passing draft.** Under the founder's decision ([proof decides, not caution](PROOF-BASED-VALIDATION.md)), a request the patch leaves on its version counts as unresolved only when Refit found a real Meta problem there:

- its pinned version is retired: dated in the deadline registry on or before the run, or older than its oldest entry;
- it definitely uses a change between its version and the target: a field, metric or parameter it names, an edge it reads, or a literal path it calls;
- a documented rule names something it sends.

Other stops leave the line untouched, on a version Meta still serves. These include:

- WhatsApp and Messenger requests;
- unversioned URLs;
- unknown parts;
- tests-only pins;
- node-wide placeholder matches;
- field changes counted against default fields;
- a changed error code.

The draft lists them as notes, not unresolved findings. A field change recorded on an edge's objects reaches only reads of that edge, so a `status` field on a catalog batch no longer matches an Instagram container's `status`.

With this, 10 of the 22 drafts validate (6 before). The 4 newly validated rows are reviewed `correct` in `docs/benchmarks/fix-reviews.json`. The other 12 are held by real problems:

- 9 grade-C drafts leave 38 requests on retired v18.0, v19.0 or v20.0 pins that could not be moved;
- ericlyfan/auto_portfolio (grade B) leaves requests on retired v18.0;
- mchantosa/smooth-kitty and md-aqil/Whatspp-api-order-notification fail their own tests before any change (grade D).

Stops after this change, by blocker (repositories with it, and with it as their only blocker):

| Blocker                                  | Repositories | Only blocker |
| ---------------------------------------- | -----------: | -----------: |
| A listed change the request uses         |           35 |            9 |
| WhatsApp or Messenger request            |           21 |            0 |
| URL names no version                     |           19 |            6 |
| Unknown request part                     |           18 |            4 |
| Only tests use the pin                   |           11 |            0 |
| Version held where a move cannot edit it |            5 |            0 |
| Pin newer than the target                |            1 |            0 |

- **Listed changes** are mostly node-wide removals (v22.0 Instagram v1.0 nodes, v24.0 custom audiences, custom conversions and Messenger lead templates), which match every request to a single opaque node, and the v22.0 Instagram v1.0 `comments` edge, which shares its name with Page post comments. The node type behind an opaque ID is not traced, so these stay stops.
- **WhatsApp and Messenger** requests are matched against their mined changelogs since `feat/meta-changelogs`; see [Benchmarks](BENCHMARKS.md) for the dev-60 measurement.
- **Unversioned URLs** follow the app's default version. Pinning one changes behaviour, so Refit does not add a version.
- **Unknown parts** are mostly a WhatsApp library's class method helper, versions chosen by callers (`apiVersion ?? DEFAULT`) and options built at runtime.

### Measured on meta-dev-60, 2026-10-29

ME1's dev set (`docs/benchmarks/subsets/meta-dev-60.json` on feat/meta-sets, 60 active repositories, target v26.0), run offline with `npm run benchmark:meta -- --validate` (no AI, no refit-bench run) at `466eb437` and at `d9224895`, which adds the tracing above. The blind set was never opened.

|                           | `466eb437` | `d9224895` |
| ------------------------- | ---------: | ---------: |
| Repositories with a patch |         15 |         17 |
| Pins moved (requests)     |    45 (50) |    67 (74) |
| Proven (ME4)              |   15 of 15 |   17 of 17 |
| Validated                 |          3 |          6 |
| Grades (B / C / D)        | 0 / 11 / 4 | 1 / 12 / 4 |

Nothing moved or validated before is lost. The 22 new pins were read by hand: each changes only the version text, on requests whose method, path and parameters are known (OAuth token exchanges, `/me/accounts`, `/{business-id}/owned_pages` and `client_pages` paging, Page feed posts and stories). CassieMarie0728/jekyll-forge, marioce12-bot/Chariow (grade B) and tareksalammohamed/socialpilot now validate, recorded `correct` in `docs/benchmarks/fix-reviews.json`.

The other 43 repositories have no patch. Pins stop most often on listed changes matched through opaque node IDs (`GET /{id}` against node-wide removals such as the v26.0 Commerce Order Management nodes or the v24.0 custom audiences) or through a request with no `fields` against default-field changes, on WhatsApp and Messenger requests, and on requests the scan cannot read. Narrowing the first two needs an owner decision on the move rule; the hand-kept change table is ME2's.

## What a Meta agent still needs

The catalog entry for `meta-graph` keeps `adapter: null`. Request detection is one of the pieces a reviewed agent needs; these are still missing:

2. **An owner decision on the version-move rule.** The [review-only rule](#propose-version-moves-review-only) exists. Wiring it into `refit run`, validation and drafts waits on the decision about whether a hand-maintained change list is enough evidence for an automatic edit.
3. **More coverage.** URLs whose host comes from configuration at runtime, and responses: the fields code reads from a response are not traced, so a request with no `fields` relies on the node's defaults, and a field rename stops wherever the old name appears.
4. **Enrollment.** `refit run` validates Meta plans, but enrollment and the hosted worker do not generate Meta configurations, and no AI repair rule targets undocumented response reads yet.

## Limits

- Only JavaScript and TypeScript are read. URLs in `.env` files, YAML or other languages are not found.
- Scoping is by name within a file. A `const` is followed to the nearest enclosing declaration; there is no type checker, and imports are followed for exported base URLs only.
- `axios` is recognized by its call shape (`axios.get`, `http.post`, `client.delete`, …) on a receiver whose name mentions axios, http, client, api or instance; other clients are reported as helpers.
- A helper that adds `fields` or changes the version on its own is not seen. Fields written in a URL passed to a helper are reported as written.
- The business SDK version is the first `facebook-nodejs-business-sdk` dependency Refit finds in the repository's manifests.
- A base URL held in a `let` is not followed, so requests built from it are not found and nothing moves them.
- Edge names are compared without node types. An edge removed from one node, such as the Instagram v1.0 `comments` edge, also stops requests to a different node's edge with the same name.
- A node-wide change stops every request to a single opaque node in its range, because a placeholder or numeric ID does not reveal the node type.
- Certificate Transparency endpoints were removed in v24.0, but the page names none of them, so the list cannot match them.
- Version moves read only what the request sends. Which response fields the code reads afterwards is not traced, which is why a request that names no `fields` stops on any field change in range.
