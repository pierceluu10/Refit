// Runs `refit cloud-sdk` over a frozen cloud SDK benchmark: shallow fetches at the pinned commits and
// one scan per repository, then a summary of which repositories still construct AWS SDK v2 clients,
// for which services, and how many also use v3. With --labels it scores the labelled repositories
// (scripts/cloud-sdk-score.mjs). Repository code is never installed or run, and neither AWS nor
// Azure is contacted.
//
//   node scripts/cloud-sdk-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] \
//     [--labels <labels.json>] [--output <file>]
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { scoreCloudSdk } from './cloud-sdk-score.mjs';

const execute = promisify(execFile);
const SCAN_TIMEOUT_MS = 180_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-cloud-sdk-repos.json' },
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    labels: { type: 'string' },
    output: { type: 'string', default: 'cloud-sdk-results.json' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/cloud-sdk-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--labels <labels.json>] [--output <file>]',
  );
  process.exit(values.help ? 0 : 1);
}
const refit = join(resolve(values.refit), 'bin', 'refit.mjs');
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
const results = [];
for (const [index, entry] of pinned.repos.entries()) {
  console.error(`[${index + 1}/${pinned.repos.length}] ${entry.repo}`);
  const result = {
    repo: entry.repo,
    commit: entry.commit,
    group: entry.group,
    declared: entry.declared,
  };
  let directory;
  try {
    directory = await shallowCheckout(values.root, entry.repo, entry.commit);
  } catch (error) {
    results.push({ ...result, status: 'not-fetched', error: message(error), clients: [] });
    continue;
  }
  try {
    const { stdout } = await execute(
      process.execPath,
      [refit, 'cloud-sdk', '--repository', directory, '--json'],
      { maxBuffer: 64 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS },
    );
    const report = JSON.parse(stdout);
    results.push({
      ...result,
      status: 'scanned',
      clients: report.clients,
      services: report.services,
      warnings: report.warnings,
    });
  } catch (error) {
    results.push({ ...result, status: 'not-scanned', error: message(error), clients: [] });
  }
}

function message(error) {
  const text = error instanceof Error ? error.stderr || error.message : String(error);
  return String(text).trim().split('\n').at(-1).slice(0, 300);
}

const live = (result, sdk) =>
  result.clients.filter((client) => client.use === 'live' && client.sdk === sdk);
const repositoriesUsing = (sdk) => results.filter((result) => live(result, sdk).length).length;
const services = (sdk) => {
  const counts = new Map();
  for (const result of results)
    for (const service of new Set(live(result, sdk).map((client) => client.service)))
      counts.set(service, (counts.get(service) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
};
const summary = {
  repositories: results.length,
  scanned: results.filter((result) => result.status === 'scanned').length,
  notScanned: results
    .filter((result) => result.status !== 'scanned')
    .map((result) => `${result.repo}: ${result.error}`),
  withLiveV2Clients: repositoriesUsing('aws-sdk-v2'),
  withLiveV3Clients: repositoriesUsing('aws-sdk-v3'),
  halfMigrated: results.filter(
    (result) => live(result, 'aws-sdk-v2').length && live(result, 'aws-sdk-v3').length,
  ).length,
  withLiveAzureLegacyLoads: repositoriesUsing('azure-legacy'),
  liveClients: {
    'aws-sdk-v2': results.reduce((total, result) => total + live(result, 'aws-sdk-v2').length, 0),
    'aws-sdk-v3': results.reduce((total, result) => total + live(result, 'aws-sdk-v3').length, 0),
    'azure-legacy': results.reduce(
      (total, result) => total + live(result, 'azure-legacy').length,
      0,
    ),
  },
  // Repositories per service, counting each repository once per service.
  v2Services: services('aws-sdk-v2'),
  v3Services: services('aws-sdk-v3'),
  azurePackages: services('azure-legacy'),
};
const output = {
  formatVersion: 1,
  list: values.list,
  checkedAt: new Date().toISOString(),
  summary,
  results,
};
if (values.labels)
  output.score = scoreCloudSdk(JSON.parse(await readFile(values.labels, 'utf8')), { results });
await writeFile(join(resolve(values.root), values.output), `${JSON.stringify(output, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      summary,
      score: output.score && { overall: output.score.overall, bySdk: output.score.bySdk },
    },
    null,
    2,
  ),
);
