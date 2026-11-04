# Inventory agent evaluation (2026-11-01)

Ten public repositories, cloned shallowly into `~/.refit/repos/` and only read. Nothing in them
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
