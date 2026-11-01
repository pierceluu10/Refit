// Finds providers by folder. Any folder under providers/ with a provider.json
// and a prompt.md is a provider; no code changes are needed to add one.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderChange, WatchProvider } from '../../shared/types.ts';
import { budgetFromEnv } from './model.ts';
import { createWatcher, runWatch, type WatchDeps } from './watcher.ts';
import type { LoadedProvider, ProviderKnowledge, ProviderSpec, WatchReport } from './types.ts';

export const PROVIDERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const ID = /^[a-z0-9][a-z0-9-]*$/;

export function listProviderIds(root = PROVIDERS_DIR): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID.test(entry.name))
    .filter((entry) => existsSync(join(root, entry.name, 'provider.json')))
    .map((entry) => entry.name)
    .sort();
}

export function loadProvider(id: string, root = PROVIDERS_DIR): LoadedProvider {
  if (!ID.test(id)) throw new Error(`bad provider id: ${id}`);
  const dir = join(root, id);
  const spec = JSON.parse(readFileSync(join(dir, 'provider.json'), 'utf8')) as ProviderSpec;
  if (spec.id !== id)
    throw new Error(`${id}/provider.json has id "${spec.id}"; it must match the folder`);
  const promptPath = join(dir, 'prompt.md');
  const knowledgePath = join(dir, 'knowledge.json');
  return {
    ...spec,
    dir,
    prompt: existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '',
    knowledge: existsSync(knowledgePath)
      ? (JSON.parse(readFileSync(knowledgePath, 'utf8')) as ProviderKnowledge)
      : undefined,
  };
}

/** A WatchProvider for one provider folder. This is all a provider's watcher.ts needs. */
export function folderWatcher(
  id: string,
  deps: WatchDeps & { onReport?: (report: WatchReport) => void } = {},
): WatchProvider {
  return createWatcher(() => loadProvider(id), deps);
}

/** Runs every provider's watcher in turn, sharing one budget through deps. */
export async function watchAll(since?: string, deps: WatchDeps = {}): Promise<WatchReport[]> {
  // One ledger for the whole run, so the cap is per run rather than per provider.
  const shared: WatchDeps = { ...deps, budget: deps.budget ?? budgetFromEnv() };
  const reports: WatchReport[] = [];
  for (const id of listProviderIds()) reports.push(await runWatch(loadProvider(id), since, shared));
  return reports;
}

export function allChanges(reports: WatchReport[]): ProviderChange[] {
  return reports.flatMap((report) => report.changes);
}
