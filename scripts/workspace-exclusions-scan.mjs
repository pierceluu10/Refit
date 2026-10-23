// Runs detectProviders and scanDeadlines on every monorepo in the frozen sets
// (docs/benchmarks/2026-10-22-workspace-monorepos.json) and lists each finding Refit places on an
// excluded path, with its reason. Before workspace attribution every one of these counted as live:
// detections had no live/non-live split, and an excluded deadline match was use `live`. Checkouts
// must sit at their frozen commits under --root/<owner>__<name>@<commit prefix>. Files are read
// only: nothing is installed or run.
//
//   node scripts/workspace-exclusions-scan.mjs --list <monorepos.json> --root <dir> --output <scan.json>
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { detectProviders } from '../pipeline/agent-catalog.ts';
import { scanDeadlines } from '../pipeline/deadline-exposure.ts';
import { loadDeadlineRegistry } from '../pipeline/deadline-registry.ts';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: { list: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' } },
});
const NOW = new Date('2026-10-22T00:00:00Z');
const listing = JSON.parse(await readFile(values.list, 'utf8'));
const registry = await loadDeadlineRegistry();
const { stdout: refitCommit } = await execute('git', ['rev-parse', 'HEAD']);
const { stdout: dirty } = await execute('git', ['status', '--porcelain']);
const repositories = [];
for (const entry of listing.results.filter((item) => item.monorepo)) {
  const directory = join(
    values.root,
    `${entry.repo.replace('/', '__')}@${entry.commit.slice(0, 12)}`,
  );
  const result = {
    repository: entry.repo,
    commit: entry.commit,
    findings: 0,
    live: 0,
    outsideRoot: 0,
    excluded: [],
  };
  try {
    const { stdout } = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']);
    if (stdout.trim() !== entry.commit) throw new Error(`checkout is at ${stdout.trim()}`);
    const add = (kind, provider, item, live) => {
      result.findings += 1;
      if (live) result.live += 1;
      if (item.workspace && item.workspace.path !== '.') result.outsideRoot += 1;
      if (item.excluded)
        result.excluded.push({ kind, provider, file: item.file, reason: item.excluded });
    };
    for (const detection of await detectProviders(directory)) {
      for (const item of detection.packages)
        add('package', detection.agent.id, item, !item.excluded);
      for (const item of detection.hostnames)
        add('hostname', detection.agent.id, item, !item.excluded);
    }
    const scan = await scanDeadlines(directory, registry, NOW);
    for (const exposure of [...scan.exposures, ...scan.mentions])
      for (const item of [...exposure.evidence, ...exposure.nonLive])
        if (item.use === 'live') add('deadline', exposure.deadline.provider, item, !item.excluded);
  } catch (error) {
    result.error = String(error.message).split('\n')[0];
  }
  repositories.push(result);
}
const excluded = repositories.flatMap((item) =>
  item.excluded.map((finding) => ({ repository: item.repository, ...finding })),
);
const byReason = {};
for (const finding of excluded) byReason[finding.reason] = (byReason[finding.reason] ?? 0) + 1;
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      refitCommit: refitCommit.trim(),
      dirty: Boolean(dirty.trim()),
      now: NOW.toISOString(),
      repositories: repositories.length,
      errors: repositories.filter((item) => item.error).length,
      findings: repositories.reduce((sum, item) => sum + item.findings, 0),
      liveAfter: repositories.reduce((sum, item) => sum + item.live, 0),
      outsideRoot: repositories.reduce((sum, item) => sum + item.outsideRoot, 0),
      excluded: excluded.length,
      repositoriesWithExcluded: repositories.filter((item) => item.excluded.length).length,
      byReason,
      results: repositories,
    },
    null,
    2,
  )}\n`,
);
