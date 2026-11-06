// Usage: node inventory/cli.ts <repoDir> <owner/name> [--out <dir>] [--run-cap <usd>] [--dependencies]
// Writes <out>/<owner__name>.json (the report), .txt (the summary) and .transcript.jsonl.
// --dependencies also lists what the agent found that the scanners did not point at.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runInventory } from './agent.ts';
import { runDependencyInventory } from './dependencies.ts';
import { scannerGap } from './evaluation/scanner-gap.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'inventory-out' },
    'run-cap': { type: 'string' },
    dependencies: { type: 'boolean', default: false },
  },
});
const [repoDir, repo] = positionals;
if (!repoDir || !repo) {
  console.error(
    'Usage: node inventory/cli.ts <repoDir> <owner/name> [--out <dir>] [--run-cap <usd>] [--dependencies]',
  );
  process.exit(2);
}
const base = path.join(values.out, repo.replace(/\//g, '__'));
await mkdir(values.out, { recursive: true });
const options = {
  runCapUsd: values['run-cap'] === undefined ? undefined : Number(values['run-cap']),
  transcriptPath: `${base}.transcript.jsonl`,
};
const root = path.resolve(repoDir);
const report = values.dependencies
  ? await runDependencyInventory(root, repo, options)
  : await runInventory(root, repo, options);
await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${base}.txt`, `${report.summary}\n\n${report.agentSummary}\n`);
if ('dependencies' in report) {
  const gap = await scannerGap(root, report.dependencies);
  await writeFile(`${base}.scanner-gap.json`, `${JSON.stringify(gap, null, 2)}\n`);
}
console.log(report.summary);
console.log(`cost $${report.costUsd.toFixed(4)} · ${report.turns} turns · ${report.outcome}`);
