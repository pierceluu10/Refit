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

## Owner policy stops (October 24)

On real repositories the wrong AI patches that validated mostly broke an owner policy, not a contract rule. In the October 21 agent comparison, 7 of 8 validated patches deleted `payment_method_types`. `pipeline/ai-patch-policies.ts` now checks these policies after the model answers and before rules 1–5. A patch that breaks one stops for review. The model gets **no** corrected request, because the policy decides the case, not the model. Each check compares the AI's version of every file it changed with the rules' version, so the rules' own edits, such as the reviewed card rename, are never charged to the AI.

| Policy | Refused when the AI's code… | Real diff it comes from |
|---|---|---|
| Never drop or replace a request parameter | no longer sends a key, nested key, spread, argument or literal value (string, number, boolean or null, also inside arrays) that a traced SDK call sent, or sets one to `undefined`, `void 0` or `null` (also over a spread). The body can be inline, a variable declared in scope with keys assigned to it later, a body a function in the same file returns, or a spread of either. Reordering, reformatting (a reflowed spread too) and added keys pass. A removed parameter moved to its documented replacement (`allowed_payment_method_types`, `marketing_features`, `promotion`) still stops, even with the same value: only the deterministic rules make that move (docs/STRIPE-PAYMENT-METHOD-TYPES.md) | `Bizgojo/drivetimetales` and `geallenboy/ai-saas-template` deleted `payment_method_types`; `Sanjdcool/ApanStack-Newsletter` replaced the expand path `latest_invoice.payment_intent`; `brendansudol/punchlines-ai` deleted it from a returned body |
| No type-only workarounds | has more `any` types, `as unknown as` or `as never` assertions, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `eslint-disable` comments | `kondax-com/Bocker` read `discounts` through `as unknown as { discounts?: unknown[] }` |
| Choosing a subscription item is a reviewed policy | reads a billing period from an item it picks (`items.data[i]`, `.at()`, `.find()`) more often: directly, through a variable holding the item or the list (`const items = s.items.data`, `const { data } = s.items`, `const { items } = s`), by destructuring, string key or `Reflect.get`. Selector calls of the generated helpers and picks are counted separately, so swapping one for the other counts. Other fields read from a picked item pass | `JiantaoFu/insightly` stored `items.data[0]` in a variable and read `current_period_end` from it; `kondax-com/Bocker` read `items.data[0]!.current_period_start` |
| Webhook reads keep both shapes | rewrote a webhook or `declaredType` finding without still reading the removed field from the same receiver (or a variable assigned from it in the edit) by property, string key, `Reflect.get`, destructuring or the generated helper for that field called on it. Every read from deeper in the receiver (`session.collected_information.shipping_details`) must sit in a `??` or `||` with an old-shape read, or under a conditional or `if` whose condition reads it. A dual read inside the code an edit replaces, a rule's helper call or an earlier round's `Reflect.get`, must stay dual too | `abressiddique/AbresStore-Admin` moved `session.shipping_details` to `session.collected_information.shipping_details` only |
| Webhook event names | no longer compares with an event type string the rules' code did | (existing) |
| Tests stay as written | changes a file on the repository's test paths (`TEST_PATH` in `pipeline/source-paths.ts`: `*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/`, fixtures, examples, stories) | `kondax-com/Bocker` and `Sanjdcool/ApanStack-Newsletter` rewrote their tests' Stripe fixtures to the new shape only |
| A rule's edit changes only with its rule | changes or deletes a line the deterministic rules wrote (a line diff from the original code to the rules' code, then from the rules' code to the AI's); a whole-function replacement that repeats the line unchanged passes | the card rename under `Bizgojo/drivetimetales`' deletion; a repair of the shipping helper's calls (`Mangu-Commerce/madcaptees`) |

Package files (`package.json`, lockfiles, `.npmrc`, `.yarnrc*`, `pnpm-workspace.yaml`) are never editable: the model may edit only scanned JavaScript and TypeScript sources with a confirmed finding, and an edit anywhere else is refused as outside its scope. The replay below predates the last two rows and does not run them.

The instructions now state these policies, and the type-error instructions no longer tell the model to remove parameters the new types reject. A first AI patch that is refused ends the run like rules 1–5 (`refit run` saves the evidence, and the AI patch scorer counts it as `review-stop`). A refused repair records `repair-error`, and the Stripe benchmark row carries its reason as `workflow.repairError`. Tests: `pipeline/ai-patch-policies.test.ts` (one per real diff above, and one per form the October 24 review found), `pipeline/ai-patches.test.ts`, and an end-to-end new-shape stop in `pipeline/stripe-webhook-payloads.test.ts`.

### Replay over the recorded agent diffs

