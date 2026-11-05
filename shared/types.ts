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

// Rebuild contracts (2026-11-05). Additive only. The list and scanner live in dead-apis/ and inventory/.

// What the scanner matches for one entry, as defined in dead-apis/match.ts. `string` is a whole token,
// so gpt-4 doesn't hit gpt-4o and embedding-001 doesn't hit gemini-embedding-001; `*` is a wildcard
// within the token. `regex` is for shapes a token can't say, `url` a host and path, `field` a property
// read on an object from that provider, `package` a dependency name. `ambiguous` means a hit is common
// words or the same shape as the app's own code, so it goes to the small AI check and never to a fix.
export type DeadApiMatcher =
  | { kind: 'string'; value: string; caseSensitive?: boolean; ambiguous?: boolean }
  | { kind: 'regex'; value: string; ambiguous?: boolean }
  | { kind: 'url'; value: string; ambiguous?: boolean }
  | { kind: 'field'; value: string; on?: string[]; ambiguous?: boolean }
  | { kind: 'package'; value: string; ecosystem?: 'npm' | 'python' };

// A version gate. An entry with none applies to every version. A pin never clears an entry alone:
// the scanner compares the version the code runs at against `since`.
export type DeadApiVersions = {
  describe: string;
  apiVersionSince?: string; // the provider's dated API version that removed it, e.g. 2025-03-31.basil
  sdkSince?: { package: string; version: string; ecosystem?: 'npm' | 'python' }[];
};

export type DeadApiEntry = {
  id: string;
  provider: string;
  what: string; // what died
  diedOn: string; // ISO date
  source: { url: string; checkedOn: string; quote?: string };
  lookFor: string[]; // the same as `matchers`, in words a fix session can read
  matchers: DeadApiMatcher[];
  versions?: string; // `appliesTo.describe`, kept flat for prompts
  appliesTo?: DeadApiVersions;
  replacement: string; // must appear on the provider's own page, or say what the page says instead
  replacementIds?: string[]; // model ids or paths named in `replacement`, so a chain can be checked
  requires: string[]; // what else moving to the replacement requires
  // Where the entry counts: the same model name on another host isn't this provider's model.
  context?: { packages?: string[]; hosts?: string[] };
};

// Announced but still working. Never flagged as a break.
export type FutureShutdown = {
  id: string;
  provider: string;
  what: string;
  diesOn: string; // ISO date
  earliest?: boolean; // the provider calls the date "earliest possible", so it doesn't turn on by itself
  source: { url: string; checkedOn: string; quote?: string };
  matchers: DeadApiMatcher[];
  appliesTo?: DeadApiVersions;
  replacement?: string;
  replacementIds?: string[];
  requires?: string[];
  context?: DeadApiEntry['context'];
};

export type MatchClass = 'live' | 'catalog' | 'test' | 'comment' | 'unclear';

export type Finding = {
  entryId: string;
  file: string;
  line: number;
  matchClass: MatchClass;
  version?: string; // the version the code runs at, when an entry has a version gate
};

// `clean` means nothing on the list needs a fix. Unlisted providers are not "clean" evidence:
// they go to the queue, so an unknown provider never reads as nothing to do.
export type ScanResult = { findings: Finding[]; unlistedProviders: string[]; clean: boolean };

export type ScanRepo = (repoDir: string, repo: string) => Promise<ScanResult>;
