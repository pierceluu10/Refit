// The kept list of what's dead. One JSON file per provider in data/, read and checked here.
// A file that fails its checks stops the load: a bad entry must never reach a scan or a fix.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DeadApiEntry, DeadApiMatcher, FutureShutdown } from '../shared/types.ts';
import { tokenMatches, urlMatches } from './match.ts';

export const DATA_DIR = path.join(import.meta.dirname, 'data');
export const NO_REPLACEMENT = 'None listed on the provider page when this was added';

export type ProviderFile = {
  provider: string;
  officialHosts: string[]; // a source must be on one of these; a path narrows a shared host
  entries: DeadApiEntry[];
  future: FutureShutdown[];
};

export type DeadApiList = {
  entries: DeadApiEntry[];
  future: FutureShutdown[];
  version: string; // changes when any entry changes, so a rescan can be triggered by it
};

export class DeadApiListError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The dead-API list has ${problems.length} problem(s):\n${problems.join('\n')}`);
    this.name = 'DeadApiListError';
    this.problems = problems;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_ID = /^[A-Z]{2}-\d+(\.[\w.*-]+)?$/;

// The round trip refuses a day past the month's end, which Date.parse rolls over.
const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().startsWith(value);

// A path in an official host ("github.com/twilio") trusts only that part of a shared host.
function onOfficialHost(official: string, url: URL) {
  const [host, ...path] = official.split('/');
  const within = url.hostname === host || url.hostname.endsWith(`.${host}`);
  return within && (path.length === 0 || url.pathname.startsWith(`/${path.join('/')}/`));
}

function sourceProblems(file: ProviderFile, id: string, url: unknown, checkedOn: unknown) {
  const problems: string[] = [];
  if (!isDate(checkedOn)) problems.push(`${id}: source.checkedOn is not a date`);
  try {
    const parsed = new URL(String(url));
    const official = file.officialHosts.some((one) => onOfficialHost(one, parsed));
    if (parsed.protocol !== 'https:' || !official) {
      problems.push(`${id}: source ${String(url)} is not on an official host`);
    }
  } catch {
    problems.push(`${id}: source ${String(url)} is not a URL`);
  }
  return problems;
}

// A field is its owner's: current_period_start on subscription isn't the one on quote_line.
export const matcherKey = (provider: string, matcher: DeadApiMatcher) =>
  `${provider}|${matcher.kind}|${matcher.value}|${matcher.kind === 'field' ? [...(matcher.on ?? [])].sort().join() : ''}`;

const isWildcard = (matcher: DeadApiMatcher): boolean =>
  (matcher.kind === 'string' || matcher.kind === 'url') && matcher.value.includes('*');

const wildcardCovers = (matcher: DeadApiMatcher, name: string): boolean =>
  (matcher.kind === 'string' && tokenMatches(matcher, name)) ||
  (matcher.kind === 'url' && urlMatches(matcher, name));

/** Every problem in the list at once, so one bad run shows them all. */
export function listProblems(files: ProviderFile[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const deadMatchers = new Map<string, string>();
  const deadIds = new Set<string>();
  const deadWildcards = new Map<string, DeadApiMatcher[]>();
  const futureIds = new Map<string, string>();

  const addId = (id: string) => {
    if (!ENTRY_ID.test(id)) problems.push(`${id}: id doesn't match ${ENTRY_ID}`);
    if (ids.has(id)) problems.push(`${id}: duplicate id`);
    ids.add(id);
  };

  for (const file of files) {
    for (const entry of file.entries) {
      addId(entry.id);
      if (entry.provider !== file.provider) problems.push(`${entry.id}: wrong provider`);
      problems.push(...sourceProblems(file, entry.id, entry.source?.url, entry.source?.checkedOn));
      if (!entry.what?.trim()) problems.push(`${entry.id}: says nothing about what died`);
      if (!entry.replacement?.trim()) problems.push(`${entry.id}: no replacement`);
      if (!Array.isArray(entry.requires)) problems.push(`${entry.id}: requires is not a list`);
      if (!entry.lookFor?.length) problems.push(`${entry.id}: lookFor is empty`);
      if (!entry.matchers?.length) problems.push(`${entry.id}: has no matchers`);
      if (!isDate(entry.diedOn)) {
        problems.push(`${entry.id}: diedOn is not a date`);
      } else if (isDate(entry.source?.checkedOn) && entry.diedOn > entry.source.checkedOn) {
        problems.push(`${entry.id}: died ${entry.diedOn}, after it was checked: move it to future`);
      }
      for (const matcher of entry.matchers ?? []) {
        const key = matcherKey(file.provider, matcher);
        const other = deadMatchers.get(key);
        if (other) problems.push(`${entry.id}: repeats ${matcher.value} from ${other}`);
        deadMatchers.set(key, entry.id);
        if (matcher.kind === 'string' || matcher.kind === 'url') {
          deadIds.add(`${file.provider}|${matcher.value}`);
        }
        if (isWildcard(matcher)) {
          deadWildcards.set(file.provider, [...(deadWildcards.get(file.provider) ?? []), matcher]);
        }
      }
    }
    for (const shutdown of file.future) {
      addId(shutdown.id);
      if (shutdown.provider !== file.provider) problems.push(`${shutdown.id}: wrong provider`);
      problems.push(
        ...sourceProblems(file, shutdown.id, shutdown.source?.url, shutdown.source?.checkedOn),
      );
      if (!shutdown.matchers?.length) problems.push(`${shutdown.id}: has no matchers`);
      if (!isDate(shutdown.diesOn)) {
        problems.push(`${shutdown.id}: diesOn is not a date`);
      } else if (
        isDate(shutdown.source?.checkedOn) &&
        shutdown.diesOn <= shutdown.source.checkedOn
      ) {
        problems.push(`${shutdown.id}: died ${shutdown.diesOn}, before it was checked: it's dead`);
      }
      for (const matcher of shutdown.matchers ?? []) {
        const key = matcherKey(file.provider, matcher);
        const other = deadMatchers.get(key);
        if (other) problems.push(`${shutdown.id}: ${matcher.value} is also dead under ${other}`);
        if (matcher.kind === 'string' || matcher.kind === 'url') {
          futureIds.set(`${file.provider}|${matcher.value}`, shutdown.id);
        }
      }
    }
  }

  // A chain of replacements has to end on what's live, and nothing moves onto something dying.
  for (const file of files) {
    for (const entry of file.entries) {
      for (const replacement of entry.replacementIds ?? []) {
        const key = `${file.provider}|${replacement}`;
        const dead =
          deadIds.has(key) ||
          deadWildcards.get(file.provider)?.some((one) => wildcardCovers(one, replacement));
        if (dead) problems.push(`${entry.id}: replacement ${replacement} is dead`);
        const dying = futureIds.get(key);
        if (dying) problems.push(`${entry.id}: replacement ${replacement} is dying (${dying})`);
      }
    }
  }
  return problems;
}

