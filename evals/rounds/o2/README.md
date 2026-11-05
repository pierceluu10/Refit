# O2 measurement: one session per repo

Locked before any paid run. `lock.json` was committed first, and `session-run.ts` refuses a lock that doesn't fail at baseline or can't pass on its proof edit.

**Rule:** take the repos the round-3 screen found green with at least one check, leaving out every repo named in `REBUILD-PLAN.md`, `PIERCE.md` or `LIST-TEST.md`. Walk them in order of SHA-256 of `rebuild-green:<lower-cased owner/name>`. Take the first 5 with a live finding, after reading each one.

**Exclusions:**

| Repo            | Reason                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WeWake1/BSOMS` | Its only finding is in `.agent/get-shit-done/`, a vendored tool, not app code. It's a false alarm from the stand-in scanner, so it has no required change. |

**Required changes are my own reading** of the code at the pinned commit against `DEAD-APIS.md`. The locks are static: they show the dead thing is gone and a replacement from the list is there. They can't show that a call works. Each result also gets a hand read.

`R5` on `backend_AgentAi` (`OpenAI-Beta: realtime=v1`) is a real break the stand-in scanner doesn't flag. It stays required, so a scanner miss shows up as a miss.
