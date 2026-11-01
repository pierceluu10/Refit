// Internal contracts between the harness modules. The public contract is shared/types.ts.
import type {
  AgentTool,
  MigrationTask,
  Recipe,
  RetrieveRecipes,
  RunRecord,
  ToolPack,
} from '../shared/types.ts';
import type { BudgetLedger } from './ledger.ts';

export type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

export type Sandbox = {
  // Host path of the working copy. File tools edit it; in Docker mode it is bind-mounted.
  dir: string;
  mode: 'docker' | 'local';
  // Runs a shell command inside the sandbox with the working copy as cwd. Never throws.
  exec(command: string, options?: { timeoutMs?: number }): Promise<ExecResult>;
  // Unified diff of the working copy against the snapshot taken at creation.
  diff(): Promise<string>;
  dispose(): Promise<void>;
};

export type CheckCommand = { name: string; command: string };

export type CheckRun = {
  name: string;
  command: string;
  ok: boolean;
  output: string; // tail of combined output, redacted
  failures: string[]; // normalised failure signatures used for before/after comparison
};

export type CheckComparison = {
  name: string;
  before: string; // one-line summary, e.g. "pass" or "fail (3 failures)"
  after: string;
  newFailures: string[]; // failures present after the change and not before
};

// What the agent reports through the finish tool.
export type FinishReport = {
  verdict: 'migrated' | 'not-affected';
  summary: string; // what changed
  why: string; // why the API change forced it
  validators: { name: string; passed: boolean; detail: string }[];
  unproven: string[];
  behaviourChanges: string[];
};

export type ToolContext = {
  sandbox: Sandbox;
  task: MigrationTask;
  toolPack: ToolPack;
  retrieveRecipes: RetrieveRecipes;
  checks: CheckCommand[];
  onFinish: (report: FinishReport) => void;
  fetch?: typeof fetch;
};

export type SessionInput = {
  model: string;
  systemPrompt: string;
  prompt: string;
  tools: AgentTool[];
  sandbox: Sandbox;
  ledger: BudgetLedger;
  resume?: string;
  maxTurns: number;
  log: (event: unknown) => void; // appended to the run transcript
};

export type SessionResult = {
  sessionId?: string;
  finalText: string;
  stopReason: 'done' | 'max-turns' | 'budget' | 'error';
  error?: string;
};

// One agent conversation turn-loop. The real one runs the Claude Agent SDK; tests pass a fake.
export type AgentSession = (input: SessionInput) => Promise<SessionResult>;

export type HarnessDeps = {
  session?: AgentSession;
  loadToolPack?: (provider: string) => Promise<ToolPack>;
  retrieveRecipes?: RetrieveRecipes;
  createSandbox?: (repoDir: string) => Promise<Sandbox>;
  budgetUsd?: number; // defaults to APTITUDE_AI_BUDGET_USD
  outDir?: string; // where the transcript, diff and PR body are written
  maxIterations?: number;
  fetch?: typeof fetch;
};

export type HarnessRunRecord = RunRecord & {
  prBody: string;
  models: string[];
  promptVersion: string;
};

export type { Recipe };
