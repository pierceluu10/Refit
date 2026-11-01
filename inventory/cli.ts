// Usage: node inventory/cli.ts <repoDir> <owner/name> [--out <dir>] [--run-cap <usd>]
// Writes <out>/<owner__name>.json (the report), .txt (the summary) and .transcript.jsonl.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runInventory } from './agent.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string', default: 'inventory-out' }, 'run-cap': { type: 'string' } },
});
const [repoDir, repo] = positionals;
if (!repoDir || !repo) {
  console.error(
    'Usage: node inventory/cli.ts <repoDir> <owner/name> [--out <dir>] [--run-cap <usd>]',
  );
  process.exit(2);
}
const base = path.join(values.out, repo.replace(/\//g, '__'));
await mkdir(values.out, { recursive: true });
const report = await runInventory(path.resolve(repoDir), repo, {
  runCapUsd: values['run-cap'] === undefined ? undefined : Number(values['run-cap']),
  transcriptPath: `${base}.transcript.jsonl`,
});
await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${base}.txt`, `${report.summary}\n\n${report.agentSummary}\n`);
console.log(report.summary);
console.log(`cost $${report.costUsd.toFixed(4)} · ${report.turns} turns · ${report.outcome}`);
