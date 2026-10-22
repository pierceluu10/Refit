// Scores `refit slack` results against blind hand labels. A label is one live call site that sends
// a Slack Web API method: an SDK call or an HTTP request to slack.com/api, at the line where the
// call starts, with the methods it sends ([] when a runtime value chooses the method). Labels were
// written from the source before any scan of that repository was looked at.
//
//   node scripts/slack-score.mjs --labels <labels.json> --results <results.json>
//
// Only labelled repositories that scanned without error count. A reported live call matches a
// label at the same file and line; precision is matched reports over live reports, recall is
// matched labels over labels, and method agreement compares the method lists of matched pairs.
// Each `kind` of label (`calls`, and the report-only `webhooks` and `rtm` added later) is scored
// against the results of the same kind.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const key = (item) => `${item.file}:${item.line}`;

// labels: { repos: [{ repo, commit, calls: [{ file, line, methods }] }] }
// results: { results: [{ repo, commit, calls?: [{ file, line, use, methods }], error? }] }
export function scoreSlack(labels, results, field = 'calls') {
  const byRepo = new Map(results.results.map((item) => [`${item.repo}@${item.commit}`, item]));
  const totals = {
    repositories: 0,
    skipped: [],
    labels: 0,
    reported: 0,
    matched: 0,
    methodsAgree: 0,
  };
  const misses = [];
  const extras = [];
  const disagreements = [];
  for (const repo of labels.repos) {
    const result = byRepo.get(`${repo.repo}@${repo.commit}`);
    if (!result || result.error || !result[field]) {
      totals.skipped.push(repo.repo);
      continue;
    }
    totals.repositories += 1;
    const expected = new Map((repo[field] ?? []).map((item) => [key(item), item]));
    const reported = new Map(
      result[field].filter((item) => item.use === 'live').map((item) => [key(item), item]),
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
      if ([...found.methods].sort().join() === [...label.methods].sort().join())
        totals.methodsAgree += 1;
      else
        disagreements.push(
          `${repo.repo} ${location}: labelled ${label.methods.join('+') || '(runtime)'}, reported ${found.methods.join('+') || '(runtime)'}`,
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
    methodAgreement: ratio(totals.methodsAgree, totals.matched),
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
      field: { type: 'string', default: 'calls' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.labels || !values.results) {
    console.log(
      'Usage: node scripts/slack-score.mjs --labels <labels.json> --results <results.json> [--field calls]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const read = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'));
  console.log(
    JSON.stringify(
      scoreSlack(await read(values.labels), await read(values.results), values.field),
      null,
      2,
    ),
  );
}
