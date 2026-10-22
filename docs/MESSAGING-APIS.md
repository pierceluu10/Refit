# Messaging APIs

Refit detects five messaging providers: Twilio, SendGrid, Resend, Postmark and Mailgun. It monitors the one support deadline a reachable provider page dates, and lists the deprecated SDK calls and removed endpoints a repository uses. None of these providers has a Refit agent (`adapter: null`). Everything here is review only: nothing is edited, installed, run or sent to a provider.

## Detection

`refit agents` and the hosted inventory (`detectProviders`) find each provider from its packages in any `package.json`, or its API hosts in source. Package names were checked on the npm registry on 2026-10-22, and each host was read from the SDK's own published source.

| Provider | Packages                                                   | API hosts                                                                                                                     |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Twilio   | `twilio`                                                   | The 38 `*.twilio.com` hosts in twilio 6.2.0's `lib/rest/*Base.js` (`api`, `verify`, `messaging`, `conversations`, `video`, …) |
| SendGrid | `@sendgrid/mail`, `@sendgrid/client`, `sendgrid` (retired) | `api.sendgrid.com`, `api.eu.sendgrid.com` (@sendgrid/client 8.1.6)                                                            |
| Resend   | `resend`                                                   | `api.resend.com` (resend 6.34.1)                                                                                              |
| Postmark | `postmark`                                                 | `api.postmarkapp.com` (postmark 5.1.0)                                                                                        |
| Mailgun  | `mailgun.js`, `mailgun-js` (retired)                       | `api.mailgun.net`, `api.eu.mailgun.net` (mailgun.js 14.1.0 and its README)                                                    |

## What the providers say

