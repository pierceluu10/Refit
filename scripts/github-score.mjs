// Scores `refit github-api` results against blind hand labels. A label is one live request to the
// GitHub API: an Octokit REST method call, `octokit.request`, `octokit.paginate`, a GraphQL query
// sent through Octokit, or an HTTP request to api.github.com, at the line where the call starts,
// with its route (`GET /repos/{}/{}/issues`; null where a runtime value decides it, and for
// GraphQL). Pinned `X-GitHub-Api-Version` headers are labelled separately at the header's line.
// Labels were written from the source before any scan of that repository was looked at.
//
//   node scripts/github-score.mjs --labels <labels.json> --results <results.json>
//
// Only labelled repositories that scanned without error count. A reported live request matches a
// label at the same file and line. Precision is matched reports over live reports; recall is
// matched labels over labels; route agreement compares the routes (parameters compared as `{}`)
// of the matched pairs whose label knows one. Pins are scored the same way, by file and line.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const key = (item) => `${item.file}:${item.line}`;
const route = (item) => {
  if (!item.route) return null;
  const [method, path = ''] = item.route.split(' ');
  return `${method.toUpperCase()} ${path
    .replace(/[?#].*$/, '')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\/+$/, '')}`;
};
const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);

function compare(expected, reported, repo, misses, extras) {
  let matched = 0;
  for (const location of expected.keys())
    if (reported.has(location)) matched += 1;
    else misses.push(`${repo} ${location}`);
  for (const location of reported.keys())
    if (!expected.has(location)) extras.push(`${repo} ${location}`);
  return matched;
}

// labels: { repos: [{ repo, commit, calls: [{ file, line, route }], pins?: [{ file, line }] }] }
// results: { results: [{ repo, commit, calls?: [{ file, line, use, route }], pins?, error? }] }
export function scoreGitHub(labels, results) {
  const byRepo = new Map(results.results.map((item) => [`${item.repo}@${item.commit}`, item]));
  const totals = { repositories: 0, skipped: [], labels: 0, reported: 0, matched: 0 };
  const pins = { labels: 0, reported: 0, matched: 0, misses: [], extras: [] };
  let compared = 0;
  let agree = 0;
  const misses = [];
  const extras = [];
  const disagreements = [];
  for (const repo of labels.repos) {
    const result = byRepo.get(`${repo.repo}@${repo.commit}`);
    if (!result || result.error || !result.calls) {
      totals.skipped.push(repo.repo);
      continue;
    }
    totals.repositories += 1;
    const live = (items) =>
      new Map(items.filter((item) => item.use === 'live').map((item) => [key(item), item]));
    const expected = new Map(repo.calls.map((item) => [key(item), item]));
    const reported = live(result.calls);
    totals.labels += expected.size;
    totals.reported += reported.size;
    totals.matched += compare(expected, reported, repo.repo, misses, extras);
    for (const [location, label] of expected) {
      const found = reported.get(location);
      if (!found || !route(label)) continue;
      compared += 1;
      if (route(found) === route(label)) agree += 1;
      else
        disagreements.push(
          `${repo.repo} ${location}: labelled ${route(label)}, reported ${route(found) ?? 'unknown'}`,
        );
    }
    const expectedPins = new Map((repo.pins ?? []).map((item) => [key(item), item]));
    const reportedPins = live(result.pins ?? []);
    pins.labels += expectedPins.size;
    pins.reported += reportedPins.size;
    pins.matched += compare(expectedPins, reportedPins, repo.repo, pins.misses, pins.extras);
  }
  return {
    ...totals,
    precision: ratio(totals.matched, totals.reported),
    recall: ratio(totals.matched, totals.labels),
    routeAgreement: ratio(agree, compared),
    compared,
    misses,
    extras,
    disagreements,
    pins: {
      ...pins,
      precision: ratio(pins.matched, pins.reported),
      recall: ratio(pins.matched, pins.labels),
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      labels: { type: 'string' },
      results: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.labels || !values.results) {
    console.log(
      'Usage: node scripts/github-score.mjs --labels <labels.json> --results <results.json>',
    );
    process.exit(values.help ? 0 : 1);
  }
  const read = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'));
  console.log(
    JSON.stringify(scoreGitHub(await read(values.labels), await read(values.results)), null, 2),
  );
}
