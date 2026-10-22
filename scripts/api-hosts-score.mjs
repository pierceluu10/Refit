// Scores detected API hosts against hand labels at the level of (repository, host) pairs.
// `found` maps a repository name to the hosts the detector reported; `labels` is the labels file.
export function scoreApiHosts(found, labels) {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const wrong = [];
  const missed = [];
  for (const { repo, hosts } of labels.repos) {
    const expected = new Set(hosts);
    const reported = new Set(found[repo] ?? []);
    for (const host of reported)
      if (expected.has(host)) truePositives++;
      else {
        falsePositives++;
        wrong.push({ repo, host });
      }
    for (const host of expected)
      if (!reported.has(host)) {
        falseNegatives++;
        missed.push({ repo, host });
      }
  }
  const ratio = (part, whole) => (whole ? Number((part / whole).toFixed(4)) : null);
  return {
    repositories: labels.repos.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    wrong,
    missed,
  };
}
