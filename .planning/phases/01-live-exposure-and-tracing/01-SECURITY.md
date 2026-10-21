---
phase: "01"
slug: "live-exposure-and-tracing"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-10-21"
---

# Phase 01 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Scanned repository → Refit analyzer | Repository source is read as text and parsed; never executed or installed | Untrusted source code and string literals |
| Refit proposal → reviewer / draft PR | Stop reasons and patches quote repository identifiers and model IDs | Untrusted names rendered in terminal and PR bodies |
| Benchmark checkouts → scripts | Fetched repositories are passed as paths; nothing runs inside them | Untrusted files |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-01-01 | Tampering | literalUse descriptor and prose rules | medium | mitigate | Rules run after the `!model` guard on a published key list; kept-live shapes tested (01-01 SUMMARY) | closed |
| T-01-02 | Denial of service | tokenUses / scanDeadlines | low | accept | Existing read limits in `readRepository`; constant-time parent climbs | closed |
| T-01-03 | Spoofing | printNonLive counts | low | mitigate | Counts are numbers; file places keep `terminalText()` | closed |
| T-01-04 | Tampering | non-text request decisions | high | mitigate | `!request.text` always blocks; shared-literal test asserts stop and null patch | closed |
| T-01-05 | Spoofing | stop reason call names | low | mitigate | Call name in backticks, identifier characters only | closed |
| T-01-06 | Denial of service | catch-all traced calls | low | accept | Calls without an object `model` drop out at `requestObject` | closed |
| T-01-07 | Tampering | valuesOf shared sources | high | mitigate | Only literals proven to reach a traced `model` are edited; shared sources stop | closed |
| T-01-08 | Tampering | functions returning their parameter | high | mitigate | Call-context arguments only; `pick` test | closed |
| T-01-09 | Denial of service | recursive resolver | high | mitigate | Per-request memo, depth 10, budget 2,000 | closed |
| T-01-10 | Tampering | D-09 shared-use check | high | mitigate | Every non-type use must be a reached pass from a non-test request; negative tests | closed |
| T-01-11 | Tampering | by-value helper stop order | medium | mitigate | Stop applied to every terminal after the caller loop; order test | closed |
| T-01-12 | Tampering / DoS | cut traces and fan-out | high | mitigate | Cut trace never edits; bounded sweep (20,000 cap); fan-out and depth tests | closed |
| T-01-13 | Tampering | instance read by spread/destructuring of `this` | medium | accept | Not detectable from named reads; documented limit in docs/DEADLINES.md | closed |
| T-01-14 | Repudiation | AGENTS.md decision record | medium | mitigate | Dated bullet naming the decider and pending owner review; D-09 isolated in 926ccf6 | closed |
| T-01-15 | Spoofing (overclaiming) | docs/DEADLINES.md, docs/READINESS.md | medium | mitigate | Limits listed; readiness checkpoint has no numbers | closed |
| T-01-16 | Elevation of privilege | smoke re-run on fetched repositories | medium | mitigate | Paths passed as arguments; nothing installed or run inside fetched repos | closed |
| T-01-SC | Tampering | package installs | high | mitigate | No package installed (`package.json`/`package-lock.json` unchanged vs origin/main) | closed |

*Status: open · closed · open — below high threshold (non-blocking)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01-01 | T-01-02 | Existing repository read limits bound the scan; new rules add constant work | Otabek Alimov (delegated) | 2026-10-21 |
| AR-01-02 | T-01-06 | Catch-all adds no recursion; calls without a `model` object drop out | Otabek Alimov (delegated) | 2026-10-21 |
| AR-01-03 | T-01-13 | Spread/destructured `this` reads are untraced and documented as a limit; they can only miss, never mis-edit | Otabek Alimov (delegated) | 2026-10-21 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-21 | 17 | 17 | 0 | secure-phase (L1 grep depth: plan register + SUMMARY threat flags + source greps) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-10-21
