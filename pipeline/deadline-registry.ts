import { readFile } from 'node:fs/promises';
import { rangesOverlap, sdkTarget, validRange } from './sdk-deadlines.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const DEFAULT_DEADLINE_REGISTRY = new URL('../data/deadlines.json', import.meta.url);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const PROVIDERS = new Set([
  'shopify',
  'meta-graph',
  'openai',
  'anthropic',
  'gemini',
  'slack',
  'cloudflare',
  'github',
  'auth0',
  'clerk',
  'firebase',
  'supabase',
  'nextauth',
]);
const KINDS = new Set(['api-version', 'model', 'sdk', 'method', 'endpoint', 'field', 'feature']);
const ENTRY_KEYS = [
  'id',
  'provider',
  'kind',
  'versions',
  'date',
  'summary',
  'replacement',
  'source',
  'checkedAt',
  'derivedDate',
];
// Kinds whose matching is too new to gate a build or open an issue (owner decision, 2026-10-22).
const REPORT_ONLY_KINDS = new Set(['method', 'endpoint', 'field', 'feature']);
const MILLISECONDS_PER_DAY = 86_400_000;

// One reviewed sunset: the date a provider stops serving these API versions or models, ends
// support for these SDK packages (`kind: 'sdk'`, whose versions are npm package names, each
// optionally narrowed to a version range as in `@clerk/nextjs@<5`), retires these API methods
// (`kind: 'method'`, whose versions are method names such as `files.upload`), HTTP endpoints
// (`kind: 'endpoint'`, whose versions read `GET /zones/{zone_id}/settings`) or GraphQL fields
// (`kind: 'field'`, whose versions read `Type.field`), or shuts down a product (`kind: 'feature'`,
// whose versions are the source markers that use it, such as an API hostname or an SDK option
// name), with the page it came from and the day a person last checked that page. `derivedDate`
// marks a date the provider never announced as a shutdown, such as one taken from a release date
// or an OpenAPI eol field.
export interface DeadlineEntry {
  id: string;
  provider:
    | 'shopify'
    | 'meta-graph'
    | 'openai'
    | 'anthropic'
    | 'gemini'
    | 'slack'
    | 'cloudflare'
    | 'github'
    | 'auth0'
    | 'clerk'
    | 'firebase'
    | 'supabase'
    | 'nextauth';
  kind: 'api-version' | 'model' | 'sdk' | 'method' | 'endpoint' | 'field' | 'feature';
  versions: string[];
  date: string;
  summary: string;
  replacement: string | null;
  source: string | null;
  checkedAt: string;
  derivedDate?: true;
}

export interface DeadlineRegistry {
  formatVersion: 1;
  deadlines: DeadlineEntry[];
}

// Listed by `refit deadlines`, but never fails --fail-within or opens a --deadline-alerts issue.
export function reportOnly(entry: DeadlineEntry) {
  return entry.derivedDate === true || REPORT_ONLY_KINDS.has(entry.kind);
}

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

// Whole days from today's UTC date to the deadline; negative once the date has passed.
export function daysUntil(date: string, now: Date) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / MILLISECONDS_PER_DAY);
}

