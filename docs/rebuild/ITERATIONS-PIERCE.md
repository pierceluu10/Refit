# Self-iteration loop, Pierce's lane

The loop for P5. Each round measures a fresh random sample (seed `pierce-p5`, disjoint groups of 16), so a round's score is on repos no earlier fix was tuned against.

**Counted repos:** the green repos in the round 3 screen, 78 after taking out 8 tuned on in P4, then 77 after one more. 47 are excluded in all: 39 not green in that screen, the 8 tuned on, 1 whose commit now returns 404 (`createdbymax/Loopletter-Open-source-email-marketing-platform`). No two repos had the same tree. `meta-dev-60`, `shopify-dev-60` and `stripe-progress-30` have no screen record, so they aren't counted.

**How a round is scored:** an agent reads each repo blind and lists what's really dead, by the list or an official page. It then opens the report and judges every live finding. Recall is really dead items flagged live, unclear or with a fix, out of all really dead items, including providers the list doesn't have. Precision is live lines judged correct, out of live lines judged, after the AI check. These are one agent's readings, and no provider was called to confirm a break.

| Round | Time (UTC)       | Commit scanned | Repos | Dead items | Recall (on the list) | Live judged | Precision | AI check cost                              | Median / max seconds |
| ----- | ---------------- | -------------- | ----- | ---------- | -------------------- | ----------- | --------- | ------------------------------------------ | -------------------- |
| 1     | 2026-11-05 09:58 | `948862f5`     | 16    | 60         | 57% (89%)            | 64          | 48%       | $0.0116 for all 21 repos with unclear hits | 0.15 / 14.6          |

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
