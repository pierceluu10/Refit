// Scores how Refit treats WhatsApp Cloud API and Messenger Send API requests against blind hand
// labels (docs/benchmarks/2026-10-22-meta-platform-labels.json). Each label is a live request a
// person found by reading the code: its file, the lines that identify it (where its HTTP or helper
// call starts and, when the URL is written on another line, that line too), and whether it goes
// to WhatsApp or Messenger. A result on any of its lines counts for the request. Three questions, from `refit meta-graph --json` and
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
    const claimed = new Set();
    for (const request of label.requests) {
      const keys = request.lines.map((line) => `${request.file}:${line}`);
      for (const key of keys) claimed.add(key);
      const name = keys[0];
      tally.labelled += 1;
      if (keys.some((key) => result.calls.includes(key))) tally.found += 1;
      else misses.push({ repo: label.repo, line: name, error: 'not found' });
      if (keys.some((key) => result.guarded.includes(key))) tally.guarded += 1;
      else misses.push({ repo: label.repo, line: name, error: 'not guarded' });
      if (keys.some((key) => result.moved.includes(key))) {
        tally.moved += 1;
        misses.push({ repo: label.repo, line: name, error: 'moved' });
      }
    }
    for (const key of result.guarded)
      if (!claimed.has(key)) {
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
