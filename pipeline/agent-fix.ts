// The agent fixer every provider hands its migrations to (docs/GUT-PLAN.md). This first version is
// the interface with a stub, so callers can code against it while the agent lands.
export type AgentFixInput = {
  repoDir: string; // sandbox copy; the agent edits it in place
  provider: 'shopify' | 'meta-graph' | 'stripe';
  target: string; // e.g. Admin API '2026-10', Graph 'v24.0'
  change: string; // what changed, quoted from Refit's provider data
  context: string; // the old stop's reason and findings, files and lines
  check: (repoDir: string) => Promise<{ passed: boolean; errors: string[] }>; // deterministic judge
  attempts?: number; // best-of-N, default 3
  rounds?: number; // feedback rounds per attempt, default 3
};
export type AgentFixResult = {
  outcome: 'passed' | 'unproven' | 'no-change' | 'failed';
  diff: string;
  errors: string[]; // remaining judge errors when not passed
  summary: string; // what the agent changed, what it could not verify, behaviour changes
  costUsd: number;
};

export async function fixWithAgent(input: AgentFixInput): Promise<AgentFixResult> {
  void input;
  return {
    outcome: 'failed',
    diff: '',
    errors: ['The agent fixer is not implemented yet.'],
    summary: '',
    costUsd: 0,
  };
}
