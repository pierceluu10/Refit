// Scores `refit deadlines` runs against hand labels: how many sampled repositories are truly
// exposed, repository and line precision and recall before and after a matcher change, deadline
// timing, and the OpenAI 2026-10-23 shutdown, with 95% Wilson intervals.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { splitRows } from './benchmark-harness.mjs';
import { assertResults } from './benchmark-results.mjs';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    runs: { type: 'string', default: 'before,after' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-16-deadline-labels.json' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-16-deadline-repos.json' },
    registry: { type: 'string', default: 'data/deadlines.json' },
    'as-of': { type: 'string', default: '2026-10-15' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.root) {
  console.log(
    'Usage: node scripts/deadline-benchmark-score.mjs --root <dir with before.json, after.json, grep.json> [--runs before,after] [--labels <labels.json>] [--list <repos.json>] [--as-of YYYY-MM-DD]',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const pinned = await read(values.list);
const labelled = await read(values.labels);
const { deadlines } = await read(values.registry);
// A run from scripts/deadline-benchmark-setup.mjs, checked against its schema before anything is
// counted: the harness file, or a bare array of scanned rows from before it. Rows whose scan or
// checkout failed were never in the bare arrays, so they stay out of the scores and are counted.
const failed = {};
const runs = Object.fromEntries(
  await Promise.all(
    values.runs.split(',').map(async (name) => {
      const data = await read(join(root, `${name}.json`));
      assertResults('deadline-results', data, { allowPredating: true });
      const rows = Array.isArray(data) ? data : data.results;
      const errored = rows.filter((row) => row.error);
      failed[name] = {
        infrastructure: splitRows('deadline-results', errored).infrastructure.length,
        repository: splitRows('deadline-results', errored).results.length,
      };
      return [name, rows.filter((row) => !row.error)];
    }),
  ),
);
const grep = await read(join(root, 'grep.json'));
const asOf = Date.parse(`${values['as-of']}T00:00:00Z`);

// 95% Wilson score interval for k successes in n trials, as percentages.
function wilson(k, n, z = 1.96) {
  if (!n) return { k, n, rate: null, low: null, high: null };
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  const round = (value) => Math.round(value * 1000) / 10;
  return {
    k,
    n,
    rate: round(p),
    low: round(Math.max(0, centre - half)),
    high: round(Math.min(1, centre + half)),
  };
}

const deadlineOf = new Map(
  deadlines.flatMap((d) => d.versions.map((v) => [`${d.provider}:${v}`, d])),
);
const providerOf = new Map(pinned.repos.map((r) => [r.repo, r.provider]));
// A labelled version's provider, from its shape: Graph API `v20.0`, Shopify `2025-10`, else a model.
const providerOfVersion = (version) =>
  /^v\d+\.\d+$/.test(version) ? 'meta-graph' : /^\d{4}-\d{2}$/.test(version) ? 'shopify' : 'openai';
const key = (repo, file, line, version) => `${repo}\t${file}\t${line}\t${version}`;
const labelOf = new Map(labelled.labels.map((l) => [key(l.repo, l.file, l.line, l.version), l]));
const labelledRepos = new Set(labelled.labelledRepos);
const providers = [...new Set(pinned.repos.map((r) => r.provider))];
const days = (date) => Math.round((Date.parse(`${date}T00:00:00Z`) - asOf) / 86_400_000);
function bucket(value) {
  if (value < 0) return 'past due';
  if (value <= 7) return '0-7 days';
  if (value <= 30) return '8-30 days';
  if (value <= 90) return '31-90 days';
  return 'later';
}

// Labelled live lines per repository, each with its deadline.
const live = new Map();
for (const label of labelled.labels.filter((l) => l.label === 'live')) {
  const deadline = deadlineOf.get(`${providerOfVersion(label.version)}:${label.version}`);
  if (!deadline) continue;
  const lines = live.get(label.repo) ?? [];
  lines.push({ ...label, deadline });
  live.set(label.repo, lines);
}
const option = new Set(labelled.labels.filter((l) => l.label === 'option').map((l) => l.repo));

function scoreRun(results, provider) {
  const inScope = (repo) => !provider || providerOf.get(repo) === provider;
  const byRepo = new Map(results.map((r) => [r.repo, r]));
  const repos = pinned.repos.map((r) => r.repo).filter(inScope);
  const flaggedAll = repos.filter((repo) => byRepo.get(repo)?.exposures.length);
  const sample = repos.filter((repo) => labelledRepos.has(repo));
  const exposed = sample.filter((repo) => live.has(repo));
  const flagged = sample.filter((repo) => byRepo.get(repo)?.exposures.length);
  // Listed evidence lines and the (repo, deadline) pairs each run reports.
  const listed = new Set();
  const reported = new Set();
  const capped = new Set();
  for (const repo of sample)
    for (const exposure of byRepo.get(repo)?.exposures ?? []) {
      reported.add(`${repo}\t${exposure.deadline.id}`);
      if (exposure.more) capped.add(`${repo}\t${exposure.deadline.id}`);
      for (const item of exposure.evidence)
        listed.add(key(repo, item.file, item.line, item.version));
    }
  const mix = { live: 0, option: 0, 'test-docs': 0, 'false-positive': 0, unlabelled: 0 };
  for (const line of listed) mix[labelOf.get(line)?.label ?? 'unlabelled'] += 1;
  const liveLines = sample.flatMap((repo) => live.get(repo) ?? []);
  // A live line Refit counted past its 20-line evidence cap is treated as found.
  const found = liveLines.filter(
    (l) =>
      listed.has(key(l.repo, l.file, l.line, l.version)) ||
      capped.has(`${l.repo}\t${l.deadline.id}`),
  );
  const pairs = new Set(liveLines.map((l) => `${l.repo}\t${l.deadline.id}`));
  return {
    flaggedOfAll: wilson(flaggedAll.length, repos.length),
    labelled: sample.length,
    repoPrecision: wilson(flagged.filter((repo) => live.has(repo)).length, flagged.length),
    repoRecall: wilson(exposed.filter((repo) => flagged.includes(repo)).length, exposed.length),
    deadlineRecall: wilson([...pairs].filter((pair) => reported.has(pair)).length, pairs.size),
    linePrecision: wilson(mix.live, listed.size),
    lineRecall: wilson(found.length, liveLines.length),
    lineMix: mix,
    missedLive: liveLines
      .filter((l) => !found.includes(l))
      .map((l) => `${l.repo} ${l.file}:${l.line} ${l.version} (${l.note})`),
  };
}

function exposure(provider) {
  const sample = labelled.labelledRepos.filter(
    (repo) => !provider || providerOf.get(repo) === provider,
  );
  return {
    labelled: sample.length,
    exposedLive: wilson(sample.filter((repo) => live.has(repo)).length, sample.length),
    exposedLiveOrOption: wilson(
      sample.filter((repo) => live.has(repo) || option.has(repo)).length,
      sample.length,
    ),
  };
}

// Each truly exposed labelled repository's most urgent live deadline.
const timing = {};
const urgent = {};
for (const [repo, lines] of live) {
  const first = lines.reduce((a, b) => (days(a.deadline.date) <= days(b.deadline.date) ? a : b));
  urgent[repo] = `${first.deadline.id} (${days(first.deadline.date)} days)`;
  const name = bucket(days(first.deadline.date));
  timing[name] = (timing[name] ?? 0) + 1;
}
// Every flagged repository's most urgent flagged deadline in the last run: an upper bound, since
// not every flag is a live pin.
const last = Object.values(runs).at(-1);
const flaggedTiming = {};
for (const result of last.filter((r) => r.exposures.length)) {
  const name = bucket(Math.min(...result.exposures.map((e) => days(e.deadline.date))));
  flaggedTiming[name] = (flaggedTiming[name] ?? 0) + 1;
}

// OpenAI's 2026-10-23 shutdown: flags in the last run, and live exposure from line labels for
// labelled repositories or the repository-level judgement for the rest.
const october = (r) =>
  r.exposures.some((e) => e.deadline.provider === 'openai' && e.deadline.date === '2026-10-23');
const openai = pinned.repos.filter((r) => r.provider === 'openai').map((r) => r.repo);
const judged = new Map((labelled.openaiOctober23?.repos ?? []).map((r) => [r.repo, r.exposed]));
const octoberLive = (repo) =>
  labelledRepos.has(repo)
    ? (live.get(repo) ?? []).some(
        (l) => l.deadline.provider === 'openai' && l.deadline.date === '2026-10-23',
      )
    : judged.get(repo);
const octoberFlagged = openai.filter((repo) => last.some((r) => r.repo === repo && october(r)));
const octoberKnown = openai.filter((repo) => octoberLive(repo) !== undefined);

// Versions found by the loose search that the registry does not list, per provider (unlabelled).
const outside = {};
for (const result of grep) {
  const versions = [
    ...new Set(result.hits.filter((h) => !h.inRegistry).map((h) => `${h.provider}:${h.version}`)),
  ];
  if (versions.length) outside[result.repo] = versions;
}

console.log(
  JSON.stringify(
    {
      asOf: values['as-of'],
      repos: pinned.repos.length,
      exposure: { all: exposure(), ...Object.fromEntries(providers.map((p) => [p, exposure(p)])) },
      runs: Object.fromEntries(
        Object.entries(runs).map(([name, results]) => [
          name,
          {
            scanned: results.length,
            failed: failed[name],
            all: scoreRun(results),
            ...Object.fromEntries(providers.map((p) => [p, scoreRun(results, p)])),
          },
        ]),
      ),
      timing,
      urgent,
      flaggedTiming,
      openaiOctober23: {
        openaiRepos: openai.length,
        flagged: octoberFlagged.length,
        judged: octoberKnown.length,
        exposedLive: wilson(octoberKnown.filter(octoberLive).length, octoberKnown.length),
        flagPrecision: wilson(
          octoberFlagged.filter((repo) => octoberLive(repo)).length,
          octoberFlagged.filter((repo) => octoberLive(repo) !== undefined).length,
        ),
        exposedRepos: octoberKnown.filter(octoberLive),
      },
      outsideRegistry: outside,
    },
    null,
    2,
  ),
);
