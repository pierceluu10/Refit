// The numbers ai-model-benchmark.mjs writes for each repository and for the whole run. They are
// pure functions of the `refit deadlines --json` result and the per-repository results, so tests
// can feed them fixtures.

// One provider's non-live matches in a repository, by use, from the exact counts the scan keeps
// for each exposure and mention. Key order carries no meaning.
export function repositoryNonLive(result, provider) {
  const nonLive = {};
  for (const group of [...(result?.exposures ?? []), ...(result?.mentions ?? [])])
    if (group.deadline.provider === provider)
      for (const [use, count] of Object.entries(group.nonLiveCounts ?? {}))
        nonLive[use] = (nonLive[use] ?? 0) + count;
  return {
    nonLive,
    nonLiveTotal: Object.values(nonLive).reduce((total, count) => total + count, 0),
  };
}

// The 2026-10-20 keys keep their meaning. `mentionedOnly` counts repositories that name a deadline
// model only outside live code: no live exposure, some non-live match and no error, since a failed
// scan says nothing about what the repository contains.
export function benchmarkSummary(results) {
  const exposed = results.filter((item) => item.exposures?.length);
  return {
    repositories: results.length,
    errors: results.filter((item) => item.error).length,
    timedOut: results.filter((item) => item.error?.startsWith('timed out')).length,
    exposed: exposed.length,
    exposedWithReplacement: exposed.filter((item) => item.replacements.length).length,
    exposedStoppedOnly: exposed.filter((item) => !item.replacements.length && item.stops.length)
      .length,
    exposedSilent: exposed.filter((item) => !item.replacements.length && !item.stops.length).length,
    replacements: results.reduce((total, item) => total + (item.replacements?.length ?? 0), 0),
    stops: results.reduce((total, item) => total + (item.stops?.length ?? 0), 0),
    mentionedOnly: results.filter(
      (item) => !item.error && !item.exposures?.length && item.nonLiveTotal > 0,
    ).length,
  };
}
