// Placeholder for GUT1's agent fixer (docs/GUT-PLAN.md, "Agent fixer interface"), so the provider
// pipelines can code against it before gut/agent-fix lands. Merging gut/agent-fix replaces this
// file with the real one.

export type AgentFixInput = {
  repoDir: string;
  provider: 'shopify' | 'meta-graph' | 'stripe';
  target: string;
  change: string;
  context: string;
  check: (repoDir: string) => Promise<{ passed: boolean; errors: string[] }>;
  attempts?: number;
  rounds?: number;
};
export type AgentFixResult = {
  outcome: 'passed' | 'unproven' | 'no-change' | 'failed';
  diff: string;
  errors: string[];
  summary: string;
  costUsd: number;
};

export async function fixWithAgent(_input: AgentFixInput): Promise<AgentFixResult> {
  return {
    outcome: 'failed',
    diff: '',
    errors: ['The agent fixer is not available on this branch yet.'],
    summary: '',
    costUsd: 0,
  };
}
