// Takes the hosted inventory (pipeline/inventory.ts scanInventory) of the first --limit repositories
// of each frozen list, in frozen order, at their recorded commits. Each clone is read, timed and
// deleted; nothing in it is installed or run, and no provider is contacted.
// Usage: node scripts/inventory-sample.mjs --list <frozen.json> [--list …] --limit 10 --root <dir> --output <results.json>
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';
import { shallowCheckout } from './ai-app-helpers.mjs';

// Loaded through tsx, as bin/refit.mjs does: pipeline modules use syntax type stripping rejects.
const load = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig: false });
const { loadDeadlineRegistry } = await load('../pipeline/deadline-registry.ts');
const {
  INVENTORY_LIMITS,
  InventoryStopError,
  inventoryDirectory,
  inventorySummary,
  measureCheckout,
} = await load('../pipeline/inventory.ts');

const { values } = parseArgs({
  options: {
    list: { type: 'string', multiple: true },
    limit: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const limit = Number(values.limit);
if (values.help || !values.list?.length || !values.root || !values.output || !(limit > 0)) {
  console.log(
    'Usage: node scripts/inventory-sample.mjs --list <frozen.json> [--list …] --limit <n> --root <dir> --output <results.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const root = resolve(values.root);
await mkdir(root, { recursive: true });
const now = new Date();
const registry = await loadDeadlineRegistry(undefined, now);
const results = [];
for (const list of values.list) {
  const frozen = JSON.parse(await readFile(list, 'utf8'));
  for (const entry of frozen.repos.slice(0, limit)) {
    const result = { list, repo: entry.repo, commit: entry.commit };
    let directory;
    try {
      const fetched = Date.now();
      directory = await shallowCheckout(root, entry.repo, entry.commit);
      result.fetchMs = Date.now() - fetched;
      const started = Date.now();
      // Counted again inside inventoryDirectory; this copy is only for the report.
      result.checkout = await measureCheckout(directory).catch(() => null);
      const inventory = await inventoryDirectory(
        directory,
        registry,
        now,
        AbortSignal.timeout(INVENTORY_LIMITS.seconds * 1000),
      );
      result.scanMs = Date.now() - started;
      result.status = 'complete';
      result.summary = inventorySummary(inventory);
      result.nonLiveModels = inventory.models.filter((call) => call.test).length;
    } catch (error) {
      if (error instanceof InventoryStopError) {
        result.status = 'stopped';
        result.stop = error.stop;
      } else if (error instanceof Error && error.name === 'TimeoutError') {
        result.status = 'stopped';
        result.stop = 'timeout';
      } else result.status = 'error';
      result.message = error instanceof Error ? error.message.slice(0, 300) : String(error);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    results.push(result);
    console.error(
      `${result.repo}: ${result.status}${result.stop ? ` (${result.stop})` : ''} in ${result.scanMs ?? '-'} ms`,
    );
  }
}
await writeFile(
  values.output,
  `${JSON.stringify({ takenAt: now.toISOString(), limits: INVENTORY_LIMITS, results }, null, 2)}\n`,
);
