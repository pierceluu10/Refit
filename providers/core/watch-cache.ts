// One changelog read per provider per UTC day, shared by every repo, every run and every process
// that points at the same cache directory.
//
// Layout, under the cache directory:
//   <day>/<provider>.json   the day's read: its changes, the hints it was led by and what it cost
//   <day>/<provider>.lock   held while one process reads; the others wait, then reuse its read
//   <day>/events.jsonl      every read (cached or not) with its cost, every serve, and the
//                           providers each repo's inventory named, for the cost report
//
// - A read serves every caller whose hints it covers: each package, host and docs URL the caller
//   names. A caller with hints the read lacks gets a new read, led by both hint sets, which then
//   replaces the day's file; so a day settles on one read that covers every caller.
// - Only a finished read is cached. A read that ended early (on its budget, its turns, a model
//   error, cut-off replies) is returned to its caller but never cached, so the next caller reads.
// - Refreshing on purpose: APTITUDE_WATCH_REFRESH=<provider,...|all> re-reads, once, any read made
//   before the process started; `node providers/core/watch-cache-cli.ts refresh <provider|all>`
//   drops the day's file so the next caller reads. `... report` prints the day's cost per repo.
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderChange, ProviderHints } from '../../shared/types.ts';
import { mergeHints } from './folders.ts';
import type { WatchReport } from './types.ts';
import { NO_SUBMISSION } from './watcher.ts';

export const WATCH_REFRESH_ENV = 'APTITUDE_WATCH_REFRESH';
export const WATCH_CACHE_ENV = 'APTITUDE_WATCH_CACHE';

/** The cache folder every process shares unless told otherwise. */
export function defaultWatchDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[WATCH_CACHE_ENV] || join(tmpdir(), 'aptitude-watch');
}
const VERSION = 1;
// How long a lock may sit untouched before another process takes over. A read takes minutes.
const STALE_LOCK_MS = 20 * 60_000;
const POLL_MS = 1_000;
// The prefix runWatchAgent gives the issue for a loop that did not end on its own.
const ENDED_EARLY = /^run ended early\b/;

/** The day's read of one provider, as stored. */
export type CachedRead = {
  version: typeof VERSION;
  provider: string;
  day: string;
  since?: string;
  /** The hints the read was led by, normalised. It serves any caller whose hints these cover. */
  hints: ProviderHints;
  readAt: string;
  costUsd: number;
  model?: string;
  turns?: number;
  changes: ProviderChange[];
};

/** What one read returned, finished or not. A read that throws is reported through `error`. */
export type WatchRead = {
  changes: ProviderChange[];
  /** True only when the agent submitted and its loop ended on its own. */
  finished: boolean;
  /** Why the read is not cached, when it is not. */
  reason?: string;
  costUsd: number;
  model?: string;
  turns?: number;
  error?: unknown;
};

export type ReadThroughOptions = {
  dir: string;
  provider: string;
  hints?: ProviderHints;
  since?: string;
  /** Runs one read, led by these hints. It is called only by the process holding the lock. */
  read: (hints: ProviderHints) => Promise<WatchRead>;
  now?: () => Date;
  /** Re-read a cached read made before this time (see APTITUDE_WATCH_REFRESH). */
  refreshBefore?: Date;
  log?: (line: string) => void;
  /** How often a process waiting on another's read looks again. */
  pollMs?: number;
};

type WatchEvent =
  | {
      type: 'read';
      at: string;
      provider: string;
      since?: string;
      hints: ProviderHints;
      costUsd: number;
      cached: boolean;
      reason?: string;
    }
  | { type: 'serve'; at: string; provider: string; since?: string; readAt: string }
  | { type: 'repo'; at: string; repo: string; providers: string[] };

const KINDS = ['packages', 'hosts', 'docsUrls'] as const;

/** Hints as the cache compares them: trimmed, de-duplicated and sorted; hosts and packages lowercased. */
export function normalizeHints(hints: ProviderHints = {}): ProviderHints {
  const normalized: ProviderHints = {};
  for (const kind of KINDS) {
    const values = (hints[kind] ?? [])
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (kind === 'docsUrls' ? value : value.toLowerCase()));
    if (values.length) normalized[kind] = [...new Set(values)].sort();
  }
  return normalized;
}

/** True when every hint the caller names is one the read was led by. */
export function hintsCover(read: ProviderHints, wanted: ProviderHints): boolean {
  const have = normalizeHints(read);
  const want = normalizeHints(wanted);
  return KINDS.every((kind) => (want[kind] ?? []).every((value) => have[kind]?.includes(value)));
}

/**
 * Whether a watcher's report is a finished read: the agent submitted and the loop ended on its
 * own. A read that ended early on its budget, its turns or a model error is not (F4's onReport
 * note), and neither is one with no report at all, since nothing then says it finished.
 */
