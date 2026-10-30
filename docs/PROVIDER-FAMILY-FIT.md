# Provider family fit

Which provider to build next, ordered by how many of its recorded breaking changes Refit could handle with code it already has: a [rule-pack](RULE-PACKS.md) family, a provider-independent mechanism, or a review stop a pack can express. Computed on 2026-10-26 by [`scripts/provider-family-fit.mjs`](../scripts/provider-family-fit.mjs) from the committed `data/` files; nothing was fetched and nothing was added from memory or search.

```sh
node scripts/provider-family-fit.mjs             # counts per provider, ranked, with every rule
node scripts/provider-family-fit.mjs --changes   # also each classified change and its sources
```

## Method

**What counts as a change.** Every removal, deprecation or behaviour change a `data/` file records for a catalog provider without a built-in adapter (Stripe and Shopify are the reference and are left out). One change is one identifier: a model ID, an SDK member, an endpoint (`METHOD path`, path parameters normalised so `{order_id}` and `{id}` match), a field, a package or a titled changelog item. A change recorded in two files is counted once with both sources; a removed endpoint that an SDK member calls is counted as that member's change.

| File                                                                 | What it contributes                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`deadlines.json`](../data/deadlines.json)                           | model retirements, API versions, SDK ends of support, retired endpoints and features (each with its provider page as `source`)                   |
| [`meta-graph-changes.json`](../data/meta-graph/changes.json)         | Graph API changelog v14.0–v26.0, by kind                                                                                                         |
| [`github-api.json`](../data/github-api.json)                         | REST 2026-03-10 breaking-change titles, deprecated OpenAPI operations, GraphQL breaking changes, Octokit methods missing from the latest release |
| [`cloudflare-endpoints.json`](../data/cloudflare-endpoints.json)     | deprecated OpenAPI operations, the API deprecations page, SDK members missing from `cloudflare` 7.3.0, compatibility flags that turn on by date  |
| [`slack-methods.json`](../data/slack-methods.json)                   | `@slack/web-api` methods deprecated or missing from 8.2.0, and the v8 migration guide's removals                                                 |
| [`paypal-requests.json`](../data/paypal-requests.json)               | the deprecated `@paypal/checkout-server-sdk` request classes, and `@paypal/paypal-server-sdk` controller methods missing from 2.5.0              |
| [`messaging-deprecations.json`](../data/messaging-deprecations.json) | `twilio` and `mailgun.js` members marked deprecated in their published types; retired `sendgrid` and `mailgun-js` packages                       |
| [`messaging-endpoints.json`](../data/messaging-endpoints.json)       | Twilio's removed WhatsApp Senders v1 endpoints                                                                                                   |
| [`aws-sdk-v2-clients.json`](../data/aws-sdk-v2-clients.json)         | every `aws-sdk` v2 client (v2 reached end of support)                                                                                            |
| [`azure-sdk-retirements.json`](../data/azure-sdk-retirements.json)   | retired legacy Azure SDK packages                                                                                                                |

Not counted: `api-hosts.json`, `go-sdks.json`, `meta-business-sdk-edges.json` and `model-parameters.json` record no changes, and `shopify-rest-deprecations.json` belongs to Shopify. Slack's Python deprecation prefixes (`channels.` and others) are patterns, not identifiers; the Node SDK data lists the same methods. Octokit methods whose route moved while the name stayed are not counted as removals.

**Categories.** Each change gets exactly one rule from its shape. The rules, in the script's `RULES`:

