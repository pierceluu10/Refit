// The AI application model-site benchmark (docs/AI-APP-PRECISION.md). Four steps:
//   candidates  check out the sampled repositories and write the labeller's independent search,
//               one text file per repository, outside the repository; no pipeline code is used;
//   negatives   print the seeded draw order of negative-file candidates from that search;
//   run         run `refit deadlines --json` on each sampled repository and save the results;
//   score       score the results against the committed site labels, per set.
// Checkouts are shallow at the pinned commit, without submodules; nothing in them is installed or
// run, and no provider is contacted.
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { seededSample, shallowCheckout } from './ai-app-helpers.mjs';
import {
  SETS,
  isProduction,
  modelCandidates,
  scoreSet,
  seededOrder,
  talksToProvider,
  validateSiteLabels,
} from './ai-app-precision-summary.mjs';

const execute = promisify(execFile);
// Repositories that declare a Git LFS filter fail to check out without git-lfs installed; with the
// filter off, LFS pointers stay plain text.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'filter.lfs.process',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'filter.lfs.smudge',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'filter.lfs.required',
  GIT_CONFIG_VALUE_2: 'false',
});
const REFIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SEED = 20261022;
const FRACTION = { openai: 0.4, anthropic: 0.5 };
const LISTS = {
  openai: 'docs/benchmarks/2026-10-21-openai-app-repos.json',
  anthropic: 'docs/benchmarks/2026-10-21-anthropic-app-repos.json',
};
const MAX_FILE_BYTES = 1024 * 1024;

const [step] = process.argv.slice(2);
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    root: { type: 'string' },
    output: { type: 'string' },
    results: { type: 'string' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-ai-app-model-sites.json' },
    registry: { type: 'string', default: 'data/deadlines.json' },
    help: { type: 'boolean' },
  },
});
const usage =
  'Usage: node scripts/ai-app-precision.mjs candidates --root <checkouts> --output <dir>\n' +
  '       node scripts/ai-app-precision.mjs negatives --output <dir>\n' +
  '       node scripts/ai-app-precision.mjs run --root <checkouts> --results <results.json>\n' +
  '       node scripts/ai-app-precision.mjs score --results <results.json> [--labels <labels.json>] [--output <score.json>]';
if (values.help || !SETS.length || !['candidates', 'negatives', 'run', 'score'].includes(step)) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));

// The seeded sample of each set, with each repository's frozen commit.
async function sample() {
  const out = {};
  for (const set of SETS) {
    const list = await read(join(REFIT, LISTS[set]));
    const commits = new Map(list.repos.map((entry) => [entry.repo, entry.commit]));
    out[set] = seededSample([...commits.keys()], SEED, FRACTION[set]).map((repo) => ({
      repo,
      commit: commits.get(repo),
    }));
  }
  return out;
}

async function walk(root, directory = '', files = []) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!['node_modules', '.git'].includes(entry.name)) await walk(root, path, files);
    } else if (entry.isFile() && isProduction(path)) files.push(path);
  }
  return files.sort();
}

if (step === 'candidates') {
  if (!values.root || !values.output) throw new Error(usage);
  await mkdir(resolve(values.output), { recursive: true });
  for (const [set, repos] of Object.entries(await sample()))
    for (const { repo, commit } of repos) {
      const directory = await shallowCheckout(values.root, repo, commit);
      const lines = [`# ${repo} @ ${commit} (${set})`, `checkout: ${directory}`, ''];
      const providerFiles = [];
      for (const path of await walk(directory)) {
        if ((await lstat(join(directory, path))).size > MAX_FILE_BYTES) continue;
        const text = await readFile(join(directory, path), 'utf8');
        if (talksToProvider(set, text)) providerFiles.push(path);
        const found = modelCandidates(text);
        if (!found.length) continue;
        const source = text.split('\n');
        lines.push(`## ${path}`);
        for (const { line } of found)
          lines.push(`${line}: ${source[line - 1].trim().slice(0, 160)}`);
      }
      lines.push('', `Files that talk to ${set}:`, ...providerFiles.map((path) => `  ${path}`));
      await writeFile(
        join(resolve(values.output), `${repo.replace('/', '__')}.txt`),
        `${lines.join('\n')}\n`,
      );
      console.error(`${repo}: ${providerFiles.length} provider files`);
    }
}

