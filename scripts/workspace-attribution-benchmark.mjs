// Runs detectProviders and scanDeadlines on the 20 labelled monorepos and scores each finding's
// package attribution and live classification against the blind labels
// (docs/benchmarks/2026-10-22-workspace-labels.json). Checkouts must sit at their frozen commits
// under --root/<owner>__<name>@<commit prefix> (scripts/workspace-monorepos.mjs fetches them).
// Files are read only: nothing is installed or run.
//
//   node scripts/workspace-attribution-benchmark.mjs --labels <labels.json> --root <dir> --output <results.json>
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { detectProviders } from '../pipeline/agent-catalog.ts';
import { scanDeadlines } from '../pipeline/deadline-exposure.ts';
import { loadDeadlineRegistry } from '../pipeline/deadline-registry.ts';
import { scoreAttribution } from '../pipeline/workspace-attribution-score.ts';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: { labels: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' } },
});
// A fixed date, so deadline classification does not drift between the before and after runs.
const NOW = new Date('2026-10-22T00:00:00Z');
const labels = JSON.parse(await readFile(values.labels, 'utf8'));
const registry = await loadDeadlineRegistry();
const { stdout: refitCommit } = await execute('git', ['rev-parse', 'HEAD']);
const { stdout: dirty } = await execute('git', ['status', '--porcelain']);
const results = [];
for (const entry of labels.repositories) {
  const directory = join(
    values.root,
    `${entry.repository.replace('/', '__')}@${entry.commit.slice(0, 12)}`,
  );
  const findings = [];
  let error;
  try {
    const { stdout } = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']);
    if (stdout.trim() !== entry.commit) throw new Error(`checkout is at ${stdout.trim()}`);
    for (const detection of await detectProviders(directory)) {
      for (const item of detection.packages)
        findings.push({
          kind: 'package',
          provider: detection.agent.id,
          file: item.file,
          live: !item.excluded,
          workspace: item.workspace?.path ?? null,
          excluded: item.excluded ?? null,
        });
      for (const item of detection.hostnames)
        findings.push({
          kind: 'hostname',
          provider: detection.agent.id,
          file: item.file,
          live: !item.excluded,
          workspace: item.workspace?.path ?? null,
          excluded: item.excluded ?? null,
        });
    }
    const scan = await scanDeadlines(directory, registry, NOW);
    for (const exposure of [...scan.exposures, ...scan.mentions])
      for (const item of [...exposure.evidence, ...exposure.nonLive])
        findings.push({
          kind: 'deadline',
          provider: exposure.deadline.provider,
          file: item.file,
          live: item.use === 'live' && !item.excluded,
          workspace: item.workspace?.path ?? null,
          excluded: item.excluded ?? null,
        });
  } catch (caught) {
    error = caught.message;
  }
  const score = scoreAttribution(entry.units, findings);
  results.push({
    repository: entry.repository,
    commit: entry.commit,
    ...(error ? { error } : {}),
    score,
    findings,
  });
  console.error(`${entry.repository} ${error ?? `${findings.length} findings`}`);
}
const all = scoreAttribution(
  labels.repositories.flatMap((entry) =>
    entry.units.map((unit) => ({ ...unit, file: `${entry.repository}/${unit.file}` })),
  ),
  results.flatMap((result) =>
    result.findings.map((finding) => ({
      ...finding,
      file: `${result.repository}/${finding.file}`,
    })),
  ),
);
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, refitCommit: refitCommit.trim(), dirty: Boolean(dirty.trim()), now: NOW.toISOString(), score: all, results }, null, 2)}\n`,
);
console.log(JSON.stringify(all));
