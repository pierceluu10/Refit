// Runs Refit's provider detection on the inventory benchmark's frozen repositories and scores it
// against the hand labels (docs/INVENTORY-BENCHMARK.md). Detection is every detector command the
// Refit checkout has that names the providers a repository uses (DETECTORS below). --refit points
// at another clean checkout, such as a teammate's branch, which is only read and run, never edited.
// Repository checkouts are shallow at the pinned commit, without submodules; nothing in them is
// installed or run. With --results and no --root, it only rescores a saved results file.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { shallowCheckout } from './ai-app-helpers.mjs';
import { scoreInventory, validateLabels } from './inventory-benchmark-helpers.mjs';

const execute = promisify(execFile);
// Repositories that declare a Git LFS filter fail to check out without git-lfs installed. Turning
// the filter off for every git child process keeps LFS pointers as plain text, which is all a scan needs.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'filter.lfs.process',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'filter.lfs.smudge',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'filter.lfs.required',
  GIT_CONFIG_VALUE_2: 'false',
});
const { values } = parseArgs({
  options: {
    refit: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-inventory-repos.json' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-inventory-labels.json' },
    root: { type: 'string' },
    results: { type: 'string' },
    score: { type: 'string' },
    aliases: { type: 'string' },
    'allow-dirty': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.results) {
  console.log(
    'Usage: node scripts/inventory-benchmark.mjs --results <results.json> [--root <checkouts>] [--refit <checkout>] [--score <score.json>] [--aliases <aliases.json>] [--list <frozen.json>] [--labels <labels.json>] [--allow-dirty]\nWith --root it runs detection and writes --results; without it, it rescores --results.',
  );
  process.exit(values.help ? 0 : 1);
}
const REFIT = resolve(values.refit ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const files = (items) => [...new Set(items)].sort();

// Each detector command and how its JSON names providers. Commands the checkout lacks are skipped.
const DETECTORS = {
  // detectProviders: manifests, lockfiles and catalog API hostnames.
  agents: (json) =>
    json.detected.map((item) => ({
      provider: item.id,
      files: files([
        ...item.packages.map((p) => p.file),
        ...item.hostnames.map((h) => `${h.file}:${h.line}`),
      ]),
    })),
  // Live deadline exposures name their provider.
  deadlines: (json) =>
    (json.exposures ?? []).map((item) => ({
      provider: item.deadline.provider,
      files: files(item.evidence.map((e) => `${e.file}:${e.line}`)),
    })),
  // Raw HTTP hosts with a known provider.
  'api-hosts': (json) =>
    (json.hosts ?? [])
      .filter((item) => item.provider)
      .map((item) => ({
        provider: item.provider.id,
        files: files((item.calls ?? []).map((c) => `${c.file}:${c.line}`)),
      })),
  // Live AWS and Azure SDK clients; the SDK id starts with the provider.
  'cloud-sdk': (json) =>
    (json.clients ?? [])
      .filter((item) => item.use !== 'test')
      .map((item) => ({
        provider: item.sdk.startsWith('azure') ? 'azure' : 'aws',
        files: [`${item.file}:${item.line}`],
      })),
  // Live Slack Web API calls, incoming webhooks and RTM connections.
  slack: (json) => {
    const live = [...(json.calls ?? []), ...(json.webhooks ?? []), ...(json.rtm ?? [])].filter(
      (item) => item.use !== 'test',
    );
    return live.length
      ? [{ provider: 'slack', files: files(live.map((c) => `${c.file}:${c.line}`)) }]
      : [];
  },
};
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
  const { stdout: usage } = await execute(
    process.execPath,
    [join(REFIT, 'bin/refit.mjs'), '--help'],
    {
      cwd: REFIT,
    },
  );
  const detectors = Object.keys(DETECTORS).filter((name) =>
    new RegExp(`^  ${name} `, 'm').test(usage),
  );
  const repos = [];
  for (const entry of list.repos) {
    const result = { repo: entry.repo, group: entry.group, commit: entry.commit, detections: [] };
    const errors = [];
    let directory;
    try {
      directory = await shallowCheckout(values.root, entry.repo, entry.commit);
    } catch (error) {
      errors.push(`checkout: ${String(error.message).split('\n')[0]}`);
    }
    // A detector that fails is recorded; the repository errors only when every detector failed.
    for (const name of directory ? detectors : []) {
      try {
        const json = await refitJson([name, '--json', '--repository', directory]);
        for (const item of DETECTORS[name](json))
          result.detections.push({ ...item, detector: name });
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
      }
    }
    if (errors.length) result.detectorErrors = errors;
    if (!directory || errors.length === detectors.length) result.error = errors.join('; ');
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
        detectors,
        catalog,
        repos,
      },
      null,
      2,
    )}\n`,
  );
}

const results = await read(values.results);
// A detector's provider id that names the same provider as a label id under another spelling
// (`{"mistral-ai": "mistral"}`). The map is recorded with the score.
const aliases = values.aliases ? await read(values.aliases) : {};
for (const repo of results.repos)
  for (const detection of repo.detections)
    detection.provider = aliases[detection.provider] ?? detection.provider;
const score = { refit: results.refit, aliases, ...scoreInventory(labels, results) };
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
