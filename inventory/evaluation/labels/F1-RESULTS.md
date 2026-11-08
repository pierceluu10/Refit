# F1 results, 2026-11-08

Measured against `f1-labels.json` (written by hand before any Refit output was read) with `f1-score.ts`. Code: `mvp` at f67cbaaf ("before") and the five lane branches merged together ("after", local only). Model: Sonnet 5.5 for inventory and watchers, as `mvp` configures them. Every cost below is the run budget's own ledger.

## What was run, and what was not

- **Full scans** (`f1-scan.ts`, the same path as `refit scan`): the three demo repos once (run 1, cold watch cache), and demo-node-api and demo-python-app a second time (run 2, same UTC day, so the watchers came from run 1's daily cache, as they would in production).
- **Inventory only** (`inventory/cli.ts --dependencies`): the five upgrade-dev-20 repos (the first five in the set's own hash order), once on "before" and once on "after", then "after" again on the same commits.
- **Not run**: full scans of the five upgrade-dev-20 repos (about $1.30 to $2.80 a scan put them past the night's $12 cap), a second "before" inventory of them, and a full "after" scan. Their finding labels are committed and unscored.
- **CI baselines**: no repo has a failing test run at its pinned commit (see `rules.ci` in the labels). Most have no run there, so their baseline is unknown, not passing.

## Full scans, before (run 1)

| repo            | cost      | inventory recall | inventory precision | finding recall  | finding precision | open rows | duplicate rows | deadlines right | errors |
| --------------- | --------- | ---------------- | ------------------- | --------------- | ----------------- | --------- | -------------- | --------------- | ------ |
| demo-node-api   | $1.67     | 6/7              | 92%                 | 5/5             | 95%               | 19        | 11             | 4/5             | 8      |
| demo-python-app | $1.36     | 4/4              | 100%                | 3/3             | 93%               | 29        | 21             | 3/3             | 9      |
| demo-next-web   | $2.77     | 11/11            | 94%                 | 3/6             | 100%              | 72        | 68             | 3/3             | 12     |
| **all**         | **$5.80** | **95%**          | **94%**             | **11/14 = 79%** | **98%**           | 120       | **100**        | 10/11           | 29     |

- demo-next-web's external match hit its 16k output-token limit on 69 changes three times and failed, so every change stayed open unmatched: the three rule findings (cookie consent, accessibility, PCI DSS 6.4.3 scripts) were never matched, and 68 of 72 rows are duplicates.
- The one wrong deadline: Lambda `nodejs16.x` dated 2027-07-29 (when creating functions is blocked) instead of its 2024-06-12 deprecation. Pytest and stripe majors also carried their release dates as deadlines on rows the labels count as acceptable (F4).
- Spend for demo-node-api: match call $0.42, regulations read $0.31 (once a day for all repos), inventory $0.15, rules match $0.11, 10 dependency watchers $0.60, five of them for the same thing under a second name.

## Run to run (demo-node-api and demo-python-app)

|                                        | run 1                                   | run 2                   |
| -------------------------------------- | --------------------------------------- | ----------------------- |
| cost                                   | $3.03                                   | $1.44 (watchers cached) |
| inventory recall                       | 10/11                                   | 10/11                   |
| inventory precision                    | 95%                                     | 85%                     |
| finding recall                         | 8/8                                     | 8/8                     |
| finding precision                      | 94%                                     | 93%                     |
| duplicate rows                         | 32 of 48                                | 27 of 43                |
| deadlines right                        | 7/8                                     | 8/8                     |
| dependency names in both runs / either | demo-node-api 6/16, demo-python-app 7/8 |                         |

The required findings are stable. The names are not: demo-node-api's Kubernetes Ingress, Lambda and node base image came back under different names, which is also why its inventory precision moved.

## Inventory only, upgrade-dev-20 (five repos)

|                                        | before | after                                                                   | after, same commits again |
| -------------------------------------- | ------ | ----------------------------------------------------------------------- | ------------------------- |
| dependency-pass cost                   | $0.87  | $0.84                                                                   | $0.00                     |
| recall                                 | 51/51  | 51/51                                                                   | 51/51                     |
| precision                              | 89%    | 90%                                                                     | 90%                       |
| dependency names in both runs / either |        | DCGW 31/41, records-mover 74/97, ddf 26/32, parsers 37/39, capone 16/18 |                           |

`inventory/cli.ts` reports the dependency pass's cost only; inside a scan, both passes together cost $0.11 to $0.15 on the demo repos.

## How to rerun

```
REFIT_AI_BUDGET_USD=<cap> node inventory/evaluation/f1-scan.ts --labels inventory/evaluation/labels/f1-labels.json --repos <dir of owner__name checkouts> --out <dir> --watch-cache <dir>
node inventory/evaluation/f1-score.ts inventory/evaluation/labels/f1-labels.json <run dir> [<second run dir>]
```
