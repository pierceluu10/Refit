// Rebuilds the Shopify benchmark root from the frozen list: shallow clones at the recorded commits,
// and each pinned Admin API schema, checked against its recorded SHA-256. It writes the selected
// part of the list to <root>/list.json for `npm run benchmark:shopify -- --list`.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { listSlice } from './aws-benchmark-helpers.mjs';

const execute = promisify(execFile);
const PINNED = 'docs/benchmarks/2026-10-16-shopify-repos.json';
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string' },
    offset: { type: 'string' },
    limit: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/shopify-benchmark-setup.mjs --root <dir> [--list <frozen.json>] [--offset N] [--limit N]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const pinned = JSON.parse(await readFile(values.list ?? PINNED, 'utf8'));
// --offset and --limit build one shard's slice; the benchmark then reads <root>/list.json.
const repos = listSlice(pinned.repos, values.offset, values.limit);
await mkdir(join(root, 'snapshots'), { recursive: true });
await mkdir(join(root, 'repos'), { recursive: true });
await writeFile(join(root, 'list.json'), `${JSON.stringify({ ...pinned, repos }, null, 2)}\n`);

for (const { version, sha256 } of pinned.schemas.versions) {
  const path = join(root, 'snapshots', `${version}.json`);
  if (!existsSync(path))
    await execute(process.execPath, [
      'bin/refit.mjs',
      'shopify-snapshot',
      '--version',
      version,
      '--output',
      path,
    ]);
  const snapshot = JSON.parse(await readFile(path, 'utf8'));
  const hash = createHash('sha256').update(snapshot.content).digest('hex');
  if (hash !== sha256)
    throw new Error(
      `Shopify ${version} schema is ${hash}, not the pinned ${sha256}; Shopify changed a published version.`,
    );
}

const failures = [];
for (const [index, entry] of repos.entries()) {
  console.error(`[${index + 1}/${repos.length}] ${entry.repo}`);
  try {
    // Reuses a clone only at the pinned commit and removes one whose fetch failed, so a rerun
    // retries it instead of leaving an empty checkout for the benchmark to read.
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
