import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './queue.ts';
import type { JobQueue } from './types.ts';

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

export type WeeklyScanDeps = {
  stateFile: string;
  now?: () => number;
  listInstallations: () => Promise<{ id: number; suspended: boolean }[]>;
  listRepos: (installationId: number) => Promise<string[]>;
  enqueue: JobQueue['enqueue'];
  intervalMs?: number;
  weekMs?: number;
  // The sweep only queues scans, so this sees the reports from before them.
  afterSweep?: () => Promise<void>;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readLastSweep(file: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const last = Date.parse((JSON.parse(raw) as { lastSweepAt: string }).lastSweepAt);
    return Number.isNaN(last) ? undefined : last;
  } catch {
    console.error(`weekly scan: ${file} is corrupt, so the week starts again`);
    return undefined;
  }
}

// Re-scans every installed repo once a week, through the queue. The last sweep's time lives in a
// file, so a restart neither re-scans (and spends) nor loses the week.
export function createWeeklyScan({
  stateFile,
  now = Date.now,
  listInstallations,
  listRepos,
  enqueue,
  intervalMs = HOUR_MS,
  weekMs = WEEK_MS,
  afterSweep,
}: WeeklyScanDeps) {
  let timer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> | undefined;
  let checking: Promise<void> | undefined;

  const writeState = () =>
    writeJsonAtomic(stateFile, { lastSweepAt: new Date(now()).toISOString() });

  async function runSweep() {
    const installations = (await listInstallations()).filter((item) => !item.suspended);
    let failed = 0;
    for (const { id } of installations) {
      try {
        for (const repo of await listRepos(id)) {
          await enqueue({ kind: 'scan', installationId: id, repo, reason: 'schedule' });
        }
      } catch (error) {
        failed++;
        console.error(`weekly scan: installation ${id} failed: ${messageOf(error)}`);
      }
    }
    // Nothing got queued, likely a GitHub outage: leave the state so the next hourly check tries again.
    if (installations.length > 0 && failed === installations.length) return;
    await writeState();
    try {
      await afterSweep?.();
    } catch (error) {
      console.error(`weekly scan: the step after the sweep failed: ${messageOf(error)}`);
    }
  }

  const sweep = () => (sweeping ??= runSweep().finally(() => (sweeping = undefined)));

  async function check() {
    const last = await readLastSweep(stateFile);
    if (last === undefined) return writeState();
    if (now() - last >= weekMs) await sweep();
  }

  // One check at a time: a check that read the state before a sweep wrote it would sweep again.
  const tick = () =>
    (checking ??= check()
      .catch((error: unknown) => {
        console.error(`weekly scan failed: ${messageOf(error)}`);
      })
      .finally(() => (checking = undefined)));

  return {
    sweep,
    start: () => {
      timer ??= setInterval(tick, intervalMs);
      timer.unref();
      return tick(); // a sweep that fell due while the app was down runs now
    },
    stop: () => {
      clearInterval(timer);
      timer = undefined;
      return checking; // a check already under way finishes
    },
  };
}
