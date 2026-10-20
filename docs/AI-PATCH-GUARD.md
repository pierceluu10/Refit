# Plan: guard AI patches against substituted fields

Status: **implemented** in `pipeline/substitution-guard.ts`, called from `proposeAiPatch()`.

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

## Measured impact

A fresh 50 cases × 3 attempts run with the guard enabled (commit `862bbeb`; see [results](ai-evals/2026-10-14-gpt-5.4-mini-guard.md)):

| | Count |
|---|---|
| Invented migrations rejected | **26**, all substituting `id` |
| Invented migrations not caught | 16: 9 added field of a different type, 5 added field with unrelated meaning, 2 removed-field fallbacks. All are outside these rules by design |
| Pre-existing-field substitutions that slipped through | **0** |
| Correct fixes wrongly rejected | **0 of 78** |

The model is non-deterministic, so the rerun produced a different set of inventions than the baseline. The guard caught every one of the kind it targets.

## Optional follow-ups (not in scope unless approved)

- **Type check on added fields:** reject an added field whose declared type differs from the removed field's type. This would have caught the 11 type-mismatch cases.
- **Removed-field fallback:** reject a patch that still reads the removed field in the edited code, since `?? ''` hides the break instead of migrating.
- **Explicit decision:** require the model to return `migrate` or `decline` and name the evidence each edit relies on.
- **Held-out cases:** add evaluation cases on resources and field names not used while tuning, so the gains generalize beyond these 50 cases.

## Phase 2: type check, fallback check, held-out cases

Status: **implemented** (`findUnsafeReplacements()` in `pipeline/substitution-guard.ts`) and measured. Results: tuning 7/63 critical (was 16), held-out 2/42, and no correct fixes rejected in either set. See [AI evaluations](AI-EVALS.md). Target: the 11 remaining invented migrations the rules above allow by design (9 type mismatches and 2 fallbacks in the guard run), with no new false positives.

### Rule 4: an added field must match the removed field's type, unless documented

Reject an AI patch that newly reads an **added** field of the affected response when its declared type differs from the type of every removed field in that schema. Example: `model.owned_by` (string) → `String(model.context_window)` (integer) is rejected with:

> `AI replacement reads added field Model.context_window (integer) in place of removed Model.owned_by (string) in src/client.js:12. Added fields must have the removed field's type unless the contract or a vendor note documents the replacement.`

- **Same mechanism as rules 1–3:** synthetic analyzer changes for each added field, with per-file read counts before and after the patch. The after-contract schemas are already passed to `proposeAiPatch()`.
- **Documented exception:** a real migration can change type, for example `owned_by` (string) → `owner` (object) read as `model.owner.name`. Such a patch is allowed when the added field's after-contract description names the removed field, or an attached vendor note mentions both fields. These are the same evidence sources the PR description cites.
- **Unknown types never block.** If either type is undeclared, the rule doesn't apply.

### Rule 5: no pure fallbacks on the removed field

Reject an AI patch if an edited file still reads a removed field **and the patch introduces no read of an added field**. For example `(model.owned_by ?? '').toLowerCase()` hides the break instead of migrating it.

The analyzer does not trace string-key reads, so rule 5 also checks them directly (October 20). On lines the model wrote, a `Reflect.get(object, 'removed_field')` is rejected when the original code read that field and the enclosing expression reads nothing else from `object`. A version-tolerant webhook read, as the AI instructions ask for, passes: `Reflect.get(session, 'shipping_details') ?? session.collected_information?.shipping_details`, even split across lines. This rule was added after `oMiguelwnl/Borcelle_admin` validated with `Reflect.get(session, "shipping_details") ?? Reflect.get(session, "shipping_details")`, which never reads the new location.

A backward-compatible fallback that reads the new field first is allowed, for example `(file.file_name ?? file.filename).toLowerCase()`. A recorded correct fix does exactly this, and an earlier, broader version of this rule would have blocked it. The rule reuses the rescan `proposeAiPatch()` already runs. It applies only to AI patches; deterministic rules keep their current `unresolvedFindings` reporting.

### Expected impact on the recorded guard run

| | Count |
|---|---|
| Inventions blocked by rule 4 | 9 of 16 |
| Inventions blocked by rule 5 | 2 of 16 |
| Correct fixes that would be blocked | 0 of 75. None reads a different-typed added field. The one that keeps the removed field also reads the new field, so it is allowed |
| Still not caught | 5: an added **string** with unrelated meaning (`region`, `checksum`). Only evidence-citing can address these |

### Held-out evaluation set

Add 34 cases on two **new** resources with **new** field names, using the same 16 scenarios. For example `vectorStores.retrieve` (`VectorStore.name` → `display_name`) and `responses.retrieve` (`Response.model` → `model_name`). `npm run eval:ai` gains `--set tuning|held-out|all` (default `tuning`, today's 50 cases). Rules for using it:
- Tune prompts and rules against `tuning` only.
- Run `held-out` to confirm a change, and don't adjust anything based on its individual failures.
- Report both sets side by side.

### Tests

- Rule 4:
  - `owned_by` → `context_window` (integer) is rejected;
  - `owned_by` → `owner_name` (string) passes;
  - `owned_by` → `owner.name`, where `owner` is an object documented as "Replaces owned_by", passes.
- Rule 5:
  - `(model.owned_by ?? '')` is rejected;
  - `(model.owner_name ?? model.owned_by)` passes;
  - a complete migration passes.
- The verified Stripe charges migration still passes.
- The held-out cases pass the same case-validity checks as the tuning set (break is real, a correct answer exists, the scorer accepts it).

### Measurement and cost

Rerun `tuning` (50 × 3) and `held-out` (34 × 3): about 250 AI requests, roughly **$0.50**. About $0.22 of the current $1 allowance remains, so `REFIT_AI_BUDGET_USD` must be raised to about $2 first.

## Verification plan

1. Implement the guard and its four tests, then run the full suite.
2. Rerun the same 50 cases × 3 attempts (about $0.30) and compare against the October 14 baseline: blocked inventions, false positives on fixes, and any change in fix rate.
3. Record the results in `docs/ai-evals/` and update `docs/AI-EVALS.md`.

## Real-repository adjustments (October 15)

On the 100-repository Stripe benchmark the guard rejected correct, version-tolerant webhook fixes, for two reasons. Both rules were narrowed to what their descriptions above already say:

- **Rules 1–3 count only traced reads.** The guard now ignores same-named reads on receivers the analyzer cannot resolve. Before, an AI fix reading `invoice.parent?.subscription_details?.subscription` was reported as substituting `checkout.session.subscription`, because Checkout Session lost an unrelated field. The rules are about reads of the affected response, which requires a traced receiver.
- **Rule 5 looks only at lines the model wrote.** Removed-field reads elsewhere in an edited file, untouched by the model, are other findings, not a fallback it introduced. A version-tolerant read of the old field through `Reflect.get(object, 'field')` is not a property read, so it is allowed; webhook payloads need it.

The AI also now works on code that already carries the deterministic rule edits, so the guards judge only its own changes. Unit tests and the 244 evaluation-case checks pass. The tuning and held-out AI evaluations were not rerun after this change.

## Known limitations

- Reads the analyzer cannot trace are invisible to the guard: destructuring (`const { id } = model`), computed access (`model['id']`), or a response passed through helper functions. These already reduce scanner confidence elsewhere.
- "Inside an SDK call argument" doesn't prove the call fetches the *replacement*. It is the boundary the rules define, and the Docker checks and human review remain the final gates.
