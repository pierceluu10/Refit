# Live AI migration evaluation — October 9, 2026

Refit generated a live OpenAI patch for the separate `refit-billing-demo` repository using configured model `gpt-5.4-mini` (reported snapshot `gpt-5.4-mini-2026-03-17`). The final patch uses the existing shared Stripe client, retains the original payment lookup, and collects the complete charge history through async pagination. The application's repository and tests remain unchanged.

## Outcomes, including failures

1. The initial workflow rejected an invalid or unchanged replacement before running application code.
2. A diagnostic request proposed adding `expand: ['charges']` to the wrapper. That does not restore a removed field and introduced an unsupported wrapper argument. It was not applied to the application.
3. After adding bounded imported-module context, a workflow rejected overlapping edits.
4. With explicit grouping instructions, a proposal passed all 14 billing tests under both contracts and strict TypeScript. The independent multi-page check then exposed a bug: the patch returned only 10 of 13 attempts. Inspection also found that it changed empty-history behavior. That bundle's `validated` status only covers its recorded checks; it must not be treated as the final approved migration.
5. The final workflow included multi-page and empty-history checks inside Docker, in addition to both billing suites and TypeScript. A fresh AI proposal passed all checks on its first validation attempt. One repair was permitted but none was requested.

Rejected source edits were not made valid by relaxing Refit's scope, unique-match or overlap requirements. Instead, the model received read-only import context, clearer replacement instructions and stronger validation. These results demonstrate one authored, simulated migration; they do not establish general model reliability or production Stripe compatibility.

## Final evidence

The local ignored bundle is `dist-cli/billing-ai-evaluation-history-2026-10-09`:

- `migration.patch`: the actual AI-generated source diff.
- `report.json`: model identity, evidence, checks, candidate attempts and repair outcome.
- `manifest.json`: workflow status and artifact hashes.
- `pull-request.md`: local draft description; no GitHub PR was published.

The baseline passes 14 tests and the additional history checks under the original contract. The candidate passes all 14 unchanged billing tests under each contract, strict TypeScript, and additional history checks under each contract. The history checks preserve all 13 unique attempts, ordering, payment filtering, refund information and empty history. Containers run without external network access.

Earlier error bundles and the insufficient-check bundle remain in `dist-cli` for comparison. No replacement success was fabricated for their failures. No automatic repair success is claimed by this final run.

## Repeat

Prepare the dependency/check image using [billing evaluation instructions](BILLING-EVALUATION.md). Run the documented workflow with `node --env-file=.env bin/refit.mjs run`, adding `--ai-patch --repair-attempts 1`, selecting `refit-billing-check:history`, and choosing a new output directory. This makes a billable OpenAI request; generated results can vary.

Verify an existing bundle without making an AI request:

```sh
node bin/refit.mjs verify --directory dist-cli/billing-ai-evaluation-history-2026-10-09
```

Recheck the saved final patch, including multi-page and empty history, without another AI request:

```sh
REFIT_BILLING_REPOSITORY=/Users/pierceluu/Repos/refit-billing-demo \
REFIT_BILLING_PATCH=/Users/pierceluu/Repos/Refit/dist-cli/billing-ai-evaluation-history-2026-10-09/migration.patch \
npm test
```

Patch requests now include at most 12 uniquely resolved relative-import modules as read-only context. Edit authority remains restricted to files containing confirmed findings; input byte limits remain enforced. Credentials are read from the local environment and were not committed.

Live GitHub publication and broader application evaluations remain outstanding.