// The seeded draw order of negative-file candidates: each set's files that talk to its provider,
// read from the candidate search output. The labeller takes them in order, skipping files that
// have a site, until 30 per set are kept.
if (step === 'negatives') {
  if (!values.output) throw new Error(usage);
  for (const [set, repos] of Object.entries(await sample())) {
    const pool = [];
    for (const { repo } of repos) {
      const text = await readFile(
        join(resolve(values.output), `${repo.replace('/', '__')}.txt`),
        'utf8',
      );
      const listed = text.split(`Files that talk to ${set}:\n`)[1] ?? '';
      for (const line of listed.split('\n')) if (line.trim()) pool.push(`${repo} ${line.trim()}`);
    }
    for (const entry of seededOrder(pool, SEED)) console.log(`${set} ${entry}`);
  }
}

if (step === 'run') {
  if (!values.root || !values.results) throw new Error(usage);
  const git = async (...args) => (await execute('git', ['-C', REFIT, ...args])).stdout.trim();
  const commit = await git('rev-parse', 'HEAD');
  const clean = (await git('status', '--porcelain')) === '';
  if (!clean)
    throw new Error('The Refit checkout has uncommitted changes; benchmark a clean commit.');
  const results = {};
  for (const [set, repos] of Object.entries(await sample()))
    for (const { repo, commit: pinned } of repos) {
      try {
        const directory = await shallowCheckout(values.root, repo, pinned);
        const { stdout } = await execute(
          process.execPath,
          [join(REFIT, 'bin/refit.mjs'), 'deadlines', '--json', '--repository', directory],
          { cwd: REFIT, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
        );
        results[repo] = { set, ...JSON.parse(stdout) };
        delete results[repo].repository;
      } catch (error) {
        results[repo] = { set, error: String(error.stderr || error.message).split('\n')[0] };
      }
      console.error(
        `${repo}: ${results[repo].error ?? `${results[repo].exposures.length} exposures`}`,
      );
    }
  await writeFile(
    resolve(values.results),
    `${JSON.stringify({ formatVersion: 1, ranAt: new Date().toISOString(), refit: { commit, clean }, seed: SEED, results }, null, 2)}\n`,
  );
}

if (step === 'score') {
  if (!values.results) throw new Error(usage);
  const labels = await read(values.labels);
  const problems = validateSiteLabels(labels);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    throw new Error(`${problems.length} label problems.`);
  }
  const run = await read(values.results);
  const registry = await read(join(REFIT, values.registry));
  const deadlineOf = new Map(
    registry.deadlines.flatMap((entry) =>
      entry.versions.map((v) => [`${entry.provider}:${v}`, entry.id]),
    ),
  );
  const score = {
    refit: run.refit,
    registry: relative(REFIT, join(REFIT, values.registry)),
    sets: {},
  };
  for (const set of SETS) {
    score.sets[set] = scoreSet(set, labels, run.results, deadlineOf);
    const s = score.sets[set];
    console.log(
      `${set}: ${s.repositories} repositories, ${s.labelledSites} sites (${s.registrySites} registry), precision ${s.precision.rate}% (${s.precision.k}/${s.precision.n}), recall ${s.recall.rate}% (${s.recall.k}/${s.recall.n}), all-site recall ${s.recallAllSites.rate}% (${s.recallAllSites.k}/${s.recallAllSites.n}), ${s.beyondLimit.length} beyond the evidence limit, ${s.negativeFileFalsePositives} false positives in negative files, ${s.compatibleHits.length} reports at compatible sites`,
    );
  }
  if (values.output) await writeFile(resolve(values.output), `${JSON.stringify(score, null, 2)}\n`);
}
