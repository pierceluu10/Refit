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
  it('sends a plain Messages API body and maps usage, keeping cache tokens and searches apart', async () => {
    const send = vi.fn(async (_body: Body) => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
        server_tool_use: { web_search_requests: 2 },
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
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheWriteTokens: 5,
        cacheReadTokens: 7,
        webSearches: 2,
      },
    });
  });

  it('adds effort, prompt caching and server tools only when asked', async () => {
    const send = vi.fn(async (_body: Body) => ({ content: [], usage: {} }));
    await messagesApiModel({ send, effort: 'low' }).complete(request);
    expect(send.mock.calls[0][0]).toMatchObject({ output_config: { effort: 'low' } });
    expect(send.mock.calls[0][0]).not.toHaveProperty('cache_control');

    const search = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
    await messagesApiModel({ send, cache: true }).complete({ ...request, serverTools: [search] });
    expect(send.mock.calls[1][0]).toMatchObject({
      cache_control: { type: 'ephemeral' },
      tools: [...request.tools, search],
    });
  });
});

describe('costOf', () => {
  it('prices cache writes, cache reads and web searches', async () => {
    const { costOf } = await import('./model.ts');
    // Sonnet 5.5: $2 in, $10 out; writes 1.25x, reads 0.05x; $0.01 a search.
    expect(
      costOf('claude-sonnet-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        webSearches: 3,
      }),
    ).toBeCloseTo(2 + 1 + 2.5 + 0.1 + 0.03);
    // Opus 5.5 reads cost $0.20 per million.
    expect(
      costOf('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }),
    ).toBeCloseTo(0.2);
    // Haiku 5.5 bills prompts over 100k tokens at the long-context price.
    expect(costOf('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 0 })).toBeCloseTo(0.1);
    // Unknown models count cache reads at the full input price, so the cap errs towards stopping.
    expect(
      costOf('some-new-model', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }),
    ).toBeCloseTo(10);
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
      cache_control: { type: 'ephemeral' },
    });
  });
});
