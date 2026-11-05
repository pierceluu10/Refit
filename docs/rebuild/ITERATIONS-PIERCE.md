# Self-iteration loop, Pierce's lane

The loop for P5. Each round measures a fresh random sample (seed `pierce-p5`, disjoint groups of 16), so a round's score is on repos no earlier fix was tuned against.

**Counted repos:** the green repos in the round 3 screen, 78 after taking out 8 tuned on in P4, then 77 after one more. 47 are excluded in all: 39 not green in that screen, the 8 tuned on, 1 whose commit now returns 404 (`createdbymax/Loopletter-Open-source-email-marketing-platform`). No two repos had the same tree. `meta-dev-60`, `shopify-dev-60` and `stripe-progress-30` have no screen record, so they aren't counted.

**How a round is scored:** an agent reads each repo blind and lists what's really dead, by the list or an official page. It then opens the report and judges every live finding. Recall is really dead items flagged live, unclear or with a fix, out of all really dead items, including providers the list doesn't have. Precision is live lines judged correct, out of live lines judged, after the AI check. These are one agent's readings, and no provider was called to confirm a break.

| Round | Time (UTC)       | Commit scanned | Repos | Dead items | Recall (on the list) | Live judged | Precision | AI check cost                                                                  | Median / max seconds |
| ----- | ---------------- | -------------- | ----- | ---------- | -------------------- | ----------- | --------- | ------------------------------------------------------------------------------ | -------------------- |
| 1     | 2026-11-05 09:58 | `948862f5`     | 16    | 60         | 57% (89%)            | 64          | 48%       | $0.0116 for all 21 repos with unclear hits                                     | 0.15 / 14.6          |
| 2     | 2026-11-05 10:48 | `468423d4`     | 16    | 25         | 52% (81%)            | 37          | 35%       | $0.0185 for all repos with unclear hits                                        | 0.2 / 15.2           |
| 3     | 2026-11-05 11:16 | `ab593087`     | 16    | 118        | 86% (97%)            | 177         | 58%       | $0.0194 for all repos with unclear hits                                        | 0.2 / 16.0           |
| 4     | 2026-11-05 11:44 | `cbc417f6`     | 16    | 95         | 80% (87%)            | 74          | 85%       | $0.0223 for all repos with unclear hits, plus the fix agent's capped test runs | 0.2 / 4.5            |
| 5     | 2026-11-05 12:13 | `d28edf58`     | 13    | 66         | 73% (83%)            | 70          | 74%       | $0.0208 for all repos with unclear hits, plus the fix agent's capped test runs | 0.2 / 4.7            |
| 6     | 2026-11-05 13:58 | `13d0c1d0`     | 13    | 22         | 82% (100%)           | 43          | 42%       | $0.0035 for all 9 repos with unclear hits                                      | 0.1 / 5.2            |
| 7     | 2026-11-05 15:32 | `b52889d3`     | 12    | 29         | 66% (90%)            | 27          | 70%       | $0.0020 for all 6 repos with unclear hits                                      | 0.85 / 7.8           |

## Round 1

**Numbers:** 34 of 60 dead items flagged, 31 of 64 live lines correct, 3 couldn't be told. Both miss the targets (90% and 85%). Time is well under 30 seconds, and repos with no unclear hit make no model call. The check cost was about $0.0005 a repo. All 21 real calls returned a usable answer, the first real test of `dead-check.ts`.

**Top causes, and what changed:**

