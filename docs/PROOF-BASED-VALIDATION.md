# Proof decides, not caution

Written 2026-10-28.

**Founder decision (Otabek, 2026-10-28):** "needs review" means only one of two things:

1. there is no proof the fix is safe; or
2. Refit found a real Stripe problem it could not fix.

Where a fix has proof, no cautious rule may hold it back. That covers AI-written fixes, and it supersedes decision 8 for fixes with proof.

## Proof levels

| Level | What proves it                                                                                                              | Result       |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ------------ |
| A     | A behaviour test against Stripe test mode reaches every changed Stripe line and passes on the original and the patched code | validated    |
| B     | The repo's own tests run the changed Stripe lines and pass before and after                                                 | validated    |
| C     | The type check covers every changed Stripe line, with no new errors and no new test failures                                | validated    |
| D     | Nothing ran, or nothing reached the changed lines                                                                           | needs review |

A fix with an unresolved, **real** Stripe finding stays "needs review" at any level. A finding is real when the type checker, a traced call or the contract diff ties it to Stripe.

## Rules to change

What held heldout-30 run 40772950934 at `790dd7c7`, `bench/combined-final`:

| Rule                                                    | Repos | Change                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Checks passed but detected findings remain unresolved" |     4 | Clear a finding when the type checker proves its receiver isn't the changed Stripe type (agent R and agent T's tracing). Also clear it when the finding is on a line the fix didn't touch, the read isn't on a Stripe-typed value, and the checks pass. Keep findings the checker ties to Stripe. |
| "No check can run … grade D"                            |     4 | Count a behaviour test at level A (agent B's harness). Grade D stays only when no test reaches the line.                                                                                                                                                                                          |
| AI patch always [Needs review] (decision 8)             |     1 | An AI fix with A–C proof is validated. Without proof it stays held.                                                                                                                                                                                                                               |
| Repo already failing before the fix                     |     1 | Validated when the fix adds no new failures and level A–C proof reaches the changed lines.                                                                                                                                                                                                        |

Other blockers, fixed separately:

- **Dependency setup (3):**
  - the Bun lockfile case that still refuses;
  - fetching public git dependencies at their pinned commit.
- **The StudMed false regression:** agent B's `155b4fdd`.
- **Open-Magiviz:** validated before the merge, now stops on `payment_method_types` with "no reviewed replacement". It is a merge bug to debug.

## Safety

- Wrong fixes are what ends trust. Hand-check every repo this change turns validated, and record verdicts in `docs/benchmarks/fix-reviews.json`. Any wrong one blocks the merge.
- Report validated before and after, with the proof level of each row, so a gain from relaxed rules is visible as such.
- No repo-specific code. No full l2-push-249 runs. Never open progress-30 repos.

## Implemented (feat/proof-validation, 2026-10-28)

| Rule                   | Code                                                                                                                                                                                                           | heldout-30 replay (40772950934, no new run)                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unresolved findings    | `localReceiverReads` takes the analyzer's undecided traced reads too, and proves `sort` comparator elements, `const` tables read by key, receivers behind a cast, and Prisma model delegates (`prisma-client`) | heyzbh, Turbo-Gestor, Safari, devczero: needs-review → validated, grade C, hand-checked `correct`                                                                                                                              |
| No check, grade D      | `no-checks` yields to grade A; the benchmark validates no-check rows with `node -e 0` when behaviour tests are on                                                                                              | AlphaAnimica, bistro-boss, Hairdresser: needs a run (no behaviour test ran); what-now-chaos stays D: its behaviour test failed on the original code because the test account's Managed Payments rejects `payment_method_types` |
| AI patch               | `aiPatchProven`: grade A–C and passing checks drop the `ai-patch` gate                                                                                                                                         | ecommerce-react stays held by `contract-changes` (PaymentIntent `amount` became optional on traced calls the AI left)                                                                                                          |
| Failing before the fix | the failing tests run on the patch; `newTestFailures` compares them                                                                                                                                            | AET-App stays held by `contract-changes`; its new test run needs a benchmark                                                                                                                                                   |

Validated before and after, with each row's proof level: 15 → 19 (every validated row grade C except VishalRaut2106/HackMate_AI, grade A).

## Proof plumbing (feat/p30-proof, 2026-10-28)

Four general fixes found on progress-30 (refit-bench 40791364860), none of them repository-specific:

- **Verbose checks.** A check no longer stops at 1 MiB of output. Each stream keeps its first 64 KiB, its last 192 KiB and, from the middle, every failure or error line (up to 512 KiB), then passing results (up to 192 KiB); the rest is dropped and marked `[Refit omitted N characters of output here]` (`pipeline/check-output.ts`). The exit code and these lines decide the result, so memory stays bounded and the time limit still ends a check that never stops.
- **Suites that fail before any test runs.** Where no test ran on either side (every suite failed while loading or in a setup hook), `newTestFailures` compares the failing suites and the errors they print: the patch adds a failure unless each was printed the same on the original code. A side that names no failure proves nothing.
- **Reads that are not the removed field.** The analyzer no longer flags a removed field's name read through a field the before contract does not declare on a traced object (`invoice.parent?.subscription_details?.subscription` before basil: the object never held `parent`, so nothing read through it is its removed field), and no longer flags an untraced read compared only with a string literal the removed field's enum never held (`body.type === 'v2.core.event'` against `line_item.type`, which held `invoiceitem` or `subscription`): it gives the same result whether the field exists or not. A webhook event's `data.object` stays typed by the webhook tracer.
- **Clients without a version option.** A `new Stripe(key)` whose client Refit cannot follow (returned from a factory, passed to helpers) is read as sending stripe-node's pinned version, so it moves with the upgrade instead of being `api-version-untraced`, when no file names a version option (`apiVersion`, `stripeVersion`), the repository has no escape hatch and the arguments are not spread.

## Meta Graph API (2026-10-29)

Meta patches use the same levels, with the reviewed change table standing in for a contract and read-only calls with Refit's test app for test mode: see [Meta Graph proof](META-GRAPH.md#proof).