export function readProviderFiles(dir = DATA_DIR): ProviderFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as ProviderFile);
}

const hashOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export function buildList(files: ProviderFile[]): DeadApiList {
  const problems = listProblems(files);
  if (problems.length > 0) throw new DeadApiListError(problems);
  const entries = files.flatMap((file) => file.entries);
  const future = files.flatMap((file) => file.future);
  return { entries, future, version: hashOf({ entries, future }) };
}

export const loadDeadApis = (dir = DATA_DIR): DeadApiList => buildList(readProviderFiles(dir));

const arrivedBy = (list: DeadApiList, today: string) =>
  list.future.filter((shutdown) => shutdown.diesOn <= today && !shutdown.earliest);

/**
 * The entries in force on a date: the list's dead entries, plus any future shutdown whose date has
 * passed. So a shutdown turns into a break on its day, with nobody editing the list. A date the
 * provider calls the earliest possible waits for a source read to move it to the dead list.
 */
export function entriesInForce(list: DeadApiList, today: string): DeadApiEntry[] {
  const arrived = arrivedBy(list, today).map((shutdown): DeadApiEntry => ({
    id: shutdown.id,
    provider: shutdown.provider,
    what: shutdown.what,
    diedOn: shutdown.diesOn,
    source: shutdown.source,
    lookFor: shutdown.matchers.map((matcher) => matcher.value),
    matchers: shutdown.matchers,
    versions: shutdown.appliesTo?.describe,
    appliesTo: shutdown.appliesTo,
    replacement: shutdown.replacement ?? NO_REPLACEMENT,
    replacementIds: shutdown.replacementIds,
    requires: shutdown.requires ?? [],
    context: shutdown.context,
  }));
  return [...list.entries, ...arrived];
}

/**
 * What a scan on this date looks for, as a hash, so a repo can tell whether its last scan still holds.
 * It moves when the list gains an entry or a shutdown's date arrives. A shutdown still in the future or
 * a re-checked source date leaves it alone, since neither changes what a scan finds.
 */
export const inForceVersion = (list: DeadApiList, today: string): string =>
  hashOf(entriesInForce(list, today).map(({ source: _source, ...entry }) => entry));

/** The shutdowns that came into force after one day, up to and including another. */
export const shutdownsArrived = (list: DeadApiList, after: string, today: string) =>
  arrivedBy(list, today).filter((shutdown) => shutdown.diesOn > after);
