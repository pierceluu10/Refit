// Scores `refit cloudflare` results against blind hand labels. A label is one live request to the
// Cloudflare API: a `cloudflare` SDK method call, `client.get('/path')`, or an HTTP request to
// api.cloudflare.com/client/v4, at the line where the call starts, with its HTTP method and path
// (`/zones/{}/dns_records`; null parts where a runtime value decides). Labels were written from
// the source before any scan of that repository was looked at.
//
//   node scripts/cloudflare-score.mjs --labels <labels.json> --results <results.json>
//
// Only labelled repositories that scanned without error count. A reported live request matches a
// label at the same file and line. Precision is matched reports over live reports; recall is
// matched labels over labels; endpoint agreement compares method and path (runtime segments
// compared as `{}`) of the matched pairs whose label knows both.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const key = (item) => `${item.file}:${item.line}`;
const endpoint = (item) =>
  item.method && item.path
    ? `${item.method} ${item.path.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '')}`
    : null;

// labels: { repos: [{ repo, commit, calls: [{ file, line, method, path }] }] }
// results: { results: [{ repo, commit, calls?: [{ file, line, use, method, path }], error? }] }
export function scoreCloudflare(labels, results) {
  const byRepo = new Map(results.results.map((item) => [`${item.repo}@${item.commit}`, item]));
  const totals = { repositories: 0, skipped: [], labels: 0, reported: 0, matched: 0 };
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
    const expected = new Map(repo.calls.map((item) => [key(item), item]));
    const reported = new Map(
      result.calls.filter((item) => item.use === 'live').map((item) => [key(item), item]),
    );
    totals.labels += expected.size;
    totals.reported += reported.size;
    for (const [location, label] of expected) {
      const found = reported.get(location);
      if (!found) {
        misses.push(`${repo.repo} ${location}`);
        continue;
      }
      totals.matched += 1;
      if (!endpoint(label)) continue;
      compared += 1;
      if (endpoint(found) === endpoint(label)) agree += 1;
      else
        disagreements.push(
          `${repo.repo} ${location}: labelled ${endpoint(label)}, reported ${endpoint(found) ?? 'unknown'}`,
        );
    }
    for (const location of reported.keys())
      if (!expected.has(location)) extras.push(`${repo.repo} ${location}`);
  }
  const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  return {
    ...totals,
    precision: ratio(totals.matched, totals.reported),
    recall: ratio(totals.matched, totals.labels),
    endpointAgreement: ratio(agree, compared),
    compared,
    misses,
    extras,
    disagreements,
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
      'Usage: node scripts/cloudflare-score.mjs --labels <labels.json> --results <results.json>',
    );
    process.exit(values.help ? 0 : 1);
  }
  const read = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'));
  console.log(
    JSON.stringify(scoreCloudflare(await read(values.labels), await read(values.results)), null, 2),
  );
}
