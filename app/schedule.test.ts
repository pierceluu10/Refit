import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWeeklyScan } from './schedule.ts';
import type { AppJob } from './types.ts';

const WEEK = 1000;
const START = Date.UTC(2026, 10, 6);

let dir: string;
let stateFile: string;
let time: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'refit-schedule-'));
  stateFile = join(dir, 'nested', 'schedule.json');
  time = START;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function setup(overrides: Partial<Parameters<typeof createWeeklyScan>[0]> = {}) {
  const jobs: AppJob[] = [];
  const scan = createWeeklyScan({
    stateFile,
    now: () => time,
    weekMs: WEEK,
    listInstallations: async () => [{ id: 1, suspended: false }],
    listRepos: async (id) => [`org${id}/a`, `org${id}/b`],
    enqueue: async (job) => void jobs.push(job),
    ...overrides,
  });
  return { scan, jobs };
}

const lastSweep = async () =>
  Date.parse(
    (JSON.parse(await readFile(stateFile, 'utf8')) as { lastSweepAt: string }).lastSweepAt,
  );

describe('createWeeklyScan', () => {
  it('first start only starts the clock: no sweep, no spend', async () => {
    const { scan, jobs } = setup();
    await scan.start();
    scan.stop();
    expect(jobs).toEqual([]);
    expect(await lastSweep()).toBe(START);
  });

  it('a restart in the middle of the week does not sweep', async () => {
    await setup().scan.start();
    time = START + WEEK - 1;
    const { scan, jobs } = setup();
    await scan.start();
    scan.stop();
    expect(jobs).toEqual([]);
    expect(await lastSweep()).toBe(START);
  });

  it('a week later it queues a scan per repo and starts the next week', async () => {
    await setup().scan.start();
    time = START + WEEK;
    const { scan, jobs } = setup();
    await scan.start();
    scan.stop();
    expect(jobs).toEqual(
      ['org1/a', 'org1/b'].map((repo) => ({
        kind: 'scan',
        installationId: 1,
        repo,
        reason: 'schedule',
      })),
    );
    expect(await lastSweep()).toBe(START + WEEK);
  });

  it('the interval finds the week going by, and stop clears it', async () => {
    const { scan, jobs } = setup({ intervalMs: 5 });
    await scan.start();
    time = START + WEEK;
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    await scan.stop();
    const after = jobs.length;
    time = START + 10 * WEEK;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(jobs).toHaveLength(after);
  });

  it('runs afterSweep once the state is written, and a failure there loses nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await setup().scan.start();
    time = START + WEEK;
    let stateAtDigest = 0;
    const { scan, jobs } = setup({
      afterSweep: async () => {
        stateAtDigest = await lastSweep();
        throw new Error('slack is down');
      },
    });
    await scan.start();
    scan.stop();
    expect(stateAtDigest).toBe(START + WEEK);
    expect(jobs).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('slack is down'));
  });

  it('does not run afterSweep when the week has not passed', async () => {
    const afterSweep = vi.fn(async () => {});
    await setup({ afterSweep }).scan.start();
    expect(afterSweep).not.toHaveBeenCalled();
  });

  it('skips suspended installations', async () => {
    const { scan, jobs } = setup({
      listInstallations: async () => [
        { id: 1, suspended: true },
        { id: 2, suspended: false },
      ],
    });
    await scan.sweep();
    expect(jobs.map((job) => job.repo)).toEqual(['org2/a', 'org2/b']);
  });

  it('one failing installation is logged and does not stop the others', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { scan, jobs } = setup({
      listInstallations: async () => [
        { id: 1, suspended: false },
        { id: 2, suspended: false },
      ],
      listRepos: async (id) => {
        if (id === 1) throw new Error('GitHub said 500');
        return ['org2/a'];
      },
    });
    await scan.sweep();
    expect(jobs.map((job) => job.repo)).toEqual(['org2/a']);
    expect(errors).toHaveBeenCalledWith('weekly scan: installation 1 failed: GitHub said 500');
    expect(await lastSweep()).toBe(START);
    errors.mockRestore();
  });

  it('when every installation fails the state stays, so the next check tries again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { scan } = setup({
      listRepos: async () => {
        throw new Error('outage');
      },
    });
    await scan.sweep();
    expect(existsSync(stateFile)).toBe(false);
    errors.mockRestore();
  });

  it('a failure to list installations is logged, not thrown, by the timer path', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await setup().scan.start();
    time = START + WEEK;
    const { scan } = setup({
      listInstallations: async () => {
        throw new Error('bad jwt');
      },
    });
    await scan.start();
    scan.stop();
    expect(errors).toHaveBeenCalledWith('weekly scan failed: bad jwt');
    expect(await lastSweep()).toBe(START);
    errors.mockRestore();
  });

  it('sweeps never overlap', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let listings = 0;
    const { scan } = setup({
      listInstallations: async () => {
        listings++;
        await gate;
        return [];
      },
    });
    const first = scan.sweep();
    const second = scan.sweep();
    release();
    await Promise.all([first, second]);
    expect(listings).toBe(1);
    await scan.sweep();
    expect(listings).toBe(2);
  });

  it('a corrupt state file restarts the week instead of sweeping or dying', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await setup().scan.start();
    await writeFile(stateFile, '{"lastSweepAt":');
    time = START + 5 * WEEK;
    const { scan, jobs } = setup();
    await scan.start();
    scan.stop();
    expect(jobs).toEqual([]);
    expect(await lastSweep()).toBe(START + 5 * WEEK);
    errors.mockRestore();
  });
});
