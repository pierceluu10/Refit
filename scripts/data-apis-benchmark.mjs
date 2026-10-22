// Scans the frozen data-APIs sample with this checkout's `refit agents` and `refit deadlines` and
// writes per-repository detections and deadline exposures. Repository code is never installed or
// run. Fetch the repositories first with scripts/data-apis-select.mjs.
//
//   node scripts/data-apis-benchmark.mjs --root <dir> [--output results.json]
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-data-apis-repos.json' },
    output: { type: 'string', default: 'docs/benchmarks/2026-10-22-data-apis-results.json' },
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
  },
});
if (!values.root) {
  console.log('Usage: node scripts/data-apis-benchmark.mjs --root <dir> [--output <file>]');
  process.exit(1);
}
const cli = join(resolve(values.refit), 'bin', 'refit.mjs');
const run = async (command, directory) => {
  const options = { maxBuffer: 256 * 1024 * 1024, timeout: 300_000 };
  try {
    return JSON.parse(
      (await execute('node', [cli, command, '--repository', directory, '--json'], options)).stdout,
    );
  } catch (error) {
    // `deadlines` exits 2 only with --fail-within; any other failure is a real error.
    return { error: String(error.message).split('\n')[0].slice(0, 200) };
  }
};
const refit = (await execute('git', ['-C', values.refit, 'rev-parse', 'HEAD'])).stdout.trim();
const dirty = Boolean(
  (await execute('git', ['-C', values.refit, 'status', '--porcelain'])).stdout.trim(),
);
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
const results = [];
for (const entry of pinned.repos) {
  const directory = join(resolve(values.root), entry.repo.replace('/', '__'));
  const agents = await run('agents', directory);
  const deadlines = await run('deadlines', directory);
  results.push({
    repo: entry.repo,
    provider: entry.provider,
    commit: entry.commit,
    ...(agents.error || deadlines.error
      ? { error: agents.error ?? deadlines.error }
      : {
          detected: agents.detected.map((item) => ({
            id: item.id,
            packages: item.packages.map((p) => `${p.name}@${p.locked ?? p.version}`),
            hostnames: item.hostnames.map((h) => `${h.file}:${h.line} ${h.hostname}`),
            requests: item.requests.map((r) => `${r.file}:${r.line} ${r.host} ${r.client}`),
          })),
          exposures: deadlines.exposures.map((item) => ({
            id: item.deadline.id,
            evidence: item.evidence.map((e) => ({
              file: e.file,
              line: e.line,
              kind: e.kind,
              text: e.text,
            })),
          })),
        }),
  });
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, refit, dirty, scannedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(
  `${results.length} repositories scanned, ${results.filter((item) => item.error).length} failed (refit ${refit.slice(0, 7)}${dirty ? ', dirty tree' : ''})`,
);
