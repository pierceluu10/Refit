// A small tool-use loop. The model decides what to read and what to report;
// tools give it pages and checks. The loop ends when the model is done, the
// turn limit is hit, or the budget runs out, and it always says which.

import {
  BudgetExceededError,
  isText,
  isToolUse,
  worstCaseUsd,
  type ContentBlock,
  type Message,
  type ModelClient,
  type ServerTool,
  type ToolResultBlock,
  type ToolSpec,
} from './model.ts';

export type ToolResult = { content: string; isError?: boolean };

export type LoopTool = ToolSpec & {
  run: (input: Record<string, unknown>) => Promise<ToolResult>;
};

/** One model turn, for the run log: why it stopped, what it cost, which tools it called. */
export type TurnLog = {
  turn: number;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  calls: { tool: string; input: string }[];
};

export type LoopResult = {
  messages: Message[];
  log: TurnLog[];
  turns: number;
  /** 'done' | 'max-turns' | 'budget' | 'model-error' */
  ended: 'done' | 'max-turns' | 'budget' | 'model-error';
  finalText: string;
  error?: string;
};

/** What the loop reads of a run's ledger to warn the model before the money runs out. */
export type LoopBudget = { readonly capUsd: number; readonly spentUsd: number };

export async function runToolLoop(options: {
  model: ModelClient;
  system: string;
  prompt: string;
  tools: LoopTool[];
  /** Tools Anthropic runs itself, such as web search. Their blocks are passed back unchanged. */
  serverTools?: ServerTool[];
  maxTurns?: number;
  maxTokens?: number;
  /** Checked after each round of tool calls; true ends the loop. */
  isDone?: () => boolean;
  /** One reminder sent if the model stops before isDone() is true. */
  nudge?: string;
  /**
   * Added to the tool results when isDone() is false and the run is nearly out
   * of turns (two or fewer left) or of budget (less than about two turns' cost left).
   */
  wrapUp?: string;
  /** The ledger the model is metered on, for the budget warning. */
  budget?: LoopBudget;
}): Promise<LoopResult> {
  const maxTurns = options.maxTurns ?? 16;
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }];
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const specs: ToolSpec[] = options.tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
  const log: TurnLog[] = [];
  let finalText = '';
  let nudged = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    let response;
    const spentBefore = options.budget?.spentUsd ?? 0;
    try {
      response = await options.model.complete({
        system: options.system,
        messages,
        tools: specs,
        maxTokens: options.maxTokens ?? 16_000,
        ...(options.serverTools?.length ? { serverTools: options.serverTools } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        messages,
        log,
        turns: turn - 1,
        ended: error instanceof BudgetExceededError ? 'budget' : 'model-error',
        finalText,
        error: message,
      };
    }
    const calls = response.content.filter(isToolUse);
    // Server tools (web search) run inside the turn; they are logged with the client tools.
    const serverCalls = response.content.filter(
      (block): block is ContentBlock & { name: string; input?: unknown } =>
        block.type === 'server_tool_use' && typeof (block as { name?: unknown }).name === 'string',
    );
    log.push({
      turn,
      stopReason: response.stopReason,
      inputTokens:
        response.usage.inputTokens +
        (response.usage.cacheWriteTokens ?? 0) +
        (response.usage.cacheReadTokens ?? 0),
      outputTokens: response.usage.outputTokens,
      calls: [...serverCalls, ...calls].map((call) => ({
        tool: call.name,
        input: JSON.stringify(call.input ?? {}).slice(0, 300),
      })),
    });
    // An empty assistant turn cannot be sent back, so it ends the loop.
    if (response.content.length === 0)
      return { messages, log, turns: turn, ended: 'done', finalText };
    messages.push({ role: 'assistant', content: response.content });
    const text = response.content.filter(isText).map((block) => block.text);
    if (text.length) finalText = text.join('\n').trim();

    // A long server-tool turn can pause; sending the conversation back as it is resumes it.
    if (response.stopReason === 'pause_turn' && calls.length === 0) continue;

    if (calls.length === 0) {
      if (options.isDone?.() === false && options.nudge && !nudged && turn < maxTurns) {
        nudged = true;
        messages.push({ role: 'user', content: [{ type: 'text', text: options.nudge }] });
        continue;
      }
      return { messages, log, turns: turn, ended: 'done', finalText };
    }

    // At max_tokens the last tool call may be cut off mid-input, so it is not run.
    const cutOff = response.stopReason === 'max_tokens' ? calls.at(-1) : undefined;
    const results: ContentBlock[] = await Promise.all(
      calls.map(async (call): Promise<ToolResultBlock> => {
        if (call === cutOff) {
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content:
              'Your reply hit the max_tokens limit, so this call was cut off and not run. Send it again, more compactly.',
            is_error: true,
          };
        }
        const tool = byName.get(call.name);
        if (!tool) {
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: `No tool named ${call.name}.`,
            is_error: true,
          };
        }
        try {
          const input =
            call.input && typeof call.input === 'object'
              ? (call.input as Record<string, unknown>)
              : {};
          const result = await tool.run(input);
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: result.content,
            is_error: result.isError,
          };
        } catch (error) {
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
            is_error: true,
          };
        }
      }),
    );
    const left = maxTurns - turn;
    if (options.wrapUp && options.isDone?.() === false) {
      const turnUsd = (options.budget?.spentUsd ?? 0) - spentBefore;
      const leftUsd = options.budget ? options.budget.capUsd - options.budget.spentUsd : Infinity;
      // The ledger sends a call only if its worst case fits, so warn before that wall, too.
      const nextWorstUsd = options.budget
        ? worstCaseUsd(options.model.model, {
            system: options.system,
            messages: [...messages, { role: 'user', content: results }],
            tools: specs,
            maxTokens: options.maxTokens ?? 16_000,
            serverTools: options.serverTools,
          })
        : 0;
      if (left <= 2) {
        results.push({
          type: 'text',
          text: `${left} model turn${left === 1 ? '' : 's'} left. ${options.wrapUp}`,
        });
      } else if (leftUsd < nextWorstUsd) {
        results.push({
          type: 'text',
          text: `About $${Math.max(leftUsd, 0).toFixed(2)} of this run's AI budget is left, which may not cover another full turn: your next reply may be cut short. ${options.wrapUp}`,
        });
      } else if (turnUsd > 0 && leftUsd < turnUsd * 2.5) {
        results.push({
          type: 'text',
          text: `About $${Math.max(leftUsd, 0).toFixed(2)} of this run's AI budget is left, enough for one or two more turns. ${options.wrapUp}`,
        });
      }
    }
    messages.push({ role: 'user', content: results });
    if (options.isDone?.()) return { messages, log, turns: turn, ended: 'done', finalText };
  }
  return { messages, log, turns: maxTurns, ended: 'max-turns', finalText };
}
