import type { BehindItem, ScanReport } from '../../shared/types.ts';
import { link, plain } from './slack.ts';

const DEADLINE_WARNING_DAYS = 30;
const MAX_DIGEST_ITEMS = 10;
const DAY_MS = 86_400_000;
const ISO_DAY_LENGTH = 10;
const UNDATED_LAST = Number.MAX_VALUE;
// The form watchers write (providers/core/watcher.ts), plus an optional time.
const ISO_DAY = /^\d{4}-\d{2}(-\d{2})?(?=T|$)/;

// Date.parse alone is too loose: V8 reads "late 2026" as 1 January and 2026-02-30 as 2 March,
// which would raise false "passed" alerts or show a date nobody wrote.
function parseDeadline(value: string | undefined): number | undefined {
  const day = value?.match(ISO_DAY)?.[0];
  if (!value || !day) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(Date.parse(day)).toISOString().startsWith(day) ? time : undefined;
}

const deadlineOf = (item: BehindItem) => parseDeadline(item.deadline ?? item.change.effectiveDate);

// Whole UTC days, because deadlines are shown as days: one due today hasn't passed yet.
const daysUntil = (time: number, now: number) =>
  Math.floor(time / DAY_MS) - Math.floor(now / DAY_MS);

function formatDeadline(time: number, now: number): string {
  const day = new Date(time).toISOString().slice(0, ISO_DAY_LENGTH);
  return daysUntil(time, now) < 0 ? `${day} (passed)` : day;
}

const isBehind = (item: BehindItem) => item.status === 'open' || item.status === 'pr-open';

export function dueItems(report: ScanReport, now: number): BehindItem[] {
  return report.items.filter((item) => {
    const deadline = deadlineOf(item);
    return (
      isBehind(item) && deadline !== undefined && daysUntil(deadline, now) < DEADLINE_WARNING_DAYS
    );
  });
}

export const finishedMessage = (repo: string, title: string, pr: string) =>
  `Migration verified in ${plain(repo)}: ${plain(title)} · ${link(pr, 'PR')}`;

// shortcut: a report past Slack's text limit (40,000 characters per its docs) gets cut, split it if reports get there.
export function scanMessage(repo: string, items: BehindItem[], now: number): string {
  const rows = items.map((item) => {
    const parts = [
      `• ${plain(item.dependency.name)}: ${plain(item.change.title)}`,
      `deadline ${formatDeadline(deadlineOf(item)!, now)}`,
      link(item.change.source.url, 'source'),
      ...(item.pr ? [link(item.pr, 'PR')] : []),
    ];
    return parts.join(' · ');
  });
  return [`Deadlines coming up in ${plain(repo)}:`, ...rows].join('\n');
}

function digestRow(item: BehindItem, now: number): string {
  const deadline = deadlineOf(item);
  return [
    `• ${plain(item.repo)}, ${plain(item.dependency.name)}: ${plain(item.change.title)}`,
    ...(item.change.toVersion ? [`target ${plain(item.change.toVersion)}`] : []),
    deadline === undefined ? 'no deadline' : `deadline ${formatDeadline(deadline, now)}`,
    item.pr ? link(item.pr, 'PR') : link(item.change.source.url, 'source'),
  ].join(' · ');
}

function orgDigest(org: string, items: BehindItem[], now: number): string {
  const behind = items.filter(isBehind);
  if (behind.length === 0) return `*${plain(org)}*: nothing behind.`;

  const sorted = [...behind].sort(
    (a, b) => (deadlineOf(a) ?? UNDATED_LAST) - (deadlineOf(b) ?? UNDATED_LAST),
  );
  const next = sorted
    .map(deadlineOf)
    .find((deadline) => deadline !== undefined && daysUntil(deadline, now) >= 0);
  const open = behind.filter((item) => item.status === 'open').length;
  const summary = [
    `*${plain(org)}*: ${open} open, ${behind.length - open} PR open.`,
    next === undefined ? 'No upcoming deadline.' : `Next deadline ${formatDeadline(next, now)}.`,
  ].join(' ');
  const rows = sorted.slice(0, MAX_DIGEST_ITEMS).map((item) => digestRow(item, now));
  const hidden = sorted.length - rows.length;
  return [summary, ...rows, ...(hidden > 0 ? [`and ${hidden} more`] : [])].join('\n');
}

// shortcut: one webhook for every org, per-org webhooks need customer settings.
export function digestMessages(reports: ScanReport[], now: number): string[] {
  const orgs = new Map<string, BehindItem[]>();
  for (const report of reports) {
    const org = report.repo.split('/')[0];
    orgs.set(org, [...(orgs.get(org) ?? []), ...report.items]);
  }
  return [...orgs].map(([org, items]) => orgDigest(org, items, now));
}
