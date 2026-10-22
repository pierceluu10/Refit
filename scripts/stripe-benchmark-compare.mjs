// Compares Stripe benchmark runs repository by repository: each repository's outcome in every run,
// and how many repositories got the same outcome in all of them. --details also compares where and
// why each run stopped, every check's status and the patch.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

// The benchmark keeps this much of each diff in results.json; the full diff is in the run's bundle.
const RESULTS_DIFF_LIMIT = 8000;
const HASH_LENGTH = 12;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: 'boolean' },
    details: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help || positionals.length < 2) {
  console.log(
    'Usage: node scripts/stripe-benchmark-compare.mjs <results.json> <results.json> [...] [--details] [--json]',
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

function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, HASH_LENGTH);
}

async function bundleFile(bundle, name) {
  return bundle ? JSON.parse(await readFile(join(bundle, name), 'utf8').catch(() => 'null')) : null;
}

// Every compared field of one repository's result. The patch hash comes from the full diff in
// <results dir>/repos/<owner__repo>/run/report.json, or from scan.json when the run stopped before
// validation wrote a report.
async function details(result, directory) {
  const workflow = result?.workflow ?? {};
  const bundle = result && join(directory, 'repos', result.repo.replace('/', '__'), 'run');
  const [report, scan, manifest] = await Promise.all(
    ['report.json', 'scan.json', 'manifest.json'].map((name) => bundleFile(bundle, name)),
  );
  const fullDiff = report?.patch?.diff ?? scan?.patch?.diff;
  const diff = fullDiff ?? workflow.diff;
  const scanHash = manifest?.files?.find((file) => file.path === 'scan.json')?.sha256;
  return {
    outcome: outcome(result),
    tracedCalls: result?.tracedCalls,
    confirmedFields: result?.fullAdapter?.confirmedFields?.join(' '),
    stage: workflow.stage,
    reason: workflow.reason,
    error: workflow.error,
    patch: workflow.patch,
    sdkUpgrade: JSON.stringify(workflow.sdkUpgrade),
    baseline: workflow.baseline,
    patched: workflow.patched,
    validation: workflow.validation,
    typeErrors: JSON.stringify(workflow.typeErrors),
    generated: JSON.stringify(workflow.generated),
    // scan.json is content-addressed (its runId hashes the inputs), so equal runs write equal bytes.
    scan: scanHash?.slice(0, HASH_LENGTH),
    diff:
      diff === undefined
        ? undefined
        : fullDiff
          ? digest(diff)
          : `${digest(diff)} (results, first ${RESULTS_DIFF_LIMIT} characters)`,
  };
}

const runs = await Promise.all(
  positionals.map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
);
const repositories = [...new Set(runs.flatMap((run) => run.map((result) => result?.repo)))]
  .filter(Boolean)
  .sort();
const rows = await Promise.all(
  repositories.map(async (repo) => {
    const results = runs.map((run) => run.find((result) => result?.repo === repo));
    const outcomes = results.map(outcome);
    const row = { repo, outcomes, same: outcomes.every((entry) => entry === outcomes[0]) };
    if (!values.details) return row;
    const fields = await Promise.all(
      results.map((result, index) => details(result, dirname(positionals[index]))),
    );
    const differs = Object.keys(fields[0]).filter((name) =>
      fields.some((entry) => entry[name] !== fields[0][name]),
    );
    return { ...row, fields, differs };
  }),
);
const affected = rows.filter((row) =>
  row.outcomes.some((entry) => !['not-affected', 'no-mapped-methods'].includes(entry)),
);
const summary = {
  runs: positionals,
  repositories: rows.length,
  sameOutcome: rows.filter((row) => row.same).length,
  affected: affected.length,
  affectedSameOutcome: affected.filter((row) => row.same).length,
  ...(values.details ? { identical: rows.filter((row) => !row.differs.length).length } : {}),
  rows,
};
if (values.json) console.log(JSON.stringify(summary, null, 2));
else if (values.details) {
  console.log(
    `Identical in every compared field: ${summary.identical}/${summary.repositories} repositories.\n`,
  );
  console.log(
    `| Repository | Field | ${positionals.map((_, index) => `Run ${index + 1}`).join(' | ')} |`,
  );
  console.log(`|---|---|${positionals.map(() => '---').join('|')}|`);
  for (const row of rows)
    for (const name of row.differs)
      console.log(
        `| ${row.repo} | ${name} | ${row.fields.map((entry) => String(entry[name] ?? '')).join(' | ')} |`,
      );
} else {
  console.log(
    `Same outcome in every run: ${summary.sameOutcome}/${summary.repositories} repositories; ` +
      `${summary.affectedSameOutcome}/${summary.affected} of those affected in any run.\n`,
  );
  console.log(`| Repository | ${positionals.map((_, index) => `Run ${index + 1}`).join(' | ')} |`);
  console.log(`|---|${positionals.map(() => '---').join('|')}|`);
  for (const row of affected)
    console.log(`| ${row.repo} | ${row.outcomes.join(' | ')} |${row.same ? '' : ' differs'}`);
}
