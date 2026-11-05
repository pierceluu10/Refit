// What the scan hands the fix session: every live finding in a repo and the list entries behind them.
import type { MigrationTask } from '../shared/types.ts';

// shortcut: local stub of P1's contract; swap these three for shared/types.ts when rebuild/pierce lands.
export type DeadApiEntry = {
  id: string;
  provider: string;
  what: string; // what died
  diedOn: string;
  source: { url: string; checkedOn: string };
  lookFor: string[];
  versions?: string;
  replacement: string;
  requires: string[];
};
export type Finding = {
  entryId: string;
  file: string;
  line: number;
  matchClass: 'live' | 'catalog' | 'test' | 'comment' | 'unclear';
  version?: string;
};
export type ScanResult = { findings: Finding[]; unlistedProviders: string[]; clean: boolean };

export type RepoTask = MigrationTask & { findings: Finding[]; entries: DeadApiEntry[] };

export const isRepoTask = (task: MigrationTask): task is RepoTask =>
  Array.isArray((task as RepoTask).findings);

export const providersOf = (task: RepoTask) => [
  ...new Set(task.entries.map((entry) => entry.provider)),
];

// One task for the whole repo: one session, one sandbox, one PR. Comments and catalogs never start
// a fix, so a repo whose findings are all of those has nothing to attempt.
export function repoTask(repo: string, scan: ScanResult, list: DeadApiEntry[]): RepoTask {
  const findings = scan.findings;
  const ids = new Set(findings.map((finding) => finding.entryId));
  const entries = list.filter((entry) => ids.has(entry.id));
  const first = entries[0];
  return {
    id: `${repo}:dead-apis`,
    repo,
    change: {
      provider: first?.provider ?? 'unknown',
      id: 'dead-apis',
      kind: 'other',
      title:
        entries.length === 1 && first
          ? `Replace ${first.what}`
          : `Replace ${entries.length} dead APIs (${[...new Set(entries.map((entry) => entry.provider))].join(', ')})`,
      source: { url: first?.source.url ?? '', quote: '' },
      affects: {},
    },
    usages: [],
    priority: 1,
    findings,
    entries,
  };
}

const where = (finding: Finding) =>
  `  - ${finding.file}:${finding.line} (${finding.matchClass}${finding.version ? `, version ${finding.version}` : ''})`;

// The list as the session reads it: the entries first, each with its findings.
export function renderList(task: RepoTask): string {
  return task.entries
    .map((entry) =>
      [
        `### ${entry.id}: ${entry.what}`,
        `- Provider: ${entry.provider}`,
        `- Died: ${entry.diedOn}`,
        `- Source: ${entry.source.url} (checked ${entry.source.checkedOn})`,
        entry.versions ? `- Applies to: ${entry.versions}` : '',
        `- Replacement: ${entry.replacement}`,
        entry.requires.length ? `- The replacement requires: ${entry.requires.join(' ')}` : '',
        '- Found at:',
        ...task.findings.filter((finding) => finding.entryId === entry.id).map(where),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}
