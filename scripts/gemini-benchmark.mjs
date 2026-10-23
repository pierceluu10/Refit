// Runs `refit deadlines` on the frozen Gemini benchmark list (scripts/ai-sdk-select.mjs --provider
// gemini). Each repository is fetched at its recorded commit into --root; Refit reads files only,
// with no install, no repository code run and no provider contacted.
//
// Two passes per repository:
// - the shipped registry, whose Gemini entries are the old SDK's end of support and, since
//   2026-10-22, the dated shutdowns on Google's Gemini API deprecations page;
// - a census registry written to --root for that repository alone, listing every quoted
//   Gemini-shaped model ID its source names, with a placeholder date. It measures how the matcher
//   classifies Gemini pins (live, catalog, test, check, comment) and which model sites the
//   report-only Gemini tracers reach (`refit deadlines --propose-model-fixes`). Its dates mean
//   nothing and it is never written to data/deadlines.json.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;
const SCAN_TIMEOUT_MS = 120_000;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor']);
const GEMINI_LITERAL = /(['"`])(?:models\/)?(gemini-[a-z0-9][a-z0-9.-]*)\1/g;
const SDK_IMPORT = /['"](?:@google\/genai|@google\/generative-ai)(?:\/[\w-]+)?['"]/;
const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.list || !values.root || !values.output) {
  console.log(
    'Usage: node scripts/gemini-benchmark.mjs --list <frozen.json> --root <dir> --output <results.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const frozen = JSON.parse(await readFile(values.list, 'utf8'));
const root = resolve(values.root);
await mkdir(root, { recursive: true });
const refit = resolve('bin/refit.mjs');

async function checkout(entry) {
  const directory = join(root, entry.repo.replace('/', '__'));
  if (existsSync(join(directory, '.git'))) return directory;
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
    { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  );
  await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
  return directory;
}

async function refitJson(args) {
  try {
    const { stdout } = await execute(process.execPath, [refit, ...args, '--json'], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: SCAN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return { result: JSON.parse(stdout) };
  } catch (error) {
    if (error.killed) return { error: `timed out after ${SCAN_TIMEOUT_MS / 1000} s` };
    return {
      error: String(error.stderr || error.message)
        .trim()
        .split('\n')
        .at(-1),
    };
  }
}

// Source files and the Gemini-shaped IDs they quote, read without running anything.
async function sources(directory) {
  const files = new Map();
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await visit(child);
      } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts'))
        files.set(relative(directory, child).split('\\').join('/'), await readFile(child, 'utf8'));
    }
  };
  await visit(directory);
  const ids = new Set();
  for (const content of files.values())
    for (const match of content.matchAll(GEMINI_LITERAL)) ids.add(match[2]);
  return { files, ids: [...ids].sort() };
}

const results = [];
for (const [index, entry] of frozen.repos.entries()) {
  console.error(`[${index + 1}/${frozen.repos.length}] ${entry.repo}`);
  let directory;
  try {
    directory = await checkout(entry);
  } catch (error) {
    results.push({ repo: entry.repo, commit: entry.commit, error: `checkout: ${error.message}` });
    continue;
  }
  const shipped = await refitJson(['deadlines', '--repository', directory]);
  const { files, ids } = await sources(directory);
  const registryPath = join(root, `${entry.repo.replace('/', '__')}.census.json`);
  await writeFile(
    registryPath,
    `${JSON.stringify({
      formatVersion: 1,
      deadlines: ids.map((id, position) => ({
        id: `census-${position}`,
        provider: 'gemini',
        kind: 'model',
        versions: [id],
        date: '2099-12-31',
        summary: 'Census placeholder, not a Google date.',
        replacement: null,
        source: 'https://census.invalid/not-a-google-date',
        checkedAt: '2026-10-21',
      })),
    })}\n`,
  );
  const census = ids.length
    ? await refitJson(['deadlines', '--repository', directory, '--registry', registryPath])
    : { result: { exposures: [], mentions: [] } };
  // What the report-only Gemini tracers reach: every stop's model site, with the census registry.
  const proposal = ids.length
    ? await refitJson([
        'deadlines',
        '--propose-model-fixes',
        '--repository',
        directory,
        '--registry',
        registryPath,
      ])
    : { result: { stops: [] } };
  const items = [...(census.result?.exposures ?? []), ...(census.result?.mentions ?? [])].flatMap(
    (exposure) => [...exposure.evidence, ...exposure.nonLive],
  );
  const capped = [...(census.result?.exposures ?? []), ...(census.result?.mentions ?? [])].reduce(
    (total, exposure) => total + exposure.more + exposure.nonLiveMore,
    0,
  );
  const uses = {};
  for (const item of items) uses[item.use] = (uses[item.use] ?? 0) + 1;
  const live = items.filter((item) => item.use === 'live');
  results.push({
    repo: entry.repo,
    commit: entry.commit,
    sdk: entry.sdk,
    ...(shipped.error || census.error ? { error: shipped.error ?? census.error } : {}),
    shippedExposures: (shipped.result?.exposures ?? [])
      .filter((exposure) => exposure.deadline.provider === 'gemini')
      .map((exposure) => ({
        deadline: exposure.deadline.id,
        date: exposure.deadline.date,
        evidence: exposure.evidence.map((item) => `${item.file}:${item.line}`),
        nonLive: exposure.nonLive.map((item) => `${item.file}:${item.line} ${item.use}`),
      })),
    geminiIds: ids.length,
    uses,
    capped,
    // Live pins in a file that imports either Gemini SDK, where a call can send them directly.
    liveInSdkFiles: live.filter((item) => SDK_IMPORT.test(files.get(item.file) ?? '')).length,
    live: live.map((item) => `${item.file}:${item.line} ${item.version}`),
    matches: items.map((item) => `${item.file}:${item.line} ${item.version} ${item.use}`),
    traced: (proposal.result?.stops ?? [])
      .filter((stop) => stop.provider === 'gemini')
      .map((stop) => `${stop.at.file}:${stop.at.line} ${stop.model}`),
    ...(proposal.error ? { tracerError: proposal.error } : {}),
  });
}

const scanned = results.filter((item) => !item.error);
const total = (key) => scanned.reduce((sum, item) => sum + (item.uses?.[key] ?? 0), 0);
const summary = {
  repositories: results.length,
  errors: results.filter((item) => item.error).length,
  timedOut: results.filter((item) => item.error?.startsWith('timed out')).length,
  declaresOldSdk: frozen.repos.filter((item) => item.sdk === '@google/generative-ai').length,
  // Any shipped Gemini deadline: the old SDK's end of support or a dated model shutdown.
  exposedToShippedDeadlines: scanned.filter((item) => item.shippedExposures.length).length,
  withGeminiIds: scanned.filter((item) => item.geminiIds).length,
  withLivePins: scanned.filter((item) => item.uses.live).length,
  pins: {
    live: total('live'),
    catalog: total('catalog'),
    test: total('test'),
    check: total('check'),
    comment: total('comment'),
    tokenizer: total('tokenizer'),
  },
  liveInSdkFiles: scanned.reduce((sum, item) => sum + item.liveInSdkFiles, 0),
  traced: scanned.reduce((sum, item) => sum + item.traced.length, 0),
  cappedNotListed: scanned.reduce((sum, item) => sum + item.capped, 0),
};
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      list: values.list,
      provider: 'gemini',
      ranAt: new Date().toISOString(),
      note: 'refit deadlines at each frozen commit with the shipped registry, then with a per-repository census registry naming every quoted Gemini-shaped model ID under a placeholder date. Files read only; no install, no code run, no provider contacted. Census counts measure classification, not exposure to any Google date.',
      summary,
      results,
    },
    null,
    2,
  )}\n`,
);
console.error(JSON.stringify(summary));
