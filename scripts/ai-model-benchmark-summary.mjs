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
// scan says nothing about what the repository contains. `exposedSilent` leaves out errored
// repositories, which `exposedErrored` counts instead.
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
    exposedSilent: exposed.filter(
      (item) => !item.error && !item.replacements.length && !item.stops.length,
    ).length,
    replacements: results.reduce((total, item) => total + (item.replacements?.length ?? 0), 0),
    stops: results.reduce((total, item) => total + (item.stops?.length ?? 0), 0),
    mentionedOnly: results.filter(
      (item) => !item.error && !item.exposures?.length && item.nonLiveTotal > 0,
    ).length,
    // Exposed repositories whose proposal step failed: they are neither silent nor handled.
    exposedErrored: exposed.filter((item) => item.error).length,
    // Silent ones whose every live match is listed as unresolved, with where it is written, and
    // those left with no outcome at all. Results from before `unresolved` have none.
    exposedUnresolvedOnly: exposed.filter(
      (item) =>
        !item.error && !item.replacements.length && !item.stops.length && item.unresolved?.length,
    ).length,
    exposedUnexplained: exposed.filter(
      (item) =>
        !item.error && !item.replacements.length && !item.stops.length && !item.unresolved?.length,
    ).length,
    unresolved: results.reduce((total, item) => total + (item.unresolved?.length ?? 0), 0),
  };
}

// A stop reason without what varies between sites: quoted names, places in parentheses, model IDs
// and the closing "change it by hand to <model>".
export function stopReasonKind(reason) {
  return reason
    .replace(/`[^`]*`/g, '`…`')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[;,]?\s*(?:check [^;]* and )?change (?:it|its model) by hand.*$/, '')
    .replace(/\b(?:gpt|claude|chatgpt|dall-e|tts|whisper|o\d)[\w.:@-]*/g, '<model>')
    .trim();
}

// Stop reasons ranked by the exposed repositories they block: `repositories` where the reason
// stops at least one site, and `blocked` where the repository also gets no replacement.
export function stopReasons(results) {
  const kinds = new Map();
  for (const item of results) {
    if (!item.exposures?.length) continue;
    for (const kind of new Set(
      (item.stops ?? []).map((stop) => stopReasonKind(stop.reason ?? '')),
    )) {
      const counts = kinds.get(kind) ?? { reason: kind, repositories: 0, blocked: 0 };
      kinds.set(kind, counts);
      counts.repositories += 1;
      if (!item.replacements?.length) counts.blocked += 1;
    }
  }
  return [...kinds.values()].sort(
    (a, b) =>
      b.blocked - a.blocked || b.repositories - a.repositories || a.reason.localeCompare(b.reason),
  );
}
