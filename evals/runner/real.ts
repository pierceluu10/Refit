// Wires the runner to the real Aptitude modules. They land on other branches tonight, so this
// loads them by path at run time and refuses to start (before any spend) if one is missing.
import { createReviewer } from '../reviewer/reviewer.ts';
import { unwiredModelClient } from '../reviewer/model.ts';
import type { InventoryRepo, ProviderChange, RunTask, WatchProvider } from '../../shared/types.ts';
import { gitCheckout } from './checkout.ts';
import type { MatchChanges, PipelineFactory } from './types.ts';

/**
 * Where each entry point is expected once the owning branch merges. Update these in the morning
 * if a module exports under another name.
 */
export const REAL_MODULES = {
  inventory: { path: '../../inventory/index.ts', export: 'inventoryRepo' },
  match: { path: '../../orchestrator/match.ts', export: 'matchChanges' },
  runTask: { path: '../../harness/index.ts', export: 'runTask' },
  watch: { path: '../../providers/index.ts', export: 'watchProvider' },
} as const;

async function loadExport<T>(spec: { path: string; export: string }): Promise<T | undefined> {
  try {
    const url = new URL(spec.path, import.meta.url).href;
    const module = (await import(url)) as Record<string, unknown>;
    const value = module[spec.export];
    return typeof value === 'function' ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadRealPipeline(budgetUsd: number): Promise<PipelineFactory> {
  const inventory = await loadExport<InventoryRepo>(REAL_MODULES.inventory);
  const match = await loadExport<MatchChanges>(REAL_MODULES.match);
  const runTask = await loadExport<RunTask>(REAL_MODULES.runTask);
  const watchProvider = await loadExport<(provider: string) => WatchProvider>(REAL_MODULES.watch);
  const missing = Object.entries({ inventory, match, runTask, watchProvider })
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (!inventory || !match || !runTask || !watchProvider || missing.length > 0) {
    throw new Error(
      `real modules not available yet: ${missing.join(', ')}. Merge the owning branches first; for a $0 check run "npm run smoke -w evals".`,
    );
  }
  // The harness enforces its own hard cap; give it this run's cap so both limits agree.
  process.env.APTITUDE_AI_BUDGET_USD = String(budgetUsd);
  const checkout = gitCheckout();
  const review = createReviewer(unwiredModelClient);
  const changesByProvider = new Map<string, Promise<ProviderChange[]>>();
  return ({ provider }) => ({
    checkout,
    inventory,
    watch: () => {
      // One watcher read per provider per run, so every repo is matched against the same changes.
      let changes = changesByProvider.get(provider);
      if (!changes) {
        changes = watchProvider(provider)();
        changesByProvider.set(provider, changes);
      }
      return changes;
    },
    match,
    runTask,
    review,
  });
}
