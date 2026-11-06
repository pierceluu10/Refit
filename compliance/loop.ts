// A small tool-use loop. The model reads with tools and ends by calling the submit tool. Submit
// validators return feedback the model can act on; they never end the run themselves.

import type { ContentBlock, Message, ModelClient, ToolSpec, ToolUseBlock } from './model.ts';

export type LoopTool = ToolSpec & { run: (input: Record<string, unknown>) => Promise<string> };

export type Submit<T> = ToolSpec & {
  // Returns the accepted result, or feedback for the model to fix and submit again.
  accept: (
    input: Record<string, unknown>,
  ) => { ok: true; value: T } | { ok: false; feedback: string };
};

export type LoopResult<T> = {
  value?: T;
  // The last thing submit received, kept when it was never accepted, so nothing the model wrote is lost.
  lastSubmitted?: Record<string, unknown>;
  error?: string;
  turns: number;
  transcript: Message[];
};

const isToolUse = (block: ContentBlock): block is ToolUseBlock => block.type === 'tool_use';

export async function runLoop<T>(options: {
  model: ModelClient;
  system: string;
  prompt: string;
  tools: LoopTool[];
  submit: Submit<T>;
  maxTurns?: number;
  maxTokens?: number;
}): Promise<LoopResult<T>> {
  const maxTurns = options.maxTurns ?? 24;
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }];
  const specs: ToolSpec[] = [...options.tools, options.submit].map(
    ({ name, description, input_schema }) => ({ name, description, input_schema }),
  );
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  let lastSubmitted: Record<string, unknown> | undefined;
  let nudged = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    let response;
    try {
      response = await options.model.complete({
        system: options.system,
        messages,
        tools: specs,
        maxTokens: options.maxTokens ?? 8_000,
      });
    } catch (error) {
      return { lastSubmitted, error: errorText(error), turns: turn, transcript: messages };
    }
    messages.push({ role: 'assistant', content: response.content });
    const calls = response.content.filter(isToolUse);
    if (calls.length === 0) {
      if (nudged) {
        return {
          lastSubmitted,
          error: `the model ended without calling ${options.submit.name}`,
          turns: turn,
          transcript: messages,
        };
      }
      nudged = true;
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `Finish by calling ${options.submit.name} with your result.` },
        ],
      });
      continue;
    }
    const results: ContentBlock[] = [];
    for (const call of calls) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      if (call.name === options.submit.name) {
        lastSubmitted = input;
        const verdict = options.submit.accept(input);
        if (verdict.ok) {
          return { value: verdict.value, turns: turn, transcript: messages };
        }
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: verdict.feedback,
          is_error: true,
        });
        continue;
      }
      const tool = byName.get(call.name);
      let content: string;
      let isError = false;
      try {
        content = tool ? await tool.run(input) : `No tool named ${call.name}.`;
        isError = !tool;
      } catch (error) {
        content = `Tool failed: ${errorText(error)}`;
        isError = true;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content, is_error: isError });
    }
    messages.push({ role: 'user', content: results });
  }
  return {
    lastSubmitted,
    error: `no accepted ${options.submit.name} within ${maxTurns} turns`,
    turns: maxTurns,
    transcript: messages,
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
