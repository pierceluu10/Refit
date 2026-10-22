import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import type { SdkCallRecord } from '../sdk-call-record.ts';
import { GO_TEST_PATH, traceGoCalls, type GoModule } from './calls.ts';

// Scores the Go tracer against hand labels (docs/benchmarks/2026-10-22-go-labels.json). A reported
// line is a traced Stripe call, or a model site an OpenAI or Anthropic call can send, outside test
// paths. Line precision counts both; recall is given for Stripe calls, model sites and model calls.

interface Labelled {
  repo: string;
  commit: string;
  calls: { file: string; line: number; provider: string }[];
  sent: { file: string; line: number; model: string }[];
  ambiguous: { file: string; line: number; model: string }[];
}
export interface GoLabels {
  repos: Labelled[];
}
export interface GoResult {
  repo: string;
  commit: string;
  status: 'scanned' | 'not-fetched' | 'not-scanned';
  error?: string;
  calls: { file: string; line: number; provider: string; call: string; client: string }[];
  sites: { file: string; line: number; model: string }[];
  stops: { file: string; line: number; reason: string }[];
  modules: GoModule[];
}

const ratio = (part: number, whole: number) => (whole ? part / whole : null);

export function reportedGo(calls: SdkCallRecord[]): Pick<GoResult, 'calls' | 'sites' | 'stops'> {
  const live = calls.filter((call) => !GO_TEST_PATH.test(call.file));
  const sites = new Map<string, { file: string; line: number; model: string }>();
  for (const call of live)
    for (const literal of call.arguments.model?.literals ?? [])
      if (!GO_TEST_PATH.test(literal.file))
        sites.set(`${literal.file}:${literal.line} ${literal.value}`, {
          file: literal.file,
          line: literal.line,
          model: literal.value,
        });
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
      call.arguments.model?.stop
        ? [{ file: call.file, line: call.line, reason: call.arguments.model.stop }]
        : [],
    ),
  };
}

export function scoreGo(labels: GoLabels, results: GoResult[]) {
  const byRepo = new Map(results.map((result) => [result.repo, result]));
  const counts = {
    correct: 0,
    wrong: 0,
    stripeCalls: 0,
    stripeTraced: 0,
    sent: 0,
    sentFound: 0,
    modelCalls: 0,
    modelCallsTraced: 0,
  };
  const wrong: string[] = [];
  const missed: string[] = [];
  for (const repository of labels.repos) {
    const result = byRepo.get(repository.repo);
    if (!result || result.status !== 'scanned')
      throw new Error(`${repository.repo} was not scanned.`);
    if (result.commit !== repository.commit)
      throw new Error(
        `${repository.repo} was scanned at ${result.commit}, not ${repository.commit}.`,
      );
    const stripe = new Set(
      repository.calls
        .filter((call) => call.provider === 'stripe')
        .map((call) => `${call.file}:${call.line}`),
    );
    const sent = new Set(repository.sent.map((site) => `${site.file}:${site.line} ${site.model}`));
    const ambiguous = new Set(
      repository.ambiguous.map((site) => `${site.file}:${site.line} ${site.model}`),
    );
    const reportedStripe = new Set(
      result.calls
        .filter((call) => call.provider === 'stripe')
        .map((call) => `${call.file}:${call.line}`),
    );
    const reportedSites = new Set(
      result.sites.map((site) => `${site.file}:${site.line} ${site.model}`),
    );
    const callLines = new Set(result.calls.map((call) => `${call.file}:${call.line}`));
    for (const line of reportedStripe)
      if (stripe.has(line)) counts.correct += 1;
      else {
        counts.wrong += 1;
        wrong.push(`${repository.repo} ${line} stripe call`);
      }
    for (const site of reportedSites) {
      if (ambiguous.has(site)) continue;
      if (sent.has(site)) counts.correct += 1;
      else {
        counts.wrong += 1;
        wrong.push(`${repository.repo} ${site}`);
      }
    }
    for (const line of stripe) {
      counts.stripeCalls += 1;
      if (reportedStripe.has(line)) counts.stripeTraced += 1;
      else missed.push(`${repository.repo} ${line} stripe call`);
    }
    for (const site of sent) {
      counts.sent += 1;
      if (reportedSites.has(site)) counts.sentFound += 1;
      else missed.push(`${repository.repo} ${site}`);
    }
    for (const call of repository.calls.filter((item) => item.provider !== 'stripe')) {
      counts.modelCalls += 1;
      if (callLines.has(`${call.file}:${call.line}`)) counts.modelCallsTraced += 1;
    }
  }
  return {
    linePrecision: ratio(counts.correct, counts.correct + counts.wrong),
    stripeCallRecall: ratio(counts.stripeTraced, counts.stripeCalls),
    modelSiteRecall: ratio(counts.sentFound, counts.sent),
    modelCallRecall: ratio(counts.modelCallsTraced, counts.modelCalls),
    counts,
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

// Fetches each frozen repository at its pinned commit (shallow, never built or run), traces it and
// scores the labelled ones.
async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      list: { type: 'string', default: 'docs/benchmarks/2026-10-22-go-repos.json' },
      labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-go-labels.json' },
      output: { type: 'string' },
    },
  });
  if (!values.root || !values.output) {
    console.log(
      'Usage: tsx pipeline/go/benchmark.ts --root <checkouts> --output <results.json> [--list <repos.json>] [--labels <labels.json>]',
    );
    process.exitCode = 1;
    return;
  }
  const root = resolve(values.root);
  await mkdir(root, { recursive: true });
  const list = JSON.parse(await readFile(values.list!, 'utf8')) as {
    repos: { repo: string; commit: string }[];
  };
  const labels = JSON.parse(await readFile(values.labels!, 'utf8')) as GoLabels;
  const results: GoResult[] = [];
  for (const [index, entry] of list.repos.entries()) {
    console.error(`[${index + 1}/${list.repos.length}] ${entry.repo}`);
    const base = {
      repo: entry.repo,
      commit: entry.commit,
      calls: [],
      sites: [],
      stops: [],
      modules: [],
    };
    let directory;
    try {
      directory = await checkout(root, entry.repo, entry.commit);
    } catch (error) {
      results.push({ ...base, status: 'not-fetched', error: String(error).slice(0, 300) });
      continue;
    }
    try {
      const trace = await traceGoCalls(directory);
      results.push({
        ...base,
        status: 'scanned',
        ...reportedGo(trace.calls),
        modules: trace.modules,
      });
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
    stripeCalls: scanned.reduce(
      (total, result) => total + result.calls.filter((call) => call.provider === 'stripe').length,
      0,
    ),
    sites: scanned.reduce((total, result) => total + result.sites.length, 0),
    stripeModules: scanned.flatMap((result) =>
      result.modules.filter((module) => module.provider === 'stripe'),
    ).length,
    stripeApiVersionsKnown: scanned.flatMap((result) =>
      result.modules.filter((module) => module.apiVersion),
    ).length,
    labelled: scoreGo(labels, results),
  };
  await writeFile(
    values.output,
    `${JSON.stringify({ formatVersion: 1, list: values.list, labels: values.labels, checkedAt: new Date().toISOString(), summary, results }, null, 2)}\n`,
  );
  const { wrong, missed, ...headline } = summary.labelled;
  console.log(
    JSON.stringify(
      { ...summary, labelled: { ...headline, wrong, missed: missed.length } },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
