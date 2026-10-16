// Rebuilds the Shopify benchmark root from the frozen list: shallow clones at the recorded commits,
// and each pinned Admin API schema, checked against its recorded SHA-256.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const PINNED = 'docs/benchmarks/2026-10-16-shopify-repos.json';
const GIT_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string' },
    limit: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/shopify-benchmark-setup.mjs --root <dir> [--list <frozen.json>] [--limit N]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const pinned = JSON.parse(await readFile(values.list ?? PINNED, 'utf8'));
const repos = pinned.repos.slice(0, values.limit ? Number(values.limit) : undefined);
await mkdir(join(root, 'snapshots'), { recursive: true });
await mkdir(join(root, 'repos'), { recursive: true });

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
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  if (existsSync(join(directory, '.git'))) continue;
  console.error(`[${index + 1}/${repos.length}] ${entry.repo}`);
  try {
    await execute('git', ['init', '-q', directory]);
    await execute(
      'git',
      [
        '-C',
        directory,
        'fetch',
        '-q',
        '--depth',
        '1',
        `https://github.com/${entry.repo}`,
        entry.commit,
      ],
      { timeout: GIT_TIMEOUT_MS },
    );
    await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
  } catch (error) {
    failures.push({
      repo: entry.repo,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
console.log(JSON.stringify({ root, repos: repos.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
