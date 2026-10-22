// Scores Refit's Auth0, Clerk, Firebase, Supabase and NextAuth.js results against blind hand labels
// (docs/benchmarks/2026-10-22-auth-backend-labels.json). Two questions per labelled repository:
// which of the five providers it uses (provider detection), and which registry entries of those
// providers it is exposed to through live evidence (exposure). Each is scored by repository and
// item: a result the labels lack is a false positive, a label the result lacks a false negative.
// Repositories whose scan failed are counted apart, never as misses or hits.

export const PROVIDERS = ['auth0', 'clerk', 'firebase', 'supabase', 'nextauth'];

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

// The five providers' part of one repository's result: provider IDs Refit detected and IDs of the
// registry entries with live evidence.
export function repositoryResult(agents, deadlines) {
  return {
    providers: (agents?.detected ?? [])
      .map((item) => item.id)
      .filter((id) => PROVIDERS.includes(id))
      .sort(),
    exposures: (deadlines?.exposures ?? [])
      .filter((item) => PROVIDERS.includes(item.deadline.provider))
      .map((item) => item.deadline.id)
      .sort(),
  };
}

export function scoreAuthBackend(labels, results) {
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
  };
}
