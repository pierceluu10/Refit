# Deferred items (phase 03)

- `pipeline/model-retirements.test.ts` > "parameter table: continues for a sourced literal and edits only the model" fails on the branch base (temperature 1 stop for claude-sonnet-5-5). It comes from Phase 2 parameter-table work, not from plan 03-01, which changes no pipeline code. Found 2026-10-21 while running `npm test`.

- Resolved 2026-10-21: the parameter-table test failure came from the worktree branching before Phase 2 commit 9b992fa; after merging final Phase 2 (bb9b370) `pipeline/model-retirements.test.ts` passes 51/51.
