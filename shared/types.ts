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
  tasks?: ExternalTask[]; // attempt only these, from an earlier scan, instead of running the whole loop
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

// MVP (2026-11-06): anything outside the codebase that can force it to change. Additive only.

export type MigrationKindMvp =
  | 'runtime-eol' // a language or runtime version reaches end of life
  | 'framework-major' // a framework's major version, e.g. Next.js, Django
  | 'dependency-major' // a library's major version with breaking changes
  | 'security-fix' // an advisory whose fix needs code changes
  | 'container-image-eol' // a base image or OS version reaches end of life
  | 'ci-deprecation' // a CI action, image or runner version is retired
  | 'k8s-version' // a Kubernetes API or version is removed or reaches end of life
  | 'serverless-runtime' // a Lambda, Cloud Functions or Azure Functions runtime is retired
  | 'cloud-deprecation' // a cloud service or feature is shut down
  | 'platform-policy' // an app store or platform requirement, e.g. target SDK, privacy manifest
  | 'mobile-os' // an iOS or Android behaviour change
  | 'browser-change' // a browser removes a feature, or extension manifest rules change
  | 'tls-crypto' // TLS versions, ciphers or certificate rules change
  | 'auth-standard' // OAuth or login changes, e.g. password logins switched off
  | 'payment-rule' // payment security rules, e.g. SCA, PCI DSS
  | 'regulation'; // a law, e.g. accessibility, privacy or AI rules

export type DependencyKind =
  | 'api'
  | 'sdk'
  | 'library'
  | 'framework'
  | 'runtime'
  | 'ai-model'
  | 'container-image'
  | 'ci'
  | 'platform' // app stores, mobile OS, browsers
  | 'infrastructure' // Kubernetes, serverless, cloud services
  | 'security-standard' // TLS, certificates, login standards
  | 'regulated-surface';

export type DependencyUsage = {
  repo: string;
  kind: DependencyKind;
  name: string; // e.g. 'node', 'next', 'gpt-4o', 'stripe', 'node:18-bookworm', 'actions/checkout'
  ecosystem?: string; // e.g. 'npm', 'pypi', 'docker', 'github-actions', 'openai'
  version?: string;
  declaredIn: { file: string; line?: number; text?: string }[]; // every place the version is set or implied
  callSites?: ApiUsage['callSites']; // for APIs, SDKs and AI models
  notes?: string;
  hints?: ProviderHints; // where a watcher should look
  package?: string; // the monorepo package directory that declares it
};

export type ExternalChange = Omit<ProviderChange, 'kind'> & {
  kind: MigrationKind | MigrationKindMvp;
  dependencyKind: DependencyKind;
  dependency: string; // matches DependencyUsage.name
  fromVersions?: string[];
  toVersion?: string; // the recommended target, when there is one
  severity?: 'deadline' | 'security' | 'breaking' | 'notice';
};

export type ExternalTask = Omit<MigrationTask, 'change'> & {
  change: ExternalChange;
  dependencies: DependencyUsage[];
};

export type BehindItem = {
  repo: string;
  dependency: DependencyUsage;
  change: ExternalChange;
  deadline?: string;
  status: 'open' | 'pr-open' | 'merged' | 'not-affected';
  pr?: string;
  taskId?: string; // the task covering this row; every change a task resolves shares its id
};

export type ScanReport = {
  repo: string;
  scannedAt: string;
  items: BehindItem[];
  costUsd: number;
  errors: string[]; // what couldn't be read, said honestly
};

// Entry points. Each owner exports these; everyone else codes against stubs until they land.
export type InventoryDependencies = (repoDir: string, repo: string) => Promise<DependencyUsage[]>; // P2
export type WatchDependency = (dep: DependencyUsage, since?: string) => Promise<ExternalChange[]>; // F1
export type ScanRepo = (
  repo: string,
  dir: string,
) => Promise<{ report: ScanReport; tasks: ExternalTask[] }>; // O1
export type RunExternalTask = (task: ExternalTask, repoDir: string) => Promise<RunRecord>; // O2
export type RetrieveExternalRecipes = (task: ExternalTask) => Promise<Recipe[]>; // O4

// Extended scope (2026-11-06): platforms and rules. Additive only.

export type Obligation = {
  id: string;
  rule: { name: string; jurisdiction?: string; url: string; quote: string }; // e.g. 'European Accessibility Act'
  requirement: string; // what the rule asks for, in plain words
  appliesTo: string; // which code it likely touches, e.g. 'checkout pages', 'forms', 'AI features making decisions about people'
  inCode: string; // what the rule's text points to in code, written by the agent
  effectiveDate?: string;
  checkable: string[]; // what a tool can check, e.g. 'axe accessibility scan', 'scripts on the payment page'
  needsHuman: string[]; // what a person or lawyer must confirm
};

export type AuditEntry = {
  at: string;
  repo: string;
  changeId: string;
  obligationId?: string;
  action:
    'detected' | 'matched' | 'not-affected' | 'pr-opened' | 'pr-updated' | 'merged' | 'closed';
  pr?: string;
  evidence: string[]; // check names and results, source links
  actor: 'refit' | string; // a GitHub login when a person acted
};

export type ProofResult = { check: string; passed: boolean | 'unknown'; evidence: string[] };

// Entry points.
export type InventorySurfaces = (repoDir: string, repo: string) => Promise<DependencyUsage[]>; // P5
export type WatchPlatforms = (dep: DependencyUsage, since?: string) => Promise<ExternalChange[]>; // F3
export type WatchRegulations = (since?: string) => Promise<Obligation[]>; // O5
export type ObligationsToChanges = (
  repo: string,
  surfaces: DependencyUsage[],
  obligations: Obligation[],
) => Promise<ExternalChange[]>; // O5
export type RunProof = (
  check: string,
  input: unknown,
  ctx: { repoDir: string },
) => Promise<ProofResult>; // O6
export type RecordAudit = (entry: AuditEntry) => Promise<void>; // O5