- **Provider not on the list and its host never named, so dead calls to it went unseen** (22): Added dead-scan-hosts.ts, which finds hosts the code actually calls and names them in unlistedProviders (hints carry the hosts). Added 9 list files from fetched official quotes: twitch, riot, bing-search, monday, toggl, zoom, deepseek, langchain, muapi. Numbers API and Recipe Puppy get only the named host; see unfixed.
- **Packed repo dump (merged or packed representation of a whole repo) read as live source** (16): isPackedDump treats these files as generated, by head text or at least 3 file-path tags in an .xml file. Fixture and test added.
- **Model name in a list that is only displayed, such as UI options or labels, and never reaches an API call** (9): listReach in dead-scan-reach.ts classes a list that is only displayed as catalog. Lists that are returned or passed to a call stay live. The AI check prompt also gains a picker/aggregator/alias paragraph, unverified because no model call was made. Recall guards added.
- **Allowlist or validator that accepts only dead names, previously quieted as a catalog** (2): Place.guardedBy plus onlyDeadNames promotes these to live, with the reason that it only accepts names that are dead. konan GPT_MODEL also became live under this rule, which is correct: every name it accepts is dead.
- **Orphan module that nothing imports, flagged as live** (2): isOrphan moves it to unclear with the reads attached, not clean, so the AI check still sees it. JS only, in a folder, not an entry file, and only in repos with local imports. Three more repos' files moved to unclear on the full rescan; grep found no importers.
- **Local that holds a dead name only as a display value or path label** (2): assignedReach classes it as catalog only when reads exist and all of them are display or label reads. No reads at all says nothing either way, so the finding stays as it was.
- **AI check ruled out a picker that reaches the API, a miss from the check stage** (1): MU-3 list entry gives a plain-code finding. The prompt now says the name is known dead and asks only whether it reaches the API, and details carry a reads block. The AN-1 line stays unclear for the AI, and the prompt effect is unverified because no real call was made.
- **Removal only visible at runtime: a fine-tuned model id read from a job result** (1): OA-1.fine-tuned-2026-10-23 gained an ambiguous regex limited to job reads. An earlier wider regex hit args.fine_tuned_model as a false alarm, so it was narrowed.
- **Client constructed but unused, only shadowed by a same-named parameter** (1): constructedReach classes it as catalog only when a shadowing parameter exists and nothing else reads the client.
- **Python call to a name that is neither defined nor imported, so the code cannot run** (1): unresolvedCall moves it to unclear, only when the file has imports and the callee is not a builtin. It is not removed.
- **Config key under a parent section nothing in the package reads** (1): unreadOwnerReach classes a picker as catalog when an unquoted ancestor key has no reads in the package.
- **Conflicting version pins that all predate the removal, flagged as live** (1): dead-scan-version.ts returns below with the reason that every pin predates the removal. An unversioned dependency's fallback reason now says a fresh install takes the newest, and keeps the existing no installed SDK phrase.

**Not fixed:**

- Numbers API and Recipe Puppy: no official removal statement to quote, so no list entry is possible. Their hosts are named in unlistedProviders only, with no line finding.
- HyperCLOVA: the endpoint comes only from an env var, so no host is visible in the repo. Fixing this from the code would take a repo-specific rule.
- simple-analytics: loaded by a script tag, not an API call. Host detection excludes markup attributes on purpose, because including them would add noise across every repo.
- TW-2.channel-follow-v1 is ambiguous: the version value is not joined to the subscription type in plain code, so it is left to the AI check.
- AI check prompt changes are unverified: no real model call was made under the task constraint. AN-1 in the picker miss still depends on that prompt.
- unlistedProviders picks up some of an app's own domains (e.g. lampbot.io, kognise.dev, miguel07code.dev, docsflow.app). This only adds queue noise and does not affect clean or findings. Removing it generally would need knowing each repo's own domain.

**A skew to read with care:** one repo, `rainmana/cursorify`, gave 25 of the false alarms, most of them from a packed repo dump. So round 1's precision says little about a typical repo.

## Round 2

**Numbers:** 13 of 25 dead items flagged, 13 of 37 live lines correct, 1 couldn't be told. False alarms by repo: UW-Madison-Lee-Lab__TAPE 19, Jmk125__ConstructionDocuments 2, nfindler__playbook-pipeline 1, djnightmare9909/Dungeon-master-OS-WFGY 1, AyeletHillel/fine-tune 1. Recall and precision both fell from round 1, but on a small sample skewed by one repo in each round: this is a no-gain round by the numbers, and it's logged as one.

**Top causes, and what changed:**

