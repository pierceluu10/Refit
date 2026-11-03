# Inventory agent evaluation (2026-11-01)

Ten public repositories, cloned shallowly into `~/.aptitude/repos/` and only read. Nothing in them
was installed, built or run. Main agent: `claude-sonnet-5-5` at medium effort. Area readers:
`claude-haiku-5-5` at low effort. Raw reports are in `evaluation/reports/v1` (prompt
`inventory-v1`, all 10 repos) and `evaluation/reports/v2` (prompt `inventory-v2`, 4 repos). Ground
truth is in `evaluation/ground-truth`, and the precision hand-checks are in
`evaluation/hand-checks.json`.

**Total real model spend: $1.78 of the $6 cap**, over 14 runs (the spend log has 30 lines, one per
model per run).

## The repositories

| Repository                              | Commit  | Kind                            | Files | Usages | Call sites | Cost (v1) |
| --------------------------------------- | ------- | ------------------------------- | ----: | -----: | ---------: | --------: |
| vercel/nextjs-subscription-payments     | bdd0813 | Next.js SaaS, Stripe + Supabase |    90 |      4 |         30 |   $0.1036 |
| Shopify/shopify-app-template-remix      | 2d966b7 | Shopify app, GraphQL + webhooks |    53 |      3 |          9 |   $0.0513 |
| Nutlope/roomGPT                         | 611398c | Next.js, Replicate, Upstash     |    43 |      4 |          7 |   $0.0719 |
| Nutlope/twitterbio                      | 538a7fc | Next.js, Together AI            |    33 |      2 |          3 |   $0.0349 |
| chubin/wttr.in                          | c369bc4 | Go service, OpenCage, WWO       |   638 |      3 |          5 |   $0.0876 |
| simonw/llm                              | aebaca2 | Python CLI, OpenAI              |   120 |      3 |         18 |   $0.0926 |
| charmbracelet/mods                      | 0425d0d | Go CLI, many LLM SDKs, MCP      |    63 |      7 |         20 |   $0.1434 |
| TwilioDevEd/appointment-reminders-flask | e127f19 | Flask, Twilio                   |    41 |      1 |          1 |   $0.0337 |
| maybe-finance/maybe                     | 77b5469 | Rails, Plaid, Synth, Stripe     |  1644 |     12 |         50 |   $0.2484 |
| mckaywrigley/chatbot-ui                 | 81328b6 | Next.js, Supabase + 10 LLM APIs |   320 |     15 |         44 |   $0.2082 |

Usages and call sites are from v1. Repositories using APIs outside the big names: roomGPT
(Replicate, Upstash, Bytescale), wttr.in (OpenCage, World Weather Online), maybe-finance (Synth
Finance, Plaid, Logtail), twitterbio (Together AI), chatbot-ui (OpenRouter, Perplexity, Groq).

## Precision: 15 hand-checked usages (v1)

These 15 usages from 8 repositories were checked by a subagent that read the code itself.

- **Usages: 12/15 correct (80%).** The three wrong ones:
  - `maybe` "smtp" via http: SMTP mailer config, not an HTTP API.
  - `llm` "user-supplied-urls": fetches of arbitrary URLs the user passes in. That is not a provider.
  - `nextjs-subscription-payments` "stripe-js": the package was used as the provider name, so
    Stripe was split in two. The call sites are right.
- **Call sites: 60/73 correct (82%).** Counting client construction as a valid site gives 65/73
  (89%). The other errors:
  - Off by one on a multi-line statement (`llm openai_models.py:518`, `models.py:96`, `:111`).
  - URL string constants recorded as calls (`mods google.go:38`, `maybe auto_merchant_detector.rb:69`).
  - A call to the app's own route (`twitterbio page.tsx:57`).
  - A LocationIQ site filed under OpenCage (`wttr.in nominatim_locationiq.go:23`).
- **Versions:** all 8 SDK versions matched the lockfile or manifest, and both pinned API versions
  were right (Shopify `ApiVersion.January25`, Gemini `v1beta`).
