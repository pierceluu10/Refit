# Class-client call tracing: October 14, 2026

The same 45 pinned, clean public repository commits were read with main 0.18 (`7e70375`) and the class-client implementation (`dffa3f1`). Application dependencies were not installed and application code was not executed. The corpus and candidate heuristic are unchanged between these two runs. Both scanners completed all 45 repositories without a whole-scan failure.

| Provider | Likely calls | Before | After |
|---|---|---|---|
| OpenAI | 187 | 38 | 172 |
| Anthropic | 61 | 27 | 32 |
| Stripe | 106 | 45 | 45 |
| **All** | **354** | **110 (31%)** | **249 (70%)** |

The slice adds 139 structurally traced calls. One repository (`i-am-alice/3rd-devs`) contributes 103 of them, so this is not a uniform improvement across applications. Stripe tracing does not improve in this cohort. Of 41 repositories with likely calls, those with no traced calls decrease from 18 to 15. The older pre-0.13/0.15 reports used 352 candidates and are historical measurements, not this comparison's baseline.

The candidate finder is heuristic. A traced call may retain unstable-client review evidence; it is not necessarily a confirmed breaking read or a supported migration. These numbers do not measure ground-truth recall, precision, patch correctness, PR acceptance or production reliability. The separate 100-repository Stripe upgrade benchmark has not been rerun. Remaining misses include factories, injected clients, getters/lazy initialization and unsupported project configuration.

The generated after report follows. The corpus is pinned in `2026-10-14-sdk-repos.json`; rerun with the command in `../SDK-COVERAGE.md`.

# Detailed after report

Repositories: 45. Refused by Refit's reader (size limits): 0; their tracing was still measured from source files. Scanner failed entirely: 0.

## Traced SDK call sites by provider

| Provider | Repos | Likely SDK call sites | Traced by Refit | Coverage | Repos with zero traced |
|---|---|---|---|---|---|
| openai | 15 | 187 | 172 | 92% | 5 |
| anthropic | 15 | 61 | 32 | 52% | 5 |
| stripe | 15 | 106 | 45 | 42% | 5 |
| **all** | 45 | 354 | 249 | **70%** | |

## Why calls were missed

| Reason | openai | anthropic | stripe | Total | Share of misses | Repos affected |
|---|---|---|---|---|---|---|
| `factory-call` | 4 | 4 | 17 | 25 | 24% | 7 |
| `parameter` | 2 | 2 | 18 | 22 | 21% | 6 |
| `class-field` | 8 | 5 | 8 | 21 | 20% | 5 |
| `direct-client-not-traced` | 1 | 4 | 12 | 17 | 16% | 7 |
| `object-property` | 0 | 9 | 1 | 10 | 10% | 5 |
| `inline-factory-call` | 0 | 1 | 4 | 5 | 5% | 2 |
| `other-variable` | 0 | 2 | 0 | 2 | 2% | 1 |
| `destructured` | 0 | 2 | 0 | 2 | 2% | 1 |
| `path-alias-import` | 0 | 0 | 1 | 1 | 1% | 1 |

## Per repository

