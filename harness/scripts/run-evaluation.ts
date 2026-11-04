// The real-task evaluation: node harness/scripts/run-evaluation.ts [task id ...]
// Needs ANTHROPIC_API_KEY and REFIT_AI_BUDGET_USD, the cap for the whole batch. Each task gets
// REFIT_TASK_BUDGET_USD (default $2) or what is left of the cap. Repos are cloned at their
// pinned commit outside this repo and run in the Docker sandbox; results land in
// harness/evaluation/results/<id>/. Nothing is pushed or opened.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationTask, ToolPack } from '../../shared/types.ts';
import { budgetFromEnv } from '../ledger.ts';
import { TURN_RESERVE_USD, runTask } from '../run.ts';
import { createSandbox } from '../sandbox.ts';

type Entry = { id: string; repo: string; commit: string; task: string };

const evaluation = join(dirname(fileURLToPath(import.meta.url)), '..', 'evaluation');
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set, so nothing runs and nothing is spent.');
  process.exit(2);
}
const capUsd = budgetFromEnv();
// The harness keeps TURN_RESERVE_USD of a task's budget back, so $2 leaves $1 of agent work.
const perTaskUsd = Number(process.env.REFIT_TASK_BUDGET_USD ?? 2);
let spentUsd = 0;
const wanted = process.argv.slice(2);
const entries = (
  JSON.parse(readFileSync(join(evaluation, 'tasks.json'), 'utf8')) as Entry[]
).filter((entry) => wanted.length === 0 || wanted.includes(entry.id));

for (const entry of entries) {
  const budgetUsd = Math.min(perTaskUsd, capUsd - spentUsd);
  // The harness starts no query inside its overshoot reserve, so below it a task cannot run.
  if (budgetUsd <= TURN_RESERVE_USD) {
    console.log(`${entry.id}: not run, $${(capUsd - spentUsd).toFixed(2)} of $${capUsd} left`);
    continue;
  }
  try {
    const work = mkdtempSync(join(tmpdir(), `refit-eval-${entry.id}-`));
    const repoDir = join(work, 'repo');
    const url = `https://github.com/${entry.repo}.git`;
    execFileSync('git', ['clone', '-q', '--filter=blob:none', url, repoDir]);
    execFileSync('git', ['-C', repoDir, 'checkout', '-q', entry.commit]);
    const task = JSON.parse(readFileSync(join(evaluation, entry.task), 'utf8')) as MigrationTask;
    const record = await runTask(task, repoDir, {
      budgetUsd,
      outDir: join(work, 'out'),
      createSandbox: (dir) => createSandbox(dir, { mode: 'docker' }),
      // The provider's validators and playbooks, loaded the way orchestrator/deps.ts loads them.
      loadToolPack: async (provider) =>
        ((await import(`../../providers/${provider}/tools.ts`)) as { toolPack: ToolPack }).toolPack,
      chargeRun: (usd) => (spentUsd += usd),
    });
    const results = join(evaluation, 'results', entry.id);
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, 'diff.patch'), record.diff);
    writeFileSync(join(results, 'pr-body.md'), record.prBody);
    writeFileSync(join(results, 'summary.md'), record.summary);
    const { diff, prBody, summary, transcriptPath, ...rest } = record;
    const saved = { repo: entry.repo, commit: entry.commit, ...rest };
    writeFileSync(join(results, 'record.json'), JSON.stringify(saved, null, 2) + '\n');
    console.log(
      `${entry.id}: ${record.outcome}, $${record.costUsd.toFixed(4)} (batch $${spentUsd.toFixed(4)} of $${capUsd}); transcript ${transcriptPath}`,
    );
  } catch (error) {
    // chargeRun has already counted what the task spent, so the batch cap still holds.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`${entry.id}: error, ${message} (batch $${spentUsd.toFixed(4)} of $${capUsd})`);
  }
}
