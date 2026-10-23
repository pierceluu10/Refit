// Scores `refit shopify-rest` results against blind labels in two units, by `repo file:line`:
// - rest: REST Admin request sites Refit lists (`rest`), against labelled REST requests;
// - removed: sites Refit matches to a removed endpoint (`calls`), against labelled requests to one.
// Live code only; labelled repositories that were not scanned are listed and left out.

function ratio(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

function compare(reported, expected) {
  const hits = [...reported].filter((key) => expected.has(key)).length;
  return {
    truePositives: hits,
    falsePositives: reported.size - hits,
    falseNegatives: [...expected].filter((key) => !reported.has(key)).length,
    precision: ratio(hits, reported.size),
    recall: ratio(hits, expected.size),
    errors: [
      ...[...reported]
        .filter((key) => !expected.has(key))
        .map((key) => ({ kind: 'false-positive', key })),
      ...[...expected]
        .filter((key) => !reported.has(key))
        .map((key) => ({ kind: 'false-negative', key })),
    ],
  };
}

export function scoreShopifyRest(labels, results) {
  const scanned = new Map(
    results.results.filter((item) => item.status === 'scanned').map((item) => [item.repo, item]),
  );
  const repos = labels.repos.map((item) => item.repo).filter((repo) => scanned.has(repo));
  const rest = { reported: new Set(), expected: new Set() };
  const removed = { reported: new Set(), expected: new Set() };
  for (const repo of repos) {
    const result = scanned.get(repo);
    for (const item of result.rest)
      if (item.use === 'live') rest.reported.add(`${repo} ${item.file}:${item.line}`);
    for (const item of result.calls)
      if (item.use === 'live') removed.reported.add(`${repo} ${item.file}:${item.line}`);
  }
  for (const site of labels.sites) {
    if (!repos.includes(site.repo) || !site.rest) continue;
    rest.expected.add(`${site.repo} ${site.file}:${site.line}`);
    if (site.removed === true) removed.expected.add(`${site.repo} ${site.file}:${site.line}`);
  }
  return {
    repositories: repos.length,
    notScanned: labels.repos.map((item) => item.repo).filter((repo) => !scanned.has(repo)),
    rest: compare(rest.reported, rest.expected),
    removed: compare(removed.reported, removed.expected),
  };
}