| Provider | Repository | Stars | Commit | Files | Likely SDK calls | Traced | Refused | Scanner failed |
|---|---|---|---|---|---|---|---|---|
| openai | [transitive-bullshit/OpenOpenAI](https://github.com/transitive-bullshit/OpenOpenAI) | 549 | `5b6a2a1` | 28 | 26 | 26 |  |  |
| openai | [i-am-alice/3rd-devs](https://github.com/i-am-alice/3rd-devs) | 491 | `ece916e` | 317 | 109 | 103 |  |  |
| openai | [jamonholmgren/flame](https://github.com/jamonholmgren/flame) | 306 | `018b880` | 55 | 3 | 0 |  |  |
| openai | [miikkaylisiurunen/raycast-ai-openrouter-proxy](https://github.com/miikkaylisiurunen/raycast-ai-openrouter-proxy) | 272 | `efdcda9` | 11 | 1 | 0 |  |  |
| openai | [TheOrcDev/orcish-ai-nextjs-framework](https://github.com/TheOrcDev/orcish-ai-nextjs-framework) | 165 | `ad57e02` | 54 | 0 | 0 |  |  |
| openai | [openserv-labs/sdk](https://github.com/openserv-labs/sdk) | 139 | `28b3b2a` | 21 | 2 | 0 |  |  |
| openai | [HyeonseoNam/auto-classifier](https://github.com/HyeonseoNam/auto-classifier) | 135 | `edb4727` | 8 | 1 | 1 |  |  |
| openai | [OceanPresentChao/llm-ReAct](https://github.com/OceanPresentChao/llm-ReAct) | 128 | `8e152a6` | 15 | 1 | 0 |  |  |
| openai | [yzh503/obsidian-aicommander-plugin](https://github.com/yzh503/obsidian-aicommander-plugin) | 96 | `4803788` | 4 | 0 | 0 |  |  |
| openai | [sinedied/mini-scraper](https://github.com/sinedied/mini-scraper) | 55 | `ae5e0f9` | 28 | 2 | 0 |  |  |
| openai | [VapiAI/client-sdk-react-native](https://github.com/VapiAI/client-sdk-react-native) | 49 | `1d3b834` | 5 | 0 | 0 |  |  |
| openai | [foyer-work/merlin-node](https://github.com/foyer-work/merlin-node) | 42 | `4c6aa1e` | 9 | 0 | 0 |  |  |
| openai | [Krisseck/Phrasing-Bot](https://github.com/Krisseck/Phrasing-Bot) | 34 | `e03540b` | 13 | 2 | 2 |  |  |
| openai | [wirewirewirewire/payload-ai](https://github.com/wirewirewirewire/payload-ai) | 31 | `78d8680` | 66 | 4 | 4 |  |  |
| openai | [geektutu/7days-geekagent](https://github.com/geektutu/7days-geekagent) | 30 | `280bbb0` | 175 | 36 | 36 |  |  |
| anthropic | [jackwener/open-antigravity](https://github.com/jackwener/open-antigravity) | 208 | `fab7583` | 10 | 3 | 3 |  |  |
| anthropic | [khaledh/pagemagic](https://github.com/khaledh/pagemagic) | 159 | `3f2caac` | 6 | 4 | 4 |  |  |
| anthropic | [kristianfreeman/cloudflare-retrieval-augmented-generation-example](https://github.com/kristianfreeman/cloudflare-retrieval-augmented-generation-example) | 142 | `316d57d` | 1 | 1 | 1 |  |  |
| anthropic | [rubenmarcus/ralph-starter](https://github.com/rubenmarcus/ralph-starter) | 108 | `ee9c794` | 191 | 6 | 4 |  |  |
| anthropic | [pompeii-labs/magma](https://github.com/pompeii-labs/magma) | 99 | `5c5fffe` | 22 | 2 | 0 |  |  |
| anthropic | [Lyt060814/nanocode](https://github.com/Lyt060814/nanocode) | 83 | `6c0a5f8` | 75 | 4 | 0 |  |  |
| anthropic | [iceener/aidevs-agent-cracker](https://github.com/iceener/aidevs-agent-cracker) | 66 | `8305613` | 6 | 1 | 1 |  |  |
| anthropic | [Adamlixi/codenano](https://github.com/Adamlixi/codenano) | 63 | `a32e2a2` | 143 | 4 | 0 |  |  |
| anthropic | [Vijaysingh1621/AI-powererd-interview-Assistant](https://github.com/Vijaysingh1621/AI-powererd-interview-Assistant) | 50 | `eb24d0d` | 63 | 1 | 1 |  |  |
| anthropic | [garden-md/garden-md](https://github.com/garden-md/garden-md) | 43 | `2d940cc` | 21 | 4 | 1 |  |  |
| anthropic | [1runcacu/openclaude](https://github.com/1runcacu/openclaude) | 36 | `d7a5f7d` | 28 | 17 | 13 |  |  |
| anthropic | [kleneway/forq-cli](https://github.com/kleneway/forq-cli) | 29 | `20397d0` | 33 | 3 | 3 |  |  |
| anthropic | [heyitsnoah/obsidian-tools](https://github.com/heyitsnoah/obsidian-tools) | 28 | `7bc0fb7` | 28 | 2 | 0 |  |  |
| anthropic | [snarktank/code-editing-agent](https://github.com/snarktank/code-editing-agent) | 24 | `d400693` | 16 | 6 | 1 |  |  |
| anthropic | [adolfousier/neura-spark-listener-chatbot-ui](https://github.com/adolfousier/neura-spark-listener-chatbot-ui) | 22 | `39ac7df` | 97 | 3 | 0 |  |  |
| stripe | [wevm/curl.md](https://github.com/wevm/curl.md) | 290 | `72bab6a` | 224 | 18 | 0 |  |  |
| stripe | [RubricLab/maige](https://github.com/RubricLab/maige) | 104 | `f785a27` | 188 | 2 | 0 |  |  |
| stripe | [samarbadriddin0v/google-drive-clone](https://github.com/samarbadriddin0v/google-drive-clone) | 104 | `42b3a16` | 61 | 7 | 7 |  |  |
| stripe | [brendansudol/punchlines-ai](https://github.com/brendansudol/punchlines-ai) | 60 | `0933854` | 71 | 6 | 6 |  |  |
| stripe | [LucasKlemke/doctor-reborn](https://github.com/LucasKlemke/doctor-reborn) | 30 | `8a870fd` | 53 | 3 | 3 |  |  |
| stripe | [Shivamrai15/Safari](https://github.com/Shivamrai15/Safari) | 25 | `d97e431` | 361 | 6 | 6 |  |  |
| stripe | [openshiporg/openfront-restaurant](https://github.com/openshiporg/openfront-restaurant) | 24 | `284bc5a` | 644 | 15 | 0 |  |  |
| stripe | [un/srm](https://github.com/un/srm) | 21 | `42c06d4` | 11 | 17 | 0 |  |  |
| stripe | [kpirabaharan/Spotify-Clone](https://github.com/kpirabaharan/Spotify-Clone) | 18 | `ca169ff` | 74 | 6 | 6 |  |  |
| stripe | [deifos/picturemeai_nextjs](https://github.com/deifos/picturemeai_nextjs) | 15 | `b8350df` | 113 | 4 | 4 |  |  |
| stripe | [sagar2535/e-commerce-admin](https://github.com/sagar2535/e-commerce-admin) | 14 | `ece8370` | 114 | 2 | 2 |  |  |
| stripe | [ahmedaliofficial/latest-nestjs-stripe](https://github.com/ahmedaliofficial/latest-nestjs-stripe) | 12 | `039c281` | 14 | 9 | 0 |  |  |
| stripe | [CiphersLab/SaaSPilot](https://github.com/CiphersLab/SaaSPilot) | 12 | `41bc80f` | 153 | 3 | 3 |  |  |
| stripe | [grepsoft/thelibrary](https://github.com/grepsoft/thelibrary) | 12 | `801ce84` | 115 | 2 | 2 |  |  |
| stripe | [boristenkes/shop.co](https://github.com/boristenkes/shop.co) | 10 | `2c8697c` | 284 | 6 | 6 |  |  |

## Examples of each miss reason

### `factory-call`

- `ai.chat.completions.create` in jamonholmgren/flame `src/ai/openai/openai.ts:59`
- `ai.embeddings.create` in jamonholmgren/flame `src/ai/openai/openai.ts:126`
- `openai.chat.completions.create` in jamonholmgren/flame `src/commands/experimental/convert.ts:118`
- `client.models.list` in sinedied/mini-scraper `src/ai.ts:59`

### `parameter`

- `openai.chat.completions.create` in miikkaylisiurunen/raycast-ai-openrouter-proxy `src/controllers/api.ts:75`
- `client.chat.completions.create` in sinedied/mini-scraper `src/ai.ts:33`
- `client.messages.stream` in Adamlixi/codenano `src/provider.ts:119`
- `client.messages.create` in Adamlixi/codenano `src/provider.ts:246`

### `class-field`

- `this.groq.audio.transcriptions.create` in i-am-alice/3rd-devs `audio/OpenAIService.ts:134`
- `this.groq.audio.transcriptions.create` in i-am-alice/3rd-devs `audio-map/OpenAIService.ts:134`
- `this.groq.audio.transcriptions.create` in i-am-alice/3rd-devs `mindmap/OpenAIService.ts:139`
- `this.groq.audio.transcriptions.create` in i-am-alice/3rd-devs `notes/OpenAIService.ts:137`

### `direct-client-not-traced`

- `client.chat.complete` in i-am-alice/3rd-devs `recognize_pixtral/app.ts:17`
- `client.messages.create` in rubenmarcus/ralph-starter `src/loop/agents/anthropic-sdk.ts:229`
- `client.messages.create` in Lyt060814/nanocode `src/core/agent.ts:275`
- `anthropic.messages.batches.results` in 1runcacu/openclaude `examples/batch-results.ts:15`

### `object-property`

- `client.chat.completions.create` in garden-md/garden-md `src/lib/ai.ts:69`
- `client.chat.completions.create` in garden-md/garden-md `src/lib/ai.ts:87`
- `client.chat.completions.create` in garden-md/garden-md `src/lib/ai.ts:105`
- `this.openaiClient.chat.completions.create` in 1runcacu/openclaude `src/adapters/claude-adapter.ts:278`

### `inline-factory-call`

- `getAnthropic().messages.create` in heyitsnoah/obsidian-tools `app/api/notes/diffs/summarize/route.tsx:15`
- `stripeClient().customers.create` in wevm/curl.md `src/lib/stripe.test.ts:42`
- `stripeClient().paymentIntents.create` in wevm/curl.md `src/lib/stripe.test.ts:47`
- `stripeClient().customers.create` in wevm/curl.md `src/lib/stripe.test.ts:90`

### `other-variable`

- `anthropic.messages.create` in pompeii-labs/magma `src/providers/anthropic.ts:237`
- `anthropic.messages.create` in pompeii-labs/magma `src/providers/anthropic.ts:445`

### `destructured`

- `client.messages.create` in Adamlixi/codenano `src/memory/extractor.ts:158`
- `client.messages.create` in Adamlixi/codenano `src/memory/forked-extractor.ts:125`

### `path-alias-import`

- `stripe.webhooks.constructEvent` in RubricLab/maige `app/api/webhook/stripe/route.ts:23`

## Excluded call sites

59 calls matched an SDK resource name but neither the file imports the SDK nor the receiver name suggests a client (for example `db.customers.create`). They are excluded from coverage.

