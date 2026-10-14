# Plan: guard AI patches against substituted fields

Status: **proposed, not implemented.**

## Problem

The [first AI migration evaluation](AI-EVALS.md) showed that when a response field is removed and nothing safely replaces it, Refit's AI invents a migration in 48 of 63 attempts. The most common invention, 30 of the 48, swaps in a field the response already had:

```js
return model.owned_by.toLowerCase();   // before: owned_by was removed
return model.id.toLowerCase();         // AI "migration": returns the model's name as its owner
```

The instructions already forbid this, and in most of these attempts the model's own summary admits the replacement is unproven. The prompt alone isn't a reliable control, so the check has to live in code.

## Rules

The guard must tell two cases apart. It must **not** ban pre-existing fields outright, because the verified Stripe migration legitimately reads one.

| | Example | Verdict |
|---|---|---|
| A pre-existing response field used **as a substitute** for the removed field, meaning the value the code returns or uses in its place | `model.owned_by.toLowerCase()` → `model.id.toLowerCase()` | **Block** |
| A pre-existing field passed **as an argument to a traced SDK call** that fetches the replacement data | `intent.charges.data` → `(await stripe.charges.list({ payment_intent: intent.id })).data` | **Allow** |

Precisely:

1. A replacement **may** read fields that were **added** in the after contract.
2. A replacement **may** read **pre-existing** fields only **inside the arguments of a traced SDK call**.
3. Anything else that newly reads a different pre-existing field of the affected response is **rejected with a clear reason**, the same way other invalid AI edits are rejected today (`PipelineInputError`, as for overlapping edits or out-of-scope files).

"Pre-existing" means present in the before contract's schema and still present in the after contract. The removed field itself is handled by the existing rescan, not by this guard.

## What the analyzer already provides, and the one gap

The guard needs no new data-flow tracing. Verified against the Stripe fixture:

| Need | Source | Status |
|---|---|---|
| Fields of the affected schema, before and after | `before.schemas` / `after.schemas` (already passed to `proposeAiPatch`) | ✅ exists |
| Which fields were added | `findAddedProperties()` in `specifications.ts` | ✅ exists |
| Reads of **any** field on a traced response, with file, line and column | `analyzeRepository()` with one synthetic `Removal` per schema field. On the patched Stripe fixture this reports `intent.id` at `billing.ts:7:55` | ✅ exists, reused as-is |
| Traced SDK calls, with call-start location | `analyzeRepository().sdkCalls`. It reports `stripe.charges.list` at `billing.ts:7:17` | ✅ exists |
| **Argument range** of each traced SDK call | not exposed | ❌ **gap**: re-parse the patched file with the TypeScript API, find the `CallExpression` starting at each `sdkCalls` location, and use its `arguments` text range |

## How the check works

It runs inside `proposeAiPatch()` (`pipeline/ai-patches.ts`), after the edits are validated and applied to the in-memory `modified` repository, which already happens there, and before the proposal is returned.

For each affected schema and each edited file:

1. Run `analyzeRepository()` on the **original** and the **patched** file, with synthetic changes covering every pre-existing field of the schema.
2. For each read, decide whether it lies inside the argument range of a traced SDK call (from `sdkCalls` plus the re-parse above).
3. For each pre-existing field, count reads **outside** SDK call arguments in the original and in the patched file. If the patched count is higher, the AI introduced a substitute. Reject with, for example:
   > `AI replacement substitutes pre-existing field Model.id for removed Model.owned_by in src/client.js:12. Pre-existing fields may only be passed as arguments to SDK calls.`

Comparing counts rather than positions keeps unrelated existing reads from triggering it, such as the untouched `return model.id` in another function, and it is unaffected by line shifts.

**Where a rejection goes:**
- `refit run`: the run ends with the existing error path and saves the evidence, as other rejected AI edits do today. No checks run and no PR is published.
- **AI repair** (`validation.ts`): the existing `catch` records `repair-error` and stops.
- **Evaluations:** the harness records a new `rejected` outcome. It counts as a pass on decline and ambiguous cases, and as a **false positive** on fix cases.

## Files to change

| File | Change |
|---|---|
| `pipeline/ai-patches.ts` | Add the guard after edits are applied, and throw `PipelineInputError` with the field, file and line |
| `pipeline/ai-patches.test.ts` | Add the four required tests below |
| `pipeline/ai-eval.ts`, `pipeline/ai-eval-cli.ts` | Add the `rejected` outcome and a report column |
| `docs/AI-EVALS.md` | Add the new outcome and the before/after results |

## Required tests

1. **The verified Stripe charges migration passes:** `intent.charges.data` → `(await stripe.charges.list({ payment_intent: intent.id })).data` is accepted (`intent.id` is inside a traced SDK call argument).
2. **`owned_by` → `owner_name` passes:** `owner_name` was added in the after contract.
3. **`owned_by` → `id` is rejected**, and the error names `id`.
4. **A pre-existing field outside an SDK call argument is rejected,** for example `String(model.id)` or `` `${model.object}` ``. Wrapping it in a non-SDK call such as `String()` doesn't make it an SDK argument.

The full suite, typecheck and the 128 eval-case checks must still pass.

## Expected impact, measured against the October 14 results

Applying these exact rules to the recorded patches:

| | Count |
|---|---|
| Invented migrations blocked | **30 of 48** |
| Correct fixes wrongly blocked (false positives) | **0 of 72** |

**Not covered by these rules: 18 invented migrations.** These are listed so the remaining risk is explicit:

| Pattern | Count | Why the rules allow it |
|---|---|---|
| Uses an **added** field of a different type, e.g. `String(model.owned_details)` for a removed string | 11 | Rule 1 allows any added field |
| Uses an **added** string field with unrelated meaning, e.g. `model.region` | 4 | Rule 1 allows any added field. Only meaning distinguishes it |
| Keeps reading the removed field behind a fallback, e.g. `(model.owned_by ?? '').toLowerCase()` | 3 | Not a substitution of a pre-existing field |

## Optional follow-ups (not in scope unless approved)

- **Type check on added fields:** reject an added field whose declared type differs from the removed field's type. This would have caught the 11 type-mismatch cases.
- **Removed-field fallback:** reject a patch that still reads the removed field in the edited code, since `?? ''` hides the break instead of migrating.
- **Explicit decision:** require the model to return `migrate` or `decline` and name the evidence each edit relies on.
- **Held-out cases:** add evaluation cases on resources and field names not used while tuning, so the gains generalize beyond these 50 cases.

## Verification plan

1. Implement the guard and its four tests, then run the full suite.
2. Rerun the same 50 cases × 3 attempts (about $0.30) and compare against the October 14 baseline: blocked inventions, false positives on fixes, and any change in fix rate.
3. Record the results in `docs/ai-evals/` and update `docs/AI-EVALS.md`.

## Known limitations

- Reads the analyzer cannot trace are invisible to the guard: destructuring (`const { id } = model`), computed access (`model['id']`), or a response passed through helper functions. These already reduce scanner confidence elsewhere.
- "Inside an SDK call argument" doesn't prove the call fetches the *replacement*. It is the boundary the rules define, and the Docker checks and human review remain the final gates.
