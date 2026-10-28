# Making behaviour tests and Stripe test mode work

Written 2026-10-28.

## What happened

On heldout-30 with AI and `--stripe-test-mode` (refit-bench 40744601340, `bf81624d`), the AI test writer (`pipeline/behaviour-test-writer.ts`) ran on 27 repos. **None produced a passing test**, so test mode graded nothing.

| Outcome                      | Repos | Cause                                                                                                                                                                                                                                 |
| ---------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error: `max_output_tokens`   |     5 | The writer's answer was cut off at `MAX_OUTPUT_TOKENS` (`pipeline/openai.ts:61`)                                                                                                                                                      |
| Error: response over 256 KiB |     1 | The download limit in `openai.ts`                                                                                                                                                                                                     |
| Error: timeout               |     1 | The request timed out                                                                                                                                                                                                                 |
| Declined                     |     8 | Every one said the Stripe line can't be reached offline without a database (Prisma, Supabase, Firestore), auth (NextAuth, Kinde, Supabase auth) or a Next.js request context (`cookies()`), or because the Express app isn't exported |
| Refused by Refit             |     3 | "File … cites findings that were not supplied": the writer cited finding ids Refit didn't give it                                                                                                                                     |
| Generated, but not passing   |     6 | Each test failed on the **original** code against test mode: wrong assertions, or the Stripe line "did not run", so the test never reached it                                                                                         |
| Skipped                      |     3 | Setup refused, so there were no dependencies                                                                                                                                                                                          |

## Fixes

1. **Output limits.** Give the test writer its own output budget, well above the shared `MAX_OUTPUT_TOKENS`. Raise the response download limit for writer calls. Retry once with a longer timeout. On `max_output_tokens`, retry and ask for fewer, smaller test files.
2. **Stubs for app dependencies.** The writer may replace app-level dependencies with test doubles, never Stripe itself. A harness Refit provides (`refit-behaviour/harness`) offers ready stubs for:
   - Prisma clients;
   - Supabase clients and auth;
   - NextAuth, Kinde and Clerk sessions;
   - `next/headers` (`cookies()`, `headers()`) and `NextRequest`;
   - Firestore;
   - Express apps that aren't exported, by importing the route handler module.

   It uses Node's module mocking (`node:test` `mock.module`, or a loader hook). The Stripe call itself must run for real against Stripe test mode, with the real stripe-node.

3. **Finding ids.** Hand the writer the exact finding ids, require each test to cite only those, and reject only the bad citation, not the whole file. Fix the mismatch behind the 3 refusals: check whether rule-edit or webhook finding ids are missing from the list the writer gets.
4. **Feedback on the original code.** A test must pass on the original code before it can judge the patch. When it fails there, or the Stripe line doesn't run, send the writer the failure output and the coverage gap, up to 2 rounds. Assertions must come from Stripe test mode's real responses, never be invented.
5. **Count only real evidence.** A behaviour test counts only when it passes on the original code and reaches the changed Stripe line. That rule is already in place; keep it. Report a grade per repo: before → after.

## How to measure

- **Dev set:** heldout-30, already a practice set. Run only its 3 repos with no runnable check plus the ~16 repos that reached the writer, as a subset list, not the full 30. Then the Oct 16 active-teams list if budget allows.
- **Report:**
  - generated, passing on the original, reaching the changed line, catching a regression;
  - repos whose evidence grade went up;
  - AI spend and Stripe test-mode request counts.
- **Hand-check every generated test:**
  - its stubs replace only app code, never Stripe;
  - its assertions match test mode's real responses.
- Founder decisions, 2026-10-28:
  - no per-repo AI limit;
  - AI repairs and adds onto Refit's work.

## Rules

- No full l2-push-249 or heldout-30 runs. Never open progress-30 repos.
- Never stub, mock or intercept Stripe. Only test mode, with Refit's own test key, ever answers Stripe calls.
- No repo-specific stubs: the harness covers libraries, not apps.
- Agent S owns `pipeline/stripe-package-upgrade.ts`, `migration-review.ts` and the repair budget. Agent T owns client tracing. Coordinate through PRs.
