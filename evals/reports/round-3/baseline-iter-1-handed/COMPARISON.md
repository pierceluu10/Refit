# Refit vs plain Claude

Same model (claude-sonnet-5-5), same tasks, same sandbox and setup. Plain Claude gets one prompt and plain file and shell tools.

## Every task Refit attempted

| Tasks | Refit passes checks | Claude passes checks | Reviewer: Refit looks right | Reviewer: Claude looks right | Refit $/task | Claude $/task |
| ----- | ------------------- | -------------------- | --------------------------- | ---------------------------- | ------------ | ------------- |
| 4     | 4 (100%)            | 3 (75%)              | 1 (25%)                     | 0 (0%)                       | $0.14        | $0.04         |

## Only the tasks Refit verified

| Tasks | Refit passes checks | Claude passes checks | Reviewer: Refit looks right | Reviewer: Claude looks right | Refit $/task | Claude $/task |
| ----- | ------------------- | -------------------- | --------------------------- | ---------------------------- | ------------ | ------------- |
| 3     | 3 (100%)            | 3 (100%)             | 1 (33%)                     | 0 (0%)                       | $0.14        | $0.03         |

Refit verified 3 of 4; plain Claude has no proof-test rule, so "verified" applies to Refit only.

2 more tasks are on repos with no checks of their own, so neither side can pass them; they are listed below, judged only by the reviewer.

| Set              | Repo                        | Change                                                                           | Refit                     | Claude         | Reviewer (Refit / Claude)   |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------- | ------------------------- | -------------- | --------------------------- |
| anthropic-dev-30 | atrueempire/yk              | npm @anthropic-ai/sdk 1.0.0 sends API version 2026-10-21 by default; MessagePara | verified                  | passes checks  | has-concerns / has-concerns |
| anthropic-dev-30 | ducknife/Music_Agent        | npm @anthropic-ai/sdk 1.0.0 sends API version 2026-10-21 by default; MessagePara | verified                  | passes checks  | has-concerns / has-concerns |
| anthropic-dev-30 | rainmana/cursorify          | npm @anthropic-ai/sdk 1.0.0 sends API version 2026-10-21 by default; MessagePara | verified                  | passes checks  | looks-right / has-concerns  |
| anthropic-dev-30 | saxllc/journey-intelligence | npm @anthropic-ai/sdk 1.0.0 sends API version 2026-10-21 by default; MessagePara | verified (no repo checks) | no repo checks | has-concerns / has-concerns |
| anthropic-dev-30 | saxllc/journey-intelligence | claude-sonnet-4-5-20250929 retires on the Claude API Nov 30, 2026; use claude-so | verified (no repo checks) | no repo checks | has-concerns / looks-right  |
| anthropic-dev-30 | swharr/TrailblazerAI        | New Claude API version 2026-10-21 (anthropic-version header); SDKs older than th | needs-review              | checks fail    | has-concerns / has-concerns |