`pipeline/ai-patch-eval-replay.ts` runs every guard (these policies and rules 1–5) over a recorded patch without calling a model or running repository code. The rules' stripe-node upgrade reads npm registry metadata, so it needs that access. For each repository it applies Refit's deterministic patch, applies the recorded diff on top, and runs the guards the way `proposeAiPatch()` does. It runs a second time against the original code, which charges the patch with every change it made itself.

Where any hunk of a file conflicts with the rules, the whole file is taken from the original plus the diff. On the rules' code that charges the agent with undoing the rules' edits in that file, so the comparisons below use the original code. Files outside the scanned sources, such as `package.json` and `.mdx` docs, are listed and skipped.

The replay runs the guards alone. It skips the scan's stops and `proposeAiPatch()`'s scope checks (a confirmed finding, and edits only in files with one), which on main stop all 16 wrong patches before any model request. It measures the guards as the last check, not what main would publish. It records the commit it ran at and refuses to run with uncommitted pipeline changes.

The run covers all 17 agent patches recorded on October 21, at their frozen commits (`docs/benchmarks/subsets/p2-agent-replay.json`, results in `docs/benchmarks/2026-10-24-p2-agent-replay-results.json`). These are the 8 that validated:

| Repository | Review verdict | Refused on the rules' code by | Refused on the original code by |
|---|---|---|---|
| `Bizgojo/drivetimetales` | wrong | item choice, dropped parameter, new shape only, substitution | the same |
| `Dvargas005/node-hub` | wrong | dropped parameter | the same |
| `abressiddique/AbresStore-Admin` | wrong | dropped parameter, new shape only | the same |
| `Kanba-co/kanba` | wrong | item choice, dropped parameter, new shape only | the same |
| `iggy-tech/product-hunt-clone-final` | wrong | item choice, dropped parameter | the same |
| `geallenboy/ai-saas-template` | wrong | dropped parameter | the same |
| `utsavkrishnatra/pdf_answers` | wrong | item choice, dropped parameter, new shape only, substitution | the same |
| `sammorrispb/nextgen-academy` | correct | none | none |

All 7 wrong patches are refused. What made each one wrong was the deleted card restriction, and the dropped-parameter guard refuses it in all 7. On the original code, the path it reports is the agent's own deletion of `payment_method_types`. On the rules' code it reports `allowed_payment_method_types` wherever the file came from the original: that is the card rule's rename, which the agent's file undoes, not the agent's own change (8 of the 17 rows).

The other refusals land on edits the reviewer judged right: the first-item period reads in drivetimetales, Kanba, iggy-tech and pdf_answers, and the new-shape-only webhook reads (`invoice.subscription`, `shipping_details`) in drivetimetales, AbresStore, Kanba and pdf_answers. They stop because the owner policies make item choice and webhook shape review decisions, not because the code was wrong. On the rules' code, the new-shape check refuses the agent's replacement of the rules' version-tolerant helper calls in AbresStore, Kanba and pdf_answers (and in punchlines-ai and spotify below). Before the October 24 review it had nothing to check there, because those helper calls are not findings.

The 9 patches that never validated have no October 21 verdict. Each was read in full on October 24, and all 9 are wrong; these labels are recorded here and in `docs/overnight/P2.md`, not in the results file. Six of them (marked †) are held out: no test was built from them before the replay. Two then led to fixes with tests: punchlines-ai (below) and wedillybird (two request bodies with the same name, found in review), so 4 remain untouched.

| Repository | October 21 checks | Wrong because | Refused on the original code by |
|---|---|---|---|
| `kondax-com/Bocker` | not run | every class | event type, item choice, dropped parameter, type escape, new shape only, substitution |
| `JiantaoFu/insightly` | baseline failed | dropped parameter, item choice | item choice, dropped parameter, new shape only |
| `Sanjdcool/ApanStack-Newsletter` | baseline failed | swapped `expand` path, new shape only | dropped parameter, new shape only |
| `inventashif/hackerai` † | not run | deleted `payment_method_types` (2 calls) | dropped parameter |
| `beindigital-products/wedillybird` † | error | deleted `payment_method_types` (4 calls) | dropped parameter |
| `RISHIE2006/Signl` † | baseline failed | deleted `payment_method_types` | dropped parameter |
| `pretzelai/stripe-no-webhooks` † | error | webhook reads in the new shape only, edits to its own SQL and a doc comment | item choice, new shape only, substitution |
| `brendansudol/punchlines-ai` † | regression | deleted `payment_method_types` from a body a helper returns; first-item period reads | item choice, dropped parameter, substitution |
| `mrwebwork/spotify` † | regression | deleted `payment_method_types`; first-item period reads | item choice, dropped parameter |

The held-out six found one gap. punchlines-ai builds its Checkout body in `getSessionCreateParams()` and passes the result to the call. The dropped-parameter check did not follow it, and only an incidental substitution (a new `subscription.id` read in an error message) refused the patch. The check now follows a body that a function in the same file returns, with a test from that diff.

