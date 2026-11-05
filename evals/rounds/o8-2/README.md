# O8 round 2

Locked before any paid run. Same product run as round 1. This round adds the Stripe field breaks, which are the hard kind: a version gate, values read through casts, and webhook payloads that can arrive in either shape.

**Rule:** the repos of `stripe-progress-30` with a live finding, in set order, that pass their own checks once the planner has run, plus the two repos round 1 left for this round (`atrueempire/yk`, `0-CYBERDYNE-SYSTEMS-0/quorum`).

| Left out                                                     | Reason                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `webrenew/unicon`                                            | Its `build` fails at baseline: pnpm says `node_modules` is out of sync. |
| `twaldin/trade-up-bot`                                       | A test fails at baseline.                                               |
| `noa10/mataresit`                                            | A test fails at baseline.                                               |
| `jackstonemedia/StoneAIOMainSystem`                          | Used in O7, and its baseline is red.                                    |
| `Shards-foundation/shards-workflow-hub`                      | Its `test` script finds no test files, so it fails at baseline.         |
| `camster91/ashbi-platform`, `CarlosReyes0/mon-unlock-widget` | Red at baseline in the $0 screen.                                       |

**Stripe locks:** the required change is that the sole read of the removed field is gone. The list's `requires` line asks for a fallback for older webhook payloads, so keeping the old field as a fallback passes. Quality is left to the hand read.

**Quiet repos:** `quiet.json` holds 2 repos that already read both the old and new Stripe shapes. The scan flags them, so a good session leaves them alone. They check false alarms and cost, and have no required change.
