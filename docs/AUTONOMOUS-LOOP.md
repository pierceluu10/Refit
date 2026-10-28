# Refit's autonomous loop

Written 2026-10-28.

**Founder decision (Otabek, 2026-10-28):** Refit spots new issues, fixes them, tests the fixes and opens validated PRs without human intervention. The only humans involved are the people reviewing the PRs Refit opens. Nothing waits on a founder.

## The loop

1. **Spot.** Every stop, refusal and failure gets a stable signature: stage, reason, change id, error code. Signatures are recorded in a store that persists across runs (`data/learning/`). A signature Refit hasn't seen before is marked new and counted.
2. **Fix.** For a code problem, AI repair writes the fix (founder decisions of 2026-10-28: AI may repair build-breaking patches and build on rule edits, with no per-repo AI limit). For a setup problem, the AI may propose an install recipe for the sandbox only: Node version, flags, a lockfile repair. Recipes never touch the customer's repository.
3. **Prove.** The same checks as everywhere, at proof levels A–C (`docs/PROOF-BASED-VALIDATION.md`). Level D, nothing proven, never opens a validated PR. It stays a [Needs review] PR stating plainly what is unproven.
4. **Open the PR.** A validated fix opens a PR through the GitHub App as usual. The PR says what changed, why, and the proof behind it.
5. **Learn.** A fix that is proven and then merged, or proven at level A or B, becomes a **candidate rule**:
   - the pattern of the change: from what, to what, and in which call or field;
   - the Stripe documentation it relies on, quoted;
   - the evidence: run, repo and proof level.
6. **Promote automatically.** A candidate becomes a live rule, used deterministically with no AI, when all of these hold:
   - it was proven correct on at least 3 different repositories, not counting blind sets;
   - it passes `npm run rules:check`;
   - no evidence contradicts it.

   Promotion is a commit to the rule store, with its provenance.

7. **Roll back automatically.** A live learned rule is demoted at once, and every open PR it produced is flagged, when either of these happens:
   - a PR it produced is reverted, closed as wrong, or fails CI after merge;
   - a later run shows it causing a check failure.

   One wrong result is enough.

## Safety without a person

- **Proof is the gate:** no proof, no validated PR. AI patches with proof count, as decided.
- **Learned rules are promoted only on evidence across several repositories, and demoted on a single failure.**
- **Payment behaviour never changes silently.** Refit copies what the code sends, and never switches payment-method lists to dynamic or invents values.
- **The blind sets** (`progress-30`, and any frozen final set) are never learned from.
- Everything is recorded: signature, fix, proof, promotion and rollback, so a founder can audit after the fact without approving anything first.

## Measuring it

- New signatures seen, fixed and proven per run.
- Learned rules: promoted and rolled back.
- Wrong-fix rate, which must stay 0.
- The unseen-set score over time. With the loop working, each new set should start higher than the last.
