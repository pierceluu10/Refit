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
- **Helpers.** A Graph URL passed to any other function, such as a project's own `metaFetch(ctx, url)`, is reported with that function as the client. Its HTTP method and extra options are unknown, so its parameters are too; `fields` written in the URL itself are still reported.
- **Versions and paths.** `` `https://graph.facebook.com/${version}/…` `` has an unknown version, unless `version` is a `const` holding a literal such as `'v21.0'`. A runtime segment after the node (`` `/${id}/${edge}` ``), or one named like a path (`${path}`, `${endpoint}`), makes the rest of the path unknown. A substitution inside a query value (`fields=${fields}`) is unknown even when a constant could resolve it.
- **Reassigned URLs.** A `let` assigned again, such as a pagination loop's `next = data.paging.next`, may hold another URL by the time of the request, so its path, edge, fields and parameters are unknown.
- **Bases.** A versioned base URL passed to a function, such as `createClient('https://graph.facebook.com/v18.0')`, is reported once with no request, since the requests built from it are not traced. An unversioned base says nothing about a version and is not reported.
- **Comments never count**, and neither do other hosts (`graph.instagram.com`, `b-graph.facebook.com`) or a bare host name used as an object key.

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

**v10.0 to v26.0 are `reviewed`, with 805 changes and 105 rules (2026-10-29).** The Graph API and Marketing API changelogs of every version, the Graph API out-of-cycle changes since 2021 and the Instagram Platform, WhatsApp Business Platform and Messenger Platform changelogs were saved and mined; see [Meta Graph change table](META-GRAPH-CHANGES.md) for the method, the coverage and what is still missing. Out-of-cycle and platform changes that apply to every version at once have `version: null` and the date in `appliesToAll`, so no version move crosses them.

- **WhatsApp and Messenger.** Their changelogs are now in the list, but a request that belongs to them still stops every move: widening the move rule is an owner decision; see [the move conditions](#propose-version-moves-review-only).
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
- **No request belongs to WhatsApp or Messenger.** Their changelogs are not in the list. A request belongs to them by its edge (`messages`, `message_templates`, `phone_numbers`, `whatsapp_business_profile`, `subscribed_apps`, `conversations`, `messenger_profile`, the thread-control edges and the like) or by a parameter only their send APIs take (`messaging_product`, `messaging_type`, `recipient`, `sender_action`). So a WhatsApp media upload stops, while an Instagram container creation on the same `/media` edge does not.
- **Every changelog crossed is reviewed.** That means each version after the current one up to and including the target. The versions checked are the change list's, the deadline registry's, and every whole major version in between, so a version missing from both lists still stops the move.
- **No reviewed change between the two versions touches a request:** the request's edge, its path or an endpoint it is under, a field it requests (at any depth, so `posts{message}` names `posts` and `message`), a metric (compared regardless of case, since some pages print metric names in capitals), or a parameter. A GET that names no `fields` receives the node's default fields, so any field change in range stops it. A node-wide change stops every request to a single opaque node. A change introduced by the version the code already uses does not count; it already applies.
- **Changing the pin changes nothing else:**
  - The version is written once on that line, inside a string.
  - If a variable holds it, that variable is a `const` the file does not export.
  - Every use of the variable is one the request scan follows: the start of a URL, the version segment of a URL, a call argument, `{ url }` in a request config, or a file-local `const` alias whose uses qualify too. `axios.create({ baseURL: GRAPH })` or `FB.init({ version: VERSION })` stops the move.
- **The target is valid:** it has a record in the change list, and the deadline registry does not show it retired. Otherwise the command exits 1.

Business SDK requests always stop, because their version follows the `facebook-nodejs-business-sdk` package and a package upgrade is not proposed. So do pins used only by tests and examples, and requests whose URL names no version or builds it at runtime. Every stop lists each reason with its `file:line`.

`--json` returns `moves` (each with the pin, `from`, `to`, the versions `crossed` and its requests), `stops` (each with `reasons`), `current` (requests already on the target) and `patch`.

### Measured on the deadline benchmark

The rule was run on the 33 Meta repositories of the [deadline benchmark](DEADLINE-BENCHMARK.md) with target v25.0, the newest version in the deadline registry ([results](benchmarks/2026-10-20-meta-graph-move-results.json)):

| Change list | Pins moved | Pins stopped | Requests without a pinned version |
|---|---:|---:|---:|
| Every changelog unread (the list before this change) | 0 | 148 | 7 |
| **Reviewed v14.0 to v26.0, 281 changes (2026-10-20 list)** | **35 (35 requests, 13 repositories)** | 113 | 7 |
| Hypothetical: every version marked reviewed, with no changes | 100 (101 requests, 26 repositories) | 48 | 7 |
| Change list                                                  |                            Pins moved | Pins stopped | Requests without a pinned version |
| ------------------------------------------------------------ | ------------------------------------: | -----------: | --------------------------------: |
| Every changelog unread (the list before this change)         |                                     0 |          148 |                                 7 |
| **Reviewed v14.0 to v26.0, 281 changes (committed)**         | **35 (35 requests, 13 repositories)** |          113 |                                 7 |
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
- not be a WhatsApp Business Platform or Messenger Platform request, whose changelogs the table does not cover;
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

**Second-opinion AI review.** With AI enabled (`--assess` or `--ai-patch`), every Meta patch gets one advisory review: verdict, summary and concerns, recorded with its model, response id and cost in `validation.metaGraph.review`. It never changes the grade or the publication decision, and a failed review is recorded, not raised.

What this does not do yet: AI-written behaviour tests that run the repository's own code against the test app (the #386 harness needs a Graph adapter for its proxy, which reads the token from the query string and has no version header), and recorded responses replayed offline.

## What a Meta agent still needs

The catalog entry for `meta-graph` keeps `adapter: null`. Request detection is one of the pieces a reviewed agent needs; these are still missing:

1. **Product changelog moves.** The WhatsApp Business Platform and Messenger Platform changelogs are in the list since 2026-10-29, but their requests still stop every move until an owner decides the move rule may use them.
2. **An owner decision on the version-move rule.** The [review-only rule](#propose-version-moves-review-only) exists. Wiring it into `refit run`, validation and drafts waits on the decision about whether a hand-maintained change list is enough evidence for an automatic edit.
3. **More coverage.** The browser SDK's `FB.init({ version })`, URLs whose host comes from configuration at runtime, and responses: the fields code reads from a response are not traced, so a request with no `fields` relies on the node's defaults.

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
