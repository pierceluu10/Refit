import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { OpenPullRequest, RunRecord } from '../shared/types.ts';
import { createJobRunner } from './jobs.ts';
import type { UnderstandJob } from './types.ts';

const JOB: UnderstandJob = {
  kind: 'understand',
  installationId: 70000001,
  repo: 'aptitude-example-org/billing-api',
  reason: 'push',
};
const RECORD: RunRecord = {
  taskId: 'illustrative-task',
  outcome: 'verified',
  diff: '',
  checks: [],
  costUsd: 0,
  transcriptPath: '',
};

function fakes(
  runRepoJob: () => Promise<RunRecord[]>,
  rescan: (at: string) => Promise<void> = async () => {},
) {
  const calls: string[] = [];
  const opener: OpenPullRequest = async () => 'https://github.com/example/pull/1';
  let checkoutDir = '';
  const run = createJobRunner({
    tokens: { token: async (id) => `token-${id}` },
    checkout: async (token, repo, dir) => {
      checkoutDir = dir;
      calls.push(`checkout ${token} ${repo}`);
    },
    rescan: async (job, dir, at) => {
      calls.push(`rescan ${job.repo} ${dir === checkoutDir} ${existsSync(dir)}`);
      await rescan(at);
    },
    openPullRequestFor: (id) => {
      calls.push(`opener ${id}`);
      return opener;
    },
    runRepoJob: async (input) => {
      calls.push(
        `run ${input.repo} ${input.dir === checkoutDir} ${input.openPullRequest === opener}`,
      );
      expect(existsSync(input.dir)).toBe(true);
      return runRepoJob();
    },
  });
  return { run, calls, dir: () => checkoutDir };
}

describe('createJobRunner', () => {
  it("checks out with the installation's token, runs the loop on that checkout, then deletes it", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { run, calls, dir } = fakes(async () => [RECORD]);
    await run(JOB);
    expect(calls).toEqual([
      'checkout token-70000001 aptitude-example-org/billing-api',
      'rescan aptitude-example-org/billing-api true true',
      'opener 70000001',
      'run aptitude-example-org/billing-api true true',
    ]);
    expect(existsSync(dir())).toBe(false);
  });

  it('a failed rescan never stops the fix', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run, calls } = fakes(
      async () => [RECORD],
      async () => {
        throw new Error('scan broke');
      },
    );
    await run(JOB);
    expect(calls.at(-1)).toBe('run aptitude-example-org/billing-api true true');
    expect(logged.mock.calls.flat().join(' ')).toContain('scan broke');
  });

  it('dates the rescan before the clone, so a merge during the clone never counts against itself', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let scannedAt = '';
    const before = new Date().toISOString();
    const { run } = fakes(
      async () => [RECORD],
      async (at) => {
        scannedAt = at;
      },
    );
    await run(JOB);
    expect(scannedAt >= before, `${scannedAt} before ${before}`).toBe(true);
    expect(scannedAt <= new Date().toISOString()).toBe(true);
  });

  it('fails the job when runRepoJob throws, and still deletes the checkout', async () => {
    const { run, dir } = fakes(async () => {
      throw new Error('no run records for aptitude-example-org/billing-api: inventory failed');
    });
    await expect(run(JOB)).rejects.toThrow('no run records');
    expect(existsSync(dir())).toBe(false);
  });
});
