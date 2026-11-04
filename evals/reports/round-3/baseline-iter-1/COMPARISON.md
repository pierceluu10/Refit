# Refit vs plain Claude

Both start from the repo alone, in the same sandbox with the same setup. Refit runs its whole pipeline; plain Claude (claude-sonnet-5-5) gets one prompt and plain file, shell and web tools, and finds the changes itself. A blind judge (claude-opus-5-5) reads both diffs as A and B, in an order fixed per repo.

|                                                    | Refit        | Plain Claude |
| -------------------------------------------------- | ------------ | ------------ |
| Judge prefers                                      | 3 of 5 (60%) | 2 of 5 (40%) |
| Ties                                               | 0            | 0            |
| API changes handled correctly / handled            | 16 / 22      | 11 / 12      |
| Things broken or changed without need              | 17           | 0            |
| Repo's own checks pass (changed repos with checks) | 4 of 4       | 4 of 4       |
| Changed a repo with no checks of its own           | 1            | 1            |
| Changed nothing                                    | 0            | 0            |
| Cost of the fix per repo                           | $0.75        | $0.12        |

5 repos. Refit's cost is inventory, watch, match and harness; memory learning and the advisory review are left out. The judge cost $0.49.

| Set             | Repo                                                     | Refit                                             | Claude                       | Judge  | Why                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------- | ------------------------------------------------- | ---------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gemini-dev-15   | djnightmare9909/Dungeon-master-OS-WFGY                   | 7 tasks, 7 verified, checks passes, $1.10         | checks passes, $0.13         | refit  | B covers more of the changes that actually matter: the embedding retirement, the pro-preview removal, the sampling-parameter deprecation and the 3.5-flash supersession. A explicitly skipped the sampling and SDK checks. A |
| longtail-dev-20 | LeviathanLevi/Coinbase-Pro-Crypto-Trading-Bot-CrypFinder | 4 tasks, 4 verified, checks no-repo-checks, $0.59 | checks no-repo-checks, $0.09 | refit  | Both make the same correct required migration from Pro to Exchange hosts. B also finds two further changes to endpoints the repo calls: the transfer response body and portfolio-isolation 403/404 on /profiles. It handles  |
| openai-dev-30   | AyeletHillel/fine-tune                                   | 3 tasks, 3 verified, checks passes, $0.41         | checks passes, $0.09         | claude | B picks a base model that is documented as fine-tunable, keeps the change minimal and documents the access restrictions correctly. A picks a model of uncertain fine-tunability and adds a wrapper that mislabels ordinary 4 |
| openai-dev-30   | hachanimohamedsaid/backend_AgentAi                       | 4 tasks, 4 verified, checks passes, $1.04         | checks passes, $0.22         | claude | A handles the Gemini 2.0 Flash shutdown that B misses, and that shutdown is already breaking the Gemini paths. Both migrate the realtime service and the gpt-4o-mini defaults comparably. B adds an unrequired SDK major bum |
| openai-dev-30   | mohammadpurl/next-livekit-streaming                      | 4 tasks, 2 verified, checks passes, $0.63         | checks passes, $0.07         | refit  | A handles four OpenAI changes the code is affected by: the model retirement, the SDK v7 / Node 22 requirement, the Assistants-to-Responses migration and the whisper-1 retirement. B makes the same Assistants migration but |
