import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { BudgetExceededError, type Budget } from './budget.ts';
import type { AskModel } from './match.ts';

// A second transport for the match agent: the Claude Agent SDK, which runs on the logged-in Claude Code
// credentials when there is no ANTHROPIC_API_KEY. Cost is the SDK's own total_cost_usd estimate.
export function agentSdk(opts: { budget: Budget; model?: string }): AskModel {
  const model = opts.model ?? 'claude-opus-5-5';
  return async ({ system, prompt, schema }) => {
    const remaining = opts.budget.capUsd - opts.budget.spentUsd();
    if (remaining <= 0)
      throw new BudgetExceededError(`AI budget of $${opts.budget.capUsd} is spent.`);

    let result: SDKResultMessage | undefined;
    for await (const message of query({
      prompt,
      options: {
        model,
        systemPrompt: system,
        outputFormat: { type: 'json_schema', schema },
        effort: 'high',
        tools: [],
        maxTurns: 3,
        // The SDK checks this between turns, so one turn can overshoot by at most that turn's cost.
        maxBudgetUsd: remaining,
        settingSources: [],
        persistSession: false,
        cwd: mkdtempSync(join(tmpdir(), 'aptitude-match-')),
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
