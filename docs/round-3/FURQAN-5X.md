# L3: cost (Furqan, 5x, a quarter of the work)

Read [`README.md`](README.md) first.

- **Branch:** `r3/cost`.
- **Folders:** `inventory/`, `providers/core/` and the watch-cache lines in `orchestrator/deps.ts`.
- **No benchmarks.**
  - Test with fixtures and recorded responses.
  - You may make a few real reads to prove the cache and the scan work, logged with their cost.
- Push every commit, because L1 merges your branch at the start of each iteration.
- Open your draft PR into `main` early, and read L1's comments on it.

## Deliverables

1. **Changelog read: once per provider per day, shared by every repo and every run.**
   - The watch cache already exists in `orchestrator/deps.ts`. Make it persist across processes and runs: one cache file per provider per UTC day, keyed by provider and hints.
   - Every run and benchmark shard reuses it.
   - A read that ended early (on budget, turns or a model error) is never cached. This is F4's `onReport` note.
   - Add a way to refresh a day's read on purpose.
   - Report the cost per repo as the read's cost divided by the repos that used it.
2. **Inventory: deterministic first, AI only for what the scan can't explain.**
   - Scan these with ordinary code:
     - manifests: `package.json`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Gemfile` and others;
     - lockfiles;
     - imports;
     - API hosts in the code.
   - For a clear SDK or host hit, build the `ApiUsage` from the scan with no AI call.
   - Hand the agent only what the scan can't settle: raw HTTP with no SDK, wrappers, generated clients, or unknown hosts. Give it the scan as evidence.
   - Per `AGENTS.md`, the scan must never be the only way to find usage, and nothing is silently dropped.
   - Cache the inventory by repo commit, so an unchanged repo costs $0 the next time.
   - **Measure it:** run the old and new inventory on the round 2 repos' recorded inputs, and report the cost and the usages found. The new one must find everything the old one found.

## Ending

By 12:00:

- push;
- update your draft PR body with the measured cost before and after, what was tested and what's left;
- answer every L1 comment.
