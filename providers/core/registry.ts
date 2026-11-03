// Finds providers by folder and watches them. A folder is a head start for the same discovery
// step every provider gets (any-watcher.ts): its prompt, knowledge, starting pages and hints.

import type { ProviderChange, WatchProvider } from '../../shared/types.ts';
import { anyProviderWatcher, runAnyWatch, type AnyWatchDeps } from './any-watcher.ts';
import { listProviderIds, PROVIDERS_DIR } from './folders.ts';
import { budgetFromEnv } from './model.ts';
import type { WatchReport } from './types.ts';

export {
  folderHints,
  listProviderIds,
  loadProvider,
  mergeHints,
  PROVIDERS_DIR,
} from './folders.ts';

/**
 * A WatchProvider for one provider folder: the discovery watcher, with the
 * folder's prompt, knowledge, starting pages and hints as its head start. This
 * is all a provider's watcher.ts needs, and a folder needs only provider.json
 * (with hints) and prompt.md.
 */
export function folderWatcher(id: string, deps: AnyWatchDeps = {}): WatchProvider {
  // runAnyWatch finds the folder and adds its hints, so the folder's own watcher is the same one.
  return anyProviderWatcher(id, {}, deps);
}

/** Runs every provider folder's watcher in turn, sharing one budget through deps. */
export async function watchAll(since?: string, deps: AnyWatchDeps = {}): Promise<WatchReport[]> {
  const root = deps.root ?? PROVIDERS_DIR;
  // One ledger for the whole run, so the cap is per run rather than per provider.
  const shared: AnyWatchDeps = { ...deps, root, budget: deps.budget ?? budgetFromEnv() };
  const reports: WatchReport[] = [];
  for (const id of listProviderIds(root)) reports.push(await runAnyWatch(id, {}, since, shared));
  return reports;
}

export function allChanges(reports: WatchReport[]): ProviderChange[] {
  return reports.flatMap((report) => report.changes);
}