- **Misses found during the hand-check:** `maybe lib/tasks/securities.rake:24` (Synth),
  `maybe lib/tasks/data_migration.rake:16` (Plaid) and `llm cli.py:372`. v2 found both rake tasks.

On the three ground-truth repositories, v2's recorded sites that are not in the ground truth:

- roomGPT: 1, `UrlBuilder.url`, which builds a URL locally.
- wttr.in: none.
- chatbot-ui: 2. `getPublicUrl` sends no request. Vercel Edge Config `get` is a real API that the
  ground truth missed.

That puts v2's call-site precision there at 5/6, 3/3 and 198–199/200.

## Recall against hand-built ground truth

For three repositories, a subagent listed every external API call site by reading the code, without
seeing the agent's output. A call site matches when the file is the same and the line is within 2.
Client constructions are left out of both counts.

| Repository              | Ground-truth sites | v1 recall      | v2 recall       | v2 cost |
| ----------------------- | -----------------: | -------------- | --------------- | ------: |
| Nutlope/roomGPT         |                  6 | 5/6 (83.3%)    | 5/6 (83.3%)     | $0.0769 |
| chubin/wttr.in          |                  5 | 2/5 (40.0%)    | 3/5 (60.0%)     | $0.1044 |
| mckaywrigley/chatbot-ui |                193 | 36/193 (18.7%) | 190/193 (98.4%) | $0.2366 |
| **All three**           |            **204** | **43 (21.1%)** | **198 (97.1%)** |         |

In chatbot-ui v1, recall outside Supabase was already 21/22. The agent recorded 15 of 171 Supabase
calls as a sample, and never used its area readers.

### Every miss and why

**v1**

- **roomGPT `utils/downloadPhoto.ts:11`** (fetch of the generated image on replicate.delivery). The
  agent never opened the file. The URL comes from the Replicate response, so no host scanner sees it.
- **wttr.in `build.sh:143`** (curl from raw.githubusercontent.com). A build script, not read.
- **wttr.in `share/salt/init.sls:58`** (MaxMind GeoLite download). Salt config, not read.
- **wttr.in `share/salt/wegorc:15`** (forecast.io config for the external `wego` binary). Not read,
  and arguably out of scope because wego makes the call, not this repo.
- **chatbot-ui, 156 Supabase sites** across `db/`, `app/` and `components/`. The agent sampled
  instead of listing every call.
- **chatbot-ui `components/chat/chat-helpers/index.ts:257`** (Ollama through a shared fetch
  wrapper). The agent recorded the other Ollama site.

**v2** (after one prompt change, below)

- **roomGPT `utils/downloadPhoto.ts:11`.** Same as v1. The agent named `downloadPhoto` but did not
  follow it, despite the new "follow the response" guidance.
- **wttr.in `share/salt/init.sls:58` and `share/salt/wegorc:15`.** The agent said in its summary
  that it had not checked `share/salt` or `.github/workflows`.
- **chatbot-ui `supabase/migrations/20240108234540_setup.sql:60`** (Supabase storage DELETE through
  Postgres `extensions.http` in a SQL migration). A network call hidden in SQL.
- **chatbot-ui `app/api/chat/tools/route.ts:153` and `:178`** (user-configured OpenAPI tool
  endpoints). This one was caused by the v2 prompt: it now tells the agent not to record arbitrary
  user-supplied URLs, which conflicts with this ground truth. It is a judgement call.

## The one improvement round (v1 to v2)

The v1 misses and hand-check errors led to changes in `prompt.ts` only, plus one tool-name fix:

- **Be exhaustive with heavily used clients.** Enumerate them with grep and record every call,
  never a sample.
- **Fan out more.** Fan out when a client is used in more than about 20 places, and give a heavy
  client its own area reader.
- **Read beyond the main source tree:** rake tasks, scripts, Dockerfiles, CI and infrastructure
  config.
