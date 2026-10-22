import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import type { SdkCallRecord } from '../sdk-call-record.ts';
import { PYTHON_TEST_PATH, tracePythonModelCalls } from './models.ts';

// Scores the Python model tracer against the hand labels of a frozen benchmark
// (docs/benchmarks/2026-10-22-python-model-labels.json). A reported site is a literal the tracer
// says a traced SDK call can send as its model, outside test paths, as `file:line model`.

interface Site {
  file: string;
  line: number;
  model: string;
}
interface LabelledRepository {
  repo: string;
  commit: string;
  calls: { file: string; line: number; provider: string }[];
  sent: Site[];
  notSent: Site[];
  ambiguous: Site[];
}
export interface PythonModelLabels {
  repos: LabelledRepository[];
}
export interface PythonModelResult {
  repo: string;
  commit: string;
  status: 'scanned' | 'not-fetched' | 'not-scanned';
  error?: string;
  calls: { file: string; line: number; provider: string; call: string; client: string }[];
  sites: Site[];
  // Traced calls whose model could not be followed to a literal, with the reason.
  stops: { file: string; line: number; reason: string }[];
}

const key = (site: Site) => `${site.file}:${site.line} ${site.model}`;
const ratio = (part: number, whole: number) => (whole ? part / whole : null);

// The record's reportable parts, with test paths left out as the labels leave them out.
export function reported(
  calls: SdkCallRecord[],
): Pick<PythonModelResult, 'calls' | 'sites' | 'stops'> {
  const live = calls.filter((call) => !PYTHON_TEST_PATH.test(call.file));
  const sites = new Map<string, Site>();
  for (const call of live)
    for (const literal of call.arguments.model.literals)
      if (!PYTHON_TEST_PATH.test(literal.file)) {
        const site = { file: literal.file, line: literal.line, model: literal.value };
        sites.set(key(site), site);
      }
  return {
    calls: live.map((call) => ({
      file: call.file,
      line: call.line,
      provider: call.provider,
      call: `${call.resource}.${call.method}`,
      client: call.client.kind,
    })),
    sites: [...sites.values()],
    stops: live.flatMap((call) =>
      call.arguments.model.stop
        ? [{ file: call.file, line: call.line, reason: call.arguments.model.stop }]
        : [],
    ),
  };
}

// Line precision and recall over the labelled repositories. Ambiguous labels count neither way;
// a reported site that is not labelled sent is a false positive.
export function scorePythonModels(labels: PythonModelLabels, results: PythonModelResult[]) {
  const byRepo = new Map(results.map((result) => [result.repo, result]));
  let truePositives = 0;
  let falsePositives = 0;
  let sent = 0;
  let labelledCalls = 0;
  let tracedCalls = 0;
  const wrong: string[] = [];
  const missed: string[] = [];
  const repositories = [];
  for (const repository of labels.repos) {
    const result = byRepo.get(repository.repo);
    if (!result || result.status !== 'scanned')
      throw new Error(`${repository.repo} was not scanned.`);
    if (result.commit !== repository.commit)
      throw new Error(
        `${repository.repo} was scanned at ${result.commit}, not the labelled ${repository.commit}.`,
      );
    const truth = new Set(repository.sent.map(key));
    const ambiguous = new Set(repository.ambiguous.map(key));
    const found = new Set(result.sites.map(key));
    let repoTrue = 0;
    let repoFalse = 0;
    for (const site of result.sites) {
      if (ambiguous.has(key(site))) continue;
      if (truth.has(key(site))) repoTrue += 1;
      else {
        repoFalse += 1;
        wrong.push(`${repository.repo} ${key(site)}`);
      }
    }
    for (const site of repository.sent)
      if (!found.has(key(site))) missed.push(`${repository.repo} ${key(site)}`);
    const callLines = new Set(result.calls.map((call) => `${call.file}:${call.line}`));
    const callsFound = repository.calls.filter((call) =>
      callLines.has(`${call.file}:${call.line}`),
    ).length;
    truePositives += repoTrue;
    falsePositives += repoFalse;
    sent += repository.sent.length;
    labelledCalls += repository.calls.length;
    tracedCalls += callsFound;
    repositories.push({
      repo: repository.repo,
      reported: repoTrue + repoFalse,
      correct: repoTrue,
      sent: repository.sent.length,
      calls: repository.calls.length,
      callsTraced: callsFound,
    });
  }
  return {
    repositories,
    linePrecision: ratio(truePositives, truePositives + falsePositives),
    lineRecall: ratio(truePositives, sent),
    callRecall: ratio(tracedCalls, labelledCalls),
    counts: { truePositives, falsePositives, sent, labelledCalls, tracedCalls },
    wrong,
    missed,
  };
}

