// Compares Stripe benchmark runs repository by repository: each repository's outcome in every run,
// and how many repositories got the same outcome in all of them.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { json: { type: 'boolean' }, help: { type: 'boolean' } },
});
if (values.help || positionals.length < 2) {
  console.log(
    'Usage: node scripts/stripe-benchmark-compare.mjs <results.json> <results.json> [...] [--json]',
  );
  process.exit(values.help ? 0 : 1);
}

// One label per repository: where the pipeline stopped, or the validated/PR-ready end state.
function outcome(result) {
  if (!result) return 'missing';
  if (result.read && result.read !== 'ok') return 'unreadable';
  if (result.scanCrash) return 'scan-crash';
  if (!result.mappedMethods) return 'no-mapped-methods';
  if (result.fullAdapter?.error) return 'scan-error';
  if (!result.fullAdapter?.confirmed) return 'not-affected';
  const workflow = result.workflow;
  if (!workflow) return result.checks === 'none' ? 'affected-no-checks' : 'affected';
  if (result.publication?.url) return 'pr-published';
  if (workflow.status === 'validated') return 'validated';
  if (workflow.status === 'validation-failed') return `validation-${workflow.validation}`;
  if (workflow.status === 'needs-review') return 'needs-review';
  return workflow.status;
}

const runs = await Promise.all(
  positionals.map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
);
const repositories = [...new Set(runs.flatMap((run) => run.map((result) => result?.repo)))]
  .filter(Boolean)
  .sort();
const rows = repositories.map((repo) => {
  const outcomes = runs.map((run) => outcome(run.find((result) => result?.repo === repo)));
  return { repo, outcomes, same: outcomes.every((entry) => entry === outcomes[0]) };
});
const affected = rows.filter((row) =>
  row.outcomes.some((entry) => !['not-affected', 'no-mapped-methods'].includes(entry)),
);
const summary = {
  runs: positionals,
  repositories: rows.length,
  sameOutcome: rows.filter((row) => row.same).length,
  affected: affected.length,
  affectedSameOutcome: affected.filter((row) => row.same).length,
  rows,
};
if (values.json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(
    `Same outcome in every run: ${summary.sameOutcome}/${summary.repositories} repositories; ` +
      `${summary.affectedSameOutcome}/${summary.affected} of those affected in any run.\n`,
  );
  console.log(`| Repository | ${positionals.map((_, index) => `Run ${index + 1}`).join(' | ')} |`);
  console.log(`|---|${positionals.map(() => '---').join('|')}|`);
  for (const row of affected)
    console.log(`| ${row.repo} | ${row.outcomes.join(' | ')} |${row.same ? '' : ' differs'}`);
}
