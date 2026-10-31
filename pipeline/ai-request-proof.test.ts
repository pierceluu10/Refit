import { expect, it } from 'vitest';
import { proveRequests, redact } from './ai-request-proof.ts';

it('sends nothing and names the missing key', async () => {
  let loaded = false;
  const proof = await proveRequests({
    provider: 'anthropic',
    calls: [{ call: 'messages.create' }],
    env: {},
    load: async () => {
      loaded = true;
      return {};
    },
  });
  expect(loaded).toBe(false);
  expect(proof.status).toBe('pending');
  expect(proof.reason).toContain('ANTHROPIC_API_KEY is not set');
});

it('parses text, stream, tool and JSON output from the installed SDK', async () => {
  const requests: Record<string, unknown>[] = [];
  class OpenAI {
    chat = {
      completions: {
        create: async (body: Record<string, unknown>) => {
          requests.push(body);
          if (body.stream)
            return (async function* () {
              yield { choices: [{ delta: { content: 'ok' } }] };
            })();
          if (body.tools)
            return {
              choices: [
                { message: { tool_calls: [{ function: { arguments: '{"word":"ok"}' } }] } },
              ],
            };
          if (body.response_format) return { choices: [{ message: { content: '{"word":"ok"}' } }] };
          return { choices: [{ message: { content: 'ok' } }] };
        },
      },
    };
  }
  const proof = await proveRequests({
    provider: 'openai',
    calls: [{ call: 'chat.completions.create', stream: true, tools: true, json: true }],
    env: { OPENAI_API_KEY: 'test-key' },
    load: async () => ({ OpenAI }),
  });
  expect(proof.status).toBe('accepted');
  expect(proof.calls[0].detail).toBe(
    'text parsed, stream parsed (1 chunks), tool call parsed, JSON parsed',
  );
  expect(requests).toHaveLength(4);
});

it('reports a rejected request without the key it was sent with', async () => {
  class OpenAI {
    embeddings = {
      create: async () => {
        throw Object.assign(new Error('Incorrect API key provided: sk-proj-abcd****wxyz.'), {
          status: 401,
        });
      },
    };
  }
  const proof = await proveRequests({
    provider: 'openai',
    calls: [{ call: 'embeddings.create' }, { call: 'images.generate' }],
    env: { OPENAI_API_KEY: 'test-key' },
    load: async () => ({ OpenAI }),
  });
  expect(proof.status).toBe('rejected');
  expect(proof.calls[0].detail).toBe('HTTP 401: Incorrect API key provided: [redacted]');
  expect(proof.calls[1]).toEqual(expect.objectContaining({ status: 'pending' }));
});

it('redacts key-shaped text', () => {
  expect(redact('key sk-ant-api03-xyz and AIzaSyA1234567 and api_key: hunter2')).toBe(
    'key [redacted] and [redacted] and api_key: [redacted]',
  );
});
