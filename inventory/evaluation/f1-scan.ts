// Scans each labeled repo the way `refit scan` does and saves what the scorer needs: the full
// dependency inventory (the scan report keeps only rows with a change), the report and every part's spend.
// Usage: REFIT_AI_BUDGET_USD=<cap> node inventory/evaluation/f1-scan.ts --labels <f1-labels.json>
//          --repos <dir of owner__name checkouts> --out <dir> [--watch-cache <dir>] [--only owner/name ...]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createBudget } from '../../orchestrator/budget.ts';
import { createDeps } from '../../orchestrator/deps.ts';
import { createScanRepo } from '../../orchestrator/index.ts';
import type { DependencyUsage } from '../../shared/types.ts';
import type { Labels } from './f1-score.ts';

const { values } = parseArgs({
  options: {
    labels: { type: 'string' },
    repos: { type: 'string' },
    out: { type: 'string' },
    'watch-cache': { type: 'string' },
    only: { type: 'string', multiple: true },
  },
});
if (!values.labels || !values.repos || !values.out) {
  console.error(
    'usage: f1-scan.ts --labels <file> --repos <dir> --out <dir> [--watch-cache <dir>]',
  );
  process.exit(2);
}
const labels = JSON.parse(await readFile(values.labels, 'utf8')) as Labels;
const spend: { label: string; usd: number }[] = [];
// The run-level cap is the hard limit: createBudget throws without REFIT_AI_BUDGET_USD.
const budget = createBudget(undefined, (label, usd) => spend.push({ label, usd }));
const base = createDeps({
  budget,
  watchCache: values['watch-cache'],
  reports: join(values.out, 'reports'),
});
await mkdir(values.out, { recursive: true });

for (const { repo, commit } of labels.repos) {
  if (values.only && !values.only.includes(repo)) continue;
  let dependencies: DependencyUsage[] = [];
  const deps = {
    ...base,
    external: base.external && {
      ...base.external,
      inventoryDependencies: async (
        ...args: Parameters<NonNullable<typeof base.external>['inventoryDependencies']>
      ) => (dependencies = await base.external!.inventoryDependencies(...args)),
    },
  };
  const before = budget.spentUsd();
  const from = spend.length;
  const startedAt = Date.now();
  // SECURITY: a scan only reads the checkout; nothing in it runs.
  const { report } = await createScanRepo(deps)(repo, join(values.repos, repo.replace('/', '__')));
  const result = {
    repo,
    commit,
    costUsd: budget.spentUsd() - before,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    dependencies,
    report,
    spend: spend.slice(from),
  };
  await writeFile(
    join(values.out, `${repo.replace('/', '__')}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(
    `${repo}: $${result.costUsd.toFixed(4)}, ${dependencies.length} dependencies, ${report.items.length} rows, ${report.errors.length} errors`,
  );
}
console.log(`run budget: $${budget.spentUsd().toFixed(4)} spent of $${budget.capUsd}`);
