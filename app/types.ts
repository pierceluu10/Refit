import type { RunRecord, RunView } from '../shared/types.ts';

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

export type UnderstandJob = Extract<AppJob, { kind: 'understand' }>;

export type JobQueue = { enqueue: (job: AppJob) => Promise<void> };

// memory/ owns the run store; app/ reports what a human did with an Aptitude PR.
export type RecordVerdict = (pr: string, verdict: HumanVerdict) => Promise<void>;

// memory/'s FixEvidence, copied by shape until memory/types.ts lands from rebuild/otabek.
export type FixEvidence = {
  edited?: boolean; // a person's commits changed our PR
  merged?: { at: string; humanDiff?: string }; // humanDiff: our PR against what was merged
  closed?: { at: string; comment?: string };
  reverted?: { at: string; via: 'revert' | 'rescan' };
};

// memory/'s recordEvidence, plus whether this customer agreed to share what it learns. The evidence
// always goes to the customer's own store; `consented` decides only whether anything leaves it.
export type RecordEvidence = (
  pr: string,
  evidence: FixEvidence,
  consent: { consented: boolean },
) => Promise<void>;

// What a repo's team keeps doing to our PRs. Per repo, for the customer's own store, never shared.
export type RepoHabitEvidence = {
  repo: string;
  rejections: { count: number; reasons: string[] }; // closed unmerged, latest reasons last
  edits: { count: number; repeatedFiles: string[] }; // files people changed on 2 or more merged PRs
};

export type RecordHabits = (habits: RepoHabitEvidence) => Promise<void>;

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

// What the app keeps when it opens a fix: its commit, and the list entries it fixed.
export type OpenedFix = {
  repo: string;
  number: number;
  url: string;
  sha: string;
  entryIds: string[];
};

// Every Aptitude PR branch starts with this, which is how webhooks recognise our PRs.
export const BRANCH_PREFIX = 'aptitude/';

// owner/name with GitHub's characters (letters, digits, '-', '_', '.'); never '.' or '..' as a segment.
export const REPO_PATTERN = /^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/;
