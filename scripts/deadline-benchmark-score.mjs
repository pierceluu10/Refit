// Scores `refit deadlines` against hand labels: the share of sampled repositories truly exposed,
// line and repository precision, repository recall, and deadline timing, with 95% Wilson intervals.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    results: { type: 'string' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-15-deadline-pilot-labels.json' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-15-deadline-pilot-repos.json' },
    'as-of': { type: 'string', default: '2026-10-15' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.results) {
  console.log(
    'Usage: node scripts/deadline-benchmark-score.mjs --results <root>/results.json [--labels <labels.json>] [--list <repos.json>] [--as-of YYYY-MM-DD]',
  );
  process.exit(values.help ? 0 : 1);
}
const results = JSON.parse(await readFile(values.results, 'utf8'));
const { labels, missed } = JSON.parse(await readFile(values.labels, 'utf8'));
const pinned = JSON.parse(await readFile(values.list, 'utf8'));
const asOf = Date.parse(`${values['as-of']}T00:00:00Z`);

// 95% Wilson score interval for k successes in n trials.
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

const deadlines = new Map(
  results.flatMap((r) => r.exposures.map((e) => [e.deadline.id, e.deadline])),
);
const weight = (label) => label.unlisted ?? 1;
const providers = [...new Set(pinned.repos.map((r) => r.provider))];
const scope = (provider) =>
  provider ? pinned.repos.filter((r) => r.provider === provider) : pinned.repos;

function summary(provider) {
  const repos = scope(provider).map((r) => r.repo);
  const mine = (items) => items.filter((item) => repos.includes(item.repo));
  const flagged = new Set(
    results.filter((r) => repos.includes(r.repo) && r.exposures.length).map((r) => r.repo),
  );
  const live = new Set(
    [...mine(labels), ...mine(missed)].filter((l) => l.label === 'live').map((l) => l.repo),
  );
  const broad = new Set([
    ...live,
    ...mine(labels)
      .filter((l) => l.label === 'option')
      .map((l) => l.repo),
  ]);
  const lines = mine(labels);
  const count = (label) =>
    lines.filter((l) => l.label === label).reduce((sum, l) => sum + weight(l), 0);
  const total = lines.reduce((sum, l) => sum + weight(l), 0);
  return {
    repos: repos.length,
    flagged: wilson(flagged.size, repos.length),
    exposedLive: wilson(live.size, repos.length),
    exposedLiveOrOption: wilson(broad.size, repos.length),
    repoPrecision: wilson([...flagged].filter((r) => live.has(r)).length, flagged.size),
    repoRecall: wilson([...live].filter((r) => flagged.has(r)).length, live.size),
    linePrecision: wilson(count('live'), total),
    lineMix: {
      live: count('live'),
      option: count('option'),
      'test-docs': count('test-docs'),
      'false-positive': count('false-positive'),
    },
  };
}

// Each exposed repository's most urgent live deadline, bucketed by days from --as-of.
function bucket(days) {
  if (days < 0) return 'past due';
  if (days <= 7) return '0-7 days';
  if (days <= 30) return '8-30 days';
  if (days <= 90) return '31-90 days';
  return 'later';
}
const urgent = new Map();
for (const label of labels.filter((l) => l.label === 'live')) {
  const days = Math.round(
    (Date.parse(`${deadlines.get(label.deadline).date}T00:00:00Z`) - asOf) / 86_400_000,
  );
  if (!urgent.has(label.repo) || days < urgent.get(label.repo).days)
    urgent.set(label.repo, { days, deadline: label.deadline });
}
const timing = {};
for (const { days } of urgent.values()) timing[bucket(days)] = (timing[bucket(days)] ?? 0) + 1;

console.log(
  JSON.stringify(
    {
      asOf: values['as-of'],
      all: summary(),
      ...Object.fromEntries(providers.map((p) => [p, summary(p)])),
      drawFilters: wilson(pinned.repos.length, pinned.repos.length + pinned.rejected.length),
      mostUrgentLiveDeadline: Object.fromEntries([...urgent].map(([repo, value]) => [repo, value])),
      timing,
    },
    null,
    2,
  ),
);
