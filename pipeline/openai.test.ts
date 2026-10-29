import { afterEach, expect, it, vi } from 'vitest';
import { MAX_OUTPUT_TOKENS, requestStructuredOutput } from './openai.ts';

const OPTIONS = { apiKey: 'test-key', model: 'configured-test-model' };
const REQUEST = { evidence: { files: [] }, instructions: 'Return JSON.', name: 'test', schema: {} };

afterEach(() => vi.unstubAllGlobals());

it('leaves room for reasoning tokens in the output limit', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'resp_test',
        model: OPTIONS.model,
        status: 'completed',
        output: [
          { type: 'reasoning' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] },
        ],
      }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(requestStructuredOutput(REQUEST, OPTIONS)).resolves.toMatchObject({
    content: '{}',
  });
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
  expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(25_000);
});

it('sends a reasoning effort only when the request names one', async () => {
  const reply = () =>
    new Response(
      JSON.stringify({
        id: 'resp_test',
        model: OPTIONS.model,
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] },
        ],
      }),
    );
  const fetcher = vi.fn().mockImplementation(async () => reply());
  vi.stubGlobal('fetch', fetcher);
  await requestStructuredOutput({ ...REQUEST, reasoningEffort: 'medium' }, OPTIONS);
  await requestStructuredOutput(REQUEST, OPTIONS);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).reasoning).toEqual({ effort: 'medium' });
  expect(JSON.parse(fetcher.mock.calls[1][1].body).reasoning).toBe(undefined);
});

it('names why a response is incomplete, such as running out of output tokens while reasoning', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_test',
          model: OPTIONS.model,
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'reasoning' }],
        }),
      ),
    ),
  );
  await expect(requestStructuredOutput(REQUEST, OPTIONS)).rejects.toThrow(
    'OpenAI response was incomplete or invalid (max_output_tokens).',
  );
});