- **Reachability: a module nothing that runs imports was classed live. The round 1 orphan rule covered JS only, was one level deep, and counted a same-named package or any word as a mention (services/openai.js, whole of TAPE src/llms).** (11): Extended the orphan rule in dead-scan-reach.ts rather than undoing it. Python modules now use folder and module pairs, so utils/llm no longer holds llms/llm. A package's own imports only count if something running imports it. A main guard counts as a debug block only in a folder whose modules import each other. Top-level calls and **init** always count as running. JS ignores same-named dependencies, URLs and media types, and a nameless module whose relative import can't load holds nothing. Goes to unclear, not catalog. All 11 still need the AI check to rule them out.
- **The provider had no list file, so nothing could match (OpenWeatherMap, Moonshot, Coinbase Pro x2, Slack, Tableau, Azure AD Graph x2, azure-keyvault).** (9): New list files: openweathermap, moonshot, coinbase, slack, tableau, azure-ad-graph and azure-keyvault, each with an official URL, checkedOn 2026-11-05 and a fetched quote. Also added catalog entries and the slackclient package and module. 6 of these 9 now flag live. Tableau and Key Vault are unclear by design: Tableau depends on the target, and Key Vault depends on the installed version.
- **A substring test on a model name was read as a model table, and the AI check then upgraded it to live: any(x in name for x in ("o1","o3","o4")).** (6): checkPlace now classes these as catalog when a loop, comprehension or JS .some/.every only tests each name. A loop or callback that sends the name stays as it was. No AI call is made for these. The AI prompt also now says a test sends nothing.
- **A parameter default was treated as what the code sends, even when every caller passes its own value.** (3): New defaultReach: catalog when every call in the repo passes that parameter by keyword or position, including class **init** through the class name. Stays live with no callers, a call that omits it, *args, **kwargs alone, a bare reference, a package **init** re-export, or a JS export.
- **A local stand-in for an SDK: import cc_anthropic as anthropic, and a Proxy wrapper that doesn't offer generateImages.** (2): New facadeReach and wrapperReach send these to unclear with a reason. The facade also gives the AI check the import line and the stand-in's model lines. A real client, the real SDK under an alias, or a wrapper that names the method stays live.
- **A GraphQL query in a template that opens on a field was read as prose, and would then have gone quiet as a common word in a file that never names GitHub.** (2): isProse now recognises GraphQL selections: ... on Type {, nodes {, or two or more fields in braces, so a Python f-string's {name} stays prose. A selection also skips the common-word quiet path. GH-5 stays ambiguous, so both lines are unclear rather than live.
- **An uncalled function in a script whose own entry point is visible (mainShort).** (1): New uncalledReach: unclear when a top-level function has no reads anywhere and the file starts from another top-level call or a main guard. Exports, decorated functions and files with no start of their own are untouched.
- **An app-local table key matched an alias of a dead id, while the request line sends the full id (aiHandler.js:31).** (1): A walked table key becomes catalog when the same file holds a different non-key string for the same entry. The request line stays reported on its own, and a key beside only other keys stays unclear.
- **An old @actions/cache bundled inside an action, invisible to a package.json match (setup-python@v3 with cache: pip).** (1): Added a regex to GH-6.toolkit-cache for setup-python@v2/v3, setup-node@v2 and setup-java@v2 with a cache: input in the same step. The tags came from reading each action's package.json at that tag. This is a list rule for those tags only, not general resolution of what an action bundles.

**Not fixed:**

- AI check not exercised: no real model call was allowed. 14 of the 24 false alarms are now unclear with a clear reason (11 orphans, 2 stand-ins, 1 uncalled function), and whether Haiku rules them out is unproven. Its rule is still that unsure means live, so some could come back as live. The other 10 are settled by plain code as catalog.
- index.html:513 gemini-3-pro-preview: the AI check can only answer live or not, so it can't express that the list entry itself is unsure the id still fails. Fixing it needs a third verdict or a change to what live means, which I left alone. The verdict isn't proven wrong.
- aiHandler.js:234 Opus reason naming the Sonnet id: this got a prompt line only (name the item's own id). It can't be confirmed without a real call.
- JS orphans through an importer that loads stay one level deep: an existing test requires a module imported only by a leaf module to stay live, and I didn't edit it. Only an importer with a broken relative import is discounted, so TAPE-style chains are caught in Python but not in JS when the importer loads.
- Third-party actions bundling an old @actions/cache can't be resolved from repo text. Only the tags I checked are listed, and SHA pins can't be matched.
- clean: true with a named unlisted provider is unchanged. The regression clones must stay clean while naming unlisted providers, so these still read as clean. A dead product at an unlisted host only surfaces once it has a list entry.
- Tableau password sign-in stays unclear rather than live: it depends on Cloud versus on-premise Server, and no live sign-in was tried. azure-keyvault stays unclear when unpinned, because no wheel was opened.
- jasper reads at GitHubV4IssueClient.ts:421 and 426 stay quiet as a common word in a file that never names GitHub. They weren't listed as misses, and the query lines now carry the finding.

## Round 3

**Numbers:** 102 of 118 dead items flagged, 102 of 177 live lines correct, 16 couldn't be told. False alarms by repo: bicalhobim__ia.rt_bim 64, liamstamper__lamp-bot 5, nicuk__docsflow 3, adeojoemmanuel/EDD-Kafka-Rest-Api 1, kousalyaChintha__InfiniteCode 1. A committed virtualenv in one repo gave 56 of the 75 false alarms. Round 3's gain partly reflects a sample with more on-list findings, so don't read it as all from the fixes.

**Top causes, and what changed:**

- **Committed virtualenv (Lib/site-packages) scanned as app code** (56): site-packages and dist-packages added to the walk's skipped folders (inventory/repo-files.ts). bicalhobim went from 15.3 s to 0.1 s, and app.py's own Assistants calls stay flagged.
- **Whop has no list file, so @whop/api GraphQL calls match nothing** (9): New dead-apis/data/whop.json. WH-1.public-graphql has a regex for the 41 operations in Whop's guide on a whop-named client, plus a URL matcher; verifyUserToken and @whop/sdk methods don't match. WH-2.api-v2 sits in future, starting 2026-11-13. Also added a general rule: a Convex function nothing in the repo calls goes to unclear (5 notification and auth lines). All 9 misses are live.
- **Backup copies of an entry point treated as running code** (8): backupReach: a name with a bkp, bak, backup, old, orig or copy mark, an original beside it, and no other file naming it is catalog. Imported backups, backups with no original and names like gold.js stay live.
- **OpenRouter has no list file, and its routes retire with no notice** (4): New dead-apis/data/openrouter.json with 12 slugs, each confirmed that day as empty /endpoints and absent from /api/v1/models. Quote is the fetched text; diedOn is the probe date, following muapi. A docs/ folder a vercel, netlify or firebase config serves now counts as running code, which reaches docs/script.js. A list under a table key the code never reads is catalog, so the 4 unread keys in nicuk don't become new false alarms.
- **The list matched only dated Claude 3 ids, so undated names had no matcher** (3): Added claude-3-opus, claude-3-sonnet and claude-3-haiku as ambiguous matchers with a new additive bare flag (shared/types.ts, dead-apis/match.ts), so anthropic/claude-3-haiku stays out and tinypivot keeps exactly 3. These land as unclear, not live, because the undated name is a reading; the AI check settles them.
- **`x.y || 'literal'` classed live though y always has its own default** (2): fallbackReach sends it to unclear and shows the line that sets the default as a read. Environment left sides and left sides with no default elsewhere stay live. This also moved 3 kousalya gpt-4 fallback lines from live to unclear; the gpt-4 default itself stays live at Index.jsx.
- **Display label of an option record counted as a second live use** (2): label added to DISPLAY_KEY, so it is catalog. The record's value stays live.
- **Model id copied into the app's own usage record counted as sent** (1): bookkeepingReach: an argument under a save, record, track or log call ending in usage, cost, tokens or similar is catalog. The real call two lines up stays live.
- **Request body sent to an /api path no route serves** (1): missingRouteReach compares fetch('/api/...') with Next.js app and pages routes, including dynamic and catch-all segments, and goes to unclear. It stays off when next.config has rewrites or the repo has no routes.
- **File imports a name its module doesn't export, so it can't load (adeojo)** (1): brokenImportReach sends the file to unclear when a relative named import's module never mentions the name. The other half of the hand-check's reasoning, a service no deploy config starts, is not detected.
- **Existing rule 'a parameter default every caller overrides is catalog' bailed on any package **init** re-export** (1): defaultReach now ignores the re-export when the repo has no setup.py or pyproject and a caller sits outside the package folder. Published packages and packages with no outside caller keep their old result. An existing test covers that case and still passes unedited.
- **Existing orphan rule was defeated: a same-named twin module matched by path tail, and a dynamic-load check matched the folder name 'ai' inside any word** (1): With a same-named module present, a JS module counts as imported only if a quoted path resolves to it. The dynamic-load check now needs the folder as a path part. Result is unclear, as the orphan rule intends.
- **String inside an object member or plain-class method nothing calls** (1): uncalledMemberReach goes to unclear for members of `= {` objects and classes with no base. Returned objects such as Vite plugins, subclasses and members passed to framework calls stay live.
- **List read only inside `if (x)` where `const x = false`** (1): deadBranchReach makes both that list and code directly inside such a branch catalog. let, true, computed flags and any read outside the guard stay live. This also stops the AI check's wrong upgrade, since a catalog line is never sent to it.

**Not fixed:**

- 6 of the 19 non-venv false alarms are now unclear, not catalog: adeojo chat.service.ts:18, kousalya LeftPanel.jsx:158, lamp-bot AIConfigurationClient.tsx:686 and :1249, nicuk lib-frontend/ai/providers.ts:34 and lib/ai/providers.ts:107. Their reasons and reads say why they may not run, but the AI check could still upgrade them. Not tested, because no model call was allowed.
- AI check reasoning from absence: the four z.enum upgrades in vadik88888-prog/beauty-saas ('an admin can pick') need the check to see the dropdown. No rule shows that, and a prompt change can't be measured without a model call, so dead-check.ts is untouched.
- A service no deploy config starts, or routes no root app mounts (adeojo): this needs per-repo knowledge of how a monorepo deploys. Only the typo'd import half is a rule.
- lamp-bot's handler whose only button is commented out: JSX reachability has no general rule. The missing-route rule catches this line for a different reason.
- OpenRouter's catalog changes with no notice feed. The file holds only slugs seen in this sample, and being listed takes openrouter off the unlisted queue, so a new retirement stays invisible until someone re-probes. It needs a periodic diff of /api/v1/models in the refresh, which is outside this task.
- Known real miss, kept by the brief: anthropic/claude-3-haiku and google/gemini-2.0-flash-001 also have zero OpenRouter endpoints. I left those and other gateway-shaped ids out of the file because tinypivot must keep exactly 3 Anthropic findings, and the same shape is used by other gateways. So tinypivot's api/ai-proxy.ts:103 and unified-handler.ts:214 are dead but not flagged by the OpenRouter list.
- nicuk lib/query-complexity-classifier.ts:296 and :298 are newly live via OR-1. They go into a recommendedModel field nothing appears to read, so these are likely new false alarms. Current rules treat a holder nothing reads as no evidence.
- The Whop regex needs 'whop' in the client's name, so `sdk.users.getUser` on an @whop/api client is missed. A wider root would catch unrelated SDKs.
- The false-guard rule covers only JS `const x = false` with `if (x) {`, not Python or ternaries. It carries a shortcut comment in the code.

## Round 4

**Numbers:** 76 of 95 dead items flagged, 63 of 74 live lines correct, 0 couldn't be told. False alarms by repo: swharr/TrailblazerAI 10, Anassarwar14/Chat-Nest-AI 1. One repo gave 10 of the 11 false alarms. Precision met 85% on this sample for the first time, at 63 of 74, with no finding left uncertain.

**Top causes, and what changed:**

- **Misses: a model record fed into a picker was classed as a catalog (`{ id, name }` lists mapped into a select), so its values never reached live** (10): Added `recordPicker` in inventory/dead-scan-reach.ts, used by classify in dead-scan.ts: a record list that a local picker renders or that a picker prop receives now continues as a picker instead of catalog. It fired 27 times across the repos. JS/TS only. Fixture atrueempire__yk and tests added.
- **Misses: the provider had no list file (Mistral 2+, Perplexity, Hugging Face SDK default host, Bitpanda exchange host, youtube-transcript-api static methods)** (8): New dead-apis/data files: mistral.json (MI-1._, MI-2._), perplexity.json (PX-1..4, all bare), huggingface.json (HF-1.*), bitpanda.json (BP-1), youtube-transcript-api.json (YT-1), plus catalog entries. Added additive `sdkUntil` to shared/types.ts and to the version gate for old-SDK-only deaths. Each entry has a source URL, checkedOn 2026-11-05 and a fetched quote. HF and Bitpanda sourcing is weak: see unfixed. Fixtures atrueempire__yk, MRwangqi__chatGPT-nodejs, Brettjo77__YTAstroAssistant and provinzio__CoinTaxman added. YouTube comes out unclear because >=0.6.2 can install either side; the AI check made it live.
- **False alarms: an allow-list test of a model name in swharr route.ts:37,40,41,42 was flagged even though other branches use their own model** (4): Tried a prompt sentence plus table-name reads, then added caller reads, measuring both on swharr. The AI still said live for all, so both were reverted and dead-check.ts is back to HEAD. Only Anthropic's branch passes `model`, so separating them needs per-branch flow in one repo, and a deterministic rule would also hide the 4 true Anthropic lines.
- **False alarms: the fallback in a controlled `<Select value={saved || x}>` was read as a sent value, though the kept value is what's used** (2): `controlledValueReach` in inventory/dead-scan-reach.ts makes it catalog. admin/page.tsx:579 and 747 are now catalog. Fixture swharr__TrailblazerAI and tests added.
- **False alarms: an option's visible label was read as its value (`o1 Mini` matching OA-1.o1)** (2): `holdsOptionTag` in inventory/dead-scan-place.ts: a JSX tag with `value=` makes its text only a label. The wrong OA-1.o1 at admin:678/679 is gone. Those lines still flag correctly as OA-1.o1-mini, because their value= is o1-mini, so the line count there doesn't drop.
- **Miss: an SDK method hides the dead endpoint, so OpenAI 3.x `createCompletion`-era calls named no URL** (1): Regex matchers added to OA-3.v1-engines, edits, fine-tunes, search, classifications and answers in openai.json. Method names were verified from the openai@3.1.0 dist, and the receiver must be openai-named. Fixture MRwangqi__chatGPT-nodejs added.
- **False alarm: a model name on a usage record beside token counts (swharr sample-analysis/page.tsx:157) is display data** (1): Built `usageRecordReach`, then deleted it along with its test and fixture. It fired on this one line in all the repos, so it was a one-repo rule. The line is live again.
- **False alarm: an option in swharr analyze/page.tsx:403 (gemini-pro-vision) is rejected by the server's own allow-list** (1): No rule: one line in one repo, and the same cross-file allow-list problem as the 4 above.
- **False alarm: Anassarwar14 route.ts:50 `modelName` is a storage-key label inside a template** (1): No rule: grep found this shape only once in the repos.

**Not fixed:**

- swharr route.ts:37,40,41,42 (4 false alarms): allow-list values. Two measured prompt attempts failed and were reverted. Needs per-branch flow, and a deterministic rule would hide true Anthropic lines.
- swharr sample-analysis/page.tsx:157 (1 false alarm): usage record display data. The rule was built and then deleted because it fired on one line only.
- swharr analyze/page.tsx:403 gemini-pro-vision (1 false alarm): server allow-list rejects it; one line in one repo.
- Anassarwar14 route.ts:50 modelName storage-key label (1 false alarm): the shape appears once in the repos.
- mailerlite: URL inside an inline loader string is not treated as called. DuckDuckGo favicon proxy held under avatarUrl is a picture, not an API call, so it stays unqueued.
- Perplexity sonar-small-_/sonar-medium-_ in atrueempire__yk: no removal notice in the fetched changelog, so not listed. Those ids are not flagged.
- Hugging Face: Python huggingface_hub's old default host is not covered, and listing huggingface removes it from the unlisted queue. Sourcing is a forum post quoting the error (diedOn is the post date); no docs page states the retirement. The orchestrator may want to strike it.
- Bitpanda: sourcing is our own probe date (muapi precedent) plus the successor's docs quote, with no retirement notice. The orchestrator may want to strike it.
- OpenAI method regex needs an openai-named receiver, so `api.listEngines()` is missed. recordPicker doesn't follow default-export record lists and is JS/TS only.
- AI check at swharr admin/page.tsx:676: on the final --check run it ruled out OA-1.o1 as a label list, though `value="o1"` is a real option. This is a miss-direction error by the model. I did not change the prompt for it because that prompt already says options count.

## Round 5

**Numbers:** 48 of 66 dead items flagged, 52 of 70 live lines correct, 0 couldn't be told. False alarms by repo: mohammadpurl__next-livekit-streaming 6, Pittawat2542/null-shot-prompting 5, XDTerminated__t2-chat-t3c-2025 4, PRIYESHSINGH24/buddy_connect 1, lissettecarlr/chat-openai-streamlit 1. Both numbers fell from round 4, and recall has now dropped twice in a row, so this is a no-gain round. Across all 77 repos, each scored once by the code as it stood then, recall is 273 of 364 (75%) and precision 261 of 422 (62%).

**Top causes, and what changed:**

- **Model records in a selector table were not followed through a table of lists and barrel re-exports to the picker that offers them (XDT models.ts lines 52, 59, 66, 77, 116, 123, 130, 137, 144, 151)** (10): recordPicker now follows named barrel re-exports and a list gathered into a table (leadsTo, gatheredInto, offeredAs in dead-scan-reach.ts). The AI wrongly ruled offered rows out in some runs, so a row users pick now skips the 'ambiguous' doubt, and skips the 'file names only another provider' doubt unless the name is in a gateway's vendor/name form. All 10 lines are live in the plain scan. Guards: a table that is never offered stays catalog.
- **No list entry for a dead API: Anthropic Skills display_title, OpenRouter ids that return 404, Cloud Functions Node 18, NVIDIA llama-3.3-70b-instruct, HeyGen streaming REST and SDK (upload_skills.py:46,66; models.ts:84,98; functions/package.json:13; smartdoc route.ts:169; heygen-token route.ts:8; useStreamingAvatarSession.ts:130)** (8): Added AN-8.skills-fields, OR-2.anthropic-claude-4-sonnet, OR-2.deepseek-deepseek-r1-qwen3-8b, new google-cloud-functions.json (GC-1, GC-2), new nvidia.json (NV-1), new heygen.json (HG-1, HG-2), each with a fetched official quote and checkedOn 2026-11-05. NV-1, HG-1 and HG-2 are live in the scan. The AN-8 and GC-1 lines are unclear in the scan and the AI check ruled them live. The AWS Lambda spelling nodejs18.x does not match GC-1, and a test covers that. Fixtures and tests added for each.
- **A module under Next.js app/ that nothing imports was treated as a served entry, because the folder counted as a route (mohammadpurl app/openai-assistant.ts:22, 26, 30, 39, 45, 52)** (6): isImportedModule now treats a non-served file under a Next package's app/ as a module waiting for an importer. page, route and layout files stay entries. The scan says unclear and the AI check ruled all 6 not live in the 2 runs measured, while app/api/chat/route.ts stays live.
- **A Python enum value that is only a label, mapped to the real id by a case arm elsewhere (Pittawat types.py:5, 6, 14)** (3): New enumLabelReach marks it catalog when a `case "x": ...model... =` arm elsewhere maps it to another id. The ablation shows it affects only these 3 lines across all repos.
- **A parameter default that is never sent: the body ignores it, or every caller passes its own (XDT gemini-api.ts:39, google-gemini-api.ts:15, lissettecarlr chat.py:9)** (3): New ignoredDefaultReach marks a default the function body never reads as catalog, and defaultReach no longer counts a mention inside a prose string as a read. Empty and one-line bodies are left alone, so an existing test that pins `def f(model=...): pass` as live still holds.
- **A constant read only by a switch arm that no caller reaches with that value (Pittawat config.py:17, 18)** (2): Needs value tracking across callers. See the unfixed list.
- **A method whose only calls are on another class with the same method name (XDT gemini-api.ts:46)** (1): uncalledMemberReach now resolves the receiver's `new K()`. If every call lands on a different class, the line is catalog. An inheriting class, or a receiver it can't resolve, leaves it live, with tests. This was first unclear, but the AI said live in every run, so it became a scan rule.
- **The AI check upgraded a Twilio in-window reply because it could not see the helper's callers or the list's exclusion (elnazar index.js:39)** (1): Items now carry 'Counts as a hit' from the entry's lookFor, and a call inside a function gets its callers' reads (holderReads, callerReads). TW-10 lookFor now says a send from the inbound handler back to the sender is excluded. Lines 39, 40 and 48 came back `not` in all 4 measured runs. Reasons now also answer the scan's stated doubt on version ranges. A prompt sentence on orphan modules added this round was reverted: 4 measured runs showed no reliable gain, and on XDT the model wrongly ruled out selector rows in one of them.
- **Unlisted provider Jira was never named** (1): Added a jira entry to catalog.ts (npm, python, atlassian.net) so AIspect names it. Nothing dead is listed for it. This case comes from the unlisted notes and is not one of the 36 counted cases.
- **A queue worker whose producer has no callers (buddy_connect lib/ai-client.ts:34)** (1): Needs queue semantics for one line. See the unfixed list.
- **A switch return that an earlier routing branch diverts (XDT model-helpers.ts:55)** (1): Needs control-flow analysis for one line. See the unfixed list.

**Not fixed:**

- Pittawat config.py:17,18 (false alarm, still live): the constant is read by a switch arm that no caller reaches with that value. Fixing it needs value tracking across callers, and a narrower rule would only serve this repo. The same GE-2.gemini-pro finding is real elsewhere in the repo, so the fix target stays right.
- buddy_connect lib/ai-client.ts:34 (false alarm, still live): a queue worker whose producer has no callers. It needs queue semantics, and a rule would serve one line in one repo.
- XDT model-helpers.ts:55 (false alarm, still live): a switch return that earlier routing diverts. It needs control-flow analysis for one line.
- Pittawat PaLM text-bison-001 and chat-bison-001 (unlisted): no entry, because I could not fetch an official quote. ai.google.dev/palm_docs/deprecation returns 404, ai.google.dev/api/palm redirects to a 404, the deprecations and changelog pages don't name them, and the API needs a key. I only had a search summary, which doesn't meet the fetched-quote rule.
- An open SDK range stays unclear rather than live (AN-2 in AIspect, AN-8 in rosscrooke, per the AI check notes), because the existing test at dead-scan.test.ts:109 pins it and may not be edited just to pass. The reason now says a fresh install takes the newest version, and the AI ruled those lines live. Its AIspect wording still sometimes says only 'may' or 'unproven'.
- HeyGen has no fetched shutdown date, so diedOn in heygen.json is the check date (2026-11-05). The quotes prove the REST route is gone (404) and the SDK is deprecated, not when that happened.
- AI noise remains on orphan modules: Jmk125 services/openai.js:69 came back live once and catalog twice across the last 3 runs. Removing the prompt sentence didn't settle it, and a code gate there would go against the AGENTS.md rule that the AI decides.
- Not checked with the AI after the final patch: MU-2 records in benlamiro models.js (lines 2138, 2140, 4030, 4032) are ruled live with 'can't be ruled out'. They are ambiguous rows with no caller shown, which looks like a false alarm. It was not in this round's hand-check, so I left it for the next one.

## Round 6

**Numbers:** 18 of 22 dead items flagged, 18 of 43 live lines correct, 3 couldn't be told. False alarms by repo: chandandadhekar/ListAI-V2 5, mssalemi__b-is-for-bundles 4, polidario__weeklyhow-remix-app 3, sanjeev744__smart-bundle 3, Priyadharshini29-M/Combo-page-app 2. Fresh repos from a new screen: 13 counted (Meta 3, Shopify 10, Stripe 0). One more, AdReplica, was left out because the other lane tuned on it. Shopify's app template skews this round: 22 of its 25 false alarms are Shopify version-pin lines, most from that template. Most of these repos' green is a bundler build alone.

**Top causes, and what changed:**

- **An exported version constant nothing reads, repeating the pin** (9): assignedReach also sees bare values like ApiVersion.X: catalog if no file reads it and the package is not published, unclear if it is the only hit on that entry. Exported strings stay live, because two existing tests lock that.
- **A [webhooks] api_version in an app toml with no subscription under it** (8): catalog when the file declares no subscription and the code registers none: 6 of the 8. The 2 whose code calls registerWebhooks stay unclear with that doubt in the reason. Shopify's docs conflict on whether the setting applies to those, so the check isn't told to rule them out.
- **Dev tool config treated as a runtime pin** (2): .graphqlrc*, graphql.config.* and codegen files with generates are catalog.
- **REST resources import with no REST use** (2): catalog when the template import is only passed to shopifyApp and nothing reads .rest or rest.resources. The other lane's tungbinzzz case still flags.

**Not fixed:**

- A pin in a repo with no Admin traffic behind it (subscription-sync): the pin is still worth a fix, so it stays flagged.
- A file under routes/ that is not a route (ListAI-V2), and an unused constants file (wp-module-facebook): one-repo rules.
- MG-8 id-shape upgrade by the AI check (wp-module-facebook).
- The 4 recall misses on Shopify GraphQL (Customer.ordersCount, Order.financialStatus, LineItem.weight, productVariantUpdate): the list has no entry and the scan does not read the schema. Needs a schema diff per version. For 3 of the 4, the hand-check could only source that the field is absent, not when it was removed.

## Round 7

**Numbers:** 19 of 29 dead items flagged, 19 of 27 live lines correct, 0 couldn't be told. False alarms by repo: alistairmartin__honey-birdette-checkout-amd 4, Shamrock2245__shamrock-bail-portal-site 2, ogSulem__pulse 2. Fresh repos from a second screen: 12 counted (Meta 6, Shopify 5, Stripe 1). Three more green repos were left out because the other lane had already used them. This round scored the code after the review's fixes. One repo, Shamrock2245, holds 5 of the 10 misses.

**Top causes, and what changed:**

- **Provider or name not on the list** (8): Added after this round, so not measured: mongodb-data-api, cerebras, linkedin, google-search, google-maps-javascript, a Bing sitemap entry and an OpenRouter id, each with a quote read on an official page. X v1.1 media upload stays out: the only page is future tense and the endpoint still answers.
- **The AI check upgrades on the pattern alone: unsure means live, so an uncalled module or an archive folder comes back live** (6): Left as is. Asking the check to rule out more trades recall away, and the brief says unsure means live.
- **A shell command in package.json scripts read as prose** (1): scripts values are not prose, and template holes no longer count as words when judging prose. Also not measured.

**Not fixed:**

- A template URL in a connector catalog (voiceify MG-1.v19.0) stays catalog, though a user can install it.
- old-scripts/ and reference files with no deploy path are flagged. A folder-name rule would hide real code that happens to live in a folder called legacy.
- A test script outside a test path (server/scripts/smoke.mjs), and a display string in a provider table (image.js): one-repo rules.

## Why the loop stopped

The targets aren't met, and the stop rule applies: rounds 5, 6 and 7 each failed to beat round 4 on both recall and precision.

| Target                                             | Result                                                                                             | Met? |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---- |
| At least 90% of really dead items found            | 75% across all rounds (310 of 415); 66% in round 7, the last. 90% in round 7 for items on the list | No   |
| At least 85% line precision                        | 61% across all rounds (298 of 492); 70% in round 7. Only round 4 reached 85%                       | No   |
| Under 30 s a repo                                  | Slowest in rounds 6 and 7: 7.8 s                                                                   | Yes  |
| $0 of model spend on repos with no unclear matches | No model call on those repos                                                                       | Yes  |

These are small samples, each with a different mix of providers, and one or two repos move each round a lot. Treat them as a range, not a trend.

**What's blocking the targets:**

- **Recall is mostly a list problem.** In round 7, 8 of the 10 misses were on providers or names the list didn't have, and each round brings different ones. Reading the queue helps, but only a person's check keeps it true: 2 of 24 proposed matcher sets were usable. What would help most is a scheduled read of more providers, plus diffing provider model lists (OpenRouter's has no notice feed).
- **Shopify GraphQL fields.** 4 misses in round 6 need the schema at each version. The list only names a few removals, and the scan doesn't read selections.
- **Precision is limited by the AI check's rule.** Unsure means live, so the check rarely rules anything out: in rounds 6 and 7 it moved 26 of 28 unclear findings to live and ruled out 2. An uncalled module or an archive folder then counts as a false alarm. Loosening it trades recall away, so that's a founder call.
- **Reach.** A plain scan can't always tell whether a file runs. That's why the check exists.

**Not measured:** the entries and the prose fix added after round 7. There are no fresh repos scored against them, and they were written from round 7's misses, so rescoring those repos would flatter them.
