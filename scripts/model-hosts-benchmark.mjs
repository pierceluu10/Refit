// Runs Refit's cloud-hosted model detection on the frozen sample
// (docs/benchmarks/2026-10-22-model-hosts-repos.json) and scores it against the blind line labels.
// Each repository must be checked out at its frozen commit under --root/<owner>_<name>. The
// detector is run on the JS/TS files this script reads (skipping installed and build directories),
// and readRepository is tried too, to record which repositories exceed Refit's scan limits. Files
// are read only: nothing is installed or run.
//
//   node scripts/model-hosts-benchmark.mjs --list <frozen.json> --labels <labels.json> --root <dir> --output <results.json>
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { loadDeadlineRegistry } from '../pipeline/deadline-registry.ts';
import { detectModelHosts, hostDeadlineMatches } from '../pipeline/model-hosts.ts';
import { scoreModelHosts } from '../pipeline/model-hosts-score.ts';
import { readRepository } from '../pipeline/repository.ts';

const execute = promisify(execFile);
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.refit']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    labels: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
  },
});

async function sources(root, directory = root, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !SKIP.has(entry.name)) await sources(root, path, found);
    else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts'))
      found.push({ path: relative(root, path), content: await readFile(path, 'utf8') });
  }
  return found;
}

const frozen = JSON.parse(await readFile(values.list, 'utf8'));
const labels = JSON.parse(await readFile(values.labels, 'utf8'));
const { stdout: refitCommit } = await execute('git', ['rev-parse', 'HEAD']);
const { stdout: dirty } = await execute('git', ['status', '--porcelain', '--', 'pipeline']);
const results = [];
for (const entry of frozen.repos) {
  const directory = join(values.root, entry.repo.replace('/', '_'));
  const result = { host: entry.host, repo: entry.repo, commit: entry.commit };
  try {
    const { stdout } = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']);
    if (stdout.trim() !== entry.commit) throw new Error(`checkout is at ${stdout.trim()}`);
    const sites = detectModelHosts({ files: await sources(directory) });
    result.sites = sites.map(({ text, ...site }) => site);
    try {
      await readRepository(directory);
    } catch (error) {
      result.scanLimit = String(error.message).split('\n')[0];
    }
  } catch (error) {
    result.error = String(error.message).split('\n')[0];
    result.sites = [];
  }
  results.push(result);
  console.error(`${entry.host} ${entry.repo} ${result.error ?? result.sites.length}`);
}
const scored = labels.repositories.flatMap((repository) =>
  repository.lines.map((line) => ({ ...line, at: `${repository.repository}/${line.at}` })),
);
const score = scoreModelHosts(
  scored,
  results.flatMap((result) =>
    result.sites.map((site) => ({ ...site, file: `${result.repo}/${site.file}` })),
  ),
);
// OpenRouter IDs (and any Bedrock or Azure site with its own entry) that reach a registry deadline.
const registry = await loadDeadlineRegistry();
const hasEntry = (provider, version) =>
  registry.deadlines.some(
    (entry) => entry.provider === provider && entry.versions.includes(version),
  );
const routes = { sites: 0, repositories: 0, byModel: {} };
for (const result of results) {
  const matches = hostDeadlineMatches(
    result.sites.map((site) => ({ ...site, text: '' })),
    hasEntry,
  );
  routes.sites += matches.length;
  if (matches.length) routes.repositories += 1;
  for (const match of matches) {
    const key = `${match.provider}:${match.version}`;
    routes.byModel[key] = (routes.byModel[key] ?? 0) + 1;
  }
}
const byHost = {};
for (const result of results) {
  const summary = (byHost[result.host] ??= {
    repositories: 0,
    withSite: 0,
    sites: 0,
    scanLimit: 0,
  });
  summary.repositories += 1;
  summary.sites += result.sites.length;
  if (result.sites.some((site) => site.host === result.host)) summary.withSite += 1;
  if (result.scanLimit) summary.scanLimit += 1;
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, refitCommit: refitCommit.trim(), pipelineDirty: Boolean(dirty.trim()), byHost, routes, score, results }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    { byHost, overall: score.overall, byHostScore: score.byHost, uses: score.truePositivesByUse },
    null,
    1,
  ),
);
