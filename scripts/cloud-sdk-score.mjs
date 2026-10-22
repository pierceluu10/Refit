// Scores `refit cloud-sdk` results against blind labels: precision and recall of the reported
// client and package-load sites, overall, per SDK and per service. A site is `repo file:line` with
// its SDK; a reported site that matches a labelled one but names another service counts as wrong.
// Only live code in labelled repositories is scored, with the same path rules the candidate search
// used (scripts/cloud-sdk-label-candidates.mjs).

const SKIPPED =
  /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|\.refit)\/|\.d\.[cm]?ts$|\.min\.js$/;

function ratio(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

function bucket(map, key) {
  let row = map.get(key);
  if (!row) {
    row = { truePositives: 0, falsePositives: 0, falseNegatives: 0, wrongService: 0 };
    map.set(key, row);
  }
  return row;
}

function finish(row) {
  return {
    ...row,
    precision: ratio(row.truePositives, row.truePositives + row.falsePositives),
    recall: ratio(row.truePositives, row.truePositives + row.falseNegatives),
  };
}

export function scoreCloudSdk(labels, results) {
  const labelled = new Set(labels.repos.map((item) => item.repo));
  const positives = new Map();
  for (const site of labels.sites)
    if (site.client) positives.set(`${site.repo}\t${site.file}\t${site.line}\t${site.sdk}`, site);
  const reported = new Map();
  const missing = [];
  for (const result of results.results) {
    if (!labelled.has(result.repo)) continue;
    if (result.status !== 'scanned') {
      missing.push(result.repo);
      continue;
    }
    for (const client of result.clients)
      if (client.use === 'live' && !SKIPPED.test(client.file))
        reported.set(`${result.repo}\t${client.file}\t${client.line}\t${client.sdk}`, client);
  }
  const overall = bucket(new Map(), 'all');
  const bySdk = new Map();
  const byService = new Map();
  const errors = [];
  const count = (sdk, service, field) => {
    overall[field] += 1;
    bucket(bySdk, sdk)[field] += 1;
    bucket(byService, `${sdk} ${service}`)[field] += 1;
  };
  for (const [key, client] of reported) {
    const site = positives.get(key);
    if (!site) {
      count(client.sdk, client.service, 'falsePositives');
      errors.push({
        kind: 'false-positive',
        key: key.split('\t').join(' '),
        service: client.service,
      });
    } else if (site.service !== client.service) {
      count(client.sdk, client.service, 'falsePositives');
      count(site.sdk, site.service, 'falseNegatives');
      count(site.sdk, site.service, 'wrongService');
      errors.push({
        kind: 'wrong-service',
        key: key.split('\t').join(' '),
        service: client.service,
        expected: site.service,
      });
    } else count(client.sdk, client.service, 'truePositives');
  }
  for (const [key, site] of positives)
    if (!reported.has(key) && !missing.includes(site.repo)) {
      count(site.sdk, site.service, 'falseNegatives');
      errors.push({
        kind: 'false-negative',
        key: key.split('\t').join(' '),
        service: site.service,
      });
    }
  const table = (map) =>
    Object.fromEntries(
      [...map].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, finish(v)]),
    );
  return {
    repositories: labelled.size,
    notScanned: missing,
    overall: finish(overall),
    bySdk: table(bySdk),
    byService: table(byService),
    errors,
  };
}
