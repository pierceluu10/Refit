# compliance

Refit's rules and regulations agent and the audit trail (prompt O5 in `MVP-PLAN.md`).

Rules are different from software changes. Refit never says code is compliant, never says it meets a law, and doesn't give legal advice. For a rule, Refit finds the code the rule likely touches, makes the change the rule's text points to, runs the checks a tool can run, and opens a **needs-review** PR listing what a person or lawyer must confirm. Every step goes to the audit trail.

## Entry points (`index.ts`)

| Export                                         | What it does                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watchRegulations(since)`                      | An agent reads the official texts for each rule family and returns `Obligation[]`, each with a source URL, an exact quote, the effective date when the source gives one, what it means in code, what a tool can check and what a person must confirm.                                    |
| `readRegulations(since, options)`              | The same, plus what couldn't be read, per-family errors and the cost. Use this when you need the errors.                                                                                                                                                                                 |
| `obligationsToChanges(repo, surfaces, obls)`   | An agent reads the repo's regulated surfaces (P5) against each obligation. Applicable ones become `ExternalChange`s (`kind` `regulation` or `payment-rule`, `provider` `rules`, `id` `rule:<obligation id>`). The rest are written to the audit trail as `not-affected` with the reason. |
| `matchObligations(repo, surfaces, obls, opts)` | The same, plus every verdict and its reasoning. Pass `repoDir` to let the agent read and search the checkout (read only; nothing in it runs).                                                                                                                                            |
| `recordAudit(entry)`, `listAudit(repo)`        | The audit trail. Local JSON lines, one file per repo under `REFIT_AUDIT_DIR` (default `.refit/audit/`), behind the `AuditStore` interface. `audit.sql` sketches the Postgres table it can move to. Evidence is redacted for common secret shapes before it is written.                   |
| `rulePlaybook(change)`, `RULE_TASK_GUIDANCE`   | Guidance for the harness on rule tasks: one playbook per family in `playbooks/` (accessibility, privacy, payments, AI transparency) and the lines to add to its system prompt.                                                                                                           |
| `rulePrBody(input)`, `ruleOutcome(input)`      | The rule PR body: what changed, what each check showed, what to confirm, and "Refit doesn't give legal advice." Outcome is needs-review unless every item is proven by a check and nothing is left for a person.                                                                         |
| `findClaims`, `scrubClaims`                    | Wording checks. The agents get claims fed back to rewrite; anything left is replaced before it ships.                                                                                                                                                                                    |

## Rule families

Defined in `families.ts`, each with official sources to start from (the agent may follow other official pages):

- **accessibility**: European Accessibility Act (Directive (EU) 2019/882) and WCAG 2.2.
- **privacy**: GDPR, the ePrivacy Directive's consent-before-cookies rule (Article 5(3)), CCPA and the CPPA regulations.
- **payments**: PSD2 Strong Customer Authentication (Article 97 and the RTS) and PCI DSS 4.0.1 (6.4.3 and 11.6.1). Kind `payment-rule`.
- **ai-transparency**: EU AI Act Article 50.

## How it decides

The model reads, decides and writes. Code gives it tools (`read_page`, `find_in_page`; `list_files`, `read_file`, `search` on a checkout) and checks its work:

- Every quote is checked word for word against the text Refit fetched. A quote that isn't found, or comes from a page Refit didn't read, is kept and flagged in `needsHuman`, never dropped or trusted silently.
- Compliance claims in the agent's wording are fed back for a rewrite.
- The matcher must return a verdict for every obligation. Missing ones are asked for again; any still missing, or every one when no model is available, is treated as possibly applying, so the harness attempts it.
- Sources that couldn't be read are reported in `readRegulations().errors`.

## Model and spend

`model.ts` is a local stand-in for O3's `shared/models.ts`: a `ModelClient` over the Messages API (no SDK dependency), metered against `REFIT_AI_BUDGET_USD`. No cap, no spend. `REFIT_COMPLIANCE_MODEL` picks the model (default `claude-sonnet-5-5`). Callers can pass their own `model` in the options, so the orchestrator's run budget covers these calls. Once `shared/models.ts` lands, `createComplianceModel` should build on it.

## Tests and fixtures

`npm test` runs everything on a fake model and saved fixtures; nothing spends. The texts in `fixtures/official/` are **transcribed excerpts, not saved snapshots**: the session that wrote them couldn't reach the official sites. Each file says so. On a machine that can reach them:

```sh
npm run save-fixtures -w compliance        # replace the transcriptions with real snapshots (no AI)
REFIT_AI_BUDGET_USD=4 npm run live-read -w compliance   # one live read per family, with ANTHROPIC_API_KEY set
```

The PCI DSS standard is a PDF, which `fetch.ts` doesn't read yet; a live read reports it as unread.