- **Follow the response.** Record fetches of URLs that an API returned.
- **Tighten what a call site is.** It is the line with the method name. Client construction and URL
  constants go in notes instead.
- **Tighten what counts as an API.** The provider is the vendor, not the package. SMTP and arbitrary
  user URLs are not providers.
- **Tool-name fix.** The runtime exposes the subagent tool as `Task`, so it is now allowed by both
  names. In v1, no run fanned out.

Results:

- **chatbot-ui:** fanned out to 3 Haiku area readers and went from 36 to 190 sites, at $0.24 against
  $0.21.
- **maybe-finance:** still read everything itself even with 1,644 files (45 turns, $0.29). It
  recorded the two rake-task sites it missed before, and dropped the SMTP false positive.
- **wttr.in:** picked up `build.sh`.

## Limits and what is not proven

- Ground truth was built by one subagent per repository and is itself fallible. Its own uncertain
  calls are listed in the ground-truth files.
- Precision was hand-checked on v1, not re-checked on all of v2.
- Only 3 repositories have full ground truth. The other 7 show precision only.
- Fan-out is guidance in the prompt, and the agent ignored it on the largest repository.
- Provider hints (`ApiUsage.hints`, prompt `inventory-v3`) were added after these runs and have not
  been measured on any real repository. Only the fake-model unit tests cover them.

# Round 3: scan first, then the agent (2026-11-03)

The round 2 benchmark's 8 inventoried repos, at the commits it froze. Each repo was downloaded as a
GitHub tarball and only read.

- **Old:** `main` at `d0b93178` (prompt `inventory-v3`). The agent reads everything.
- **New:** prompt `inventory-v8` with scan `scan-v5`. The code scan runs first, then the agent on
  what the scan left.
- **Both:** `claude-sonnet-5-5` with `claude-haiku-5-5` area readers, at the default $0.60 run
  cap.

The reports are in `evaluation/round-3/old`, `new` and `old-rerun`. This command reproduces the
matches at $0:

```sh
node inventory/evaluation/compare.ts inventory/evaluation/round-3/old inventory/evaluation/round-3/new
```

## Cost and what was found

| Repo                                | Round 2 old | Old today            | New today (scan)         | Old usages found | Cached rerun |
| ----------------------------------- | ----------- | -------------------- | ------------------------ | ---------------: | -----------: |
| 4lbatr0s/jiro                       | $0.1391, 6  | $0.1381, 6, 18 turns | $0.0592, 10 (7), 7 turns |              6/6 |           $0 |
| adamhitzger/financehb               | $0.2734, 11 | $0.2691, 13, 35      | $0.0957, 14 (9), 11      |            13/13 |           $0 |
| alanagoyal/branded                  | $0.2656, 10 | $0.2512, 10, 24      | $0.1145, 11 (7), 17      |            10/10 |           $0 |
| borodinka/hire-wise                 | $0.0948, 3  | $0.1064, 6, 22       | $0.0278, 5 (3), 5        |              6/6 |           $0 |
| crlny/lobe-chat                     | $0.2992, 50 | $0.2563, 79, 1       | $0.2199, 79 (17), 1      |            74/79 |           $0 |
| guixincui/LobeChat                  | $0.2689, 12 | $0.2236, 9, 27       | $0.1401, 11 (3), 29      |              9/9 |           $0 |
| mohammadpurl/next-livekit-streaming | $0.1148, 6  | $0.1116, 6, 23       | $0.0233, 6 (5), 4        |              6/6 |           $0 |
| ravi-aman/pureFeedback              | $0.0472, 2  | $0.0498, 2, 14       | $0.0154, 2 (2), 2        |              2/2 |           $0 |
| **All 8**                           | **$1.5030** | **$1.4062**, 131     | **$0.6960**, 138 (53)    |      **126/131** |       **$0** |

Each cell gives the cost, then the usages, then the turns. "Round 2 old" is the inventory part of
each result file in `evals/reports/2026-11-03/`. Those files keep only a usage count.

