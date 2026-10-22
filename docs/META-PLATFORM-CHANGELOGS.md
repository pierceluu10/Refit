# WhatsApp and Messenger changelogs (FG7)

`data/meta-graph-changes.json` reviews the Graph API changelogs from v14.0 to v26.0, but not the WhatsApp Business Platform or Messenger Platform changelogs. So `refit meta-graph --propose-version-moves` stops every request that belongs to either; see [Meta Graph API](META-GRAPH.md#propose-version-moves-review-only). This lane was meant to review those two changelogs version by version and add their changes, so that these requests no longer stop wholesale.

Checked 2026-10-22. Nothing was installed or run, and Meta was never contacted.

## Blocked: the changelog pages could not be read

The cloud environment's egress proxy refuses developers.facebook.com. The first attempt and the one retry both failed (2026-10-22T11:54Z):

- `curl https://developers.facebook.com/docs/whatsapp/business-platform/changelog/` → `curl: (56) CONNECT tunnel failed, response 403`
- `curl https://developers.facebook.com/docs/messenger-platform/changelog/` → the same
- `curl https://developers.facebook.com/docs/instagram-platform/changelog/` (the keep-going step) → the same

The web fetch tool fails as well (`getaddrinfo ENOTFOUND developers.facebook.com`). Meta does not publish these changelogs in a public repository.

**No change was added.**

- The WhatsApp and Messenger versions stay unreviewed, and their requests keep stopping.
- `--propose-version-moves` is not widened.
- `data/meta-graph-changes.json` is unchanged.

**To unblock:**

1. Allow developers.facebook.com in the environment's network policy, or run the review on a machine that can reach it.
2. Read the WhatsApp Business Platform and Messenger Platform changelogs in full, and add each change that names an edge, field or parameter, with `source` and `checkedAt`.
3. Run `npm run meta-graph:check` and the two benchmarks below.

## Which stopped requests resolve, and which still stop

**Deadline benchmark.** The rule was rerun on its 33 Meta repositories with target v25.0 at this branch, with `node scripts/meta-platform-benchmark.mjs --root <clones> --list docs/benchmarks/2026-10-16-deadline-repos.json`. It reported 35 pins moving, 120 stopping, and 26 of the stopped pins (12 repositories) carrying the WhatsApp and Messenger reason. **These numbers and the reason table below are not backed by a committed results file or a pinned commit**; the committed run in [META-GRAPH.md](META-GRAPH.md#measured-on-the-deadline-benchmark) reports 35 moved, 113 stopped and 7 unpinned.

**Previously stopped requests that now resolve: none,** because no changelog was read.

**Would reading the changelogs help today? Not for this set.** Every one of the 26 pins also stops for a reason the WhatsApp and Messenger changelogs could not remove:

| Other reason on a WhatsApp or Messenger pin                                                          |   Pins |
| ---------------------------------------------------------------------------------------------------- | -----: |
| v20.0 `edge-changed` `messages` ("The Booking button is no longer supported in Messenger API calls") |     19 |
| v24.0 `parameter-changed` `type` on `/search` (detailed targeting)                                   |     14 |
| A request with an unknown part (fields, metrics, parameters)                                         |      5 |
| Only tests and examples use the version                                                              |      5 |
| Ads insights metrics, ad creative and other field changes from v19.0 to v25.0                        | 2 each |
| v17.0 ThreatExchange `/malware_analyses` endpoint removed                                            |      1 |

Both of the first two reasons over-stop WhatsApp requests:

- **The v20.0 Messenger change.** It is recorded on the Page `messages` edge, and the list matches edges without node types. So it also stops every WhatsApp Cloud API `/{phone-number-id}/messages` request.
- **The v24.0 `/search` change.** Its entry names `path: "/search"`, but parameter changes are matched by name alone. So the WhatsApp message body's `type` field matches it.

> **Needs owner decision.** Should a parameter change with a `path` match only requests under that path, and an edge change apply only to its node type where the request shows one? Either change would let more pins move, so it is not made here: the lane must not widen `--propose-version-moves`.

## WhatsApp and Messenger sample

**Sample.** `docs/benchmarks/2026-10-22-meta-platform-repos.json` holds 20 repositories, made by `node scripts/meta-platform-select.mjs --output … --cache <dir>`. The method is recorded in the file:

- npm search for WhatsApp and Messenger packages, published since 2022;
- the name, description or keywords mention WhatsApp or Messenger;
- a github.com repository outside Meta's organizations, not already frozen, one per commit, ranked by monthly downloads;
- kept only when a live JS/TS file names graph.facebook.com together with a Cloud API or Send API marker (`messaging_product`, `messaging_type`, `sender_action`, or `/messages` with `recipient`).

Two runs of the selector picked the same 20, apart from one renamed duplicate now excluded. Transient git fetch failures can change a rerun's picks, so the frozen file is the record.

**Labels.** `docs/benchmarks/2026-10-22-meta-platform-labels.json` holds the 10 repositories at even positions. They were labelled blind and committed (`d051e55`) before `refit meta-graph` ran on them.

- 115 requests: 75 WhatsApp and 40 Messenger.
- The labeller read every live file in the packages that hold the send-API code.
- Each label is a request to graph.facebook.com that belongs to the WhatsApp Business Platform or the Messenger Platform, with the line its HTTP or helper call starts on and, where the URL is written on another line, that line too.
- Media downloads from returned URLs, generic Graph calls (`/me`, Page reads, OAuth, `debug_token`, app subscriptions, resumable uploads, catalogs) and graph.instagram.com are left out.

**Run.** `node scripts/meta-platform-benchmark.mjs --root <clones>` on clean commit `e42be8b` wrote `docs/benchmarks/2026-10-22-meta-platform-results.json`. `CopilotKit/CopilotKit` (4 labels) exceeds Refit's scan limits and is counted as a failed scan. Its 4 labels stay in the denominator as requests not found, so the table counts all 115. The committed results file's `score` excludes them (111).

| Measure                                                              |         Result |
| -------------------------------------------------------------------- | -------------: |
| Requests the scan reports (found)                                    | 27 / 115 (23%) |
| Found requests that stop                                             |        26 / 27 |
| Requests the WhatsApp and Messenger guard names                      |        5 / 115 |
| Guard precision (guarded live requests that are labelled), in sample |   5 / 5 (100%) |
| Labelled requests inside a proposed move                             |          **0** |
| Moves proposed in all 20 repositories                                |          **0** |

The guard edges were chosen from these same 10 labelled repositories (e42be8b after d051e55), so the guard precision is in-sample. The scan's own request precision is not measured.

**What this shows.**

- **Nothing unsafe moves.** No WhatsApp or Messenger request in the sample is inside a proposed move. Of the 27 requests found, 26 stop. The other (`Dosbodoke/better-zap`) already pins v25.0, the target, so it has nothing to move.
- **The guard is rarely what stops them.** Of the 26 found requests that stop:
  - 19 stop first because their version is built at runtime (an option default, a class field or a vendor argument), so the guard reason is never reached;
  - 5 carry the guard reason;
  - 2 stop because part of the request is unknown.
- **Most requests are not found at all.** These SDKs send through:
  - an injected fetcher (`this.fetchImpl`, `options.fetch`);
  - a client helper (`this.call(method, path)`, `restClient.post`, `graphFetch(path)`, `chatServer.post`);
  - or URLs built from functions (`${apiBase()}/${apiVersion()}`).

  `refit meta-graph` follows none of these, so those requests are invisible to the version-move rule. They are not moved, because a pin with no traced request is not moved. But the report understates WhatsApp and Messenger use. This is a request-scan coverage gap (`pipeline/meta-graph-calls.ts`), listed under requests for other lanes.

**The guard, extended.** The labelled code names WhatsApp and Messenger endpoints that the guard did not list. This branch adds them, so each request stops if its version is ever a literal:

- the WhatsApp Calling API (`/{phone-number-id}/calls`), coexistence sync (`smb_app_data`), `request_display_name`, the two-step `pin`, phone-number `settings` and the root `/message_template_library`;
- Messenger's `moderate_conversations`;
- the `phone_number_id` parameter of a WhatsApp media node read.

This only adds stops, and `pipeline/meta-graph-moves.test.ts` tests each one. The deadline benchmark's 35 moves and 120 stops are unchanged.

## Limits

- The selection is npm packages (SDKs, adapters, bots), not deployed applications.
- The labels cover the packages holding the send-API code, not every file of the large monorepos.
- A request issued through a project helper counts once per helper call that names an endpoint. A helper with one fixed endpoint counts once.