| Rule                        | Category  | Family or reason        | Shape                                                                                                                                                                                              |
| --------------------------- | --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-replacement`         | mechanism | `model-retirement`      | a retired text-generation model whose registry replacement is a concrete model ID (the same `MODEL_ID` test as `pipeline/model-retirements.ts`)                                                    |
| `same-operation`            | mechanism | `operationReplacements` | an SDK member removed while the same file records another member serving the same operation: same method and path, or for Twilio's and Mailgun's deprecations the same resource under a new parent |
| `model-stop`                | review    | `model-stops`           | a retired model with no concrete replacement, or one whose ID marks it as embeddings, image, audio, video, moderation or legacy completions (`NON_TEXT_MODEL`)                                     |
| `sdk-member`                | review    | `symbolReviews`         | an SDK member removed or deprecated with no member recorded for the same operation                                                                                                                 |
| `endpoint-with-member`      | review    | `symbolReviews`         | a deprecated endpoint that a member of the latest SDK release calls                                                                                                                                |
| `field-removed`             | review    | `readReviews`           | a response field removed with no replacement of the same value recorded                                                                                                                            |
| `request-parameter-removed` | review    | `request-removals`      | a request parameter removed (the shared stop in `pipeline/request-removals.ts`)                                                                                                                    |
| `request-review`            | new code  | `request-review`        | an endpoint, edge or request value (a Meta metric) removed with no SDK member recorded for it                                                                                                      |
| `semantic-change`           | new code  | `semantic-change`       | same name, different behaviour, type, status code or enum values                                                                                                                                   |
| `graphql-document`          | new code  | `graphql-documents`     | a GraphQL schema change                                                                                                                                                                            |
| `version-pin`               | new code  | `version-pin`           | an API version retired                                                                                                                                                                             |
| `sdk-replacement`           | new code  | `sdk-replacement`       | an SDK package or major retired                                                                                                                                                                    |
| `feature-retirement`        | new code  | `feature-retirement`    | a credential, key or product feature retired                                                                                                                                                       |
| `runtime-flag`              | new code  | `runtime-flag`          | a Cloudflare Workers compatibility flag that turns on by date                                                                                                                                      |

GitHub's REST breaking changes are prose titles, so `GITHUB_REST_TITLES` reads them in order: titles starting "Change" or "Update", or about a media type, are semantic; "Remove deprecated /x endpoint" is an endpoint; an enum value removal is semantic; a removal from a request (not a "pull request") with no response side is a request parameter; any other removal or deprecation is a response field. `pipeline/provider-family-fit.test.ts` pins these and a few hand-picked entries from every file.

**Fit** is mechanism plus review: the changes an adapter for the provider could handle without new families. **Edits** is the mechanism part alone, the changes that could become an automatic fix. The ranking is by fit, then by edits.

**No change fits a pack edit family.** `moved-value`, `moved-id`, `period-helper`, `request-rename` and `request-wrap` each need a removed field or parameter with a recorded replacement path holding the same value. No file outside Stripe records one: Meta's change list has no replacement field, GitHub's GraphQL notices say "Use X instead" in prose and are GraphQL, and GitHub's REST titles name no target path. The fact families (`member-since`, `constant-value`, `minimum-major`) are not changes; the SDK release data for Slack, Octokit, PayPal and Cloudflare could feed `member-since` facts once a provider gets an SDK upgrade.

## Ranking

3,436 changes across 27 providers.

| #   | Provider   | Recorded | Fit (%)     | Edits (%)   | Review stops                           | New code                                                            | Files                                                                       |
| --- | ---------- | -------- | ----------- | ----------- | -------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Cloudflare | 744      | 473 (63.6%) | 149 (20%)   | 324 symbol                             | 271: 117 runtime flags, 97 request review, 57 semantic              | `cloudflare-endpoints.json`, `deadlines.json`                               |
| 2   | Twilio     | 136      | 134 (98.5%) | 134 (98.5%) | 0                                      | 2: 1 request review, 1 SDK replacement                              | `messaging-deprecations.json`, `messaging-endpoints.json`, `deadlines.json` |
| 3   | GitHub     | 1,457    | 127 (8.7%)  | 9 (0.6%)    | 105 symbol, 12 read, 1 request removal | 1,330: 1,289 GraphQL, 26 request review, 14 semantic, 1 version pin | `github-api.json`, `deadlines.json`                                         |
| 4   | OpenAI     | 69       | 69 (100%)   | 41 (59.4%)  | 28 model stops                         | 0                                                                   | `deadlines.json`                                                            |
| 5   | Gemini     | 55       | 52 (94.5%)  | 18 (32.7%)  | 34 model stops                         | 3 SDK replacement                                                   | `deadlines.json`                                                            |
| 6   | Slack      | 52       | 52 (100%)   | 0           | 52 symbol                              | 0                                                                   | `slack-methods.json`, `deadlines.json`                                      |
| 7   | Meta Graph | 294      | 31 (10.5%)  | 0           | 27 read, 4 request removal             | 263: 149 request review, 101 semantic, 13 version pin               | `meta-graph-changes.json`, `deadlines.json`                                 |
| 8   | Anthropic  | 21       | 21 (100%)   | 21 (100%)   | 0                                      | 0                                                                   | `deadlines.json`                                                            |
| 9   | PayPal     | 36       | 21 (58.3%)  | 21 (58.3%)  | 0                                      | 15 SDK replacement                                                  | `paypal-requests.json`                                                      |
| 10  | Mailgun    | 19       | 18 (94.7%)  | 2 (10.5%)   | 16 symbol                              | 1 SDK replacement                                                   | `messaging-deprecations.json`                                               |
| —   | AWS        | 386      | 0           | 0           | 0                                      | 386 SDK replacement (every v2 client)                               | `aws-sdk-v2-clients.json`, `deadlines.json`                                 |
| —   | Azure      | 114      | 0           | 0           | 0                                      | 114 SDK replacement                                                 | `azure-sdk-retirements.json`, `deadlines.json`                              |
| —   | Clerk      | 29       | 0           | 0           | 0                                      | 29 SDK replacement                                                  | `deadlines.json`                                                            |
| —   | 14 others  | 1–7 each | 0           | 0           | 0                                      | all: SDK replacement, feature retirement, version pin, endpoint     | `deadlines.json`, `messaging-deprecations.json` (SendGrid)                  |

The 14 others: Supabase 7, Firebase 3, Adyen 2, Braintree 2, and one each for Airtable, Algolia, Auth0, Coinbase Commerce, EasyPost, HubSpot, Mailchimp, NextAuth, SendGrid and Zoom.

**Unknown** (in the catalog, no recorded change in `data/`, not estimated): Resend, Postmark, Plaid, Square, Paddle, Lemon Squeezy, Shippo, Lob, Google Maps, Mapbox, Intercom, Dropbox, Notion, Segment, Sentry, Discord, Contentful, Cloudinary.

## New code with the most reach

Families that do not exist yet, by how many recorded changes they would cover:

| Family               | Changes | Providers                                                 |
| -------------------- | ------- | --------------------------------------------------------- |
| `graphql-documents`  | 1,289   | GitHub only                                               |
| `sdk-replacement`    | 564     | AWS 386, Azure 114, Clerk 29, PayPal 15 and 12 more       |
| `request-review`     | 274     | Meta 149, Cloudflare 97, GitHub 26, Twilio 1, Mailchimp 1 |
| `semantic-change`    | 172     | Meta 101, Cloudflare 57, GitHub 14                        |
| `runtime-flag`       | 117     | Cloudflare only                                           |
| `version-pin`        | 15      | Meta 13, GitHub 1, HubSpot 1                              |
| `feature-retirement` | 7       | Firebase 3, Supabase 2, Zoom 1, Airtable 1                |

A `request-review` family (stop on a raw request by method and path, with a reason and source) is the one new family that serves three ranked providers at once, and every one of its changes is a stop, not an edit. `sdk-replacement` is large but each package swap changes call shapes differently, so it is a family name, not one piece of code.

## Recommended order

The ranking counts fit; the order below also weighs what each count needs before it is real.

1. **Gemini model IDs.** 18 edits through the model-retirement rule with no new family. What blocks them is an owner decision, not code: Gemini is report only (AGENTS.md), and `MODEL_CALLS` in `pipeline/model-retirements.ts` has no Gemini calls. The 34 stops are all image, video, embedding, speech and live models, 6 of which also have no replacement.
2. **Cloudflare.** The largest fit (473) and 149 edit candidates, and the OpenAPI document is pinned by commit in the data file. Needs a reviewed adapter mapping `client.resource.method` to operation IDs; the 324 stops then come from data, and the 117 runtime flags stay report only (`refit cloudflare` already reads them).
3. **PayPal (server SDK).** 21 renamed `@paypal/paypal-server-sdk` controller methods (`ordersCreate` in 0.5.1–0.6.1 → `createOrder` from 0.7.0, same route) fit `operationReplacements`, and PayPal's specifications are pinned by commit. The 15 deprecated-SDK request classes are an `sdk-replacement` and an owner decision (AGENTS.md).
4. **Twilio.** 134 of 136 fit `operationReplacements`, but these are deprecated aliases that still work, not removals, and no Twilio OpenAPI document is in the repository, which the mechanism's contract check needs.
5. **Slack.** All 52 fit, all as stops; no edit is possible from the data, because no Slack contract records whether a replacement method has the same shape.
6. **GitHub.** 127 fit, but 1,289 of 1,457 changes are GraphQL and need `graphql-documents` first.
7. **Meta Graph.** 31 fit; 263 need `request-review` and `semantic-change`, which is why Meta stays review only (`refit meta-graph`).

OpenAI and Anthropic already have their model edits (`refit serve --model-fixes`); they rank high because that work is done. AWS, Azure and the deadline-only providers fit nothing until an `sdk-replacement` decision exists for them.

## Caveats

- **Same route is necessary, not sufficient.** `operationReplacements` also checks that both operations return the same schema in the recorded contracts and edits only direct calls. The data records routes, not argument shapes, so a rename whose arguments also changed between the sampled releases stops at that check. The 315 `operationReplacements` counts are an upper bound.
- **A review stop still needs a tracer.** A `symbolReviews` or `readReviews` entry is data only once the provider has an adapter that finds the call. Today Cloudflare, GitHub, Slack, Twilio, Mailgun, Meta and PayPal have review-only detectors (`refit cloudflare`, `refit github-api`, `refit slack`, `refit messaging`, `refit meta-graph`, `refit paypal`), none of which feeds `refit run`.
- **Meta is incomplete.** v14.0 to v26.0 are reviewed; v13.0 is unread, and the WhatsApp Business Platform and Messenger Platform changelogs are not reviewed at all (AGENTS.md), so those requests keep stopping and their changes are not counted.
- **PayPal has no deadline entries.** `developer.paypal.com` was unreachable from the cloud environment on 2026-10-21; PayPal's count is SDK data only.
- **Gemini model dates** are from `ai.google.dev/gemini-api/docs/deprecations`, read on 2026-10-22 after the page was unreachable on 2026-10-21. The three SDK entries come from the deprecated repositories' READMEs.
- **Twilio's SDK deadline is Refit's estimate** from Twilio's support policy, not a Twilio date (its entry says so). Twilio's 134 deprecations are from twilio 6.2.0's type declarations.
- **SDK diffs are sampled.** Slack's, Octokit's, Cloudflare's and PayPal's removed members come from the releases each generator downloaded (for example Cloudflare 3.5.0, 4.5.0, 5.2.0, 6.5.0 and 7.3.0), so a member added and removed between two sampled releases is missed.
- **GitHub REST titles** are classified by pattern; "the organization request and response" is counted as a response field, though the request side also lost it.
- **Counts are not usage.** A provider with many recorded changes is not necessarily one whose users hit them; how common each SDK is comes from the frozen sets in [BENCHMARKS.md](BENCHMARKS.md), which this page does not use.
