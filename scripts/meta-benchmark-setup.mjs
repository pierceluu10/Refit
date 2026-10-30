// Rebuilds the Meta Graph benchmark root from a frozen list (docs/benchmarks/subsets/meta-*.json):
// shallow clones at the recorded commits. It writes the selected part of the list to
// <root>/list.json for `npm run benchmark:meta -- --list`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { listSlice } from './aws-benchmark-helpers.mjs';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string' },
    offset: { type: 'string' },
    limit: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root || !values.list) {
  console.log(
    'Usage: node scripts/meta-benchmark-setup.mjs --root <dir> --list <frozen.json> [--offset N] [--limit N]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
if (pinned.provider !== 'meta-graph') throw new Error(`${values.list} is not a Meta Graph list.`);
// --offset and --limit build one shard's slice; the benchmark then reads <root>/list.json.
const repos = listSlice(pinned.repos, values.offset, values.limit);
await mkdir(join(root, 'repos'), { recursive: true });
await writeFile(join(root, 'list.json'), `${JSON.stringify({ ...pinned, repos }, null, 2)}\n`);

const failures = [];
for (const [index, entry] of repos.entries()) {
  console.error(`[${index + 1}/${repos.length}] ${entry.repo}`);
  try {
    // A failed fetch leaves no checkout, so the benchmark records it as a clone failure.
    await shallowCheckout(join(root, 'repos'), entry.repo, entry.commit);
  } catch (error) {
    failures.push({
      repo: entry.repo,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
console.log(JSON.stringify({ root, repos: repos.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