export function readOutcome(
  report: WatchReport | undefined,
): Pick<WatchRead, 'finished' | 'reason' | 'model' | 'turns'> {
  if (!report) return { finished: false, reason: 'the watcher gave no report' };
  const early = report.issues.find(
    (issue) => ENDED_EARLY.test(issue.message) || issue.message === NO_SUBMISSION,
  );
  return {
    finished: !early,
    ...(early ? { reason: early.message } : {}),
    model: report.model,
    turns: report.turns,
  };
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

function fileBase(provider: string, since?: string): string {
  const id = provider
    .trim()
    .toLowerCase()
    .replace(/[^\w.-]+/g, '_');
  return since ? `${id}--since-${since.replace(/[^\w.-]+/g, '_')}` : id;
}

export function cacheFile(dir: string, provider: string, day: string, since?: string): string {
  return join(dir, day, `${fileBase(provider, since)}.json`);
}

async function loadRead(file: string): Promise<CachedRead | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const read = JSON.parse(text) as CachedRead;
    return read.version === VERSION && Array.isArray(read.changes) ? read : undefined;
  } catch {
    return undefined; // a torn or foreign file is a miss, and the next read replaces it
  }
}

// Written beside the target and renamed over it, so a reader never sees half a file.
async function saveRead(file: string, read: CachedRead): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeAll(temporary, JSON.stringify(read));
  await rename(temporary, file);
}

async function writeAll(file: string, text: string): Promise<void> {
  const handle = await open(file, 'w');
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
}

async function logEvent(dir: string, day: string, event: WatchEvent): Promise<void> {
  await mkdir(join(dir, day), { recursive: true });
  await appendFile(join(dir, day, 'events.jsonl'), `${JSON.stringify(event)}\n`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A lock is stale when its process is gone (same host) or it has sat untouched too long.
async function staleLock(lock: string): Promise<boolean> {
  const info = await stat(lock).catch(() => undefined);
  if (!info) return false;
  if (Date.now() - info.mtimeMs > STALE_LOCK_MS) return true;
  const owner = await readFile(lock, 'utf8')
    .then((text) => JSON.parse(text) as { pid?: number; host?: string })
    .catch(() => undefined);
  return Boolean(owner?.pid && owner.host === hostname() && !alive(owner.pid));
}

async function tryLock(lock: string): Promise<boolean> {
  try {
    const handle = await open(lock, 'wx');
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }),
      );
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await staleLock(lock)) await rm(lock, { force: true });
    return false;
  }
}

// Reads running in this process, by cache file, with the hints each is led by. A caller whose
// hints one covers shares it, finished or not, as calls that start together always have.
const inflight = new Map<string, { hints: ProviderHints; changes: Promise<ProviderChange[]> }>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The day's read of a provider: from the cache when a read today covers the caller's hints,
 * otherwise read now (under a lock other processes wait on) and cached when it finished.
 */
export async function readThroughCache(options: ReadThroughOptions): Promise<ProviderChange[]> {
  const now = options.now ?? (() => new Date());
  const provider = options.provider.trim().toLowerCase();
  const since = options.since ? { since: options.since } : {};
  const wanted = normalizeHints(options.hints);
  // Not a type guard: a read can exist and still not serve this caller.
  const usable = (read: CachedRead | undefined): boolean =>
    read !== undefined &&
    !(options.refreshBefore && new Date(read.readAt) < options.refreshBefore) &&
    hintsCover(read.hints, wanted);

  for (;;) {
    const day = dayOf(now());
    const file = cacheFile(options.dir, provider, day, options.since);
    const running = inflight.get(file);
    if (running) {
      if (hintsCover(running.hints, wanted)) return running.changes;
      await running.changes.catch(() => {});
      continue;
    }
    const cached = await loadRead(file);
    if (cached && usable(cached)) {
      await logEvent(options.dir, day, {
        type: 'serve',
        at: now().toISOString(),
        provider,
        ...since,
        readAt: cached.readAt,
      }).catch(() => {});
      return cached.changes;
    }
    await mkdir(join(options.dir, day), { recursive: true });
    const lock = file.replace(/\.json$/, '.lock');
    if (!(await tryLock(lock))) {
      // Another process is reading this provider: wait for its read, then look again.
      await sleep(options.pollMs ?? POLL_MS);
      continue;
    }
    // Led by every hint seen today, so the new read also serves whoever the old one served.
    const hints = normalizeHints(mergeHints(cached?.hints ?? {}, wanted));
    const changes = (async () => {
      try {
        // Another process may have cached a covering read between the check and the lock.
        const latest = await loadRead(file);
        if (latest && usable(latest)) return latest.changes;
        const led = normalizeHints(mergeHints(hints, latest?.hints ?? {}));
        const readAt = now().toISOString();
        const result = await options.read(led);
        const keep = result.finished && result.error === undefined;
        const reason = keep ? undefined : (result.reason ?? errorText(result.error));
        await logEvent(options.dir, day, {
          type: 'read',
          at: readAt,
          provider,
          ...since,
          hints: led,
          costUsd: result.costUsd,
          cached: keep,
          ...(reason ? { reason } : {}),
        }).catch(() => {});
        if (result.error !== undefined) throw result.error;
        if (keep) {
          await saveRead(file, {
            version: VERSION,
            provider,
            day,
            ...since,
            hints: led,
            readAt,
            costUsd: result.costUsd,
            ...(result.model ? { model: result.model } : {}),
            ...(result.turns !== undefined ? { turns: result.turns } : {}),
            changes: result.changes,
          });
        } else {
          options.log?.(
            `watch ${provider}: today's read is not cached (${reason}), so the next caller reads again`,
          );
        }
        return result.changes;
      } finally {
        await rm(lock, { force: true });
      }
    })();
    inflight.set(file, { hints, changes });
    try {
      return await changes;
    } finally {
      inflight.delete(file);
    }
  }
}

