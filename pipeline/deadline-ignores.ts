import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DeadlineExposure } from './deadline-exposure.ts';
import { daysUntil, reportOnly } from './deadline-registry.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const DEADLINE_IGNORE_FILE = '.refit-deadlines-ignore.json';
const MAX_IGNORE_BYTES = 64 * 1024;
const MAX_IGNORES = 100;
const MAX_PATHS = 20;
const MAX_REASON = 500;
// An ignore is a reviewed, temporary decision: it must expire within a year, so nothing stays
// accepted without someone looking at it again.
export const MAX_IGNORE_DAYS = 365;
const MAX_FAIL_WITHIN_DAYS = 3650;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEYS = new Set(['deadline', 'reason', 'until', 'paths']);

// One accepted exposure: a registry deadline, why it is accepted, the last day the acceptance
// holds, and optionally the repository paths it covers. Without paths it covers the repository.
export interface DeadlineIgnore {
  deadline: string;
  reason: string;
  until: string;
  paths: string[] | null;
}

export interface DeadlineIgnores {
  // The file read, relative to the repository when it is inside it; null when there is none.
  file: string | null;
  entries: DeadlineIgnore[];
}

function realDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
  );
}

// "src/legacy/" or "./src/legacy" → "src/legacy". Repository-relative, forward slashes, no
// parent segments, so a path can never reach outside the repository it describes.
function normalizePath(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  )
    return undefined;
  return path;
}

