// Scores how Refit treats WhatsApp Cloud API and Messenger Send API requests against blind hand
// labels (docs/benchmarks/2026-10-22-meta-platform-labels.json). Each label is a live request a
// person found by reading the code: its file and the line its HTTP call starts on, and whether it
// goes to WhatsApp or Messenger. Three questions, from `refit meta-graph --json` and
// `refit meta-graph --propose-version-moves --json`:
// - found: the request scan reports a live call on that line;
// - guarded: a version-move stop names that line with the WhatsApp and Messenger reason, so no
//   move can change its version while their changelogs are unread;
// - moved: a proposed move includes the request, which must never happen.
// Guarded lines no label names are counted too, as the guard's false positives.

export const GUARD_REASON =
  'WhatsApp Business Platform and Messenger Platform requests follow their own changelogs';

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

// One repository's result: live call lines, lines the guard names, and lines inside a move.
export function repositoryResult(scan, moves) {
  const guarded = new Set();
  for (const stop of moves?.stops ?? [])
    for (const reason of stop.reasons ?? [])
      if (reason.includes(GUARD_REASON)) guarded.add(reason.slice(0, reason.indexOf(': ')));
  return {
    calls: [
      ...new Set(
        (scan?.calls ?? [])
          .filter((call) => call.use === 'live')
          .map((call) => `${call.file}:${call.line}`),
      ),
    ].sort(),
    guarded: [...guarded].sort(),
    moved: [
      ...new Set(
        (moves?.moves ?? []).flatMap((move) =>
          (move.requests ?? []).map((request) => `${request.file}:${request.line}`),
        ),
      ),
    ].sort(),
  };
}

export function scoreMetaPlatform(labels, results) {
  const byRepo = new Map(results.repos.map((item) => [item.repo.toLowerCase(), item]));
  const tally = { labelled: 0, found: 0, guarded: 0, moved: 0, falseGuards: 0 };
  const misses = [];
  const failed = [];
  for (const label of labels.labels) {
    const result = byRepo.get(label.repo.toLowerCase());
    if (!result || result.error) {
      failed.push(label.repo);
      continue;
    }
    const expected = new Set(label.requests.map((request) => `${request.file}:${request.line}`));
    for (const key of expected) {
      tally.labelled += 1;
      if (result.calls.includes(key)) tally.found += 1;
      else misses.push({ repo: label.repo, line: key, error: 'not found' });
      if (result.guarded.includes(key)) tally.guarded += 1;
      else misses.push({ repo: label.repo, line: key, error: 'not guarded' });
      if (result.moved.includes(key)) {
        tally.moved += 1;
        misses.push({ repo: label.repo, line: key, error: 'moved' });
      }
    }
    for (const key of result.guarded)
      if (!expected.has(key)) {
        tally.falseGuards += 1;
        misses.push({ repo: label.repo, line: key, error: 'guarded, not labelled' });
      }
  }
  return {
    repositories: labels.labels.length - failed.length,
    failed,
    ...tally,
    foundRecall: ratio(tally.found, tally.labelled),
    guardRecall: ratio(tally.guarded, tally.labelled),
    guardPrecision: ratio(tally.guarded, tally.guarded + tally.falseGuards),
    misses,
  };
}
