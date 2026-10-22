// Scores Refit's list-A payments and commerce results against blind hand labels
// (docs/benchmarks/2026-10-22-commerce-labels.json). Three questions per labelled repository:
// which list-A providers it uses (provider detection), which registry entries of those providers
// it is exposed to through live evidence (exposure), and which API versions its live code pins,
// as `provider version` (pins). Each is scored by repository and item: a result the labels lack
// is a false positive, a label the result lacks a false negative. Repositories whose scan failed
// are counted apart, never as misses or hits.

export const PROVIDERS = [
  'plaid',
  'square',
  'braintree',
  'adyen',
  'paddle',
  'lemon-squeezy',
  'shippo',
  'easypost',
  'lob',
  'coinbase-commerce',
];

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function tally(pairs) {
  const counts = { truePositive: 0, falsePositive: 0, falseNegative: 0 };
  const misses = [];
  for (const { repo, expected, actual } of pairs) {
    for (const item of actual)
      if (expected.includes(item)) counts.truePositive += 1;
      else {
        counts.falsePositive += 1;
        misses.push({ repo, item, error: 'false positive' });
      }
    for (const item of expected)
      if (!actual.includes(item)) {
        counts.falseNegative += 1;
        misses.push({ repo, item, error: 'false negative' });
      }
  }
  return {
    ...counts,
    precision: ratio(counts.truePositive, counts.truePositive + counts.falsePositive),
    recall: ratio(counts.truePositive, counts.truePositive + counts.falseNegative),
    misses,
  };
}

// The list-A part of one repository's result: detected provider IDs, IDs of registry entries with
// live evidence, and the distinct live API-version pins.
export function repositoryResult(agents, deadlines) {
  const detected = (agents?.detected ?? []).filter((item) => PROVIDERS.includes(item.id));
  return {
    providers: detected.map((item) => item.id).sort(),
    exposures: (deadlines?.exposures ?? [])
      .filter((item) => PROVIDERS.includes(item.deadline.provider))
      .map((item) => item.deadline.id)
      .sort(),
    pins: [
      ...new Set(
        detected.flatMap((item) =>
          (item.apiVersions ?? [])
            .filter((pin) => pin.use === 'live')
            .map((pin) => `${pin.provider} ${pin.version}`),
        ),
      ),
    ].sort(),
  };
}

export function scoreCommerce(labels, results) {
  const byRepo = new Map(results.repos.map((item) => [item.repo.toLowerCase(), item]));
  const scored = [];
  const failed = [];
  for (const label of labels.labels) {
    const result = byRepo.get(label.repo.toLowerCase());
    if (!result || result.error) failed.push(label.repo);
    else scored.push({ label, result });
  }
  const select = (key) =>
    scored.map(({ label, result }) => ({
      repo: label.repo,
      expected: label[key],
      actual: result[key],
    }));
  return {
    labelled: labels.labels.length,
    scored: scored.length,
    failed,
    providers: tally(select('providers')),
    exposures: tally(select('exposures')),
    pins: tally(select('pins')),
  };
}
