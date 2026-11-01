import { describe, expect, it } from 'vitest';
import type { AgentTool } from '../shared/types.ts';
import { toSdkTool } from './agent.ts';

describe('toSdkTool', () => {
  it('keeps the JSON Schema properties and returns the tool output as text', async () => {
    const echo: AgentTool = {
      name: 'echo',
      description: 'Echo the input',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, times: { type: 'number' } },
        required: ['text'],
      },
      run: async (input, context) => `${JSON.stringify(input)} in ${context.repoDir}`,
    };
    const converted = toSdkTool(echo, '/sandbox');
    expect(Object.keys(converted.inputSchema)).toEqual(['text', 'times']);
    const result = await converted.handler({ text: 'hi' }, undefined);
    expect(result.content).toEqual([{ type: 'text', text: '{"text":"hi"} in /sandbox' }]);
  });
});
