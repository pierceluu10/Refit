// Entry points that land on other branches tonight (MVP-PLAN.md section 6). Each is loaded from its
// owner's module when that module exports it, and falls back to a local stand-in until then, so the
// orchestrator codes against the contract and picks up the real part at integration without edits.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  InventoryDependencies,
  InventorySurfaces,
  RunExternalTask,
  WatchDependency,
  WatchPlatforms,
} from '../shared/types.ts';

// A missing file means the owner's branch has not merged yet, so the stand-in is used. A file that
// exists but fails to load is a real bug and is thrown, never hidden behind a stand-in.
export async function loadModule(path: string): Promise<Record<string, unknown> | undefined> {
  const url = new URL(path, import.meta.url);
  if (!existsSync(fileURLToPath(url))) return undefined;
  return (await import(/* @vite-ignore */ url.href)) as Record<string, unknown>;
}

// One exported function from a module that may not exist yet.
export async function loadOptional<T>(path: string, name: string): Promise<T | undefined> {
  const mod = await loadModule(path);
  let value: unknown;
  try {
    value = mod?.[name];
  } catch {
    // A test's module mock throws on exports it does not define.
    return undefined;
  }
  return typeof value === 'function' ? (value as T) : undefined;
}

export type Upstream = {
  inventoryDependencies?: InventoryDependencies; // P2
  inventorySurfaces?: InventorySurfaces; // P5
  watchDependency?: WatchDependency; // F1
  watchPlatforms?: WatchPlatforms; // F3
  runExternalTask?: RunExternalTask; // O2
};

let loaded: Promise<Upstream> | undefined;

// Loaded once per process.
export function loadUpstream(): Promise<Upstream> {
  loaded ??= (async () => ({
    inventoryDependencies: await loadOptional<InventoryDependencies>(
      '../inventory/index.ts',
      'inventoryDependencies',
    ),
    inventorySurfaces: await loadOptional<InventorySurfaces>(
      '../inventory/surfaces/index.ts',
      'inventorySurfaces',
    ),
    watchDependency: await loadOptional<WatchDependency>(
      '../providers/index.ts',
      'watchDependency',
    ),
    watchPlatforms: await loadOptional<WatchPlatforms>(
      '../providers/platforms/index.ts',
      'watchPlatforms',
    ),
    runExternalTask: await loadOptional<RunExternalTask>('../harness/index.ts', 'runExternalTask'),
  }))();
  return loaded;
}
