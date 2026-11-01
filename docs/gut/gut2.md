# GUT2: Shopify stops become agent hand-offs

Branch `gut/shopify`, from `refit/gut` with `gut/agent-fix` (GUT1) merged. Plan: [GUT-PLAN.md](../GUT-PLAN.md); items: [GUT-INVENTORY.md](../GUT-INVENTORY.md#shopify).

## What changed

- **No Shopify stop ends a repository.** `pipeline/shopify-pipeline.ts` no longer turns a finding with a `contractReview` into `not-generated` (SH-S0). Every such finding, and a pin that does not match the before contract, is collected in `shopify.handoff` and passed to `fixWithAgent` at once (stops are layered).
- **Codemods first.** The version move, the SDK upgrade and its source codemods (#434), the dated-string pin, and the rule and migration edits run first; their patch is applied to the agent's copy of the repository. Rule edits to documents no longer wait for a version move (SH-S25). Several runtime pins all move to the target (SH-S9).
- **The hand-off** (`pipeline/shopify-agent.ts`): a copy of the repository with the codemods applied; `change` holds the schema diff entries for the types the code uses, the quoted rule tables between the versions, the REST → GraphQL mappings and refusals when a REST call is handed off, and the SDK migration guide; `context` lists each stop with its file, line, expression and reason, the locked SDK and the upgrade result, and the notes (variables, migrations, other APIs, Storefront).
- **The judge** (`check`): `shopifySchemaProof` on the patched tree (every Admin document validates on the target, every REST call proven by the REST contract, nothing unread) and every runtime pin naming the target on an SDK that has it. tsc, build and tests run afterwards in validation; GUT5's before/after check plugs in here once `gut/sandbox` exposes it.
- **Outcomes.** `passed` ships as an AI patch (generator `openai`) through validation and the proof levels. `unproven` ships `[Needs review]` with the judge errors and the agent's summary. Without AI, or when the agent produces nothing, the codemods' patch carries the hand-off for review. The fallback to an older supported version runs only when the agent did not pass, and only accepts a version that needs no hand-off.
- **One agent run per tree.** The benchmark scan, the child workflow scan and validation all run the pipeline; the first run with AI pays and the others reuse its result from `REFIT_AI_BUDGET_DIRECTORY/shopify-agent/`.
- **Benchmark outcomes** (SH-S26): each row gets `result`: `validated`, `needs-review`, `no-change` or `infrastructure`.

## Deleted

| Item          | What                                                                                                                                                                 |                    Lines |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------------: |
| SH-F1         | REST → GraphQL rewrite and adapter in `shopify-rest-rewrite.ts`; the file keeps only the tracing the REST contract prover imports (`rewriteRestCalls` is trace-only) |                    1,081 |
| SH-A3, SH-X1  | `shopify-rest-ai.ts` and its test                                                                                                                                    |                      525 |
| SH-X2         | the rewrite cases of `shopify-rest-rewrite.test.ts`                                                                                                                  |                      452 |
| SH-A1, SH-S19 | the single-shot `aiRewriteDocument` call site and its report fields (the export stays for wave 3, GUT4's file)                                                       | in `shopify-pipeline.ts` |

`shopify-pipeline.ts`: 264 lines removed, 376 added (the judge, the hand-off and the agent's context).

## Measurement

Baselines on dev-60: 3 validated at #427's head; at #434's head (`396c5b1e`, run 40973528148) 9 validated, 22 patched but not validated, 29 stopped.

**Run 41268580516** (`b6e43f4c`, refit-bench `gut/sandbox`, `size=1`, `count=60`, `--sdk-upgrade`, `agent=true`, `claude-sonnet-5-5`, budget $300) is void as a measurement:

- 0 validated, 60 needs-review.
- Every row's validation was `untested` with `dependency-preparation`, including the 30 rows where nothing was handed off. Preparation failed with `cp: can't open ... Permission denied`.
- The cause is the `gut/sandbox` workflow: it sets `umask 077` before writing the AI env file and never restores it, so every clone and dependency archive written afterwards is unreadable in the sandboxes. The fix is on refit-bench `gut/shopify-bench` (`1186d79`) and was reported to GUT5. `meta.yml` has the same bug.

What the run still shows:

- **Hand-off:** 30 rows were handed to the agent: 21 passed the judges and 9 were unproven. The other 30 rows needed no hand-off.
- **Agent spend:** $9.20 in the scan.
- **Schema proof:** proven on every agent-patched row that reached validation. The development store gave grade A on 8 of them, but none could validate without dependencies.
- **Errors:** 2 rows ended with `Cannot read properties of null (reading 'replace')` during validation: iamgenesistech-hub/IAGT_AI_VIRAL_ENGINE and sanjeev744/smart-slidecart. No stack trace was recorded, and it is not investigated yet.
- **For review:** on sanjeev744/smart-slidecart the agent also edited `shopify.app.toml` (the webhook `api_version`). That changes webhook payloads and needs a reviewer.

**Run 41269399890** (`b6e43f4c`, refit-bench `gut/shopify-bench` with the umask fix) was cancelled under the founder's spend freeze and has no results. GUT5 has since fixed the umask on `gut/sandbox` (`b06dd03`) and made checked trees readable in the sandbox (`c60d3ad6`, merged here as `70cd9e5c`). A valid dev-60 measurement still needs a new run on this branch's head, once the founder approves.
