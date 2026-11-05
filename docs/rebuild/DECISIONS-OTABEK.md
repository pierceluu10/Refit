# Decisions, Otabek's lane

Every choice made overnight without asking, newest last. Times are EST.

| Date       | Task  | Choice                                                                                                                  | Why                                                                                                                                |
| ---------- | ----- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-05 | Setup | Ran at the session's max effort in auto mode; no separate "ultracode" switch exists in this session.                    | The session reports `effort: max`, `model: claude-opus-5-5`, `permissionMode: auto`.                                               |
| 2026-11-05 | O1    | Merged `r3/loop` (#485) and `r3/match-memory` (#484) whole into `rebuild/otabek`. Left `r3/cost` (#483) to Pierce's P4. | Both merge clean and all checks pass. #483 is the inventory, which is Pierce's lane.                                               |
| 2026-11-05 | O1    | Put the one price table in a new file, `shared/prices.ts`.                                                              | `shared/` is the only folder every ledger may import. A new file is additive, so the contract is untouched.                        |
| 2026-11-05 | O1    | Took prices from the live pricing page, not the `claude-api` skill's table.                                             | The brief says use the provider's published prices. The skill's cached table says Sonnet 5.5 reads are $0.20; the page says $0.10. |
