// What the scan hands the fix session: every live finding in a repo and the list entries behind them.
import type { DeadApiEntry, Finding, MigrationTask, ScanResult } from '../shared/types.ts';

export type { DeadApiEntry, Finding, ScanResult };

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

// What a rescan still finds: only live code counts. A test that keeps the dead name is reported, not
// held against the fix, unless the live path still has it too.
export const liveFindings = (scan: ScanResult) =>
  scan.findings.filter((finding) => finding.matchClass === 'live');

const JS_CHECK = /^(typecheck|build|test)$/;
const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/;
const PY_FILE = /\.py$/;

// Did any passing check touch what changed? Its own test does; otherwise a check of the same language
// as a changed file. shortcut: a language match, not coverage; a build can miss a changed file.
export function checksTouchChange(
  files: string[],
  passing: string[],
  proofTest: string | undefined,
): boolean {
  if (proofTest && passing.includes(proofTest)) return true;
  const js = files.some((file) => JS_FILE.test(file)) && passing.some((n) => JS_CHECK.test(n));
  const py = files.some((file) => PY_FILE.test(file)) && passing.includes('pytest');
  return js || py;
}

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|\.refit-proof)(\/|$)|\.(test|spec)\.\w+$/;

// A rename touches about a line per finding. Far more than that means the calls themselves changed,
// which a clean rescan can't vouch for: the blind read of O7 rejected half the "Fixed" reworks.
export function isRework(diff: string, findings: Finding[]): boolean {
  let added = 0;
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const file = /^diff --git a\/.+? b\/(.+)$/m.exec(section)?.[1];
    if (!file || !CODE_FILE.test(file) || TEST_FILE.test(file)) continue;
    added += section.split('\n').filter((line) => /^\+(?!\+\+)/.test(line)).length;
  }
  const live = findings.filter((finding) => finding.matchClass === 'live').length;
  return added > Math.max(REWORK_LINES, live * REWORK_LINES_PER_FINDING);
}

const REWORK_LINES = 20;
const REWORK_LINES_PER_FINDING = 3;

// What an entry says the move requires taking out, and the fix's own hunks still set: the lines
// around the edit, since a whole file can set it for another provider.
export function requiredRemovals(entries: DeadApiEntry[], diff: string): string[] {
  const left = new Set<string>();
  const names = entries.flatMap((entry) =>
    entry.requires.flatMap((line) =>
      /\bremove\b/i.test(line) ? (line.match(/\b(temperature|top_p|top_k)\b/gi) ?? []) : [],
    ),
  );
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const file = /^diff --git a\/.+? b\/(.+)$/m.exec(section)?.[1];
    if (!file || !CODE_FILE.test(file) || TEST_FILE.test(file)) continue;
    const kept = section.split('\n').filter((line) => /^[ +](?!\+\+)/.test(line));
    for (const name of new Set(names.map((found) => found.toLowerCase()))) {
      if (kept.some((line) => new RegExp(`\\b${name}\\b`, 'i').test(line))) {
        left.add(`${name} in ${file}`);
      }
    }
  }
  return [...left];
}

export type FixLabel = { outcome: 'verified' | 'needs-review' | 'failed'; reason: string };

// The label from plain facts: the rescan and the checks, never the session's own words.
export function labelFix(input: {
  findings: Finding[]; // what the first scan found
  rescan: ScanResult;
  newFailures: number;
  changed: boolean;
  touched: boolean;
  rework?: boolean;
  codeRan?: boolean; // a passing check imports the code that changed
  stillSet?: string[]; // what the entry says to remove and a changed file still has
}): FixLabel {
  const before = input.findings.filter((finding) => finding.matchClass === 'live').length;
  const left = liveFindings(input.rescan).length;
  const failures = `${input.newFailures} new check failure${input.newFailures === 1 ? '' : 's'}`;
  if (!input.changed) return { outcome: 'failed', reason: 'The session changed nothing.' };
  if (input.newFailures > 0) return { outcome: 'failed', reason: `The fix caused ${failures}.` };
  if (left >= before) {
    return { outcome: 'failed', reason: `The rescan still finds ${left} of ${before} uses.` };
  }
  if (left > 0) {
    return {
      outcome: 'needs-review',
      reason: `Partly clean: the rescan still finds ${left} of ${before} uses.`,
    };
  }
  if (!input.touched) {
    return {
      outcome: 'needs-review',
      reason: 'The rescan is clean, but no check that passes touches the changed code.',
    };
  }
  if (input.rework && !input.codeRan) {
    return {
      outcome: 'needs-review',
      reason: 'The rescan is clean, but this reworks the calls and no test runs the new code.',
    };
  }
  if (input.stillSet?.length) {
    return {
      outcome: 'needs-review',
      reason: `The rescan is clean, but the list says to remove what's still here: ${input.stillSet.join(', ')}.`,
    };
  }
  return { outcome: 'verified', reason: 'The rescan is clean and the checks are no worse.' };
}
