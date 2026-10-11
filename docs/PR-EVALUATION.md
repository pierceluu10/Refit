# Live draft PR evaluation — October 11, 2026

Refit created [draft PR #1](https://github.com/pierceluu10/refit-billing-demo/pull/1) in the private independent billing demo repository through its actual CLI, OpenAI integration, offline Docker validation and GitHub publisher. The PR remains open and draft; it was not merged. The original application checkout remains clean and unmigrated.

## Observed workflow

- Original code passed all 14 tests, TypeScript and the billing CLI demo. The changed API contract caused the expected three history failures.
- The live model (`gpt-5.4-mini-2026-03-17`) initially proposed a single-page Charges list. Both small billing suites passed, but the independent pagination check failed: 10 charges instead of 13.
- Refit sent the failed check evidence for the one permitted repair. The replacement iterates all Charges pages using the existing shared client and preserves the original payment retrieval.
- The repaired candidate passed all 14 unchanged tests under each contract, TypeScript, multi-page history, refund/payment filtering and empty history inside network-disabled Docker containers.
- The publisher verified the remote base, created a migration commit and opened a draft PR modifying only `src/billing/history.ts`. The remote head is `61baeacd695735d5e04e78ec21581ce2c339c465`; its parent/base is `a8ea0428ec7a3f2b90a24e2168791b4dba3e87c2`. No co-author trailer was added.
- A separate download of the GitHub branch passed both suites, TypeScript, the additional history checks under both modes and the billing CLI demo. Its application source matched the validated publication bytes and its test file matched the original.

The full gated Refit regression suite passed **244 tests with none skipped** using the actual published patch. Production build and formatting checks passed.

## Evidence

The ignored local bundle is `dist-cli/billing-pr-evaluation-2026-10-11`. It retains both attempted patches and check results in `report.json`, the final diff in `migration.patch`, the draft description, `publication.json` and an integrity manifest. `node bin/refit.mjs verify --directory dist-cli/billing-pr-evaluation-2026-10-11` verified the seven declared artifacts. This is unsigned consistency evidence, not authentication.

This evaluation uses the real Stripe SDK against an independently authored local HTTP simulator and reduced historical API projections. OpenAI and GitHub requests were live; Stripe requests were simulated. It verifies one supported migration, not general AI reliability, production billing correctness, live Stripe behavior, scheduling or GitHub App onboarding. GitHub Actions were not configured; tests ran locally and inside Docker.
