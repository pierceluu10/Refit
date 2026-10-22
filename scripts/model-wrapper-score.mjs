// Scores AI wrapper SDK detection (pipeline/model-wrappers.ts) against blind hand labels
// (docs/benchmarks/2026-10-22-model-wrapper-labels.json). A site matches on file, line and the
// model string as written; the provider must agree too. Pure, so tests can feed it fixtures.

const key = (site) => `${site.file}:${site.line}:${site.model}`;
const rate = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : null);

// `labelled` is the labels file's `repos`; `detected` maps each repository to the sites found.
export function scoreWrapperSites(labelled, detected) {
  const totals = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
  const byWrapper = {};
  const falsePositiveSites = [];
  const falseNegativeSites = [];
  const count = (wrapper, field) => {
    byWrapper[wrapper] ??= { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
    byWrapper[wrapper][field] += 1;
    totals[field] += 1;
  };
  for (const entry of labelled) {
    const found = new Map((detected[entry.repo] ?? []).map((site) => [key(site), site]));
    const expected = new Map(entry.sites.map((site) => [key(site), site]));
    for (const [id, site] of expected) {
      const hit = found.get(id);
      if (hit && hit.provider === site.provider) count(site.wrapper, 'truePositives');
      else {
        count(site.wrapper, 'falseNegatives');
        falseNegativeSites.push({ repo: entry.repo, ...site });
      }
    }
    for (const [id, site] of found)
      if (!expected.has(id) || expected.get(id).provider !== site.provider) {
        count(site.wrapper, 'falsePositives');
        falsePositiveSites.push({ repo: entry.repo, ...site });
      }
  }
  const scored = (counts) => ({
    ...counts,
    precision: rate(counts.truePositives, counts.truePositives + counts.falsePositives),
    recall: rate(counts.truePositives, counts.truePositives + counts.falseNegatives),
  });
  return {
    repositories: labelled.length,
    ...scored(totals),
    byWrapper: Object.fromEntries(
      Object.entries(byWrapper)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([wrapper, counts]) => [wrapper, scored(counts)]),
    ),
    falsePositiveSites,
    falseNegativeSites,
  };
}
