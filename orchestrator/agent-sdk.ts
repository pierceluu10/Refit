import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { query, type CanUseTool, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { BudgetExceededError, type Budget } from './budget.ts';
import type { AskModel } from './match.ts';

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

export const CODE_ACCESS = `

You can read this repository with Read, Grep and Glob. They are read-only and nothing in the repo runs. Before saying a change does not affect the repo, search the code for the change's operations, fields and versions, and cite in the reasoning what you searched and what you found.`;

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// Read-only tools on paths inside the repo only; every other tool or path is denied.
export function readOnlyInRepo(repoDir: string): CanUseTool {
  const root = real(resolve(repoDir));
  return async (toolName, input) => {
    if (!READ_TOOLS.includes(toolName)) {
      return { behavior: 'deny', message: `${toolName} is not available to the match agent.` };
    }
    const path = input.file_path ?? input.path;
    const target = typeof path === 'string' ? real(resolve(root, path)) : root;
    return target === root || target.startsWith(root + sep)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'Only files inside the repository can be read.' };
  };
}

// A second transport for the match agent: the Claude Agent SDK, which runs on the logged-in Claude Code
// credentials when there is no ANTHROPIC_API_KEY. Cost is the SDK's own total_cost_usd estimate.
// Given a repoDir, the agent can read the code before judging, which matters most for "not affected".
export function agentSdk(opts: { budget: Budget; model?: string }): AskModel {
  const model = opts.model ?? 'claude-opus-5-5';
  return async ({ system, prompt, schema, repoDir }) => {
    const remaining = opts.budget.capUsd - opts.budget.spentUsd();
    if (remaining <= 0)
      throw new BudgetExceededError(`AI budget of $${opts.budget.capUsd} is spent.`);

    let result: SDKResultMessage | undefined;
    for await (const message of query({
      prompt,
      options: {
        model,
        systemPrompt: repoDir ? system + CODE_ACCESS : system,
        outputFormat: { type: 'json_schema', schema },
        effort: 'high',
        // With a checkout the agent may read it (no shell, nothing executed); without one it judges from the usage map.
        tools: repoDir ? READ_TOOLS : [],
        canUseTool: repoDir ? readOnlyInRepo(repoDir) : undefined,
        maxTurns: repoDir ? 40 : 3,
        // The SDK checks this between turns, so one turn can overshoot by at most that turn's cost.
        maxBudgetUsd: remaining,
        settingSources: [],
        persistSession: false,
        cwd: repoDir ?? mkdtempSync(join(tmpdir(), 'aptitude-match-')),
      },
    })) {
      if (message.type === 'result') result = message;
    }
    if (!result) throw new Error('Agent SDK returned no result.');
    const costUsd = opts.budget.chargeUsd(result.total_cost_usd);
    if (result.subtype !== 'success') {
      throw new Error(`Agent SDK match run ended with ${result.subtype} after $${costUsd}.`);
    }
    if (result.structured_output === undefined) {
      throw new Error('Agent SDK match run returned no structured output.');
    }
    return { output: result.structured_output, costUsd };
  };
}
