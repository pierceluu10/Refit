# One price table

`shared/prices.ts` is now the only price table. `harness/ledger.ts`, `orchestrator/budget.ts`, `providers/core/model.ts` and `memory/ai.ts` all read it.

Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-05.

| Per million tokens                   | Input | Cache write, 5 min | Cache write, 1 hour | Cache read | Output |
| ------------------------------------ | ----- | ------------------ | ------------------- | ---------- | ------ |
| Opus 5.5                             | $4    | $5                 | $8                  | $0.20      | $20    |
| Sonnet 5.5                           | $2    | $2.50              | $4                  | $0.10      | $10    |
| Haiku 5.5, prompts up to 100k tokens | $0.10 | $0.125             | $0.20               | $0.01      | $0.50  |
| Haiku 5.5, prompts over 100k tokens  | $0.50 | $0.625             | $1                  | $0.05      | $2.50  |

Batch API: 50% off every token rate. Web search: $0.01 a search.

## What was wrong

| Table                     | Sonnet 5.5 cache read | Result      |
| ------------------------- | --------------------- | ----------- |
| `harness/ledger.ts`       | $0.20                 | 2x too high |
| `orchestrator/budget.ts`  | $0.20                 | 2x too high |
| `providers/core/model.ts` | 0.1x of $2, so $0.20  | 2x too high |
| Published page            | $0.10                 |             |

Opus 5.5 and Haiku 5.5 read prices were already right in every table, so the three tables were closer than they looked: the Sonnet read rate was wrong in all three in the same way. The `claude-api` skill's cached table also still says $0.20.

`harness/ledger.ts` also priced Haiku as Opus, and neither it nor `orchestrator/budget.ts` applied Haiku's long-prompt rate. Nothing ran the harness on Haiku, so this changed no past number.

## Were earlier cost numbers affected?

Yes, for spend that came through `harness/ledger.ts`'s live meter, the watchers' Sonnet reads and anything priced by `orchestrator/budget.ts` that used the cache.

Measured on this machine from 223 recorded harness query results (Sonnet 5.5, $21.36 on the Agent SDK's own total):

|             | Tokens     | Cost at $0.10 | Cost at $0.20 |
| ----------- | ---------- | ------------- | ------------- |
| Cache reads | 28,029,910 | $2.80         | $5.61         |

- The SDK's own total implies exactly $0.10 per million, which matches the page. So the SDK was right and our live meter was not.
- A live charge above the SDK's total stays charged (`chargeCumulative`), so the harness part of past reports was overstated. In this sample it was about 13% ($2.80 on $21.36).
- Reports that added up `total_cost_usd` directly were not affected.
- This sample is what's on this machine, not the runs in any named report, so 13% is an estimate of the size, not a correction to any published number. Nothing in `evals/reports/` has been changed.
- The match, inventory and reviewer costs aren't in this sample. Those parts mostly make single calls with few cache reads, so I expect a much smaller effect there, but I didn't measure it.
