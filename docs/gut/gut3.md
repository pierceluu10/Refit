# GUT3: Meta Graph stops become agent hand-offs

Written 2026-11-01. Branch `gut/meta`, draft PR #450 into `refit/gut`. See [GUT-PLAN.md](../GUT-PLAN.md) and [GUT-INVENTORY.md](../GUT-INVENTORY.md) (Meta Graph section).

## What changed

No Meta stop ends a repository. With AI on, `runMetaGraphPipeline` does three things:

- **Head start.** It applies the deterministic version moves and rule edits first.
- **Hand-off.** It then calls `fixWithAgent` (`pipeline/meta-graph-agent.ts`) with:
  - the target Graph version;
  - the quoted change-table entries the requests use;
  - every stop reason, finding, alert and AI-read request, all at once.
- **Judge.** The agent's tree is checked after each round. It passes only when:
  - every traced live request sends the target;
  - `proveMetaGraphPatch` proves every changed request;
  - the code proof that validation grades with holds where no check covers the change: a clean checkJs check, or edits only to request strings.

Which patch ships:

- An agent patch replaces the moves' patch only when it passed.
- An unproven agent patch ships as a needs-review draft only where the moves wrote nothing. The draft lists the remaining judge errors and the agent's summary.

Deleted: ME-A2 `reviewMetaGraphPatch` (94 lines) and its tests (55 lines). The inventory lists no Meta FIX-delete items.

## Measured on meta-dev-60

refit-bench `meta.yml` on `gut/sandbox`:

- `agent=true`, `claude-sonnet-5-5`, `ai_budget` 600, `size` 1;
- the gut/sandbox workflow sends agent runs to Anthropic, so every AI call in these runs was Claude, not OpenAI.

| Run         | Commit     | Rows      | Validated | Needs review | Agent: passed / unproven / failed | AI spend |
| ----------- | ---------- | --------- | --------: | -----------: | --------------------------------- | -------: |
| 41267723524 | `22a1c423` | 60        |         7 |           53 | 6 / 47 / 1                        |   $59.27 |
| 41269104870 | `bef9492d` | 24 of 60¹ |        10 |           14 | 2 / 17 / 0                        |   $13.00 |

¹ Cancelled under the founder's spend freeze. Its 24 rows are the first 24 of the list.

Old engine, on the same 60 rows: 6 validated without AI and 9 with AI (run 40987935081).

On the 24 rows the second run finished:

| Run                              | Validated |
| -------------------------------- | --------: |
| Old engine with AI (40987935081) |         4 |
| First run (41267723524)          |         5 |
| Second run (41269104870)         |        10 |

### What moved the numbers

- **The agent validated no repository in either run.** Every validated row is a deterministic version move.
- **First run.** The agent's patch replaced the moves' patch on 7 repositories the old engine had validated, and each one ended at D:
  - no check ran, because dependency preparation failed on every row (GUT5's sandbox);
  - the agent edited more than request strings (OAuth dialog URLs, test assertions, docs), so no code proof held.
- **The fix in `bef9492d`.** The code proof joined the judge, and the moves' patch is kept over an unproven agent patch. The second run regains those rows and adds the moves the #429 changelog matching allows.
- **Two agent patches pass and grade C, but publish as needs review.** These are herslander-netizen/cortai-app and jakeoborn/Plursky.
  - The cause is `publication.ts` (not GUT3's file): the `ai-patch` gate treats an AI patch as proven only when the validation status is `passed`.
  - Meta's proof-based grade C on an untested patch does not count there.
  - Allowing `metaGraphProven` there would publish both as validated.
- **One row is lost to AI variance.** zerfinityProd/intelliRX validated in the first run. In the second, the AI reconstruction read a runtime `payload` body and a v20.0 `messages` edge change, so the move stopped and the agent's patch could not be proven.

## Hand-check of every validated row

Every newly validated row changes only the `vNN.N` segment of a Graph URL, a version constant or an environment default. No row changes another line. Labels:

| Repository                      | Run(s) | Change                                                                      | Label   |
| ------------------------------- | ------ | --------------------------------------------------------------------------- | ------- |
| Bennettxai/FounderOS            | 1      | `GRAPH` constant v21.0 → v26.0                                              | correct |
| Cap-go/videoclub                | 1, 2   | `instagram_oembed` URL v18.0 → v26.0                                        | correct |
| Intekhab78/JTS-Chat-Support     | 1, 2   | two WhatsApp `/messages` URLs v18.0 → v26.0                                 | correct |
| Mukul0610/Enterprise_qua        | 1, 2   | `WHATSAPP_API_URL` default v19.0 → v26.0                                    | correct |
| zerfinityProd/intelliRX         | 1      | WhatsApp `/messages` URL v19.0 → v26.0                                      | correct |
| anderrsc/crm-bielenki           | 2      | `/messages` URL and two `WHATSAPP_API_VERSION` defaults v19.0/v23.0 → v26.0 | correct |
| ingridandrade-ctrl/arthea       | 2      | `GRAPH_API_VERSION` v21.0 → v26.0                                           | correct |
| symbiosika/symbiosika-framework | 2      | WhatsApp `subscribed_apps`, `register`, `phone_numbers` URLs v22.0 → v26.0  | correct |
| umero882/whatsApp-CRM           | 2      | `META_API_VERSION` v21.0 → v26.0                                            | correct |

Shamrock2245/shamrock-bail-portal-site and ogSulem/pulse (run 2) were validated and labelled `correct` by the old engine. Their patches are the same version moves.

## Judge blind spots for wave 3

- **Node-wide removals.** Some changes remove a whole node type: v26.0 Commerce Order Management and v24.0 custom audiences and conversions. They match every request to an opaque `/{id}` node, so the proof fails on such requests whoever writes the patch.
  - In the first run each of the 15 Commerce entries was a judge error on 97 requests.
  - Tracing the node type behind an ID is the fix.
- **Unread requests.** "The fields, metrics, parameters of this request are not known" fails the proof even where the agent's edit is only the version.
- **No checks.** Dependency preparation failed on every row, so grades came only from the change table and the code proof (GUT5).
