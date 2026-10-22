# Raw HTTP API inventory

Refit reports every external HTTP API a JS/TS repository calls, not only providers that have an SDK in the [agent catalog](PROVIDER-AGENTS.md). `detectApiHosts(directory)` in `pipeline/api-hosts.ts` reads source without running it and returns the hosts, where they are called, and which provider each belongs to.

```
refit api-hosts [--repository <root>] [--json]
```

`scanDeadlines` returns the same result as `apiHosts` (and `apiHostsError` if reading failed), so the hosted inventory gets it with the deadline scan. The command is review only: nothing is changed, installed, run or sent to any host.

## What counts as a call

A host is reported where an absolute URL reaches an HTTP client:

| Client       | Forms read                                                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`      | global `fetch(url)`, `globalThis.fetch`, `node-fetch`, `cross-fetch`, `isomorphic-fetch`, `ofetch`                                                                                                                                        |
| `axios`      | `axios(url)`, `axios({ url })`, `axios.get/post/…(url)`, `axios.create({ baseURL })`, `axios.defaults.baseURL = …`, and `.get/post/…` on the instance (a variable or `this.x`)                                                            |
| `got`        | `got(url)`, `got.get/…`, `got.extend({ prefixUrl })`                                                                                                                                                                                      |
| `ky`         | `ky(url)`, `ky.get/…`, `ky.create/extend({ prefixUrl })`                                                                                                                                                                                  |
| `undici`     | `request`, `fetch`, `stream`, `new Client/Pool(origin)`                                                                                                                                                                                   |
| `http`       | `node:http`/`node:https` `get`/`request` with a URL, or with `{ hostname, path, protocol }`                                                                                                                                               |
| `superagent` | `superagent.get(url)`, `superagent(method, url)`                                                                                                                                                                                          |
| `request`    | the deprecated `request`, `request-promise` and `needle`                                                                                                                                                                                  |
| `client`     | a call on a client the detector could not trace to an import (`client.request.post(url)`) or a helper named like one (`fetchWithTimeout(url)`), only when the call is awaited, chained into `.json()`/`.then()`, or given request options |

The URL may be a string literal, a template, a `+` concatenation, a `const` (or a `let`/`var` never reassigned) in the same file or imported from another scanned file, a member of a `const` object literal, `this.field` set once in the class, `new URL(path, base)`, `url.toString()`, and `process.env.X || 'https://…'` / `import.meta.env.X ?? '…'`. An environment variable without a literal default, or a host with a runtime piece (`https://${region}.example.com`), is not reported: Refit cannot say which host is called.

Each call has `host`, `pathPrefix` (the literal path up to the first runtime piece, without a trailing slash), `file`, `line` and `client`. A host lists at most five calls and its total `count`.

## Exclusions

Each exclusion is named and counted in `excluded`:

| Name            | What is left out                                                                                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-file`     | test, spec, e2e, fixture, example, story and mock paths, and files named `test-*`, `spec-*`, `*.mock.ts`                                                                                                                                                 |
| `docs-file`     | files under `docs/`, `doc/`, `documentation/`                                                                                                                                                                                                            |
| `localhost`     | `localhost`, `127.*`, `0.0.0.0`, `::1`, and the `.localhost`, `.local`, `.test`, `.invalid`, `.internal`, `.lan`, `.home` names                                                                                                                          |
| `private-range` | `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, IPv6 unique-local and link-local                                                                                                                                                           |
| `asset-url`     | image, font, media and archive paths; `cdn.`, `static.`, `assets.`, `images.`, `img.`, `media.`, `fonts.` hosts; common CDN and image hosts (CloudFront, Fastly, unpkg, jsDelivr, Unsplash, GitHub avatars, Imgur, placeholder and image-proxy services) |
| `schema-url`    | namespace and schema URLs (`w3.org`, `json-schema.org`, `schemas.microsoft.com`, `schema.org`, …)                                                                                                                                                        |
| `placeholder`   | `example.com/org/net/edu` and common `yourdomain.com`-style placeholders                                                                                                                                                                                 |

A host that `data/api-hosts.json` or the catalog documents as an API is never left out as `asset-url`, so `cdn.contentful.com` stays once a provider entry documents it; until FG3 adds Contentful it is excluded as `asset-url`.

## Provider mapping

`provider` is `{ id, name, origin }`, where `origin` is `catalog` (an [agent catalog](../pipeline/agent-catalog.ts) hostname) or `api-hosts` (an entry of `data/api-hosts.json`). Any other host has `provider: null`: it is **untracked**.

`data/api-hosts.json` is `{ formatVersion: 1, hosts: [{ host, provider, docs, source, checkedAt }] }`. `host` is an exact name, or `*.example.com` for every subdomain. It has 200+ entries and none overlaps a catalog hostname (a test enforces it). `source` is a page that answered with a success status and named the host when `checkedAt` was recorded; it is never written from memory.

### How the list is chosen and rebuilt

1. The untracked hosts called most often in the [frozen sample](benchmarks/2026-10-22-api-hosts-repos.json) (below), then
2. the documented API base URL of widely used providers in weather and location, finance and crypto, AI and speech, social and content, developer tools and hosting, and business tools, written to `scripts/api-hosts-candidates.txt`.

