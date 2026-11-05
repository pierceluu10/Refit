import type { RunRecord, RunView } from '../shared/types.ts';

export type HumanVerdict = NonNullable<RunRecord['humanVerdict']>;

// `repo` is always the full name, `owner/name`, matching ApiUsage.repo.
export type AppJob =
  | {
      kind: 'understand';
      installationId: number;
      repo: string;
      reason: 'install' | 'repos-added' | 'push' | 'clock' | 'manual';
      sha?: string;
    }
  | { kind: 'forget'; installationId: number; repo: string };

export type UnderstandJob = Extract<AppJob, { kind: 'understand' }>;

export type ForgetJob = Extract<AppJob, { kind: 'forget' }>;

export type JobQueue = { enqueue: (job: AppJob) => Promise<void> };

// memory/ owns the run store; app/ reports what a human did with an Aptitude PR.
export type RecordVerdict = (pr: string, verdict: HumanVerdict) => Promise<void>;

// memory/'s listRunViews: every installation's runs, newest first, filtered by repo before the limit.
export type ListRunViews = (filter: { repo?: string; limit?: number }) => Promise<RunView[]>;

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

// owner/name with GitHub's characters (letters, digits, '-', '_', '.'); never '.' or '..' as a segment.
export const REPO_PATTERN = /^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/;
