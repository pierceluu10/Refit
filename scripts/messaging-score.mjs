// Scores `refit messaging` results against blind labels, in three units:
// - providers: a (repository, provider) pair Refit detects, against whether live code uses it;
// - calls: deprecated-member and removed-endpoint sites reported in live code, by file and line;
// - versions: package.json files Refit puts under the twilio-below-6.0.0 deadline.
// Only labelled repositories that were scanned are scored.

const SKIPPED =
  /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|\.refit)\/|\.d\.[cm]?ts$|\.min\.js$/;

function ratio(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

function compare(reported, expected) {
  const truePositives = [...reported].filter((key) => expected.has(key));
  const result = {
    truePositives: truePositives.length,
    falsePositives: reported.size - truePositives.length,
    falseNegatives: [...expected].filter((key) => !reported.has(key)).length,
    errors: [
      ...[...reported]
        .filter((key) => !expected.has(key))
        .map((key) => ({ kind: 'false-positive', key })),
      ...[...expected]
        .filter((key) => !reported.has(key))
        .map((key) => ({ kind: 'false-negative', key })),
    ],
  };
  return {
    ...result,
    precision: ratio(result.truePositives, result.truePositives + result.falsePositives),
    recall: ratio(result.truePositives, result.truePositives + result.falseNegatives),
  };
}

export function scoreMessaging(labels, results) {
  const scanned = new Map(
    results.results
      .filter((result) => result.status === 'scanned')
      .map((result) => [result.repo, result]),
  );
  const labelled = labels.repos.map((item) => item.repo).filter((repo) => scanned.has(repo));
  const inScope = (repo) => labelled.includes(repo);
  const providers = { reported: new Set(), expected: new Set() };
  const calls = { reported: new Set(), expected: new Set() };
  const versions = { reported: new Set(), expected: new Set() };
  for (const repo of labelled) {
    const result = scanned.get(repo);
    for (const item of result.providers) providers.reported.add(`${repo} ${item.agent.id}`);
    for (const call of result.calls)
      if (call.use === 'live' && !SKIPPED.test(call.file))
        calls.reported.add(`${repo} ${call.file}:${call.line}`);
    for (const item of result.packages)
      if (item.name === 'twilio' && item.deadline) versions.reported.add(`${repo} ${item.file}`);
  }
  for (const item of labels.providers)
    if (item.used && inScope(item.repo)) providers.expected.add(`${item.repo} ${item.provider}`);
  for (const item of labels.calls)
    if (item.deprecated && inScope(item.repo))
      calls.expected.add(`${item.repo} ${item.file}:${item.line}`);
  for (const item of labels.versions)
    if (item.below && inScope(item.repo)) versions.expected.add(`${item.repo} ${item.file}`);
  return {
    repositories: labelled.length,
    notScanned: labels.repos.map((item) => item.repo).filter((repo) => !scanned.has(repo)),
    providers: compare(providers.reported, providers.expected),
    calls: compare(calls.reported, calls.expected),
    versions: compare(versions.reported, versions.expected),
  };
}
