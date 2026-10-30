import type { GraphCallScan } from './meta-graph-calls.ts';
import type { VersionMoveProposal } from './meta-graph-moves.ts';

// One Meta Graph benchmark row's outcome, from `refit meta-graph`'s scan and version-move
// proposal. Nothing is applied or validated: `version-move` means Refit proposes a patch with no
// stop, `needs-review` that at least one pin stops.
export type MetaOutcome = 'no-graph-usage' | 'current' | 'version-move' | 'needs-review';

// Why a pin stops, in the order a reason is matched. The texts are pipeline/meta-graph-moves.ts's.
const STOP_KINDS: [string, RegExp][] = [
  ['separate-changelog', /follow their own changelogs/],
  ['unreviewed-changelog', /not reviewed in the Meta Graph API change list/],
  ['listed-change', /^.+:\d+: v\d+\.\d+ [a-z-]+ [a-z0-9-]+: /],
  ['business-sdk', /requests follow the package's version/],
  ['unversioned', /the URL names no version|the version is built at runtime/],
  ['tests-only', /only tests and examples use this version/],
  ['newer-than-target', /is newer than the target/],
  ['unknown-request', /is not known|are not known|no request call was traced/],
  [
    'version-holder',
    /is written \d+ times|is not written on this line|not inside a string|destructured value|in the exported|which is not a const|used in a way|file not found/,
  ],
];

export function stopKind(reason: string) {
  return STOP_KINDS.find(([, pattern]) => pattern.test(reason))?.[0] ?? 'other';
}

export function metaRow(scan: GraphCallScan, proposal: VersionMoveProposal) {
  const live = scan.calls.filter((call) => call.use === 'live');
  const versions = [...new Set(live.map((call) => call.version).filter(Boolean))] as string[];
  const stopKinds: Record<string, number> = {};
  for (const stop of proposal.stops)
    for (const kind of new Set(stop.reasons.map(stopKind)))
      stopKinds[kind] = (stopKinds[kind] ?? 0) + 1;
  const outcome: MetaOutcome = !live.length
    ? 'no-graph-usage'
    : proposal.stops.length
      ? 'needs-review'
      : proposal.moves.length
        ? 'version-move'
        : 'current';
  return {
    outcome,
    liveRequests: live.length,
    testRequests: scan.calls.length - live.length,
    versions: versions.sort(),
    businessSdk: scan.sdk ? (scan.sdk.locked ?? scan.sdk.declared) : null,
    target: proposal.target,
    moves: proposal.moves.map((move) => ({
      file: move.file,
      line: move.line,
      from: move.from,
      to: move.to,
    })),
    stops: proposal.stops.map((stop) => ({
      file: stop.file,
      line: stop.line,
      from: stop.from,
      requests: stop.requests.length,
      reasons: stop.reasons,
    })),
    stopKinds,
    current: proposal.current.length,
    patch: proposal.patch,
  };
}

// The merged summary's table: outcomes, then stop kinds counted once per repository.
export function summaryTable(rows: Record<string, unknown>[]) {
  const count = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  };
  const outcomes = count(
    rows.map((row) =>
      row.outcomeClass === 'infrastructure'
        ? 'infrastructure'
        : typeof row.error === 'string'
          ? 'error'
          : String(row.outcome),
    ),
  );
  const kinds = count(rows.flatMap((row) => Object.keys((row.stopKinds as object) ?? {})));
  // `refit run` outcomes and grades, for rows run with --validate.
  const workflows = rows.flatMap((row) =>
    row.workflow ? [row.workflow as { status: string; grade?: string }] : [],
  );
  const statuses = count(workflows.map((workflow) => workflow.status));
  const grades = count(workflows.map((workflow) => workflow.grade ?? 'none'));
  return [
    '| Meta outcome | Repositories |',
    '|---|---|',
    ...outcomes.map(([outcome, total]) => `| ${outcome} | ${total} |`),
    '',
    '| Stop kind | Repositories |',
    '|---|---|',
    ...kinds.map(([kind, total]) => `| ${kind} | ${total} |`),
    '',
    ...(workflows.length
      ? [
          '| refit run | Repositories |',
          '|---|---|',
          ...statuses.map(([status, total]) => `| ${status} | ${total} |`),
          '',
          '| Grade | Repositories |',
          '|---|---|',
          ...grades.map(([grade, total]) => `| ${grade} | ${total} |`),
          '',
        ]
      : []),
  ].join('\n');
}