const errorText = (error: unknown) =>
  error === undefined
    ? 'the read did not finish'
    : error instanceof Error
      ? error.message
      : String(error);

/** Notes the providers a repo's inventory named today, so a read's cost splits over its repos. */
export async function noteRepoProviders(
  dir: string,
  repo: string,
  providers: string[],
  now = new Date(),
): Promise<void> {
  const unique = [...new Set(providers.map((provider) => provider.trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
  await logEvent(dir, dayOf(now), { type: 'repo', at: now.toISOString(), repo, providers: unique });
}

/**
 * The refresh time for a provider from APTITUDE_WATCH_REFRESH ("stripe,openai" or "all"): reads
 * cached before it are read again once. Undefined when the provider is not named.
 */
export function refreshTime(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  startedAt: Date = PROCESS_STARTED,
): Date | undefined {
  const named = (env[WATCH_REFRESH_ENV] ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const id = provider.trim().toLowerCase();
  return named.includes('all') || named.includes(id) ? startedAt : undefined;
}

const PROCESS_STARTED = new Date(Date.now() - process.uptime() * 1000);

/** Drops the day's cached read of a provider (or of all), so the next caller reads again. */
export async function dropCachedReads(
  dir: string,
  provider: string | 'all',
  day = dayOf(new Date()),
): Promise<string[]> {
  const folder = join(dir, day);
  const names = await readdir(folder).catch(() => [] as string[]);
  const base = provider === 'all' ? undefined : fileBase(provider);
  const dropped = names.filter(
    (name) =>
      name.endsWith('.json') &&
      (base === undefined || name === `${base}.json` || name.startsWith(`${base}--since-`)),
  );
  for (const name of dropped) await rm(join(folder, name), { force: true });
  return dropped.map((name) => join(folder, name));
}

export type WatchCostRow = {
  provider: string;
  /** Reads made that day, cached or not, and what they cost together. */
  reads: number;
  cachedReads: number;
  costUsd: number;
  /** Lookups served from the day's cached read. */
  served: number;
  /** Repos whose inventory named the provider that day. */
  repos: string[];
  /** costUsd split over those repos; undefined when no repo named the provider. */
  costPerRepoUsd?: number;
};

/** What each provider's reads cost on a day, and that cost per repo that used them. */
export async function watchCostReport(
  dir: string,
  day = dayOf(new Date()),
): Promise<{ day: string; rows: WatchCostRow[]; totalUsd: number }> {
  const text = await readFile(join(dir, day, 'events.jsonl'), 'utf8').catch(() => '');
  const rows = new Map<string, WatchCostRow>();
  const repos = new Map<string, Set<string>>();
  const row = (provider: string) => {
    let found = rows.get(provider);
    if (!found) {
      found = { provider, reads: 0, cachedReads: 0, costUsd: 0, served: 0, repos: [] };
      rows.set(provider, found);
    }
    return found;
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: WatchEvent;
    try {
      event = JSON.parse(line) as WatchEvent;
    } catch {
      continue;
    }
    if (event.type === 'read') {
      const found = row(event.provider);
      found.reads += 1;
      found.costUsd += event.costUsd;
      if (event.cached) found.cachedReads += 1;
    } else if (event.type === 'serve') {
      row(event.provider).served += 1;
    } else if (event.type === 'repo') {
      for (const provider of event.providers) {
        const set = repos.get(provider) ?? new Set<string>();
        set.add(event.repo);
        repos.set(provider, set);
      }
    }
  }
  const result = [...rows.values()]
    .map((found) => {
      const users = [...(repos.get(found.provider) ?? [])].sort();
      return {
        ...found,
        repos: users,
        ...(users.length ? { costPerRepoUsd: found.costUsd / users.length } : {}),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
  return { day, rows: result, totalUsd: result.reduce((sum, found) => sum + found.costUsd, 0) };
}
