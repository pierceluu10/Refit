import type { RunRecord } from '../shared/types.ts';

export type HumanVerdict = NonNullable<RunRecord['humanVerdict']>;

// `repo` is always the full name, `owner/name`, matching ApiUsage.repo.
export type AppJob =
  | {
      kind: 'understand';
      installationId: number;
      repo: string;
      reason: 'install' | 'repos-added' | 'push';
      sha?: string;
    }
  | { kind: 'forget'; installationId: number; repo: string };

// The orchestrator's queue replaces this; app/ only enqueues.
export type JobQueue = { enqueue: (job: AppJob) => Promise<void> };

// memory/ owns the run store; app/ reports what a human did with an Aptitude PR.
export type RecordVerdict = (pr: string, verdict: HumanVerdict) => Promise<void>;

export type InstallationTokens = { token: (installationId: number) => Promise<string> };

export type FileChange = { path: string; content: string } | { path: string; delete: true };

export type OpenPullRequestInput = {
  repo: string;
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: FileChange[];
  base?: string; // defaults to the repo's default branch
  draft?: boolean;
};

export type OpenedPullRequest = { url: string; number: number; branch: string; sha: string };

// Every Aptitude PR branch starts with this, which is how webhooks recognise our PRs.
export const BRANCH_PREFIX = 'aptitude/';
