---
phase: "02"
slug: "sourced-parameter-stops"
status: verified
threats_open: 0
asvs_level: 1
created: "2026-10-21"
---

# Phase 02 — Security

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| data/model-parameters.json → rule | Committed table widens automation only where it proves acceptance | Provider facts with source URLs |
| Scanned repository → numericLiteral | Request parameter values read from untrusted source | Literals only; anything else stops |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-02-01 | Spoofing | `source`/`defaultSource` URL check | high | mitigate | `new URL` with an exact hostname allow-list, `https:` only, and no credentials or port. Tests cover look-alike and suffix hosts for both fie | closed |
| T-02-02 | Tampering | edits to data/model-parameters.json that silently widen automation | high | mitigate | The whole file is rejected on any error, and `checkedAt` cannot be in the future. The shipped-file test runs in `npm test`. Entries come onl | closed |
| T-02-03 | Tampering | prototype keys in parsed JSON (`__proto__`, `constructor`) | medium | mitigate | `Object.keys` and `Object.hasOwn` with allowed-key lists, never `in` | closed |
| T-02-04 | Information disclosure / terminal injection | CLI error printing | low | mitigate | Each error line goes through `terminalText` | closed |
| T-02-05 | Repudiation | provenance of entries | medium | mitigate | One `source` per entry, plus a `defaultSource` that cites only the default (D-12, D-17). The SUMMARY records each page re-read, with its URL | closed |
| T-02-SC | Tampering | npm/pip/cargo installs | high | mitigate | This plan installs no package. Any install is out of scope and must stop at a blocking human checkpoint | closed |
| T-02-06 | Tampering | parameterVerdict lookup by a property name from user code (`__proto__`, `constructor`) | medium | mitigate | `Object.hasOwn` on `parameters`; unit test for prototype names gives unproven | closed |
| T-02-07 | Elevation of privilege (wrong automated edit) | numericLiteral | high | mitigate | Only a direct (optionally signed) NumericLiteral counts; non-finite values, identifiers, shorthand, strings and expressions stop. Tests cove | closed |
| T-02-08 | Elevation of privilege | precedence of the existing stops | high | mitigate | Table reasons replace only the last sensitive branch; spread, non-text, base-URL, limit and shared-use branches stay in front. The precedenc | closed |
| T-02-09 | Denial of safety (fail open) | table load failure in serve/CLI | high | mitigate | `loadModelParameters` throws. local-service skips model fixes with the existing message, and the CLI exits 1. Nothing falls back to an empty | closed |
| T-02-10 | Tampering | renamed parameters | medium | mitigate | Stop only; the renamed test asserts the source text is unchanged (D-06) | closed |
| T-02-11 | Repudiation / overclaiming | AGENTS.md, DEADLINES.md, READINESS.md | medium | mitigate | Dated, attributed, pending-review wording. The docs state plainly what continues, with no numbers and no live-provider claims | closed |

Evidence (L1 grep, 2026-10-21): official-host allowlist via `new URL` (pipeline/model-parameters.ts:22-60); `Object.hasOwn` lookups (84-190); signed numeric literal only (pipeline/model-retirements.ts:1668); serve skips model fixes on table load failure (pipeline/local-service.ts:361-367); package-lock.json unchanged, package.json adds only the `model-parameters:check` script.

## Accepted Risks Log

No accepted risks.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-21 | 12 | 12 | 0 | secure-phase (L1) |

## Sign-Off

- [x] All threats have a disposition
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set

**Approval:** verified 2026-10-21