- **Cost: $0.6960 against $1.4062, 50% less, on a cold cache.** A rerun of an unchanged commit
  costs $0. All 8 came from the commit cache, in a new process, with no model call.
- **The scan built 53 of the 138 usages with no AI call.** The agent's turns fell from 14 to 35 per
  repo to 2 to 29. The exceptions are the two lobe-chat forks, whose leads are mostly AI-provider
  base URLs.
- **The new run found 126 of the old run's 131 usages.** It found all of them on 7 repos and 74 of
  79 on lobe-chat. For scale, a second run of the old inventory on lobe-chat found 72 of the first
  run's 79 (`old-rerun`). Round 2's old run had found 50 there.
- **What it missed, all on lobe-chat:**
  - Hugging Face through its SDK (it recorded the raw-HTTP use);
  - Higress, an OpenAI-compatible endpoint with no fixed host;
  - WeChat and Microsoft Entra sign-in through next-auth;
  - Umami's script.
- **What it found that the old run did not** (6 usages):
  - Google reCAPTCHA in financehb;
  - the uploadthing file host in jiro;
  - Microsoft speech in LobeChat;
  - LobeHub's plugin gateway, and the Casdoor and Logto sign-in endpoints, in lobe-chat.
- The usage totals (138 against 131) don't subtract to these counts. One usage in one run can
  match several in the other, such as an SDK usage the other run split by package.
- **The matcher only undercounts.** A usage counts as found only with the same channel and a
  matching provider id, SDK or host. A usage named differently in the two runs counts as missed.
  For example, one earlier run named the livekit backend `custom-backend` and the other
  `NEXT_PUBLIC_API_URL backend`.

## How it got there

Each version was measured on all 8 repos.

| Version          | What changed                                                          | Cost    | Found   |
| ---------------- | --------------------------------------------------------------------- | ------- | ------- |
| `v4` + `scan-v1` | Scan, leads, agent on the leads                                       | $0.7227 | 78/131  |
| `v5` + `scan-v2` | UI-only SDK components, a catalog of browser services, base-URL leads | $0.7692 | 112/131 |
| `v6` + `scan-v3` | Runtime-URL fetches tagged with the hosts their file names            | $0.8346 | 115/131 |
| `v7` + `scan-v4` | Several records per reply; a runtime-URL fetch tied to a lone host    | $0.7501 | 110/131 |
| `v8` + `scan-v5` | The scan suggests areas, so lead-heavy repos fan out                  | $0.6960 | 126/131 |

Almost all the movement is lobe-chat.

- **Without fan-out:** 58 one-record replies on Sonnet, $0.31, 61 of 79.
- **With the scan's suggested areas:** one turn that fans out to Haiku area readers, $0.22, 74 of 79.

## Precision of the scan

I read the line behind every 10th of the scan's 272 call sites (25 of them), spread over the 8
repos.

- All 25 point at a real use of the SDK or host on that line.
- 23 of the 25 are requests. The two that are not are HeyGen's `avatarRef.current.on(...)`, an
  event listener, and Firestore's `doc(...)`, a reference builder.

## Limits

- One run per version. Model runs vary: the old inventory found 72 of its own earlier 79 usages on
  lobe-chat.
- There is no ground truth for these 8 repos. The score is against the old inventory's findings,
  not against every API the repos use.
- The scan reads call sites in JS/TS and Python only. Go, Ruby, PHP and JVM code goes to the agent
  as a lead.

## Real-AI spend: $5.56

| Run                                                         | Cost    |
| ----------------------------------------------------------- | ------- |
| Old inventory on all 8 repos                                | $1.4062 |
| Second old run on lobe-chat                                 | $0.2492 |
| New inventory, `v4` to `v7`, 8 repos each                   | $3.0766 |
| New inventory `v8`, 8 repos                                 | $0.6960 |
| Changelog-read proofs (see `providers/core/watch-cache.ts`) | $0.1325 |

The cached reruns cost $0.
