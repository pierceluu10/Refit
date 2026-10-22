// Runs Refit's package inventory on the frozen multi-ecosystem sample
// (scripts/package-inventory-select.mjs) and, with --labels, scores it against the blind labels.
// Each repository must already be cloned at its frozen commit under --root/<host>/<path> (the
// selection script leaves them there). Files are read only: nothing is installed or run, and no
// registry or provider is contacted.
//
//   node scripts/package-inventory-benchmark.mjs --list <frozen.json> --root <clones> \
//     --output <results.json> [--labels <labels.json>]
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { AGENT_CATALOG, detectProviders, ecosystemPackages } from '../pipeline/agent-catalog.ts';
import { readPackageManifests } from '../pipeline/package-manifests.ts';
import { scoreInventory } from '../pipeline/package-manifests-score.ts';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
    labels: { type: 'string' },
  },
});
if (!values.list || !values.root || !values.output)
  throw new Error(
    'Usage: package-inventory-benchmark.mjs --list <frozen.json> --root <clones> --output <results.json>',
  );

const frozen = JSON.parse(await readFile(values.list, 'utf8'));
const { stdout: refitCommit } = await execute('git', ['rev-parse', 'HEAD']);
const { stdout: dirty } = await execute('git', ['status', '--porcelain', '--', 'pipeline']);
const results = [];
for (const entry of frozen.repositories) {
  const directory = join(values.root, entry.host, entry.repository);
  const result = { ecosystem: entry.ecosystem, repository: entry.repository, commit: entry.commit };
  try {
    const { stdout } = await execute('git', ['-C', directory, 'rev-parse', 'HEAD']);
    if (stdout.trim() !== entry.commit) throw new Error(`checkout is at ${stdout.trim()}`);
    const inventory = await readPackageManifests(directory);
    result.manifests = {};
    for (const manifest of inventory.manifests)
      result.manifests[manifest.ecosystem] = (result.manifests[manifest.ecosystem] ?? 0) + 1;
    result.dependencies = inventory.dependencies.length;
    result.locked = inventory.dependencies.filter((item) => item.locked).length;
    result.stops = inventory.stops;
    // The product path: detectProviders, which also reads npm manifests and source hostnames.
    let detections;
    try {
      detections = await detectProviders(directory);
    } catch (error) {
      // detectProviders reads JS/TS source too and refuses repositories over its scan limits;
      // the other ecosystems' evidence is still recorded, separately.
      result.detectError = error.message;
      detections = AGENT_CATALOG.map((agent) => ({
        agent,
        packages: ecosystemPackages(agent, inventory),
        hostnames: [],
      })).filter((item) => item.packages.length);
    }
    const units = new Map();
    for (const detection of detections)
      for (const item of detection.packages) {
        const unit = {
          provider: detection.agent.id,
          ecosystem: item.ecosystem ?? 'npm',
          file: item.file,
        };
        units.set(`${unit.provider}\0${unit.ecosystem}\0${unit.file}`, unit);
      }
    result.units = [...units.values()];
    result.packages = detections.flatMap((detection) =>
      detection.packages.map((item) => ({ provider: detection.agent.id, ...item })),
    );
  } catch (error) {
    result.error = error.message;
    result.units = [];
  }
  results.push(result);
  console.error(`${entry.ecosystem} ${entry.repository} ${result.error ?? result.units.length}`);
}

const byEcosystem = {};
for (const result of results) {
  const summary = (byEcosystem[result.ecosystem] ??= {
    repositories: 0,
    withManifest: 0,
    withProvider: 0,
    withStop: 0,
    errors: 0,
  });
  summary.repositories += 1;
  if (result.error) summary.errors += 1;
  if (result.manifests?.[result.ecosystem]) summary.withManifest += 1;
  if (result.units.some((unit) => unit.ecosystem === result.ecosystem)) summary.withProvider += 1;
  if (result.stops?.length) summary.withStop += 1;
}
const report = {
  formatVersion: 1,
  refitCommit: refitCommit.trim(),
  pipelineDirty: Boolean(dirty.trim()),
  list: values.list,
  byEcosystem,
  ...(values.labels
    ? {
        score: scoreInventory(
          JSON.parse(await readFile(values.labels, 'utf8')).repositories,
          results,
        ),
      }
    : {}),
  results,
};
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