// Shape problems make the registry unusable; past-due entries and missing sources are flagged for
// review but still load, since a repository pinning a sunset version is the most urgent exposure.
export function checkDeadlineRegistry(value: unknown, now: Date) {
  const errors: string[] = [];
  const missingSource: string[] = [];
  const pastDue: { id: string; date: string; days: number }[] = [];
  if (!isObject(value) || value.formatVersion !== 1 || !Array.isArray(value.deadlines))
    return {
      errors: ['Registry requires formatVersion: 1 and a deadlines array.'],
      missingSource,
      pastDue,
    };
  const ids = new Set<string>();
  const versions = new Set<string>();
  // Package ranges seen so far, by provider and package, to reject overlaps.
  const packageRanges = new Map<string, { version: string; label: string }[]>();
  for (const [index, entry] of value.deadlines.entries()) {
    const label = isObject(entry) && typeof entry.id === 'string' ? entry.id : `entry ${index}`;
    if (!isObject(entry)) {
      errors.push(`${label}: must be an object.`);
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => !ENTRY_KEYS.includes(key));
    if (unknown.length) errors.push(`${label}: unknown fields ${unknown.join(', ')}.`);
    if (typeof entry.id !== 'string' || !ENTRY_ID.test(entry.id))
      errors.push(`${label}: id must be lowercase letters, digits and hyphens.`);
    else if (ids.has(entry.id)) errors.push(`${label}: duplicate id.`);
    else ids.add(entry.id);
    if (!PROVIDERS.has(String(entry.provider)))
      errors.push(`${label}: provider must be one of ${[...PROVIDERS].join(', ')}.`);
    if (!KINDS.has(String(entry.kind)))
      errors.push(`${label}: kind must be one of ${[...KINDS].join(', ')}.`);
    if (
      !Array.isArray(entry.versions) ||
      !entry.versions.length ||
      entry.versions.some((item) => typeof item !== 'string' || !item.trim())
    )
      errors.push(`${label}: versions must be a non-empty list of strings.`);
    else
      for (const version of entry.versions as string[]) {
        const key = `${String(entry.provider)}:${version}`;
        if (versions.has(key)) errors.push(`${label}: ${version} already has another deadline.`);
        versions.add(key);
        if (entry.kind !== 'sdk') continue;
        const { name, range } = sdkTarget(version);
        if (range !== null && !validRange(range)) {
          errors.push(`${label}: ${version} has a version range Refit cannot read.`);
          continue;
        }
        const seen = packageRanges.get(`${String(entry.provider)}:${name}`) ?? [];
        for (const other of seen)
          if (other.version !== version && rangesOverlap(range, sdkTarget(other.version).range))
            errors.push(
              `${label}: ${version} overlaps ${other.version} in ${other.label}, so a release would have two deadlines.`,
            );
        packageRanges.set(`${String(entry.provider)}:${name}`, [...seen, { version, label }]);
      }
    if (!validDate(entry.date)) errors.push(`${label}: date must be a real YYYY-MM-DD date.`);
    if (!validDate(entry.checkedAt))
      errors.push(`${label}: checkedAt must be a real YYYY-MM-DD date.`);
    if (entry.derivedDate !== undefined && entry.derivedDate !== true)
      errors.push(`${label}: derivedDate must be true or left out.`);
    if (typeof entry.summary !== 'string' || !entry.summary.trim())
      errors.push(`${label}: summary is required.`);
    if (entry.replacement !== null && typeof entry.replacement !== 'string')
      errors.push(`${label}: replacement must be a string or null.`);
    if (entry.source === null || entry.source === undefined || entry.source === '')
      missingSource.push(label);
    else if (typeof entry.source !== 'string' || !/^https:\/\/[^\s]+$/.test(entry.source))
      errors.push(`${label}: source must be an https URL.`);
    if (validDate(entry.date) && daysUntil(entry.date, now) < 0)
      pastDue.push({ id: label, date: entry.date, days: -daysUntil(entry.date, now) });
  }
  return { errors, missingSource, pastDue };
}

// Loads the registry for matching. An entry without a source is never used for alerts: a deadline
// nobody can verify must not open an issue in someone's repository.
export async function loadDeadlineRegistry(
  path: string | URL = DEFAULT_DEADLINE_REGISTRY,
  now = new Date(),
): Promise<DeadlineRegistry> {
  const value = parseObject(await readFile(path, 'utf8'), 'Deadline registry');
  const { errors, missingSource } = checkDeadlineRegistry(value, now);
  if (errors.length)
    throw new PipelineInputError(`Deadline registry is invalid: ${errors.slice(0, 5).join(' ')}`);
  const registry = value as unknown as DeadlineRegistry;
  return {
    formatVersion: 1,
    deadlines: registry.deadlines.filter((entry) => !missingSource.includes(entry.id)),
  };
}
