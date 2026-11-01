import { rm } from 'node:fs/promises';
import { fixWithAgent, type AgentFixInput, type AgentFixResult } from './agent-fix.ts';
import { agentWorkspace, workspaceDiff } from './meta-graph-agent.ts';
import {
  disposeSandboxBaseline,
  sandboxBaseline,
  sandboxCheck,
  type SandboxBaseline,
} from './validation-sandbox-check.ts';

// Stripe's hand-off (docs/GUT-PLAN.md), as shopify-agent.ts does it: every stop goes to the agent
// fixer, which starts from the rules' patch in a copy of the repository. Refit's Stripe rescan and
// GUT5's before/after sandbox check judge each round.
export async function stripeHandOff(options: {
  repository: string;
  patch: string | null;
  target: string;
  change: string;
  context: string;
  judge: AgentFixInput['check'];
}): Promise<AgentFixResult & { patch: string }> {
  let baseline: SandboxBaseline | undefined;
  try {
    baseline = await sandboxBaseline({ repository: options.repository });
  } catch {
    // Without Docker the Stripe judge still runs, and validation runs the checks afterwards.
  }
  const directory = await agentWorkspace(options.repository, options.patch);
  try {
    const result = await fixWithAgent({
      repoDir: directory,
      provider: 'stripe',
      target: options.target,
      change: options.change,
      context: options.context,
      check: async (repoDir) => {
        const stripe = await options.judge(repoDir);
        const box = baseline ? await sandboxCheck(repoDir, baseline) : undefined;
        return {
          passed: stripe.passed && (box?.passed ?? true),
          errors: [...stripe.errors, ...(box?.errors ?? [])],
        };
      },
    });
    return { ...result, patch: await workspaceDiff(directory) };
  } finally {
    if (baseline) await disposeSandboxBaseline(baseline);
    await rm(directory, { recursive: true, force: true });
  }
}
