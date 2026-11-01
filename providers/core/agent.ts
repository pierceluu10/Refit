// A small tool-use loop. The model decides what to read and what to report;
// tools give it pages and checks. The loop ends when the model is done, the
// turn limit is hit, or the budget runs out, and it always says which.

import {
  BudgetExceededError,
  isText,
  isToolUse,
  type ContentBlock,
  type Message,
  type ModelClient,
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

export async function runToolLoop(options: {
  model: ModelClient;
  system: string;
  prompt: string;
  tools: LoopTool[];
  maxTurns?: number;
  maxTokens?: number;
  /** Checked after each round of tool calls; true ends the loop. */
  isDone?: () => boolean;
  /** One reminder sent if the model stops before isDone() is true. */
  nudge?: string;
  /** Added to the tool results when two or fewer turns remain and isDone() is false. */
  wrapUp?: string;
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
    try {
      response = await options.model.complete({
        system: options.system,
        messages,
        tools: specs,
        maxTokens: options.maxTokens ?? 16_000,
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
    log.push({
      turn,
      stopReason: response.stopReason,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      calls: calls.map((call) => ({
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
    if (options.wrapUp && left <= 2 && options.isDone?.() === false) {
      results.push({
        type: 'text',
        text: `${left} model turn${left === 1 ? '' : 's'} left. ${options.wrapUp}`,
      });
    }
    messages.push({ role: 'user', content: results });
    if (options.isDone?.()) return { messages, log, turns: turn, ended: 'done', finalText };
  }
  return { messages, log, turns: maxTurns, ended: 'max-turns', finalText };
}
