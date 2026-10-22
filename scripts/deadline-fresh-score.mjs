// Scores a `refit deadlines --json` run against line labels from the loose search, for all
// providers and each one: live exposure per repository, per (repository, deadline) pair and per
// line, how Refit classifies labelled test, comment and catalog lines, and exposure to OpenAI's
// 2026-10-23 shutdown. See docs/DEADLINE-BENCHMARK-2026-10-22.md.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { scoreFresh, wilson } from './deadline-fresh-helpers.mjs';

const { values } = parseArgs({
  options: {
    results: { type: 'string' },
    labels: { type: 'string', default: 'docs/benchmarks/2026-10-22-deadline-fresh-labels.json' },
    list: { type: 'string', default: 'docs/benchmarks/2026-10-22-deadline-fresh-repos.json' },
    registry: { type: 'string', default: 'data/deadlines.json' },
    providers: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.results) {
  console.log(
    'Usage: node scripts/deadline-fresh-score.mjs --results <results.json> [--labels <labels.json>] [--list <repos.json>] [--providers openai,anthropic]',
  );
  process.exit(values.help ? 0 : 1);
}
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const pinned = await read(values.list);
const { labels } = await read(values.labels);
const { deadlines } = await read(values.registry);
const run = await read(values.results);
const repos = pinned.repos.map((r) => r.repo);
const deadlineOf = new Map(
  deadlines.flatMap((d) => d.versions.map((v) => [`${d.provider}:${v}`, d])),
);
const providers = values.providers?.split(',') ?? [...new Set(deadlines.map((d) => d.provider))];
const results = Object.fromEntries(run.map((r) => [r.repo, r]));

// One provider's view of a result: its deadlines only.
function only(provider) {
  const keep = (group) => group.deadline.provider === provider;
  return Object.fromEntries(
    Object.entries(results).map(([repo, r]) => [
      repo,
      {
        ...r,
        exposures: (r.exposures ?? []).filter(keep),
        mentions: (r.mentions ?? []).filter(keep),
      },
    ]),
  );
}
// Repositories that setup.mjs could not scan are absent from the run; they count as not flagged.
for (const repo of repos) results[repo] ??= { error: 'not scanned' };

const live = labels.filter((l) => l.label === 'live');
const october = (l) => {
  const d = deadlineOf.get(`${l.provider}:${l.version}`);
  return d?.provider === 'openai' && d.date === '2026-10-23';
};
const exposedOctober = [...new Set(live.filter(october).map((l) => l.repo))];
const flaggedOctober = repos.filter((repo) =>
  (results[repo].exposures ?? []).some(
    (e) => e.deadline.provider === 'openai' && e.deadline.date === '2026-10-23',
  ),
);

console.log(
  JSON.stringify(
    {
      repositories: repos.length,
      all: scoreFresh(repos, labels, results, deadlineOf),
      providers: Object.fromEntries(
        providers.map((p) => [
          p,
          scoreFresh(
            repos,
            labels.filter((l) => l.provider === p),
            only(p),
            deadlineOf,
          ),
        ]),
      ),
      openaiOctober23: {
        exposed: exposedOctober.length,
        exposedShare: wilson(exposedOctober.length, repos.length),
        flagged: flaggedOctober.length,
        flagPrecision: wilson(
          flaggedOctober.filter((r) => exposedOctober.includes(r)).length,
          flaggedOctober.length,
        ),
        flagRecall: wilson(
          exposedOctober.filter((r) => flaggedOctober.includes(r)).length,
          exposedOctober.length,
        ),
        exposedRepos: exposedOctober.sort(),
      },
    },
    null,
    2,
  ),
);
