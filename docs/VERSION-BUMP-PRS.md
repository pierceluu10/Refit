# Version-bump PRs for repos the change doesn't touch

Written 2026-10-28.

## The gap

On progress-30, the unseen set, about 7 of 30 repos had all their Stripe calls traced, and none used anything the target API version changed. Refit stops on them with `NO_USAGE_REASON` in `pipeline/workflow.ts`: "No confirmed supported usage was found … no patch or publication was attempted". The customer gets nothing, although the repo is still pinned to an old API version and an old stripe-node.

## The product

For these repos Refit opens a small, checked PR that does two things:

1. **Moves every `apiVersion` pin** to the target version.
2. **Upgrades stripe-node** to the release for that version, in `package.json` and the lockfile.

The PR says, in plain words:

- Refit traced N Stripe calls and none uses anything this version changes.
- The checks (type check and tests) passed before and after.
- The list of traced calls.
- One "please check": webhook endpoints have their own API version in the Stripe dashboard, which this PR does not change.

## Safety gates

A wrong bump is worse than none. The PR is opened only when all of these hold:

| Gate                                                                               | Why                                                                                                              |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Every detected Stripe call is traced (`tracedCalls === sdkCalls`, and more than 0) | An untraced call might use something the version changed. The 6 untraced progress-30 repos stay out.             |
| The full contract diff has no reached or unmapped breaking change                  | "Unaffected" has to come from the contract, not just from finding no rule.                                       |
| The pin and the stripe-node upgrade move together                                  | Moving the pin without the library breaks the type check. That is Agent S's fix A; reuse it, never duplicate it. |
| Baseline and patched checks pass, with no new type errors                          | It's a checked PR or no PR.                                                                                      |
| The scan was complete: no unparseable files, within scan limits                    | A partial scan can't prove "unaffected".                                                                         |

When the checks can't run (setup refused, no runnable check), open nothing and keep today's honest stop.

## Outcome and scoring

- A new outcome, `version-bump`, reported beside `validated`. It counts as validated when its checks pass, because every edit is deterministic.
- The benchmark summary and the bench monitor list it separately, so a gain from bumps is never mixed up with migration fixes.

## How to measure it

- Build a subset of about 15 rows from past l2-push-249 results where `NO_USAGE_REASON` stopped with every call traced. Never use progress-30.
- Run it before and after.
- Hand-check every bump PR.
- No full l2-push-249 or heldout-30 runs.

## Rules

- Founder decisions, 2026-10-28:
  - AI repair may fix a bump that breaks the build, shipped as [Needs review];
  - no per-repo AI limit.
- No repo-specific code; tests written from scratch.
- Agent S owns `pipeline/stripe-package-upgrade.ts` and the pin and SDK pairing. Call it, don't fork it.