Main's guard (October 24, before these policies) had only the event-type check, a per-edit item-choice check and the substitution guard. On the same 17 diffs, on the original code, it refuses 5 of the 16 wrong patches: 2 of the 7 that validated and 2 of the 6 held out. The policies above refuse all 16, and the correct patch passes both.

The correct patch passes, but the pass proves little. Its call is `getStripe().checkout.sessions.create(...)`, through a cached factory (`let cached: Stripe | null`; `cached = new Stripe(key)`) that the tracer does not follow on current main. So none of the request guards saw it. On main, that repository stops for review on unrelated review-confidence reads, so the AI is not asked there. Nothing catches the untraced call itself. No correct AI diff that the guards can see is recorded. Refit's own correct October 22 fix for `ABHINAVJINDAL26/VANTAGE-Golf-Charity-Platform` was not kept, but [AI patch reliability](AI-PATCH-RELIABILITY.md) describes its two edits: each `(subscription as any).current_period_end` read goes through `getSubscriptionPeriodEnd(subscription)`. A test rebuilds those edits on the real webhook route and checks that the four policies that apply accept them. Its reads come from a retrieved subscription, not a webhook payload, so the dual-shape check has nothing to check, and the substitution guard is not run in that test. Beyond that, the guards' false refusals on real code are measured only by the accepted cases in the tests.

Known gaps:

- A changed non-literal value, such as a different variable, is not compared.
- A body passed to the call through a parameter or an import, filled by `Object.assign` or through an alias of the body is not resolved.
- Type escapes are counted per file and construct, so swapping an existing `any` for a new one in the same file passes.
- An item the AI picks and passes to the app's own function, which reads the period, is not detected.
- A repair that moves a helper call into a separate edit from the reads it feeds stops for review (an over-stop).
- A request through a client the tracer cannot follow, such as the cached factory above, is not checked.
- An invented field the after contract does not define still depends on validation and review.

## Type-only repairs of upgrade-introduced type errors (October 27)

Founders' decision (2026-10-27): type errors the stripe-node upgrade introduces may be repaired by changing types only. Any such repair, deterministic or AI, must pass the type-only gate (`typeOnlyRepairFailures` in `pipeline/ai-patch-policies.ts`):

| Condition | How it is checked |
|---|---|
| Edits only statements that hold an error the upgrade introduced | The type oracle's run of the original code on the target stripe-node lists the upgrade's errors by file, code and message. Each changed range of the rules' code must sit inside one statement that holds such an error. A range between statements, which adds or removes one, is refused, even a new `type` alias. |
| Every changed file compiles to the same JavaScript | `ts.transpileModule` with the compiler options of the nearest `tsconfig.json` in the repository, before and after, compared per file. Only TypeScript files qualify: an assertion in JavaScript is a JSDoc comment, which changes the output. |
| No enums, namespaces or decorators | A changed range that touches one, on either side, is refused, as their output depends on more than the file. |
| Zero new errors and passing checks | The repository's own checks run on the repair in offline Docker. Their type check compares errors with the original code, so a pass is the oracle's zero new errors on the repaired code. |

**Deterministic repair.** `openEnumRepair(…, assertions = true)` in `pipeline/stripe-open-enums.ts` handles TS2322 and TS2345 errors whose message names both types. It wraps the value at the site (a property or variable initializer, a returned or assigned value, or a call argument) as `(value as Target)`, where `Target` is the type the message names. It runs only where the file can write `Target`: literals, primitives, and names the file declares or imports. It never drops `null` or `undefined` that the value's type has, so a value Stripe now types as possibly missing still stops. It is generic (owner decision D5): it reads only the error and the file. It runs after the existing open-enum restore, and only on errors the oracle attributes to the upgrade. A repair that passes the gate and the checks publishes like any rules' patch (`repair.stopReason: type-assertion-repair`, `repair.typeAssertions`), and the draft names each site and says the JavaScript is unchanged.

**AI fallback.** When every error left on a candidate is one the upgrade introduced, the AI repair is held to the same gate before its checks run. A repair that fails the gate stops for review (`repair.typeOnlyGate`), and one that passes ships `[Needs review]` with its lines marked (decision 8). AI repairs of other errors are unchanged.

**What stops.** Removed properties and methods, removed or unknown request parameters, arity changes, untraced API-version literals, null widening, targets the file cannot name, and every error in JavaScript. These were most of the errors the type oracle recorded on l2-push-249 (run 40591181316): 79 errors on 12 rows, of which only the 4 `Subscription.Status` assignments on kondax-com/Bocker have the widened-enum shape, and that row has 31 other errors.

## Known limitations

- Reads the analyzer cannot trace are invisible to the guard: destructuring (`const { id } = model`), computed access (`model['id']`), or a response passed through helper functions. These already reduce scanner confidence elsewhere.
- "Inside an SDK call argument" doesn't prove the call fetches the *replacement*. It is the boundary the rules define, and the Docker checks and human review remain the final gates.
