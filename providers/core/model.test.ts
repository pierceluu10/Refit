import { afterEach, describe, expect, it, vi } from 'vitest';

const created: unknown[] = [];
const create = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
    constructor(options: unknown) {
      created.push(options);
    }
  },
}));

const { anthropicModel, messagesApiModel } = await import('./model.ts');
type Body = import('./model.ts').MessagesApiBody;

const request = {
  system: 'sys',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
  maxTokens: 3000,
};

afterEach(() => {
  created.length = 0;
  create.mockReset();
});

describe('messagesApiModel', () => {
  it('sends a plain Messages API body and maps usage, counting cache tokens as input', async () => {
    const send = vi.fn(async (_body: Body) => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
      },
    }));
    const model = messagesApiModel({ send, model: 'claude-sonnet-5-5' });
    const response = await model.complete(request);
    expect(send).toHaveBeenCalledWith({
      model: 'claude-sonnet-5-5',
      max_tokens: 3000,
      system: 'sys',
      messages: request.messages,
      tools: request.tools,
    });
    expect(response).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 112, outputTokens: 20 },
    });
  });

  it('adds effort only when asked', async () => {
    const send = vi.fn(async (_body: Body) => ({ content: [], usage: {} }));
    await messagesApiModel({ send, effort: 'low' }).complete(request);
    expect(send.mock.calls[0][0]).toMatchObject({ output_config: { effort: 'low' } });
  });
});

describe('anthropicModel', () => {
  it('builds the SDK client with retries off, so every retry is a fresh budgeted call', async () => {
    create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const model = anthropicModel({ model: 'claude-sonnet-5-5' });
    await model.complete(request);
    expect(created).toEqual([{ maxRetries: 0 }]);
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 3000,
      output_config: { effort: 'medium' },
    });
  });
});
