// Measures `refit meta-graph` on the Meta repositories of the frozen deadline benchmark: shallow
// clones at the pinned commits, a scan of each, then scores against hand labels. Repository code
// is never installed or run, and Meta is never contacted.
//
//   node scripts/meta-graph-benchmark.mjs --root <dir> [--refit <checkout>] [--output results.json]
//   node scripts/meta-graph-benchmark.mjs --root <dir> --score [--labels <labels.json>]
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-16-deadline-repos.json' },
    refit: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    output: { type: 'string', default: 'meta-graph-results.json' },
    score: { type: 'boolean' },
    // Scores a saved results file, such as the committed docs/benchmarks one, instead.
    results: { type: 'string' },
    labels: {
      type: 'string',
      default: 'docs/benchmarks/2026-10-20-meta-graph-call-labels.json',
    },
    'deadline-labels': {
      type: 'string',
      default: 'docs/benchmarks/2026-10-16-deadline-labels.json',
    },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/meta-graph-benchmark.mjs --root <dir> [--list <repos.json>] [--refit <checkout>] [--output <file>] [--score [--labels <file>]]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const resultsPath = values.results ? resolve(values.results) : join(root, values.output);
if (values.score) await score();
else await scan();

async function scan() {
  const refit = join(resolve(values.refit), 'bin', 'refit.mjs');
  const pinned = JSON.parse(await readFile(values.list, 'utf8'));
  const repos = pinned.repos.filter((entry) => entry.provider === 'meta-graph');
  await mkdir(join(root, 'repos'), { recursive: true });
  const results = [];
  const failures = [];
  for (const [index, entry] of repos.entries()) {
    const directory = join(root, 'repos', entry.repo.replace('/', '__'));
    console.error(`[${index + 1}/${repos.length}] ${entry.repo}`);
    try {
      if (!existsSync(join(directory, '.git'))) {
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
      }
      const { stdout } = await execute(
        process.execPath,
        [refit, 'meta-graph', '--repository', directory, '--json'],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const report = JSON.parse(stdout);
      results.push({
        repo: entry.repo,
        commit: entry.commit,
        calls: report.calls,
        sdk: report.sdk,
      });
    } catch (error) {
      failures.push({
        repo: entry.repo,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ root, repos: repos.length, scanned: results.length, failures }));
  if (failures.length) process.exitCode = 1;
}

function rate(hit, total) {
  return total ? `${hit}/${total} (${((100 * hit) / total).toFixed(1)}%)` : '0/0';
}

// Scores reported calls against hand labels. Each label judges one reported call: whether it is
// a real Graph API request, and whether each value the call reports as known is right.
async function score() {
  const saved = JSON.parse(await readFile(resultsPath, 'utf8'));
  const results = Array.isArray(saved) ? saved : saved.results;
  const labels = JSON.parse(await readFile(values.labels, 'utf8'));
  const deadline = JSON.parse(await readFile(values['deadline-labels'], 'utf8'));
  const byKey = new Map(
    labels.calls.map((label) => [`${label.repo}\t${label.file}\t${label.line}`, label]),
  );
  const attributes = ['version', 'path', 'edge', 'fields', 'metrics', 'method'];
  const tally = {
    calls: 0,
    live: 0,
    unlabelled: [],
    request: 0,
    allCorrect: 0,
    known: Object.fromEntries(attributes.map((name) => [name, 0])),
    correct: Object.fromEntries(attributes.map((name) => [name, 0])),
    wrong: [],
  };
  for (const result of results)
    for (const call of result.calls) {
      if (call.use !== 'live') continue;
      tally.live += 1;
      const label = byKey.get(`${result.repo}\t${call.file}\t${call.line}`);
      if (!label) {
        tally.unlabelled.push(`${result.repo} ${call.file}:${call.line}`);
        continue;
      }
      tally.calls += 1;
      if (label.request) tally.request += 1;
      let right = label.request;
      for (const name of attributes) {
        // A known path with no edge is a node read, so its edge (none) is known too.
        if ((name === 'edge' ? call.path : call[name]) === null) continue;
        tally.known[name] += 1;
        if (label.wrong?.includes(name)) {
          right = false;
          tally.wrong.push(`${result.repo} ${call.file}:${call.line} ${name}: ${label.note}`);
        } else tally.correct[name] += 1;
      }
      if (right) tally.allCorrect += 1;
    }
  // Recall against the deadline benchmark's labelled live Graph API pins: a pin counts as found
  // when a reported call is made on its line or pins its version there.
  const pins = deadline.labels.filter(
    (label) => label.label === 'live' && /^v\d+\.\d+$/.test(label.version),
  );
  const found = pins.filter((pin) => {
    const result = results.find((item) => item.repo === pin.repo);
    return result?.calls.some(
      (call) =>
        (call.file === pin.file && call.line === pin.line) ||
        (call.pin?.file === pin.file && call.pin.line === pin.line),
    );
  });
  const missed = pins.filter((pin) => !found.includes(pin));
  const summary = {
    repositories: results.length,
    repositoriesWithCalls: results.filter((result) =>
      result.calls.some((call) => call.use === 'live'),
    ).length,
    liveCalls: tally.live,
    labelled: tally.calls,
    unlabelled: tally.unlabelled,
    requestPrecision: rate(tally.request, tally.calls),
    allValuesCorrect: rate(tally.allCorrect, tally.calls),
    known: Object.fromEntries(
      attributes.map((name) => [name, rate(tally.known[name], tally.calls)]),
    ),
    precision: Object.fromEntries(
      attributes.map((name) => [name, rate(tally.correct[name], tally.known[name])]),
    ),
    wrong: tally.wrong,
    deadlinePinRecall: rate(found.length, pins.length),
    missedPins: missed.map((pin) => `${pin.repo} ${pin.file}:${pin.line} ${pin.note ?? ''}`.trim()),
  };
  console.log(JSON.stringify(summary, null, 2));
}
