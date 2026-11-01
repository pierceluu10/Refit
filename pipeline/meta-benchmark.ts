import type { GraphCallScan } from './meta-graph-calls.ts';
import type { VersionMoveProposal } from './meta-graph-moves.ts';

// One Meta Graph benchmark row's scan outcome, from `refit meta-graph`'s scan and version-move
// proposal: `version-move` means the deterministic moves cover every pin, `needs-review` that at
// least one pin is left for the agent fixer.
export type MetaOutcome = 'no-graph-usage' | 'current' | 'version-move' | 'needs-review';
// The gut plan's four outcomes for a row (docs/GUT-PLAN.md): there are no stops.
export type MetaResult = 'validated' | 'needs-review' | 'no-change' | 'infrastructure';

export function metaResult(row: Record<string, unknown>): MetaResult {
  if (row.outcomeClass === 'infrastructure') return 'infrastructure';
  if ((row.workflow as { status?: string } | undefined)?.status === 'validated') return 'validated';
  if (row.outcome === 'no-graph-usage' || row.outcome === 'current') return 'no-change';
  return 'needs-review';
}

export function metaRow(scan: GraphCallScan, proposal: VersionMoveProposal) {
  const live = scan.calls.filter((call) => call.use === 'live');
  const versions = [...new Set(live.map((call) => call.version).filter(Boolean))] as string[];
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
    current: proposal.current.length,
    patch: proposal.patch,
  };
}

// The merged summary's table.
export function summaryTable(rows: Record<string, unknown>[]) {
  const count = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  };
  const results = count(rows.map((row) => String(row.result ?? metaResult(row))));
  const outcomes = count(
    rows.map((row) =>
      row.outcomeClass === 'infrastructure'
        ? 'infrastructure'
        : typeof row.error === 'string'
          ? 'error'
          : String(row.outcome),
    ),
  );
  // `refit run` outcomes and grades, for rows run with --validate.
  const workflows = rows.flatMap((row) =>
    row.workflow
      ? [row.workflow as { status: string; grade?: string; agent?: { outcome: string } }]
      : [],
  );
  const statuses = count(workflows.map((workflow) => workflow.status));
  const grades = count(workflows.map((workflow) => workflow.grade ?? 'none'));
  const agents = count(
    workflows.flatMap((workflow) => (workflow.agent ? [workflow.agent.outcome] : [])),
  );
  return [
    '| Result | Repositories |',
    '|---|---|',
    ...results.map(([result, total]) => `| ${result} | ${total} |`),
    '',
    '| Meta outcome | Repositories |',
    '|---|---|',
    ...outcomes.map(([outcome, total]) => `| ${outcome} | ${total} |`),
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
          ...(agents.length
            ? [
                '| Agent fixer | Repositories |',
                '|---|---|',
                ...agents.map(([outcome, total]) => `| ${outcome} | ${total} |`),
                '',
              ]
            : []),
        ]
      : []),
  ].join('\n');
}
