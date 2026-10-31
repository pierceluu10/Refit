import { afterEach, expect, it, vi } from 'vitest';
import { assessmentConfiguration } from './assessment.ts';
import { checkAiModel, MAX_OUTPUT_TOKENS, requestStructuredOutput } from './openai.ts';

const OPTIONS = { apiKey: 'test-key', model: 'gpt-6.1-sol' };
const REQUEST = { evidence: { files: [] }, instructions: 'Return JSON.', name: 'test', schema: {} };

afterEach(() => vi.unstubAllGlobals());

it('leaves room for reasoning tokens in the output limit', async () => {
  const fetcher = vi.fn().mockImplementation(
    async () =>
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
  // Without a configured effort the model's default applies.
  expect(body).not.toHaveProperty('reasoning');
  await requestStructuredOutput(REQUEST, { ...OPTIONS, reasoningEffort: 'xhigh' });
  expect(JSON.parse(fetcher.mock.calls[1][1].body).reasoning).toEqual({ effort: 'xhigh' });
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

it('answers after a rate limit once OpenAI accepts the retried request', async () => {
  const completed = {
    id: 'resp_test',
    model: OPTIONS.model,
    status: 'completed',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] },
    ],
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify(completed)));
  vi.stubGlobal('fetch', fetcher);
  await expect(requestStructuredOutput(REQUEST, OPTIONS)).resolves.toMatchObject({ content: '{}' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('names an exhausted quota and does not retry it', async () => {
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'secret detail',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
        { status: 429, headers: { 'retry-after': '0' } },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const error = await requestStructuredOutput(REQUEST, OPTIONS).catch((caught: Error) => caught);
  expect(String(error)).toContain('HTTP 429 (insufficient_quota). No retry was made.');
  expect(String(error)).not.toContain('secret detail');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('runs AI work only on gpt-6.1-sol unless an override names the model', async () => {
  expect(checkAiModel('gpt-6.1-sol', {})).toBe('gpt-6.1-sol');
  expect(() => checkAiModel('gpt-5.6-luna', {})).toThrow(
    "The AI model is gpt-5.6-luna; Refit's AI work runs only on gpt-6.1-sol. Set OPENAI_MODEL=gpt-6.1-sol, or REFIT_AI_MODEL_OVERRIDE=gpt-5.6-luna to use gpt-5.6-luna on purpose.",
  );
  expect(checkAiModel('gpt-5.6-luna', { REFIT_AI_MODEL_OVERRIDE: 'gpt-5.6-luna' })).toBe(
    'gpt-5.6-luna',
  );
  // A misconfigured override fails, even for gpt-6.1-sol.
  expect(() => checkAiModel('gpt-6.1-sol', { REFIT_AI_MODEL_OVERRIDE: 'gpt-5.6-luna' })).toThrow(
    'REFIT_AI_MODEL_OVERRIDE is gpt-5.6-luna but the AI model is gpt-6.1-sol; they must name the same model.',
  );
  // The request path refuses before anything is sent.
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    requestStructuredOutput(
      { evidence: {}, instructions: 'x', name: 'x', schema: {} },
      { apiKey: 'test-key', model: 'gpt-5.6-luna' },
    ),
  ).rejects.toThrow("Refit's AI work runs only on gpt-6.1-sol");
  expect(fetch).not.toHaveBeenCalled();
});

it('refuses an AI configuration on another model before any work starts', () => {
  expect(() =>
    assessmentConfiguration(true, { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-5.4-mini' }),
  ).toThrow("Refit's AI work runs only on gpt-6.1-sol");
  expect(
    assessmentConfiguration(true, { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-6.1-sol' })?.model,
  ).toBe('gpt-6.1-sol');
});
