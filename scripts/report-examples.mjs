// Writes `refit report` for frozen benchmark repositories at their recorded commits, from the same
// inventory the hosted worker takes (pipeline/inventory.ts), into --output as <owner>--<name>.md
// and .json with an index. Each shallow clone is read and deleted; nothing in it is installed or
// run, and no provider is contacted.
// Usage: node scripts/report-examples.mjs --root <dir> --output <dir> <frozen.json>:<owner/name> ...
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';
import { shallowCheckout } from './ai-app-helpers.mjs';

// Loaded through tsx, as bin/refit.mjs does: pipeline modules use syntax type stripping rejects.
const load = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig: false });
const { loadDeadlineRegistry } = await load('../pipeline/deadline-registry.ts');
const { INVENTORY_LIMITS, inventoryDirectory } = await load('../pipeline/inventory.ts');
const { buildReport, renderReport } = await load('../pipeline/report.ts');

const execute = promisify(execFile);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help || !values.root || !values.output || !positionals.length) {
  console.log(
    'Usage: node scripts/report-examples.mjs --root <dir> --output <dir> <frozen.json>:<owner/name> ...',
  );
  process.exit(values.help ? 0 : 1);
}
const refit = new URL('..', import.meta.url).pathname;
if ((await execute('git', ['-C', refit, 'status', '--porcelain'])).stdout.trim())
  throw new Error(
    'Generate examples from a clean checkout, so the index names the code that made them.',
  );
const commit = (await execute('git', ['-C', refit, 'rev-parse', 'HEAD'])).stdout.trim();
const root = resolve(values.root);
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const now = new Date();
const registry = await loadDeadlineRegistry(undefined, now);
const rows = [];
for (const argument of positionals) {
  const [list, repository] = argument.split(':');
  const entry = JSON.parse(await readFile(list, 'utf8')).repos.find(
    (item) => item.repo === repository,
  );
  if (!entry) throw new Error(`${repository} is not in ${list}.`);
  const directory = await shallowCheckout(root, repository, entry.commit);
  try {
    const inventory = await inventoryDirectory(
      directory,
      registry,
      now,
      AbortSignal.timeout(INVENTORY_LIMITS.seconds * 1000),
    );
    const report = buildReport({ inventory, registry, repository, revision: entry.commit, now });
    const name = repository.replace('/', '--');
    await writeFile(join(output, `${name}.md`), `${renderReport(report)}\n`);
    await writeFile(join(output, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
    rows.push(
      `| [${repository}](${name}.md) | \`${entry.commit.slice(0, 12)}\` | \`${list}\` | ${report.integrations.length} | ${report.deadlines.length} | ${report.models.reduce((sum, group) => sum + group.calls.length, 0)} |`,
    );
    console.error(`${repository}: ${report.deadlines.length} deadlines`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
await writeFile(
  join(output, 'README.md'),
  `# Report examples

Generated with \`refit report\`'s builder from public repositories in Refit's frozen benchmark sets, at the commits those sets pinned. Each repository was shallow-cloned, inventoried read-only (nothing installed or run, no provider contacted) and deleted. Days left are counted from ${now.toISOString().slice(0, 10)}. These are examples of the format, not reviews of the repositories: the findings are what Refit's scanners report, including their known gaps.

Refit commit \`${commit}\`, command:

\`\`\`bash
node scripts/report-examples.mjs --root <dir> --output docs/report-examples ${positionals.join(' ')}
\`\`\`

| Repository | Commit | Frozen list | Integrations | Deadlines | Model calls |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`,
);
