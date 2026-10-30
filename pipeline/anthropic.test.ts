import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { supportedSchema } from './anthropic.ts';
import { aiProvider, assessmentConfiguration } from './assessment.ts';
import { MAX_OUTPUT_TOKENS, requestStructuredOutput } from './openai.ts';

const OPTIONS = { provider: 'anthropic' as const, apiKey: 'test-key', model: 'claude-sonnet-5-5' };
const REQUEST = {
  evidence: { files: [] },
  instructions: 'Return JSON.',
  name: 'test',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['minLength'],
    properties: { minLength: { type: 'string', maxLength: 10 } },
  },
};
const MESSAGE = {
  id: 'msg_test',
  type: 'message',
  model: 'claude-sonnet-5-5',
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: '{"minLength":"x"}' },
  ],
  usage: {
    input_tokens: 800,
    output_tokens: 100,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 100,
  },
};

afterEach(() => vi.unstubAllGlobals());

it('sends the Messages API a strict JSON schema and returns the one text answer', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(MESSAGE)));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    requestStructuredOutput(REQUEST, { ...OPTIONS, reasoningEffort: 'high' }),
  ).resolves.toMatchObject({
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    responseId: 'msg_test',
    content: '{"minLength":"x"}',
    usage: { inputTokens: 1000, cachedInputTokens: 100, cacheWriteInputTokens: 100 },
    budget: null,
  });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.anthropic.com/v1/messages');
  expect(init.headers).toMatchObject({
    'x-api-key': 'test-key',
    'anthropic-version': '2026-10-21',
  });
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({
    model: 'claude-sonnet-5-5',
    system: 'Return JSON.',
    max_tokens: MAX_OUTPUT_TOKENS,
    output_config: { effort: 'high', format: { type: 'json_schema' } },
  });
  // Unsupported constraints are dropped; a property with a keyword's name is kept.
  expect(body.output_config.format.schema.properties).toEqual({ minLength: { type: 'string' } });
  expect(body).not.toHaveProperty('temperature');
});

it('counts tokens, reserves the budget and records the Claude price of the answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-anthropic-'));
  try {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ input_tokens: 1000 })))
      .mockResolvedValueOnce(new Response(JSON.stringify(MESSAGE)));
    vi.stubGlobal('fetch', fetcher);
    const result = await requestStructuredOutput(REQUEST, {
      ...OPTIONS,
      budget: { directory, limitUsd: 1 },
    });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    // 800 × $2 + 100 × $0.20 + 100 × $2.50 + 100 × $10 per million tokens.
    expect(result.budget).toEqual({ costUsd: 0.00287, spentUsd: 0.00287, limitUsd: 1 });
    const ledger = JSON.parse(await readFile(join(directory, 'budget.json'), 'utf8'));
    expect(ledger).toMatchObject({ spentNano: 2_870_000, reservations: {} });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('retries 429 and 5xx answers, and names a refused key without retrying it', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    .mockResolvedValueOnce(new Response('', { status: 529, headers: { 'retry-after': '0' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify(MESSAGE)));
  vi.stubGlobal('fetch', fetcher);
  await expect(requestStructuredOutput(REQUEST, OPTIONS)).resolves.toMatchObject({
    responseId: 'msg_test',
  });
  expect(fetcher).toHaveBeenCalledTimes(3);

  const refused = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key test-key' },
        }),
        { status: 401 },
      ),
  );
  vi.stubGlobal('fetch', refused);
  const error = (await requestStructuredOutput(REQUEST, OPTIONS).catch((error) => error)) as Error;
  expect(error.message).toBe(
    'Anthropic message request failed with HTTP 401 (authentication_error). No retry was made.',
  );
  expect(error.message).not.toContain('test-key');
  expect(refused).toHaveBeenCalledTimes(1);
});

it('names a refusal and a response cut off at max_tokens as unusable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...MESSAGE, stop_reason: 'refusal' }))),
  );
  await expect(requestStructuredOutput(REQUEST, OPTIONS)).rejects.toThrow(
    'Anthropic response was refused.',
  );
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ...MESSAGE, stop_reason: 'max_tokens' }))),
  );
  await expect(requestStructuredOutput(REQUEST, OPTIONS)).rejects.toMatchObject({
    message: 'Anthropic response was incomplete or invalid (max_tokens).',
    incomplete: 'max_tokens',
  });
});

it('chooses Anthropic when configured or when its key is the only one', () => {
  expect(aiProvider({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' })).toBe('openai');
  expect(aiProvider({ ANTHROPIC_API_KEY: 'a' })).toBe('anthropic');
  expect(aiProvider({ REFIT_AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'o' })).toBe('anthropic');
  expect(() => aiProvider({ REFIT_AI_PROVIDER: 'gemini' })).toThrow('openai or anthropic');
  expect(assessmentConfiguration(true, { ANTHROPIC_API_KEY: 'a' })).toMatchObject({
    provider: 'anthropic',
    apiKey: 'a',
    model: 'claude-sonnet-5-5',
    escalation: { model: 'claude-opus-5-5', reasoningEffort: 'high' },
  });
  expect(
    assessmentConfiguration(true, {
      REFIT_AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'a',
      ANTHROPIC_MODEL: 'claude-opus-5-5',
      ANTHROPIC_ESCALATION_MODEL: 'claude-fable-5-1',
    }),
  ).toMatchObject({ model: 'claude-opus-5-5', escalation: { model: 'claude-fable-5-1' } });
  expect(() => assessmentConfiguration(true, { REFIT_AI_PROVIDER: 'anthropic' })).toThrow(
    'needs ANTHROPIC_API_KEY',
  );
  expect(supportedSchema({ items: { minItems: 1, type: 'string' } })).toEqual({
    items: { type: 'string' },
  });
});

it('says when token counting fails because the account has no credit, without the API message', async () => {
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
          },
        }),
        { status: 400 },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const directory = await mkdtemp(join(tmpdir(), 'refit-anthropic-'));
  try {
    await expect(
      requestStructuredOutput(REQUEST, { ...OPTIONS, budget: { directory, limitUsd: 1 } }),
    ).rejects.toThrow(
      'Anthropic token counting failed with HTTP 400 (invalid_request_error: the credit balance is too low); generation was not attempted.',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // Any other 400 names only its type.
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { type: 'invalid_request_error', message: 'evidence text' } }),
          { status: 400 },
        ),
      ),
  );
  await expect(requestStructuredOutput(REQUEST, OPTIONS)).rejects.toThrow(
    'Anthropic message request failed with HTTP 400 (invalid_request_error). No retry was made.',
  );
});
