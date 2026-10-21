---
phase: "03"
slug: "application-benchmark-sets"
status: verified
threats_open: 0
asvs_level: 1
created: "2026-10-21"
---

# Phase 03 — Security

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| GitHub API → selector | Repository names, SHAs, paths from code search and GraphQL | Untrusted identifiers, validated before any shell use |
| Fetched checkouts → grep / labelling agents | Read-only text; nothing installed or executed | Untrusted source code |
| Labels → committed JSON | Names, SHAs, paths, lines, models, classifications only | No code text (notes guard) |

## Threat Register

All T-03-01..T-03-17 and T-03-SC from the three plans: closed. Evidence (L1, 2026-10-21): every subprocess uses `execFile` argv arrays (scripts/ai-app-*.mjs); repo-name/SHA/workspace validators with tests; no token read or printed (0 matches for `gh auth token`/`GITHUB_TOKEN`); symlinks skipped and nothing run inside checkouts; `noteLeaksCode` guard rejects code fragments and 20-character source runs (0 failures on the committed labels after 58c5673); labels never derived from Refit output (no `pipeline/` imports in the label scripts); no package installed (package-lock.json unchanged). Code review 03-REVIEW.md had 0 critical; all 5 warnings fixed (03-REVIEW-FIX.md).

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-03-01 | determinism | The frozen lists are reproducible by cache replay, not by a fresh search against GitHub's moving index; documented in the files and BENCHMARKS.md | Otabek Alimov (delegated) | 2026-10-21 |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-21 | 18 | 18 | 0 | secure-phase (L1) |

**Approval:** verified 2026-10-21