Providers whose catalog entry another lane owns (the Furqan lanes' list A and list B, messaging, Slack, Cloudflare, GitHub, Auth0, Clerk, Firebase, Supabase, AWS, Bedrock, Azure OpenAI, OpenRouter, Vertex AI and the existing catalog) are left out of the candidates on purpose, so merging those lanes cannot create an overlap. Until they merge, their hosts show as untracked.

```
npx tsx scripts/api-hosts-verify.mjs --report unverified.txt
```

fetches each candidate's docs page and keeps the host only when a page names it. JavaScript-rendered or bot-blocking docs pages fail this check, so a missing provider usually means its docs could not be read, not that the host is wrong. The last run kept 218 of 392 candidates on 2026-10-22; the rest are not shipped.

## Measurement

Pinned Refit commit: the commit named in [`2026-10-22-api-hosts-results.json`](benchmarks/2026-10-22-api-hosts-results.json) (`refit`), clean tree.

**Sample.** [`2026-10-22-api-hosts-repos.json`](benchmarks/2026-10-22-api-hosts-repos.json) freezes 60 public JS/TS repositories at pinned commits, selected by `scripts/api-hosts-select.mjs` from GitHub repository search (14 topics × TypeScript and JavaScript, top 3 by stars, pushed since 2025-10-21, 30 to 3000 stars; the exact queries and the search date are in the file). It is a mix of applications, bots, libraries and boilerplates, because stars and topic, not shape, selected it. Fetched with `git fetch --depth 1` of the pinned commit, no submodules, nothing installed or run.

**Labels.** [`2026-10-22-api-hosts-labels.json`](benchmarks/2026-10-22-api-hosts-labels.json) holds hand labels for the 30 odd-numbered repositories (0-based), committed (`dd08573`) before Refit ran on any of them. The labeller used `scripts/api-hosts-label-candidates.mjs`, a plain text search for every URL host in non-test source, and kept a host only when the code sends a request to it through an HTTP client (the `method` field in the file lists what was not kept). Eighteen of the 30 repositories call no external API; 49 (repository, host) pairs are labelled across the other 12. The scorer is `scripts/api-hosts-score.mjs` (`pipeline/api-hosts-score.test.ts` tests it), run by `node scripts/api-hosts-benchmark.mjs --root <dir>`.

**Result, host level (a repository and host pair is one unit):**

| Run                                                                                   | Precision | Recall | Pairs              |
| ------------------------------------------------------------------------------------- | --------- | ------ | ------------------ |
| First run, before any change to the detector (not backed by a committed results file) | 1.00      | 0.61   | TP 30, FP 0, FN 19 |
| Final                                                                                 | 1.00      | 0.86   | TP 42, FP 0, FN 7  |

The final recall is **not blind**: the 19 misses of the first run were read and the detector was extended for the general forms behind them (the `request` library, `let`/`var` URLs, `this.field`, options held in a variable, an untraced client or a request helper). Use the first run as the blind recall (0.61, unverified: its output was not committed; only the final run is, in [`2026-10-22-api-hosts-results.json`](benchmarks/2026-10-22-api-hosts-results.json)) and the final one as a measure of the fixes. Precision was 1.00 in both runs.

Misses that remain are config flowing between objects and files, which the detector does not follow: `DEFAULT_BASE_URL` passed to a client through an options object (Claude-to-IM, metabot's WeChat client), a Telegram file URL built inside a helper, and `jsonUrl` members of a coin table read by index (btc-rpc-explorer).

**Precision on the other 30 repositories** (no labels): after the final run, every reported host and its first evidence line in those repositories was read (121 pairs). One was wrong: `93.184.216.34` in a script named `test-audit-security.mjs`. The `test-*` file-name rule now excludes it. The rest are real calls, but this is an audit of Refit's own output after seeing it, not a blind label.

**Not scanned.** Three repositories exceed the repository reader's limits (10,000 files, 2 MiB per file, 50 MiB total) and fail with the existing error: react-native-datetimepicker, graphile/starter and ts-proto. All three are labelled repositories with no hosts, so 27 of the 30 labelled repositories were scanned; they count in the denominators and change no labelled pair.

**Not measured:** recall outside this sample; hosts reached only through SDKs or wrappers Refit cannot see; the share of repositories whose hosts come from environment variables only.

## Most common untracked hosts in the sample

Hosts called in the sample that no catalog entry or list entry names, ranked by repositories then calls. These are candidates for catalog entries or the host list, written for other lanes under "Requests for other lanes" in the PR.

| Host                                   | Repositories | Calls | Note                                              |
| -------------------------------------- | ------------ | ----- | ------------------------------------------------- |
| `api.github.com`                       | 7            | 9     | FP6 (GitHub API)                                  |
| `discord.com`                          | 5            | 11    | FG3 list B (Discord)                              |
| `api.coingecko.com`                    | 2            | 11    | CoinGecko; docs page not readable by the verifier |
| `slack.com`                            | 2            | 4     | FP1 (Slack)                                       |
| `api.elevenlabs.io`                    | 2            | 3     | ElevenLabs                                        |
| `lrclib.net`                           | 2            | 3     | LRCLIB                                            |
| `api.notion.com`                       | 1            | 2     | FG3 list B (Notion)                               |
| `api.together.xyz`, `api.fireworks.ai` | 1 each       | 4, 3  | OpenAI-compatible model hosts (FP3/FP4 territory) |
| `oauth2.googleapis.com`                | 1            | 6     | Google OAuth                                      |

The full ranking is derived from [`2026-10-22-api-hosts-results.json`](benchmarks/2026-10-22-api-hosts-results.json).
