// Internal contracts for the proof checks. The public contract is ProofResult and RunProof in
// shared/types.ts; everything here only adds to it.
import type { ProofResult } from '../../shared/types.ts';
import type { Sandbox } from '../types.ts';

export type ProofContext = {
  // The working copy to read. Inside the harness this is the sandbox's copy, already edited.
  repoDir: string;
  // Reuse the harness's sandbox for commands. Without one, a check that runs repo code makes its own
  // from repoDir and disposes of it afterwards.
  sandbox?: Sandbox;
  createSandbox?: (repoDir: string) => Promise<Sandbox>;
  // An untouched copy of the repo, for before/after checks. The harness passes the original checkout;
  // without it, the first call of a before/after check is kept as the baseline.
  baselineDir?: string;
  // Runs a command on the host, for tools that isolate repo code themselves (only `docker build`).
  hostExec?: (
    file: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<HostExecResult>;
  now?: Date;
};

export type HostExecResult = { code: number; stdout: string; stderr: string };

// ProofResult plus the parts the audit trail and the PR body want separately. `evidence` repeats all
// of it as lines, so a reader of plain ProofResult loses nothing.
export type ProofDetail = ProofResult & {
  commands: string[];
  passedItems: string[];
  failedItems: string[];
  notes: string[];
  logTail?: string;
  skipped?: string; // set when a tool the check needs (Docker, a browser) is missing
};

export type ProofCheck = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>, ctx: ProofContext) => Promise<ProofDetail>;
};
