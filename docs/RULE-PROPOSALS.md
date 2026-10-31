# Rule proposals from AI fixes

The rule is "it should never happen twice" (owner decision, Furqan, 2026-10-29). When Refit's rules leave something open, the AI fallback (`pipeline/ai-fallback.ts`) tries to fix it. A fix that passes every gate (output, secrets, scope, runtime, resolves, checks, request proof) is evidence that Refit was missing a rule. This loop turns that evidence into a proposed rule, so the next repository with the same pattern gets Refit's rule instead of the AI.

A proposal never becomes an active rule by itself. A person accepts it into a rule table, and the rule ships with a test built from a synthetic program. The other option is to reject it with a reason; a rejected pattern is never proposed again.

Code: `pipeline/rule-proposals.ts` (reading patches, deduplication, the ledger, reports), `pipeline/rule-proposals-accept.ts` (acceptance), `pipeline/rule-proposal-fixtures.ts` (the fixture check) and `pipeline/rule-proposals-cli.ts`.

## What a proposal holds

Each validated patch is read change block by change block. Dependency files and new test files are skipped. Each block becomes one transformation:

| Kind               | Example                                                              | Table an acceptance writes                            |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `method-rename`    | `createChatCompletion(` → `chat.completions.create(`, same arguments | `data/rules/openai/sdk-majors.json` (`method-rename`) |
| `parameter-rename` | `max_tokens:` → `max_completion_tokens:`, same value                 | `data/model-parameter-changes.json` (`rename`)        |
| `parameter-remove` | `temperature: 0.7,` removed                                          | `data/model-parameter-changes.json` (`remove`)        |
| `model-replace`    | `'gpt-4-0613'` → `'gpt-5.6-terra'`                                   | none: the registry decides models; link a rule        |
| `rewrite`          | anything else, as code shapes                                        | none: write the engine rule by hand, then link it     |

Each proposal also holds:

- the call shapes: the removed code with the repository's own names and literals taken out (`codeShape` in `pipeline/ai-misses.ts`);
- the conditions: the open items it fixed (registry or rule refs and the engine stop), the language, whether the fix also moved a dependency, and the gates every row passed;
- `safeUnder`: the same conditions in sentences;
- the quoted provider sources the fallback was given;
- the evidence: list, run, repository, commit, file, line and gates passed, for each row.

The id comes from a hash of provider, change type and transformation, so the same pattern gets the same id in every run.

Measurement sets (`openai-100`, `anthropic-100`, `gemini-30`) are never mined. Their validated fixes are counted and nothing else is kept.

## Deduplication

A run's proposals are checked in this order:

1. **Rejected in the ledger:** not proposed again. The run lists them under "Rejected earlier", with the reason.
2. **Accepted in the ledger, or already made by a shipped rule:** marked "covered". Shipped rules are a `method-rename` in the AI rule tables, a parameter change, or a registry deadline whose replacement names the new model. The AI fixed a site that a rule already covers, so the engine failed to reach that site. That is engine reach work, not a missing rule.
3. **Open in the ledger:** "seen again". When it is recorded, it gains this run's evidence.
4. **Everything else:** "new".

## After every run

refit-bench's `ai-providers.yml` runs this in its merge job, after the shards are merged, for every list:

```bash
node --experimental-strip-types refit/pipeline/rule-proposals-cli.ts propose \
  --results merged/results.json --list "$LIST" --run "$GITHUB_RUN_ID" --commit "$COMMIT" \
  --out merged --root refit
```

It writes `merged/rule-proposals.json` and `merged/rule-proposals.md`, which are uploaded with the `merged` artifact. The Markdown file is also appended to the run summary. `propose` never writes the ledger, so a run cannot change what Refit knows.

To record the round, download the artifact and fold it into the ledger in a pull request:

```bash
npx tsx pipeline/rule-proposals-cli.ts record --proposals merged/rule-proposals.json
```

This adds new proposals as `open`, adds this run's evidence to open ones, and records the round (misses by category, validated fixes, new proposals). It never changes a decision.

## Approve

A person reads the proposal and checks the change on the provider page. Then they accept it with a quote from a page Refit has saved:

```bash
# A method rename (OpenAI SDK upgrade)
npx tsx pipeline/rule-proposals-cli.ts accept <id> --by <name> --reason "<why>" \
  --status auto --page openai-node-v4 --quote "- \`createModeration\` -> \`moderations.create\`" --from-major 3

# A parameter rename or removal
npx tsx pipeline/rule-proposals-cli.ts accept <id> --by <name> --reason "<why>" \
  --page openai-chat-create.md --quote "<sentence on the saved page>" \
  --apis chat.completions --models gpt-6-sol,gpt-6-luna --note "<what the customer should know>"

# Anything no table holds: write the engine rule and its tests by hand first, then link it
npx tsx pipeline/rule-proposals-cli.ts accept <id> --by <name> --reason "<why>" --rule <existing rule id>
```

`accept` adds the rule to its table and runs that table's own check: the table's shape, and the quote on the saved page. The table file is written only when the check passes. `accept` also writes `data/rule-proposals/fixtures/<id>.json`. That is a synthetic program built from the transformation: no evidence row's code, and a made-up receiver and arguments. `pipeline/rule-proposal-fixtures.test.ts` runs every fixture against the shipped tables:

- a method rename must be rewritten by the real SDK-upgrade engine with no blocking stop;
- a parameter change must be what `parameterChange` returns for that model, API and parameter;
- a linked rule must exist.

Run that test and `npm run ai-rules:check` (or `npm run model-parameter-changes:check`), then commit the table, the fixture and the ledger together in one draft PR.

`--status review` adds a rule that finds and explains but never edits. Use it when the pattern is real but its edit needs more evidence.

## Reject

A proposal from an AI fix that the hand-check found wrong, or right but outside Refit's scope, is rejected with a reason:

```bash
npx tsx pipeline/rule-proposals-cli.ts reject <id> --by <name> --verdict wrong \
  --reason "The rename drops the moderation model the request set."
```

The verdicts are `wrong`, `out-of-scope`, `duplicate` and `other`. A reason and a name are required. Later runs list the pattern under "Rejected earlier" and never propose it again. To reconsider it, someone edits the ledger entry in a reviewed PR.

## Report

```bash
npx tsx pipeline/rule-proposals-cli.ts report --out docs/benchmarks/rule-proposals.md
```

It shows proposals open, accepted and rejected, and a table of rounds (misses, validated AI fixes, new proposals, covered, rejected before). It also shows the latest round's misses by category (change type and engine stop), and each proposal with its decision.

## Relation to miss groups

`pipeline/ai-miss-rules-cli.ts` (#420, #421) groups every miss record, fixed or not, by the stop reason Refit gave. Its groups say where Refit stops. These proposals come only from fixes that passed every gate, and say what the fix was. A miss group that needed a fix example (`needs-fix-example`) gets one here once the AI fixes a row of it.

## Limits

- Only one-line method renames, key renames, key removals and model-string replacements map to a table. Multi-line restructures are proposals with code shapes; a person writes their rule.
- Acceptance writes only OpenAI SDK `method-rename` rules and OpenAI or Anthropic parameter changes. Other providers' and families' rules are linked after being written by hand.
- The fallback runs only in refit-bench Actions (`refit serve` does not run it), so "after every run" means every AI provider benchmark run. A production run would feed the same `propose` command from its results.
