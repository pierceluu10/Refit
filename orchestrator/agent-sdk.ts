import { cpSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { query, type CanUseTool, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { isText, type ModelClient } from '../providers/core/model.ts';
import type { Budget } from './budget.ts';
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

// Env templates are fine to read; real env files never are. Same rule as harness/sandbox.ts.
// shortcut: duplicated from the harness tonight, dedupe into shared/ when both branches merge.
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);

export function keepForReading(path: string): boolean {
  const name = basename(path);
  if (name === '.git' || name === 'node_modules' || name === '.envrc' || name === '.env')
    return false;
  if (name.startsWith('.env.') && !ENV_TEMPLATES.has(name)) return false;
  // A symlink could point at a secret outside the repo.
  return !lstatSync(path).isSymbolicLink();
}

// The matcher reads a filtered copy, never the checkout itself: in-cwd reads can be auto-allowed
// without reaching canUseTool, so the copy is what keeps real env files out of its reach.
export function copyForReading(repoDir: string, dest: string): void {
  cpSync(repoDir, dest, {
    recursive: true,
    filter: (src) => src === repoDir || keepForReading(src),
  });
}

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
    // The agent may spend what is free of the run cap; the SDK checks that only between turns.
    const hold = await opts.budget.reserve('an Agent SDK match run', Infinity, 0.01);
    let workDir: string | undefined;
    let queried = false;
    let result: SDKResultMessage | undefined;
    try {
      workDir = mkdtempSync(join(tmpdir(), 'aptitude-match-'));
      if (repoDir) copyForReading(repoDir, workDir);
      queried = true;
      for await (const message of query({
        prompt,
        options: {
          model,
          systemPrompt: repoDir ? system + CODE_ACCESS : system,
          outputFormat: { type: 'json_schema', schema },
          effort: 'high',
          // With a checkout the agent may read its filtered copy (no shell, nothing executed); without one it judges from the usage map.
          tools: repoDir ? READ_TOOLS : [],
          canUseTool: repoDir ? readOnlyInRepo(workDir) : undefined,
          maxTurns: repoDir ? 40 : 3,
          // The SDK checks this between turns, so one turn can overshoot by at most that turn's cost.
          maxBudgetUsd: hold.usd,
          settingSources: [],
          persistSession: false,
          cwd: workDir,
        },
      })) {
        if (message.type === 'result') result = message;
      }
    } finally {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      // A query that ended without a result spent an unknown amount, so the whole hold counts as spent.
      hold.settle(result ? result.total_cost_usd : queried ? hold.usd : 0);
    }
    if (!result) throw new Error('Agent SDK returned no result.');
    const costUsd = result.total_cost_usd;
    if (result.subtype !== 'success') {
      throw new Error(`Agent SDK match run ended with ${result.subtype} after $${costUsd}.`);
    }
    if (result.structured_output === undefined) {
      throw new Error('Agent SDK match run returned no structured output.');
    }
    return { output: result.structured_output, costUsd };
  };
}

// One model call on the logged-in credentials, for what expects a ModelClient on a run with no API key.
export function sdkModel(model: string): ModelClient {
  return {
    model,
    complete: async ({ system, messages }) => {
      const prompt = messages
        .flatMap((message) => message.content)
        .filter(isText)
        .map((block) => block.text)
        .join('\n');
      let result: SDKResultMessage | undefined;
      for await (const message of query({
        prompt,
        options: {
          model,
          systemPrompt: system,
          tools: [],
          maxTurns: 1,
          settingSources: [],
          persistSession: false,
        },
      })) {
        if (message.type === 'result') result = message;
      }
      if (result?.subtype !== 'success') {
        throw new Error(`Agent SDK call ended with ${result?.subtype ?? 'no result'}.`);
      }
      const { usage } = result;
      return {
        content: [{ type: 'text', text: result.result }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}