| Fact                                                                                                                                                                                                                      | Where it is used                                                  | Source (read 2026-10-22)                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| twilio-node supports only its current major version; 6.0.0 became current on 2026-04-20, so 5.x and older get no more features, fixes or security updates. 6.x has no breaking API changes but needs Node.js 20 or newer. | Registry entry `twilio-node-below-6-2026-04-20` (`twilio@<6.0.0`) | [VERSIONS.md](https://github.com/twilio/twilio-node/blob/main/VERSIONS.md), [UPGRADE.md](https://github.com/twilio/twilio-node/blob/main/UPGRADE.md) |
| 134 version-less accessors on the Twilio client are deprecated in favour of a versioned path, such as `client.verify.services` → `client.verify.v2.services` and `client.api.calls` → `client.api.account.calls`.         | `refit messaging`                                                 | `@deprecated` tags in twilio 6.2.0's type declarations                                                                                               |
| 18 mailgun.js domain methods are deprecated, such as `domains.getTracking` → `domains.domainTracking.getTracking`, and the `domains.domainTags` methods in favour of the Tags client.                                     | `refit messaging`                                                 | `@deprecated` tags in mailgun.js 14.1.0's type declarations; the same notes are in its README                                                        |
| Twilio removed the WhatsApp Senders v1 endpoints (`messaging.twilio.com/v1/Channels/WhatsApp/Senders`) in the 6.1.1 release notes of 2026-09-09; use `/v2/Channels/Senders`.                                              | `refit messaging` (`data/messaging-endpoints.json`)               | [twilio-node CHANGES.md](https://github.com/twilio/twilio-node/blob/main/CHANGES.md)                                                                 |
| npm marks the `sendgrid` package deprecated ("Please see v6.X+") and `mailgun-js` deprecated ("Package no longer supported").                                                                                             | `refit messaging` (package notes)                                 | npm registry metadata                                                                                                                                |

No provider names a date when the deprecated members or the retired packages stop working, so they are listed without a deadline. Only the Twilio major-version entry is in the deadline registry.

`twilio.com`, `help.twilio.com`, SendGrid's documentation, `resend.com`, `postmarkapp.com` and `documentation.mailgun.com` did not resolve from the cloud environment on 2026-10-22. So these pages were not read: the providers' changelog, deprecation and end-of-life pages, Twilio's helper-library support policy page, SendGrid's legacy API notices and Mailgun's API version notices. The facts above come from the providers' own GitHub repositories and npm packages. Deadlines those web pages announce are not in the registry; see [Blocked](#blocked).

## The registry matcher for older releases

An `sdk` entry normally names a whole package. `twilio@<6.0.0` names only the releases below 6.0.0. A declaration matches when its locked version is below 6.0.0. Without a lock, it matches when the lowest version its range allows is below 6.0.0: `5.3.1`, `^5.3.1`, `~5.3`, `>=4` and `5.x` match; `^6.0.0` does not. Ranges with alternatives (`^4 || ^6`), upper bounds only, tags (`latest`, `*`) and URLs are unknown and never match, so an alert is never raised on a guess.

## List the calls

```sh
refit messaging --repository /path/to/app
refit messaging --repository /path/to/app --json
```

`scanMessagingCalls` (`pipeline/messaging-calls.ts`) reports:

- **providers**: the catalog detections above;
- **packages**: each messaging SDK declaration, with npm's notice for a retired package and the registry deadline it falls under (twilio below 6.0.0);
- **calls**: with file, line, the member or URL as written, the provider's message, the replacement it names, and the source:
  - a deprecated member: the member chain on a receiver that is a client of that SDK. The file must load the SDK, or the receiver's name must name the provider (`this.twilioClient`, `mailgunClient`). Each chain is matched once, so `client.verify.services(sid).verifications.create()` is one call, and the versioned replacement (`client.verify.v2.services`) is never reported;
  - a removed endpoint: a string or template that holds the endpoint's host and path, with nothing appended to the last segment.

Calls in tests, examples and fixtures are marked `test` and counted apart.

### The generated deprecation list

`data/messaging-deprecations.json` is generated by `scripts/messaging-deprecations.mjs` from the downloaded, never-installed twilio 6.2.0 and mailgun.js 14.1.0 npm tarballs. The script parses their `.d.ts` files with the TypeScript compiler, starting from the class a user holds (`Twilio`, `MailgunClient`), and walks its members two levels deep for Twilio and three for Mailgun. It records every member tagged `@deprecated`, with the tag's text and the replacement it names. A member typed by an interface also takes the tags of the classes that implement it, which is where mailgun.js documents them. Regenerate the file rather than editing it. The script also records npm's deprecation notices for `sendgrid` and `mailgun-js`.

## Benchmark

All numbers come from Refit at a pinned commit in a clean detached worktree, scanning shallow checkouts at the pinned commits. Nothing in the samples was installed or run.

```sh
node scripts/messaging-benchmark.mjs --root <dir> --labels docs/benchmarks/2026-10-22-messaging-labels.json
```

### The sample

`docs/benchmarks/2026-10-22-messaging-repos.json` holds 60 public repositories, 12 per provider. `scripts/messaging-select.mjs` selected them on 2026-10-22 from npm search, because GitHub code search is not available here. Each repository's published package declares the provider's SDK in `dependencies`, and the providers' own organizations and scopes are excluded. The exact queries, quotas and rejection counts are in the file.

9 repositories exceed Refit's scan limits (10,000 files, 50 MiB, or 128 source-configuration files) and were not scanned: `medusajs/medusa`, `strapi/strapi`, `UsefulSoftwareCo/emulate`, `cedarjs/cedar`, `open-mercato/open-mercato`, `MemberJunction/MJ`, `molecule-dev/molecule`, `constructive-io/constructive` and `ever-works/ever-works`.

### What the 51 scanned repositories use

Results are in `docs/benchmarks/2026-10-22-messaging-results.json`, from Refit `03d8869` (the first run, at `ec3e928`, gave identical numbers on this sample).

| Provider | Repositories where Refit detects it | Live deprecated calls |
| -------- | ----------------------------------: | --------------------: |
| Twilio   |                                  15 |                     0 |
| SendGrid |                                  12 |                     0 |
| Resend   |                                  14 |                     0 |
| Postmark |                                  14 |                     0 |
| Mailgun  |                                  16 |                     0 |

- **Unsupported twilio-node:** 8 of the 12 scanned Twilio-group repositories declare twilio-node below 6.0.0 (9 manifests: 3.83.2, 4.11.0, and 5.4.0 to 5.13.0), so the registry deadline applies to them.
- **Retired package:** one repository (`akemona/strapi`) still declares the retired `mailgun-js`.
- **Deprecated calls:** none of the 60 repositories has a deprecated-member or removed-endpoint candidate, even by the independent text search.

### Precision and recall on the main sample

25 repositories were labelled blind (`docs/benchmarks/2026-10-22-messaging-labels.json`).

- **Selection:** a seeded order per provider (seed 20261022), taking the first 5 per provider that are within Refit's scan limits. The limits were counted from the file list before any scan, so `molecule-dev/molecule`, `medusajs/medusa` and `strapi/strapi` were passed over.
- **Candidates:** `scripts/messaging-label-candidates.mjs`, an independent text search that imports no pipeline code.
- **Labelling:** two fresh-context agents read the checkouts against written rules, also searching beyond the candidates, and never saw Refit output. The labels were committed before Refit scanned the sample.
- **Adjudication:** one labelling error was corrected against the SDK's declarations, not Refit output. The agent had marked `client.api.accounts` as deprecated from memory, but twilio 6.2.0 does not tag it (recorded under `adjudications`).
- This is a single AI-assisted pass. It was not second-labelled.

| Unit                                                          | Labelled positives | Reported | True positives |    Precision |       Recall |
| ------------------------------------------------------------- | -----------------: | -------: | -------------: | -----------: | -----------: |
| Provider used in live code (repository × provider, 125 pairs) |                 33 |       31 |             31 |         100% |        93.9% |
| twilio declared below 6.0.0 (package.json files)              |                  5 |        5 |              5 |         100% |         100% |
| Deprecated calls                                              |                  0 |        0 |              0 | not measured | not measured |

The two missed providers are in one repository, `nu-art-js/thunderstorm`. It imports `@sendgrid/mail` and `resend` in live code, but its packages keep their manifests as `__package.json` templates, so no `package.json` declares either SDK and no API host appears in source. `detectProviders` reads manifests and hosts, not imports, so it misses them. The registry cannot see those declarations either.

### Deprecated calls: the targeted list

The main sample has no deprecated calls to measure, so a second list was frozen:

- `docs/benchmarks/2026-10-22-messaging-targeted-repos.json` holds 21 repositories: 15 Twilio and 6 Mailgun.
- It was selected the same way, with queries aimed at the products whose accessors are deprecated ("twilio verify", "twilio sync", "otp", "mailgun domain", and others), excluding the main list.
- All 21 were labelled blind the same way (`docs/benchmarks/2026-10-22-messaging-targeted-labels.json`). The labelling agent used the twilio and mailgun.js declarations as its reference for what is deprecated.
- 3 repositories exceed the scan limits (`yorch/simple-sms-sender`, `karimsa/quicksend`, `novuhq/novu`).

On the 18 scanned repositories:

| Unit                                   | Labelled positives | Refit `0473d9d` (before)                             | Refit `03d8869` (after)                              |
| -------------------------------------- | -----------------: | ---------------------------------------------------- | ---------------------------------------------------- |
| Deprecated calls                       |                  6 | 1 of 4 reported correct: precision 25%, recall 16.7% | 6 of 6 reported correct: precision 100%, recall 100% |
| twilio declared below 6.0.0            |                  8 | precision 100%, recall 100%                          | precision 100%, recall 100%                          |
| Provider used in live code (105 pairs) |                 19 | precision 90.5%, recall 100%                         | precision 90.5%, recall 100%                         |

**The "after" column was tuned on these labels**, so it is not an independent measurement. The first run's errors had three causes, all fixed in `03d8869` with tests:

- **`this` as the client:** `howdyai/botkit` keeps its client in `this.api`, so `this.api.messages` is the root `messages` shortcut, not the deprecated `api.messages`. A bare `this` receiver is now rejected.
- **Static access on the global:** `iagocalazans/twilio-functions-utils` builds a mock on the `Twilio` runtime global (`Twilio.sync.services`). That is a static access, not a client, so receivers named `Twilio` or `Mailgun` are now rejected.
- **Client from a factory:** `denisguzeyev/twilio-pulumi-provider-ih` gets its client from `getTwilioClient()` in a file that never imports `twilio`. Locals initialized from a call or `new` whose callee names the provider are now followed.

The six true calls are all version-less accessors: `client.serverless.services` (5 sites in one repository) and `this.twilioClient.messaging.services` (1). The two provider false positives are `package.json` declarations that live code never loads (`medplum/medplum`), or loads for types only (`iagocalazans/twilio-functions-utils`). `detectProviders` counts a declaration as detection, which is what deadline monitoring needs. A repository whose only twilio reference is a declaration is still exposed to the twilio-node deadline.

### Combined

Across both lists (43 labelled, scanned repositories):

| Unit                                    |        Precision |           Recall |
| --------------------------------------- | ---------------: | ---------------: |
| Provider used in live code              | 96.2% (50 of 52) | 96.2% (50 of 52) |
| twilio declared below 6.0.0             |  100% (13 of 13) |  100% (13 of 13) |
| Deprecated calls (after the fix, tuned) |    100% (6 of 6) |    100% (6 of 6) |

The counts are small. Six deprecated calls in two repositories say the matcher handles these forms; they do not establish a rate.

## Blocked

Tried twice each on 2026-10-22 from the cloud environment. Every attempt failed with `curl: (56) CONNECT tunnel failed, response 403` from the environment's network proxy:

- `www.twilio.com` (changelog, helper-library support policy, API deprecation notices) and `help.twilio.com`;
- `docs.sendgrid.com` and `www.twilio.com/docs/sendgrid` (legacy v2 API and template deprecations);
- `resend.com` (changelog);
- `postmarkapp.com` (updates);
- `documentation.mailgun.com` (API version notices).

So no registry entry comes from those pages, and no deprecated raw endpoint other than Twilio's WhatsApp Senders v1 is matched. To unblock, someone who can read those pages adds dated entries to `data/deadlines.json` (`kind: "api-version"` or `"sdk"`), and endpoints to `data/messaging-endpoints.json`, each with `source` and `checkedAt`. The registry's provider list (`pipeline/deadline-registry.ts`) needs the provider added first.

## Not covered

- Deprecated members are matched only on twilio and mailgun.js clients. SendGrid, Resend and Postmark's current SDKs tag nothing `@deprecated` in their declarations (@sendgrid/mail and @sendgrid/client 8.1.6, resend 6.34.1, postmark 5.1.0).
- A deprecated member reached through a client whose name does not name the provider, in a file that does not load the SDK, is not matched; for example, a client passed in as `this.client` from another module.
- Python, Go and other ecosystems' messaging SDKs.
