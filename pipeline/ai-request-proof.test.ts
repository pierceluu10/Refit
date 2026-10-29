import { expect, it } from 'vitest';
import { proofGeminiModel, proveRequests, redact } from './ai-request-proof.ts';
import type { DeadlineEntry } from './deadline-registry.ts';

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
    moderations = {
      create: async () => {
        throw Object.assign(new Error('Incorrect API key provided: sk-proj-abcd****wxyz.'), {
          status: 401,
        });
      },
    };
  }
  const proof = await proveRequests({
    provider: 'openai',
    calls: [{ call: 'moderations.create' }, { call: 'images.generate' }],
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

it('redacts provider project, organization and account IDs', () => {
  expect(
    redact(
      'Project `proj_AbC123xYz789` in organization org-Q1w2E3r4T5y6 lacks access; user user-Zz9Yy8Xx7',
    ),
  ).toBe('Project `[redacted]` in organization [redacted] lacks access; user [redacted]');
  expect(
    redact(
      'Generative Language API has not been used in project 123456789012 (consumer projects/123456789012, organizations/acme-co, accounts/42ab)',
    ),
  ).toBe(
    'Generative Language API has not been used in project [redacted] (consumer projects/[redacted], organizations/[redacted], accounts/[redacted])',
  );
  expect(redact('organization 6c7a2b1e-1f2a-4b3c-9d8e-0a1b2c3d4e5f; project_id: my-proj')).toBe(
    'organization [redacted]; project_id: [redacted]',
  );
  // Keys are still caught first, whole.
  expect(redact('Incorrect API key provided: sk-proj-AbCdEfGh12345678')).toBe(
    'Incorrect API key provided: [redacted]',
  );
});

it('reads a 403 for a model outside the project as pending, without its project ID', async () => {
  const sent: unknown[] = [];
  class OpenAI {
    responses = {
      create: async (body: { model: string }) => {
        sent.push(body.model);
        throw Object.assign(
          new Error('Project `proj_AbC123xYz789` does not have access to model `gpt-6.1-sol`'),
          { status: 403 },
        );
      },
    };
  }
  const proof = await proveRequests({
    provider: 'openai',
    calls: [{ call: 'responses.create' }],
    env: { OPENAI_API_KEY: 'test-key' },
    load: async () => ({ OpenAI }),
  });
  expect(proof.status).toBe('pending');
  expect(proof.reason).not.toContain('proj_');
  expect(proof.calls[0]).toEqual({
    call: 'responses.create',
    status: 'pending',
    detail:
      "model not enabled for Refit's project (HTTP 403: Project `[redacted]` does not have access to model `gpt-6.1-sol`)",
  });
  // No other model is tried.
  expect(sent).toEqual(['gpt-6.1-sol']);
});

it('keeps a 403 that is not about the model a rejection', async () => {
  class OpenAI {
    responses = {
      create: async () => {
        throw Object.assign(new Error('Country, region, or territory not supported'), {
          status: 403,
        });
      },
    };
  }
  const proof = await proveRequests({
    provider: 'openai',
    calls: [{ call: 'responses.create' }],
    env: { OPENAI_API_KEY: 'test-key' },
    load: async () => ({ OpenAI }),
  });
  expect(proof.status).toBe('rejected');
});

it('sends OpenAI proofs with gpt-6.1-sol unless the environment names a model', async () => {
  const sent: unknown[] = [];
  let embedded = false;
  class OpenAI {
    responses = {
      create: async (body: { model: string }) => {
        sent.push(body.model);
        return { output_text: 'ok' };
      },
    };
    chat = {
      completions: {
        create: async (body: { model: string }) => {
          sent.push(body.model);
          return { choices: [{ message: { content: 'ok' } }] };
        },
      },
    };
    embeddings = {
      create: async () => {
        embedded = true;
        return { data: [{ embedding: [0] }] };
      },
    };
  }
  const prove = (env: NodeJS.ProcessEnv) =>
    proveRequests({
      provider: 'openai',
      calls: [
        { call: 'responses.create' },
        { call: 'chat.completions.create' },
        { call: 'embeddings.create' },
      ],
      env: { OPENAI_API_KEY: 'test-key', ...env },
      load: async () => ({ OpenAI }),
    });
  const proof = await prove({});
  await prove({ REFIT_PROOF_OPENAI_MODEL: 'gpt-7-sol' });
  expect(sent).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-7-sol', 'gpt-7-sol']);
  // Embeddings stay pending: no request, and no embedding model is tried.
  expect(embedded).toBe(false);
  expect(proof.status).toBe('pending');
  expect(proof.calls[2]).toEqual({
    call: 'embeddings.create',
    status: 'pending',
    detail:
      'project allows only gpt-6.1-sol, which is not an embedding model; no embeddings request was sent.',
  });
  expect(proof.reason).toContain('embeddings.create: project allows only gpt-6.1-sol');
});

const gemini = (versions: string[], replacement: string | null, date = '2026-01-01') =>
  ({
    id: `gemini-${versions[0]}`,
    provider: 'gemini',
    kind: 'model',
    versions,
    date,
    summary: 'shut down',
    replacement,
    source: 'https://ai.google.dev/gemini-api/docs/deprecations',
    checkedAt: '2026-10-29',
  }) as DeadlineEntry;

it('takes the Gemini proof model from the registry, never a retired or retiring one', () => {
  expect(
    proofGeminiModel([
      gemini(['gemini-2.5-flash-lite'], 'gemini-3.1-flash-lite'),
      gemini(['gemini-3.1-flash-lite'], 'gemini-3.5-flash-lite', '2027-03-01'),
      gemini(['gemini-2.0-flash'], 'gemini-3.6-flash'),
      gemini(['gemini-1.5-pro'], 'gemini-3.1-pro-preview'),
      gemini(['veo-3.0-generate-001'], 'gemini-omni-1.1-flash'),
    ]),
  ).toBe('gemini-3.5-flash-lite');
  expect(proofGeminiModel([gemini(['gemini-2.0-flash'], 'gemini-3.6-flash')])).toBe(
    'gemini-3.6-flash',
  );
  expect(proofGeminiModel([gemini(['gemini-1.5-pro'], null)])).toBeUndefined();
});

it('sends the registry Gemini model unless the environment names one', async () => {
  const models: unknown[] = [];
  class GoogleGenAI {
    models = {
      generateContent: async (body: { model: string }) => {
        models.push(body.model);
        return { text: 'ok' };
      },
    };
  }
  const prove = (env: NodeJS.ProcessEnv) =>
    proveRequests({
      provider: 'gemini',
      calls: [{ call: 'models.generateContent' }],
      env: { GEMINI_API_KEY: 'test-key', ...env },
      load: async () => ({ GoogleGenAI }),
      models: [gemini(['gemini-2.0-flash'], 'gemini-3.6-flash')],
    });
  expect((await prove({})).reason).toBe('Accepted with gemini-3.6-flash.');
  await prove({ REFIT_PROOF_GEMINI_MODEL: 'gemini-9-flash' });
  expect(models).toEqual(['gemini-3.6-flash', 'gemini-9-flash']);
  const none = await proveRequests({
    provider: 'gemini',
    calls: [{ call: 'models.generateContent' }],
    env: { GEMINI_API_KEY: 'test-key' },
    load: async () => ({ GoogleGenAI }),
    models: [],
  });
  expect(none.status).toBe('pending');
  expect(none.reason).toContain('names no current Gemini flash model');
});

it('proves Gemini generateContent and its stream with @google/genai', async () => {
  const seen: unknown[] = [];
  class GoogleGenAI {
    constructor(options: unknown) {
      seen.push(options);
    }
    models = {
      generateContent: async () => ({ text: 'ok' }),
      generateContentStream: async () =>
        (async function* () {
          yield { text: 'o' };
          yield { text: 'k' };
        })(),
    };
  }
  const proof = await proveRequests({
    provider: 'gemini',
    calls: [
      { call: 'models.generateContent' },
      { call: 'models.generateContentStream', stream: true },
    ],
    env: { GEMINI_API_KEY: 'test-key' },
    load: async () => ({ GoogleGenAI }),
  });
  expect(proof.status).toBe('accepted');
  expect(proof.calls.map((call) => call.detail)).toEqual([
    'text parsed',
    'stream parsed (2 chunks)',
  ]);
  expect(seen).toEqual([{ apiKey: 'test-key' }]);
  // The shipped registry gives a model it does not retire.
  expect(proof.reason).toMatch(/^Accepted with gemini-[\d.]+-flash(-lite)?\.$/);
  expect(proof.reason).not.toContain('gemini-2.5-flash-lite');
});
