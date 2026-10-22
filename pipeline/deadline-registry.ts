import { readFile } from 'node:fs/promises';
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
  'aws',
  'azure',
]);
const KINDS = new Set(['api-version', 'model', 'sdk']);
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
];
const MILLISECONDS_PER_DAY = 86_400_000;

// One reviewed sunset: the date a provider stops serving these API versions or models, or ends
// support for these SDK packages (`kind: 'sdk'`, whose versions are npm package names), with the
// page it came from and the day a person last checked that page.
export interface DeadlineEntry {
  id: string;
  provider: 'shopify' | 'meta-graph' | 'openai' | 'anthropic' | 'gemini' | 'aws' | 'azure';
  kind: 'api-version' | 'model' | 'sdk';
  versions: string[];
  date: string;
  summary: string;
  replacement: string | null;
  source: string | null;
  checkedAt: string;
}

export interface DeadlineRegistry {
  formatVersion: 1;
  deadlines: DeadlineEntry[];
}

function validDate(value: unknown): value is string {
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
      errors.push(`${label}: kind must be api-version, model or sdk.`);
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
      }
    if (!validDate(entry.date)) errors.push(`${label}: date must be a real YYYY-MM-DD date.`);
    if (!validDate(entry.checkedAt))
      errors.push(`${label}: checkedAt must be a real YYYY-MM-DD date.`);
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
