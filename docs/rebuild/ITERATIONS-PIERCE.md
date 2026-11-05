# Self-iteration loop, Pierce's lane

The loop for P5. Each round measures a fresh random sample (seed `pierce-p5`, disjoint groups of 16), so a round's score is on repos no earlier fix was tuned against.

**Counted repos:** the green repos in the round 3 screen, 78 after taking out 8 tuned on in P4, then 77 after one more. 47 are excluded in all: 39 not green in that screen, the 8 tuned on, 1 whose commit now returns 404 (`createdbymax/Loopletter-Open-source-email-marketing-platform`). No two repos had the same tree. `meta-dev-60`, `shopify-dev-60` and `stripe-progress-30` have no screen record, so they aren't counted.

**How a round is scored:** an agent reads each repo blind and lists what's really dead, by the list or an official page. It then opens the report and judges every live finding. Recall is really dead items flagged live, unclear or with a fix, out of all really dead items, including providers the list doesn't have. Precision is live lines judged correct, out of live lines judged, after the AI check. These are one agent's readings, and no provider was called to confirm a break.

| Round | Time (UTC)       | Commit scanned | Repos | Dead items | Recall (on the list) | Live judged | Precision | AI check cost                              | Median / max seconds |
| ----- | ---------------- | -------------- | ----- | ---------- | -------------------- | ----------- | --------- | ------------------------------------------ | -------------------- |
| 1     | 2026-11-05 09:58 | `948862f5`     | 16    | 60         | 57% (89%)            | 64          | 48%       | $0.0116 for all 21 repos with unclear hits | 0.15 / 14.6          |
| 2     | 2026-11-05 10:48 | `468423d4`     | 16    | 25         | 52% (81%)            | 37          | 35%       | $0.0185 for all repos with unclear hits    | 0.2 / 15.2           |

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
