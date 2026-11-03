import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { OpenPullRequest, RunRecord } from '../shared/types.ts';
import { createJobRunner } from './jobs.ts';
import type { UnderstandJob } from './types.ts';

const JOB: UnderstandJob = {
  kind: 'understand',
  installationId: 70000001,
  repo: 'refit-example-org/billing-api',
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

function fakes(runRepoJob: () => Promise<RunRecord[]>) {
  const calls: string[] = [];
  const opener: OpenPullRequest = async () => 'https://github.com/example/pull/1';
  let checkoutDir = '';
  const run = createJobRunner({
    tokens: { token: async (id) => `token-${id}` },
    checkout: async (token, repo, dir) => {
      checkoutDir = dir;
      calls.push(`checkout ${token} ${repo}`);
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
      'checkout token-70000001 refit-example-org/billing-api',
      'opener 70000001',
      'run refit-example-org/billing-api true true',
    ]);
    expect(existsSync(dir())).toBe(false);
  });

  it('fails the job when runRepoJob throws, and still deletes the checkout', async () => {
    const { run, dir } = fakes(async () => {
      throw new Error('no run records for refit-example-org/billing-api: inventory failed');
    });
    await expect(run(JOB)).rejects.toThrow('no run records');
    expect(existsSync(dir())).toBe(false);
  });
});
