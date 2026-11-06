import type { AuditEntry } from '../../shared/types.ts';

const BOM = '\uFEFF';
const ROW_END = '\r\n';
const COLUMNS = [
  'Time',
  'Repository',
  'Change',
  'Obligation',
  'Action',
  'Pull request',
  'Evidence',
  'Actor',
];
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

// A spreadsheet runs a cell starting with = + - @ as a formula, and evidence holds third-party text.
function cell(value = ''): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function chronological(entries: AuditEntry[]): AuditEntry[] {
  return [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function auditCsv(entries: AuditEntry[]): string {
  const rows = chronological(entries).map((entry) => [
    entry.at,
    entry.repo,
    entry.changeId,
    entry.obligationId,
    entry.action,
    entry.pr,
    entry.evidence.join('\n'),
    entry.actor,
  ]);
  return BOM + [COLUMNS, ...rows].map((row) => row.map(cell).join(',') + ROW_END).join('');
}
