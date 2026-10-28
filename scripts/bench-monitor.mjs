// Collects refit-bench runs and per-repo decisions into runs.json and repos.json for the monitor.
// Usage: node scripts/bench-monitor.mjs <out-dir> <refit-checkout> [--runs 25] [--detail <run-id> ...]
// Repo-level detail is never collected for progress-30: it is the blind set, totals only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [out, refit, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i < 0
    ? []
    : rest.slice(i + 1).filter((v, k, a) => !a.slice(0, k + 1).some((x) => x.startsWith('--')));
};
const limit = Number(flag('--runs')[0] ?? 25);
const detailIds = new Set(flag('--detail'));
const REPO = 'refit-dev/refit-bench';
const BLIND = /progress-30/;
const gh = (args, raw = false) => {
  try {
    const text = execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw ? text : JSON.parse(text);
  } catch {
    return undefined;
  }
};
const cache = join(out, 'cache');
mkdirSync(cache, { recursive: true });

const runs =
  gh([
    'run',
    'list',
    '-R',
    REPO,
    '-w',
    'benchmark.yml',
    '-L',
    String(limit),
    '--json',
    'databaseId,createdAt,status,conclusion,headBranch',
  ]) ?? [];
const runRows = [];
const shardDirs = {};
for (const run of runs) {
  const id = String(run.databaseId);
  const view = gh(['run', 'view', id, '-R', REPO, '--json', 'jobs']) ?? { jobs: [] };
  const shards = view.jobs.filter((j) => j.name.startsWith('shard'));
  const plan = view.jobs.find((j) => j.name === 'plan');
  const inputsFile = join(cache, `${id}.inputs.json`);
  let inputs = existsSync(inputsFile) ? JSON.parse(readFileSync(inputsFile, 'utf8')) : null;
  if (!inputs && plan?.status === 'completed') {
    const log = (
      gh(
        ['api', '--allow-escape-sequences', `repos/${REPO}/actions/jobs/${plan.databaseId}/logs`],
        true,
      ) ?? ''
    ).replace(/\x1b\[[0-9;]*m/g, '');
    const pick = (re) => (log.match(re) ?? [])[1] ?? '';
    inputs = {
      list: pick(/LIST: (\S+)/)
        .replace(/^subsets\//, '')
        .replace(/\.json$/, ''),
      commit: pick(/ {2}ref: ([0-9a-f]{7,40})/).slice(0, 8),
      ai: pick(/\bAI: (\S+)/) === 'true',
      aiBudget: Number(pick(/AI_BUDGET: (\S+)/) || 0),
      flags: pick(/FLAGS: (.*)/).trim(),
    };
    if (inputs.list) writeFileSync(inputsFile, JSON.stringify(inputs));
  }
  inputs ??= { list: '', commit: '', ai: false, aiBudget: 0, flags: '' };
  const row = {
    run: id,
    started: run.createdAt,
    list: inputs.list || 'unknown',
    commit: inputs.commit,
    ai: inputs.ai ? 'on' : 'off',
    ai_budget: inputs.aiBudget,
    flags: inputs.flags,
    branch: run.headBranch,
    status: run.status === 'completed' ? run.conclusion || 'completed' : run.status,
    shards_done: shards.filter((j) => j.status === 'completed').length,
    shards_total: shards.length,
    repos: null,
    affected: null,
    validated: null,
    passed_checks: null,
    refused_at_setup: null,
    ai_spend: null,
  };
  const done = run.status === 'completed' && run.conclusion !== 'cancelled';
  const merged = join(cache, id, 'merged');
  if (done && !existsSync(join(merged, 'results.json')))
    gh(['run', 'download', id, '-R', REPO, '-n', 'merged', '-D', merged], true);
  if (existsSync(join(merged, 'summary.md'))) {
    const summary = readFileSync(join(merged, 'summary.md'), 'utf8');
    row.repos = Number((summary.match(/Merged Stripe benchmark: (\d+) of/) ?? [])[1] ?? 0);
    row.validated = Number((summary.match(/^\| validated \| (\d+) \|/m) ?? [])[1] ?? 0);
    row.ai_spend = Number((summary.match(/AI spend: \$([0-9.]+)/) ?? [])[1] ?? 0);
    if (row.repos > 0) {
      const funnel =
        gh(['--version'], true) &&
        JSON.parse(
          execFileSync(
            'node',
            [join(refit, 'scripts/validation-funnel.mjs'), join(merged, 'results.json'), '--json'],
            { encoding: 'utf8', maxBuffer: 1 << 26 },
          ),
        );
      row.affected = funnel.affected;
      row.passed_checks = funnel.stages.validated ?? 0;
      row.refused_at_setup = funnel.stages['preparation-refused'] ?? 0;
      const verdicts = {};
      for (const m of summary.matchAll(
        /^\| ([^|]+?) \| ([a-z-]+) \| ([a-z-]+) \| [^|]* \| ([^|]*)\|$/gm,
      ))
        verdicts[m[1]] = { verdict: m[2], why: m[4].trim() };
      if (detailIds.has(id) && !BLIND.test(row.list))
        shardDirs[id] = { funnel, list: row.list, verdicts };
    }
  }
  runRows.push(row);
}

const short = (text, n = 220) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
const find = (obj, key) => {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const value of Object.values(obj)) {
    const hit = find(value, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
};
const sumCost = (obj) => {
  let total = 0;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'costUsd' && typeof v === 'number') total += v;
      else walk(v);
    }
  };
  walk(obj);
  return Math.round(total * 10000) / 10000;
};
const repoRows = [];
for (const [id, { funnel, list, verdicts }] of Object.entries(shardDirs)) {
  const dir = join(cache, id, 'shards');
  if (!existsSync(dir)) gh(['run', 'download', id, '-R', REPO, '-D', dir], true);
  const reports = {};
  const results = {};
  for (const shard of existsSync(dir) ? readdirSync(dir) : []) {
    const reposDir = join(dir, shard, 'run', 'repos');
    const resultsFile = join(dir, shard, 'run', 'results.json');
    if (existsSync(resultsFile))
      for (const r of JSON.parse(readFileSync(resultsFile, 'utf8'))) results[r.repo] = r;
    for (const name of existsSync(reposDir) ? readdirSync(reposDir) : []) {
      const file = join(reposDir, name, 'run', 'report.json.gz');
      if (existsSync(file))
        reports[name.replace('__', '/')] = JSON.parse(
          gunzipSync(readFileSync(file)).toString('utf8'),
        );
    }
  }
  for (const entry of funnel.repositories) {
    const report = reports[entry.repo] ?? {};
    const result = results[entry.repo] ?? {};
    const validation = report.validation ?? {};
    const writer = find(report, 'behaviourTestWriter') ?? {};
    const production = result.productionMode ?? {};
    const verdict = verdicts[entry.repo] ?? {};
    const heldFor = (verdict.why?.match(/draft for ([a-z, -]+?);/) ?? [])[1] ?? '';
    const reasons =
      verdict.verdict === 'validated'
        ? []
        : [
            validation.dependencyFailure?.summary,
            validation.repair?.error,
            production.stop,
            entry.detail && entry.detail.length > 2 ? entry.detail : '',
            verdict.why,
          ].filter(Boolean);
    repoRows.push({
      key: `${id}:${entry.repo}`,
      run: id,
      list,
      repo: entry.repo,
      stage: entry.stage,
      verdict: verdict.verdict ?? '',
      held_for: heldFor,
      policy_block:
        report.assessment?.status === 'blocked' ? short(report.assessment.reason, 90) : '',
      grade: validation.grade?.letter ?? '',
      checks: validation.status ?? '',
      repair: validation.repair?.stopReason ?? '',
      repair_attempts: validation.repair?.requested ?? 0,
      ai_review: report.assessment?.status ?? '',
      behaviour_test: writer.status ?? '',
      ai_cost: sumCost(report),
      stripe_calls: result.sdkCalls ?? 0,
      traced_calls: result.tracedCalls ?? 0,
      reason: short(reasons[0]),
      patch_summary: short(report.patch?.summary, 160),
    });
  }
}

writeFileSync(join(out, 'runs.json'), JSON.stringify(runRows, null, 1));
writeFileSync(join(out, 'repos.json'), JSON.stringify(repoRows, null, 1));
console.log(`runs ${runRows.length}, repos ${repoRows.length}`);
