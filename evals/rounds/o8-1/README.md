# O8 round 1

Locked before any paid run. It runs the whole product from `rebuild/integration` with `session-run.ts --product`: scan, one session, proof, label, record to memory. No PR opens, because these are public repos we don't own.

**Rule:** from the repos the round-3 screen found green with at least one check, leave out every repo named in the rebuild docs and every repo O2, O3 or O7 used. Walk the rest in order of SHA-256 of `rebuild-green:<lower-cased owner/name>` and take each with a live finding, after reading it.

| Left out         | Reason                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `atrueempire/yk` | Saved for round 2: its 55 findings are mostly a catalog and need a longer read before locking |

These are harder than O2 and O3: an image model that takes a different call, Universal Analytics to GA4 where a secret must come from config, built files tracked next to their source, and an allow-list.

**Scan:** the labelled stand-in, on Pierce's real list (P2), because P4 isn't up. **Memory:** starts empty for this round.

**No-match cost:** `no-match.json` holds 3 clean repos from the same screen, to confirm a clean repo stops at $0.

**Exclusions after the run:** a repo whose baseline turns out red in this run is reported but doesn't count.
