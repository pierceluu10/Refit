// The kept list of what's dead. One JSON file per provider in data/, read and checked here.
// A file that fails its checks stops the load: a bad entry must never reach a scan or a fix.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DeadApiEntry, FutureShutdown } from '../shared/types.ts';

export const DATA_DIR = path.join(import.meta.dirname, 'data');

export type ProviderFile = {
  provider: string;
  officialHosts: string[]; // a source must be on one of these
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

const isDate = (value: unknown): value is string =>
  typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));

function sourceProblems(file: ProviderFile, id: string, url: unknown, checkedOn: unknown) {
  const problems: string[] = [];
  if (!isDate(checkedOn)) problems.push(`${id}: source.checkedOn is not a date`);
  try {
    const parsed = new URL(String(url));
    const official = file.officialHosts.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    );
    if (parsed.protocol !== 'https:' || !official) {
      problems.push(`${id}: source ${String(url)} is not on an official host`);
    }
  } catch {
    problems.push(`${id}: source ${String(url)} is not a URL`);
  }
  return problems;
}

const matcherKey = (provider: string, matcher: DeadApiEntry['matchers'][number]) =>
  `${provider}|${matcher.kind}|${matcher.value}`;

/** Every problem in the list at once, so one bad run shows them all. */
export function listProblems(files: ProviderFile[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const deadMatchers = new Map<string, string>();
  const deadIds = new Set<string>();
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
        if (deadIds.has(key)) problems.push(`${entry.id}: replacement ${replacement} is dead`);
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

export function buildList(files: ProviderFile[]): DeadApiList {
  const problems = listProblems(files);
  if (problems.length > 0) throw new DeadApiListError(problems);
  const entries = files.flatMap((file) => file.entries);
  const future = files.flatMap((file) => file.future);
  const version = createHash('sha256')
    .update(JSON.stringify({ entries, future }))
    .digest('hex')
    .slice(0, 16);
  return { entries, future, version };
}

export const loadDeadApis = (dir = DATA_DIR): DeadApiList => buildList(readProviderFiles(dir));

/**
 * The entries in force on a date: the list's dead entries, plus any future shutdown whose date has
 * passed. So a shutdown turns into a break on its day, with nobody editing the list. A date the
 * provider calls the earliest possible waits for a source read to move it to the dead list.
 */
export function entriesInForce(list: DeadApiList, today: string): DeadApiEntry[] {
  const arrived = list.future
    .filter((shutdown) => shutdown.diesOn <= today && !shutdown.earliest)
    .map((shutdown): DeadApiEntry => ({
      id: shutdown.id,
      provider: shutdown.provider,
      what: shutdown.what,
      diedOn: shutdown.diesOn,
      source: shutdown.source,
      lookFor: shutdown.matchers.map((matcher) => matcher.value),
      matchers: shutdown.matchers,
      versions: shutdown.appliesTo?.describe,
      appliesTo: shutdown.appliesTo,
      replacement: shutdown.replacement ?? 'None listed on the provider page when this was added',
      replacementIds: shutdown.replacementIds,
      requires: shutdown.requires ?? [],
      context: shutdown.context,
    }));
  return [...list.entries, ...arrived];
}
