// One real harness run: node harness/scripts/run-task.ts <task.json> <repoDir> [outDir]
// Needs APTITUDE_AI_BUDGET_USD. Prints the record; the PR body stays local (nothing is opened or pushed).
import { readFileSync } from 'node:fs';
import type { MigrationTask } from '../../shared/types.ts';
import { runTask } from '../run.ts';

const [taskPath, repoDir, outDir] = process.argv.slice(2);
if (!taskPath || !repoDir) {
  console.error('usage: node harness/scripts/run-task.ts <task.json> <repoDir> [outDir]');
  process.exit(2);
}
const task = JSON.parse(readFileSync(taskPath, 'utf8')) as MigrationTask;
const record = await runTask(task, repoDir, { outDir });
console.log(JSON.stringify({ ...record, diff: undefined, prBody: undefined }, null, 2));
console.log(`\n${record.prBody}\n\n${record.diff}`);