// Validates an ignore document. Every problem is reported at once, and any problem rejects the
// whole file: a half-valid file must not silently accept some exposures.
export function parseDeadlineIgnores(value: unknown, now: Date): DeadlineIgnore[] {
  const errors: string[] = [];
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.ignore) ||
    Object.keys(value).some((key) => key !== 'formatVersion' && key !== 'ignore')
  )
    throw new PipelineInputError(
      `${DEADLINE_IGNORE_FILE} requires formatVersion: 1 and an ignore array, and nothing else.`,
    );
  if (value.ignore.length > MAX_IGNORES)
    throw new PipelineInputError(`${DEADLINE_IGNORE_FILE} accepts at most ${MAX_IGNORES} entries.`);
  const entries: DeadlineIgnore[] = [];
  for (const [index, entry] of value.ignore.entries()) {
    const label = `ignore[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => !ENTRY_KEYS.has(key));
    if (unknown.length) errors.push(`${label} has unknown fields: ${unknown.join(', ')}.`);
    if (typeof entry.deadline !== 'string' || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(entry.deadline))
      errors.push(`${label}.deadline must be a registry deadline id, such as meta-graph-v19-0.`);
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!reason) errors.push(`${label}.reason must say why this exposure is accepted.`);
    else if (reason.length > MAX_REASON)
      errors.push(`${label}.reason must be at most ${MAX_REASON} characters.`);
    if (!realDate(entry.until)) errors.push(`${label}.until must be a real YYYY-MM-DD date.`);
    else if (daysUntil(entry.until, now) > MAX_IGNORE_DAYS)
      errors.push(
        `${label}.until must be within ${MAX_IGNORE_DAYS} days; set a review date instead of ignoring indefinitely.`,
      );
    let paths: string[] | null = null;
    if (entry.paths !== undefined) {
      if (!Array.isArray(entry.paths) || !entry.paths.length || entry.paths.length > MAX_PATHS)
        errors.push(`${label}.paths must list 1–${MAX_PATHS} repository paths.`);
      else {
        paths = entry.paths.map(normalizePath).filter((path): path is string => Boolean(path));
        if (paths.length !== entry.paths.length)
          errors.push(
            `${label}.paths must be relative repository paths without "..", such as src/legacy.`,
          );
      }
    }
    entries.push({
      deadline: String(entry.deadline),
      reason,
      until: String(entry.until),
      paths,
    });
  }
  if (errors.length)
    throw new PipelineInputError(`${DEADLINE_IGNORE_FILE} is invalid: ${errors.join(' ')}`);
  return entries;
}

// Reads the repository's ignore file, or an explicit one. A missing default file means no
// ignores; a missing explicit file, a symbolic link, an oversized file or invalid content is an
// error, so a CI check never passes because its ignores were misread.
export async function readDeadlineIgnores(
  repository: string,
  now: Date,
  explicit?: string,
): Promise<DeadlineIgnores> {
  const root = resolve(repository);
  const path = explicit ? resolve(explicit) : join(root, DEADLINE_IGNORE_FILE);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (!explicit && error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { file: null, entries: [] };
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new PipelineInputError(`${path} must be a regular file, not a link or directory.`);
  if (stats.size > MAX_IGNORE_BYTES)
    throw new PipelineInputError(`${path} exceeds ${MAX_IGNORE_BYTES / 1024} KiB.`);
  const content = await readFile(path, 'utf8');
  const entries = parseDeadlineIgnores(parseObject(content, DEADLINE_IGNORE_FILE), now);
  const inside = relative(root, path);
  return {
    file: inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path,
    entries,
  };
}

function covers(paths: string[], file: string) {
  return paths.some((path) => file === path || file.startsWith(`${path}/`));
}

export interface IgnoreDecision {
  // The active entries that accept this exposure; empty when it is not accepted.
  ignoredBy: DeadlineIgnore[];
  // Why active entries for this deadline did not accept it, if any.
  note: string | null;
}

// Decides which exposures active ignores accept. An exposure is accepted only when every piece of
// its live evidence is covered: a repository-wide entry covers everything, and path-scoped entries
// must cover every listed file and cannot vouch for matches past the listing limit.
export function applyDeadlineIgnores(
  exposures: DeadlineExposure[],
  ignores: DeadlineIgnore[],
  knownDeadlines: ReadonlySet<string>,
  now: Date,
) {
  const active = ignores.filter((entry) => daysUntil(entry.until, now) >= 0);
  const decisions = new Map<string, IgnoreDecision>();
  for (const exposure of exposures) {
    const entries = active.filter((entry) => entry.deadline === exposure.deadline.id);
    if (!entries.length) continue;
    const wide = entries.filter((entry) => !entry.paths);
    if (wide.length) {
      decisions.set(exposure.deadline.id, { ignoredBy: wide, note: null });
      continue;
    }
    const paths = entries.flatMap((entry) => entry.paths!);
    const uncovered = exposure.evidence.filter((item) => !covers(paths, item.file));
    decisions.set(
      exposure.deadline.id,
      exposure.more
        ? {
            ignoredBy: [],
            note: `Path-scoped ignores cannot cover the ${exposure.more} matches past the listing limit; ignore the whole repository or fix the extra uses.`,
          }
        : uncovered.length
          ? {
              ignoredBy: [],
              note: `Not covered by the ignore paths: ${[...new Set(uncovered.map((item) => item.file))].join(', ')}.`,
            }
          : { ignoredBy: entries, note: null },
    );
  }
  return {
    decisions,
    expired: ignores.filter((entry) => daysUntil(entry.until, now) < 0),
    unknown: ignores.filter((entry) => !knownDeadlines.has(entry.deadline)),
  };
}

// "30" → 30. Whole days from 0 (fail only on past-due deadlines and today) to ten years.
export function parseFailWithin(value: string) {
  const days = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(days) || days > MAX_FAIL_WITHIN_DAYS)
    throw new PipelineInputError(
      `--fail-within takes whole days from 0 to ${MAX_FAIL_WITHIN_DAYS}, such as 30.`,
    );
  return days;
}

// The CI decision: a live exposure fails when its deadline is today, past or within the window,
// unless a reviewed ignore accepts it.
export function deadlineCheck(
  exposures: DeadlineExposure[],
  decisions: ReadonlyMap<string, IgnoreDecision>,
  failWithin: number,
) {
  const due = exposures.filter(
    (exposure) => exposure.days <= failWithin && !reportOnly(exposure.deadline),
  );
  const failing = due.filter((exposure) => !decisions.get(exposure.deadline.id)?.ignoredBy.length);
  return {
    failWithin,
    status: failing.length ? ('fail' as const) : ('pass' as const),
    failing: failing.map((exposure) => exposure.deadline.id),
    ignored: due
      .filter((exposure) => decisions.get(exposure.deadline.id)?.ignoredBy.length)
      .map((exposure) => exposure.deadline.id),
  };
}
