// Runs Refit's provider detection on the inventory benchmark's frozen repositories and scores it
// against the hand labels (docs/INVENTORY-BENCHMARK.md). Detection is every detector on this
// checkout that names the providers a repository uses: `refit agents --json` (detectProviders)
// and the live exposures of `refit deadlines --json`. Checkouts are shallow at the pinned commit,
// without submodules; nothing in them is installed or run. With --results and no --root, it only
// rescores a saved results file.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { scoreInventory, validateLabels } from './inventory-benchmark-helpers.mjs';

const execute = promisify(execFile);
const REFIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-inventory-repos.json' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-inventory-labels.json' },
    root: { type: 'string' },
    results: { type: 'string' },
    score: { type: 'string' },
    'allow-dirty': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.results) {
  console.log(
    'Usage: node scripts/inventory-benchmark.mjs --results <results.json> [--root <checkouts>] [--score <score.json>] [--list <frozen.json>] [--labels <labels.json>] [--allow-dirty]\nWith --root it runs detection and writes --results; without it, it rescores --results.',
  );
  process.exit(values.help ? 0 : 1);
}
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const list = await read(values.list);
const labels = await read(values.labels);
const problems = validateLabels(list, labels);
if (problems.length) {
  for (const { repo, problem } of problems) console.error(`${repo ?? 'labels'}: ${problem}`);
  throw new Error(
    `${problems.length} label problems; every repository is labelled before scoring.`,
  );
}

async function refitJson(args) {
  try {
    const { stdout } = await execute(process.execPath, [join(REFIT, 'bin/refit.mjs'), ...args], {
      cwd: REFIT,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    // `refit deadlines` exits 2 only with --fail-within, which this script never passes.
    throw new Error(String(error.stderr || error.message).split('\n')[0]);
  }
}

if (values.root) {
  const git = async (...args) => (await execute('git', ['-C', REFIT, ...args])).stdout.trim();
  const commit = await git('rev-parse', 'HEAD');
  const clean = (await git('status', '--porcelain')) === '';
  if (!clean && !values['allow-dirty'])
    throw new Error(
      'The Refit checkout has uncommitted changes; benchmark a clean commit or pass --allow-dirty.',
    );
  const { stdout } = await execute(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      'const m = await import("./pipeline/agent-catalog.ts"); console.log(JSON.stringify(m.AGENT_CATALOG));',
    ],
    { cwd: REFIT },
  );
  const catalog = JSON.parse(stdout).map(({ id, packages, hostnames }) => ({
    id,
    packages,
    hostnames,
  }));
  const repos = [];
  for (const entry of list.repos) {
    const result = { repo: entry.repo, group: entry.group, commit: entry.commit, detections: [] };
    try {
      const directory = await shallowCheckout(values.root, entry.repo, entry.commit);
      const agents = await refitJson(['agents', '--json', '--repository', directory]);
      for (const detected of agents.detected)
        result.detections.push({
          provider: detected.id,
          detector: 'agents',
          files: [
            ...new Set([
              ...detected.packages.map((item) => item.file),
              ...detected.hostnames.map((item) => `${item.file}:${item.line}`),
            ]),
          ].sort(),
        });
      const deadlines = await refitJson(['deadlines', '--json', '--repository', directory]);
      for (const exposure of deadlines.exposures ?? [])
        result.detections.push({
          provider: exposure.deadline.provider,
          detector: 'deadlines',
          files: [...new Set(exposure.evidence.map((item) => `${item.file}:${item.line}`))].sort(),
        });
    } catch (error) {
      result.error = String(error.message).split('\n')[0];
    }
    repos.push(result);
    console.error(
      `${entry.repo}: ${result.error ?? ([...new Set(result.detections.map((d) => d.provider))].join(', ') || 'none')}`,
    );
  }
  const digest = createHash('sha256')
    .update(await readFile(values.list))
    .digest('hex');
  await writeFile(
    resolve(values.results),
    `${JSON.stringify(
      {
        formatVersion: 1,
        ranAt: new Date().toISOString(),
        refit: { commit, clean },
        list: { path: relative(REFIT, resolve(values.list)), sha256: digest },
        detectors: ['agents', 'deadlines'],
        catalog,
        repos,
      },
      null,
      2,
    )}\n`,
  );
}

const results = await read(values.results);
const score = { refit: results.refit, ...scoreInventory(labels, results) };
if (values.score) await writeFile(resolve(values.score), `${JSON.stringify(score, null, 2)}\n`);
const line = (name, tally) =>
  `${name.padEnd(26)} precision ${tally.precision.rate ?? '-'}% (${tally.truePositives}/${tally.truePositives + tally.falsePositives})  recall ${tally.recall.rate ?? '-'}% (${tally.truePositives}/${tally.truePositives + tally.falseNegatives})`;
console.log(
  `Refit ${results.refit.commit}${results.refit.clean ? '' : ' (dirty)'}, ${score.repositories} repositories, ${score.errored.length} errored`,
);
console.log(line('catalog providers', score.catalogProviders));
console.log(line('every labelled provider', score.allProviders));
for (const [provider, tally] of Object.entries(score.perProvider))
  if (tally.inCatalog) console.log(line(`  ${provider}`, tally));
console.log('misses by category:', JSON.stringify(score.missesByCategory));