const execute = promisify(execFile);

async function checkout(root: string, repo: string, commit: string) {
  const directory = join(root, repo.replace('/', '__'));
  if (existsSync(join(directory, '.git'))) return directory;
  await execute('git', ['init', '-q', directory]);
  await execute(
    'git',
    ['-C', directory, 'fetch', '-q', '--depth', '1', `https://github.com/${repo}`, commit],
    { timeout: 300_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  );
  await execute('git', [
    '-C',
    directory,
    '-c',
    'advice.detachedHead=false',
    'checkout',
    '-q',
    'FETCH_HEAD',
  ]);
  return directory;
}

// Fetches each frozen repository at its pinned commit (shallow, never installed or run), traces it
// and scores the labelled ones.
async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      list: { type: 'string', default: 'docs/benchmarks/2026-10-22-python-model-repos.json' },
      labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-python-model-labels.json' },
      output: { type: 'string' },
    },
  });
  if (!values.root || !values.output) {
    console.log(
      'Usage: tsx pipeline/python/model-benchmark.ts --root <checkouts> --output <results.json> [--list <repos.json>] [--labels <labels.json>]',
    );
    process.exitCode = 1;
    return;
  }
  const root = resolve(values.root);
  await mkdir(root, { recursive: true });
  const list = JSON.parse(await readFile(values.list!, 'utf8')) as {
    repos: { repo: string; commit: string }[];
  };
  const labels = JSON.parse(await readFile(values.labels!, 'utf8')) as PythonModelLabels;
  const results: PythonModelResult[] = [];
  for (const [index, entry] of list.repos.entries()) {
    console.error(`[${index + 1}/${list.repos.length}] ${entry.repo}`);
    const base = { repo: entry.repo, commit: entry.commit, calls: [], sites: [], stops: [] };
    let directory;
    try {
      directory = await checkout(root, entry.repo, entry.commit);
    } catch (error) {
      results.push({ ...base, status: 'not-fetched', error: String(error).slice(0, 300) });
      continue;
    }
    try {
      const trace = await tracePythonModelCalls(directory);
      results.push({ ...base, status: 'scanned', ...reported(trace.calls) });
    } catch (error) {
      results.push({ ...base, status: 'not-scanned', error: String(error).slice(0, 300) });
    }
  }
  const scanned = results.filter((result) => result.status === 'scanned');
  const summary = {
    repositories: results.length,
    scanned: scanned.length,
    withCalls: scanned.filter((result) => result.calls.length).length,
    calls: scanned.reduce((total, result) => total + result.calls.length, 0),
    sites: scanned.reduce((total, result) => total + result.sites.length, 0),
    stops: scanned.reduce((total, result) => total + result.stops.length, 0),
    labelled: scorePythonModels(labels, results),
  };
  await writeFile(
    values.output,
    `${JSON.stringify({ formatVersion: 1, list: values.list, labels: values.labels, checkedAt: new Date().toISOString(), summary, results }, null, 2)}\n`,
  );
  const { repositories: _, ...headline } = summary.labelled;
  console.log(JSON.stringify({ ...summary, labelled: headline }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
