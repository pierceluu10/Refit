import type {
  ExternalTask,
  MigrationTask,
  RunRecord,
  RunView,
  ScanReport,
} from '../shared/types.ts';

export type HumanVerdict = NonNullable<RunRecord['humanVerdict']>;

export type ScanReason = 'install' | 'repos-added' | 'push' | 'schedule';

// `repo` is always the full name, `owner/name`, matching ApiUsage.repo.
export type ScanJob = {
  kind: 'scan';
  installationId: number;
  repo: string;
  reason: ScanReason;
  sha?: string;
};
export type RunJob = { kind: 'run'; installationId: number; repo: string; task: ExternalTask };
// No repo means the whole installation is gone; `account` is its owner, every repo's first segment.
export type ForgetJob = { kind: 'forget'; installationId: number; repo?: string; account?: string };

export type QueuedJob = ScanJob | RunJob;
export type AppJob = QueuedJob | ForgetJob;

export type JobQueue = { enqueue: (job: AppJob) => Promise<void> };

// A PR opener that takes external tasks as well as API tasks; it still satisfies OpenPullRequest.
export type OpenAnyPullRequest = (
  task: MigrationTask | ExternalTask,
  record: RunRecord,
  repoDir: string,
) => Promise<string>;

// O1's runRepoJob, limited to the tasks a scan already found so no task is matched or paid for twice.
export type RunTasks = (input: {
  repo: string;
  dir: string;
  tasks: ExternalTask[];
  openPullRequest: OpenAnyPullRequest;
  signal?: AbortSignal;
}) => Promise<RunRecord[]>;

// P3's app/lifecycle: runs before each PR. A returned pr means an existing PR took the change.
export type BeforeOpenPullRequest = (input: {
  installationId: number;
  task: MigrationTask | ExternalTask;
  record: RunRecord;
  repoDir: string;
}) => Promise<{ pr?: string }>;

// P3's app/notify: runs after each run job.
export type NotifyRun = (input: {
  installationId: number;
  repo: string;
  records: RunRecord[];
  report?: ScanReport;
}) => Promise<void>;

// memory/ owns the run store; app/ reports what a human did with an Refit PR, and the PR's final diff
// when it has one.
export type RecordVerdict = (
  pr: string,
  verdict: HumanVerdict,
  finalDiff?: string,
) => Promise<void>;

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

// Every Refit PR branch starts with this, which is how webhooks recognise our PRs.
export const BRANCH_PREFIX = 'refit/';

// owner/name with GitHub's characters (letters, digits, '-', '_', '.'); never '.' or '..' as a segment.
export const REPO_PATTERN = /^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/;
