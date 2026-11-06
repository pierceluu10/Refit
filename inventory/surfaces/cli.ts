// Usage: REFIT_AI_BUDGET_USD=<cap> node inventory/surfaces/cli.ts <repoDir> <owner/name> [--out <dir>] [--run-cap <usd>]
// Writes <out>/<owner__name>.surfaces.json (the report), .surfaces.txt and .surfaces.transcript.jsonl.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runSurfaceInventory } from './agent.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string', default: 'inventory-out' }, 'run-cap': { type: 'string' } },
});
const [repoDir, repo] = positionals;
if (!repoDir || !repo) {
  console.error(
    'Usage: node inventory/surfaces/cli.ts <repoDir> <owner/name> [--out <dir>] [--run-cap <usd>]',
  );
  process.exit(2);
}
const base = path.join(values.out, `${repo.replace(/\//g, '__')}.surfaces`);
await mkdir(values.out, { recursive: true });
const report = await runSurfaceInventory(path.resolve(repoDir), repo, {
  runCapUsd: values['run-cap'] === undefined ? undefined : Number(values['run-cap']),
  transcriptPath: `${base}.transcript.jsonl`,
});
await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${base}.txt`, `${report.summary}\n\n${report.agentSummary}\n`);
console.log(report.summary);
console.log(`cost $${report.costUsd.toFixed(4)} · ${report.turns} turns · ${report.outcome}`);
if (report.errors.length > 0) console.log(`errors:\n${report.errors.join('\n')}`);
