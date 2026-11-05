# Decisions, Otabek's lane

Every choice made overnight without asking, newest last. Times are EST.

| Date       | Task  | Choice                                                                                                                  | Why                                                                                                                                |
| ---------- | ----- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-05 | Setup | Ran at the session's max effort in auto mode; no separate "ultracode" switch exists in this session.                    | The session reports `effort: max`, `model: claude-opus-5-5`, `permissionMode: auto`.                                               |
| 2026-11-05 | O1    | Merged `r3/loop` (#485) and `r3/match-memory` (#484) whole into `rebuild/otabek`. Left `r3/cost` (#483) to Pierce's P4. | Both merge clean and all checks pass. #483 is the inventory, which is Pierce's lane.                                               |
| 2026-11-05 | O1    | Put the one price table in a new file, `shared/prices.ts`.                                                              | `shared/` is the only folder every ledger may import. A new file is additive, so the contract is untouched.                        |
| 2026-11-05 | O1    | Took prices from the live pricing page, not the `claude-api` skill's table.                                             | The brief says use the provider's published prices. The skill's cached table says Sonnet 5.5 reads are $0.20; the page says $0.10. |
| 2026-11-05 | Setup | Paid runs use the Agent SDK on this machine's logged-in Claude credentials, with no `ANTHROPIC_API_KEY`. | A security hook blocks any command that reads `.env`, including `node --env-file`. I did not work around it. The logged-in path needs no secret, and the code already supports it. Costs are the SDK's own estimate, still capped by `APTITUDE_AI_BUDGET_USD`. |
| 2026-11-05 | O2 | `harness/findings.ts` holds a local stub of P1's `DeadApiEntry`, `Finding` and scan result. | P1 isn't pushed. The brief says to start with a stub. |
| 2026-11-05 | O2 | A repo session is one `MigrationTask` with `findings` and `entries` added, not a new type of run. | It reuses the sandbox, baseline, checks, PR body and record, so the diff stays small. |
| 2026-11-05 | O2 | The fix rules sit in the system prompt and name no repo. The list and findings go in the kickoff message. | Tools, then system, then messages is the cache order, so sessions with the same tools share that prefix. |
| 2026-11-05 | O2 | `TURN_RESERVE_USD` drops from $1 to $0.15, with one call's output capped at 12,000 tokens. Opus keeps 3x the reserve. | A $1 reserve would stop every repo under a $1 cap. The stream meter already stops a query as soon as its grant is spent, so the reserve only has to cover one call. |
| 2026-11-05 | O2 | Sonnet at `medium` effort, Opus at `high`. | The Claude API docs recommend starting agentic coding on Sonnet 5.5 at medium. |
| 2026-11-05 | O2 | Opus runs only after a failed check that didn't improve. A crashed session stays on Sonnet. | The brief says Opus only after a failed check. |
| 2026-11-05 | O2 | Install layers cover npm, pnpm and Yarn only, keyed on the owner plus every file that can steer an install. | Saved before any check runs, so a layer is a function of its key. pip installs outside the working copy and bun fetches its own binary, so neither has a layer. |

