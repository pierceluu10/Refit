// Shared contract between app/, inventory/, harness/, memory/, providers/ and evals/.
// Change it only additively during the overnight run; agree any breaking change in the morning.

export type MigrationKind =
  | 'api-version'
  | 'sdk-major'
  | 'field-removed'
  | 'field-renamed'
  | 'endpoint-removed'
  | 'rest-to-graphql'
  | 'auth-change'
  | 'webhook-payload'
  | 'model-retirement'
  | 'product-shutdown'
  | 'pagination-or-limits'
  | 'other';

export type ApiUsage = {
  repo: string;
  provider: string; // 'stripe' | 'shopify' | 'meta-graph' | 'openai' | ...
  via: 'sdk' | 'http' | 'graphql' | 'webhook';
  sdk?: { name: string; version: string; lockfile?: string };
  pinnedVersion?: { value: string; file: string; line: number };
  callSites: { file: string; line: number; operation: string; fields?: string[]; notes?: string }[];
  hints?: ProviderHints;
};

export type ProviderChange = {
  provider: string;
  id: string;
  kind: MigrationKind;
  title: string;
  effectiveDate?: string;
  source: { url: string; quote: string };
  affects: { operations?: string[]; fields?: string[]; versions?: string[]; sdk?: string };
};

export type MigrationTask = {
  id: string;
  repo: string;
  change: ProviderChange;
  usages: ApiUsage[];
  deadline?: string;
  priority: number;
  notes?: string; // the match agent's reasoning, or why the harness must find the usage itself
};

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  run: (input: unknown, context: { repoDir: string }) => Promise<string>;
};

export type ToolPack = {
  provider: string;
  tools: AgentTool[];
  playbooks: Partial<Record<MigrationKind, string>>; // markdown guidance injected into the prompt
};

export type Recipe = {
  id: string;
  provider: string;
  kind: MigrationKind;
  preconditions: string;
  steps: string;
  pitfalls: string;
  sourceRuns: string[];
  verifiedRepos: number;
};

export type RunRecord = {
  taskId: string;
  outcome: 'verified' | 'needs-review' | 'not-affected' | 'failed';
  diff: string;
  checks: { name: string; before: string; after: string }[];
  costUsd: number;
  transcriptPath: string;
  pr?: string;
  humanVerdict?: 'merged' | 'closed' | 'edited';
};

// Entry points each owner exports, so others can code against them before they exist.
export type InventoryRepo = (repoDir: string, repo: string) => Promise<ApiUsage[]>;
export type WatchProvider = (since?: string) => Promise<ProviderChange[]>;
export type RetrieveRecipes = (task: MigrationTask) => Promise<Recipe[]>;
export type RunTask = (task: MigrationTask, repoDir: string) => Promise<RunRecord>;

// Round 2 contracts (2026-11-01). Additive only.

// Opens the PR for one finished task and returns its URL. The app implements it (P4).
export type OpenPullRequest = (
  task: MigrationTask,
  record: RunRecord,
  repoDir: string,
) => Promise<string>;

// Runs the whole loop on one checked-out repo. The orchestrator implements it (O4); the app calls it (P4).
export type RunRepoJob = (input: {
  repo: string; // owner/name
  dir: string; // a fresh checkout to read; repo code never runs on the host
  openPullRequest: OpenPullRequest;
  dryRun?: boolean; // stop before opening PRs
}) => Promise<RunRecord[]>;

// Where to look for a provider's changes. The inventory fills it (P5); the watchers read it (F4).
export type ProviderHints = { packages?: string[]; hosts?: string[]; docsUrls?: string[] };

// One run as the dashboard shows it. Memory produces it (O6), the app serves it (P4), the site renders it (P6).
export type RunView = {
  id: string;
  repo: string;
  taskId: string;
  provider: string;
  changeId: string;
  outcome: RunRecord['outcome'];
  pr?: string;
  costUsd: number;
  summary: string; // one line: what changed, or why nothing did
  finishedAt: string;
};
