import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from './github.ts';
import {
  createTick,
  createTriggerStore,
  startClock,
  STALE_AFTER_HOURS,
  summarizeTriggers,
  type TriggerRecord,
} from './triggers.ts';
import type { AppJob } from './types.ts';

const NOW = new Date('2026-11-20T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const record = (hours: number, overrides: Partial<TriggerRecord> = {}): TriggerRecord => ({
  at: hoursAgo(hours),
  repo: 'org/quiet',
  installationId: 1,
  trigger: 'clock',
  decision: 'skipped',
  why: 'unchanged-clean',
  clean: true,
  findings: 0,
  unlistedProviders: [],
  seconds: 0.2,
  costUsd: 0,
  ...overrides,
});

describe('summarizeTriggers', () => {
  it('counts what ran and adds up cost, with the time since the last check', () => {
    const [row] = summarizeTriggers(
      [
        record(50, { decision: 'scanned', why: 'first-scan', trigger: 'install', costUsd: 0.25 }),
        record(26),
        record(2),
      ],
      NOW,
    );
    expect(row).toMatchObject({ status: 'clean', scans: 1, skips: 2, failures: 0, stale: false });
    expect(row.costUsd).toBe(0.25);
    expect(row.hoursSinceCheck).toBeCloseTo(2);
    expect(row.lastScanAt).toBe(hoursAgo(50));
    expect(row.last).toMatchObject({ trigger: 'clock', decision: 'skipped' });
  });

  it('marks a repo stale once it goes unchecked too long, and puts it first', () => {
    const rows = summarizeTriggers(
      [
        record(1, { repo: 'org/a-fine' }),
        record(STALE_AFTER_HOURS + 1, { repo: 'org/z-forgotten' }),
      ],
      NOW,
    );
    expect(rows.map((row) => [row.repo, row.stale])).toEqual([
      ['org/z-forgotten', true],
      ['org/a-fine', false],
    ]);
  });

  it('never lets failures count as checks', () => {
    const failed = (hours: number) =>
      record(hours, {
        decision: 'failed',
        why: 'error',
        error: 'GitHub said no',
        clean: undefined,
      });
    const [row] = summarizeTriggers([record(100), failed(24), failed(1)], NOW);
    expect(row).toMatchObject({ stale: true, failures: 2, status: 'clean' });
    expect(row.hoursSinceCheck).toBeCloseTo(100);
    expect(row.last.error).toBe('GitHub said no');
  });

  it('shows a repo that has only ever failed as stale and not scanned, not clean', () => {
    const [row] = summarizeTriggers(
      [record(1, { decision: 'failed', why: 'error', clean: undefined, findings: undefined })],
      NOW,
    );
    expect(row).toMatchObject({ status: 'not-scanned', stale: true });
    expect(row.hoursSinceCheck).toBeUndefined();
  });

  it("doesn't let a merged trigger pass as a check", () => {
    const [row] = summarizeTriggers(
      [
        record(100),
        record(1, { decision: 'merged', why: 'job-already-waiting', clean: undefined }),
      ],
      NOW,
    );
    expect(row.stale).toBe(true);
  });

  it('keeps a dirty repo dirty through its skips, and ranks it ahead of clean ones', () => {
    const rows = summarizeTriggers(
      [
        record(1, { repo: 'org/a-clean' }),
        record(30, {
          repo: 'org/b-dirty',
          decision: 'scanned',
          why: 'first-scan',
          clean: false,
          findings: 3,
          fix: 'ran',
        }),
        record(1, { repo: 'org/b-dirty', why: 'unchanged-dirty', clean: false, findings: 3 }),
      ],
      NOW,
    );
    expect(rows[0]).toMatchObject({
      repo: 'org/b-dirty',
      status: 'not-clean',
      findings: 3,
      fix: 'ran',
    });
  });

  it('clears an old fix once the repo scans clean', () => {
    const [row] = summarizeTriggers(
      [
        record(9, {
          decision: 'scanned',
          why: 'first-scan',
          clean: false,
          findings: 1,
          fix: 'ran',
        }),
        record(1, { decision: 'scanned', why: 'tree-changed' }),
      ],
      NOW,
    );
    expect(row).toMatchObject({ status: 'clean', findings: 0 });
    expect(row.fix).toBeUndefined();
  });

  it("doesn't call a repo waiting on an unlisted provider plain clean", () => {
    const [row] = summarizeTriggers([record(1, { unlistedProviders: ['resend'] })], NOW);
    expect(row.status).toBe('clean-unlisted-waiting');
    expect(row.unlistedProviders).toEqual(['resend']);
  });
});

describe('createTriggerStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aptitude-trigger-store-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('appends, and reads back what it wrote in order', async () => {
    const store = createTriggerStore(join(dir, 'nested'));
    expect(await store.records()).toEqual([]);
    await store.append(record(2));
    await store.append(record(1));
    expect((await store.records()).map((one) => one.at)).toEqual([hoursAgo(2), hoursAgo(1)]);
  });

  it('survives a line torn by a crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createTriggerStore(dir);
    await store.append(record(2));
    await appendFile(join(dir, 'log.jsonl'), '{"at":"2026-11\n');
    await store.append(record(1));
    expect(await store.records()).toHaveLength(2);
  });

  it('refuses a repo name that would leave its folder', async () => {
    const store = createTriggerStore(dir);
    expect(() => store.state('../../etc')).toThrow('Not a GitHub owner/name');
    await mkdir(join(dir, 'repos'), { recursive: true });
    expect(await store.state('org/never-seen')).toBeUndefined();
  });
});

describe('createTick', () => {
  beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  const queueRecorder = () => {
    const jobs: AppJob[] = [];
    return { jobs, queue: { enqueue: async (job: AppJob) => void jobs.push(job) } };
  };

  it('queues every repo of every installation, with its own installation', async () => {
    const { jobs, queue } = queueRecorder();
    const tick = createTick({
      listInstallations: async () => [1, 2],
      tokens: { token: async (id) => `token-${id}` },
      listRepos: async (token) => (token === 'token-1' ? ['org/a', 'org/b'] : ['other/c']),
      queue,
    });
    await tick();
    expect(jobs).toEqual([
      { kind: 'understand', installationId: 1, repo: 'org/a', reason: 'clock' },
      { kind: 'understand', installationId: 1, repo: 'org/b', reason: 'clock' },
      { kind: 'understand', installationId: 2, repo: 'other/c', reason: 'clock' },
    ]);
  });

  it('goes on past an installation GitHub refuses', async () => {
    const { jobs, queue } = queueRecorder();
    const tick = createTick({
      listInstallations: async () => [1, 2],
      tokens: {
        token: async (id) => {
          if (id === 1) throw new GitHubApiError('POST', '/app/installations/1', 403);
          return 'token';
        },
      },
      listRepos: async () => ['other/c'],
      queue,
    });
    await tick();
    expect(jobs.map((job) => job.repo)).toEqual(['other/c']);
  });

  it("doesn't hide a bug as an installation problem", async () => {
    const { queue } = queueRecorder();
    const tick = createTick({
      listInstallations: async () => [1],
      tokens: { token: async () => 'token' },
      listRepos: async () => {
        throw new TypeError('a bug');
      },
      queue,
    });
    await expect(tick()).rejects.toThrow('a bug');
  });
});

describe('startClock', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ticks at once and on every interval, keeps going after a failed tick, and stops', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tick = vi.fn(async () => {});
    tick.mockRejectedValueOnce(new Error('GitHub is down'));
    const stop = startClock(tick, 1000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith('clock tick failed: GitHub is down');
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
