import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { RequestProof } from './ai-migrations.ts';
import { loadDeadlineRegistry, type DeadlineEntry } from './deadline-registry.ts';

// Request-level proof (b) and output-shape proof (c) for a migrated AI call: the smallest request
// of each migrated call shape, sent with the upgraded SDK and Refit's own test key. Keys come only
// from the environment (refit-bench repository secrets); a missing key marks the proof pending
// with its name, and no request is sent. Nothing here reads or sends repository code or data.

export type ProofProvider = 'openai' | 'anthropic' | 'gemini';

export const PROOF_KEYS: Record<ProofProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

// The model each probe uses unless the environment names another. OpenAI's is gpt-6.1-sol, the
// model Refit's AI work uses; an embeddings proof sends an embedding model (proofEmbeddingModel).
// Gemini's comes from the deadline registry (proofGeminiModel), since Google retires its cheap
// models often.
const PROOF_MODELS: Record<ProofProvider, { env: string; model?: string }> = {
  openai: { env: 'REFIT_PROOF_OPENAI_MODEL', model: 'gpt-6.1-sol' },
  anthropic: { env: 'REFIT_PROOF_ANTHROPIC_MODEL', model: 'claude-haiku-5-5' },
  gemini: { env: 'REFIT_PROOF_GEMINI_MODEL' },
};

// Embeddings need an embedding model; the proof's model is a chat model.
const OPENAI_EMBEDDING_ENV = 'REFIT_PROOF_OPENAI_EMBEDDING_MODEL';
const OPENAI_EMBEDDING = /^text-embedding-(\d+)-(small|large)$/;

// The OpenAI embedding model an embeddings proof sends: a text-embedding-N-small/large model OpenAI
// names as a replacement in the registry and that no registry entry retires, on any date. Small is
// preferred (the cheapest), then the newest generation.
export function proofEmbeddingModel(entries: DeadlineEntry[]) {
  const openai = entries.filter((entry) => entry.provider === 'openai' && entry.kind === 'model');
  const listed = new Set(openai.flatMap((entry) => entry.versions));
  const [best] = [...new Set(openai.map((entry) => entry.replacement ?? ''))]
    .map((model) => ({ model, match: OPENAI_EMBEDDING.exec(model) }))
    .filter((item) => item.match && !listed.has(item.model))
    .sort(
      (a, b) =>
        Number(b.match![2] === 'small') - Number(a.match![2] === 'small') ||
        Number(b.match![1]) - Number(a.match![1]),
    );
  return best?.model;
}

const GEMINI_TEXT = /^gemini-(\d+)(?:\.(\d+))?-flash(-lite)?$/;

// The Gemini model a proof sends: a plain flash text model Google names as a replacement in the
// registry and that no registry entry retires, on any date. Flash-lite is preferred, then the
// newest version.
export function proofGeminiModel(entries: DeadlineEntry[]) {
  const gemini = entries.filter((entry) => entry.provider === 'gemini' && entry.kind === 'model');
  const listed = new Set(gemini.flatMap((entry) => entry.versions));
  const [best] = [...new Set(gemini.map((entry) => entry.replacement ?? ''))]
    .map((model) => ({ model, match: GEMINI_TEXT.exec(model) }))
    .filter((item) => item.match && !listed.has(item.model))
    .sort(
      (a, b) =>
        Number(!!b.match![3]) - Number(!!a.match![3]) ||
        Number(b.match![1]) - Number(a.match![1]) ||
        Number(b.match![2] ?? 0) - Number(a.match![2] ?? 0),
    );
  return best?.model;
}

// What a migrated call's request uses, so the output shapes it parses are probed too.
export interface ProofCall {
  call: string;
  stream?: boolean;
  tools?: boolean;
  json?: boolean;
}

type Client = Record<string, unknown>;
type Probe = (
  client: Client,
  model: string,
  call: ProofCall,
  models: { embedding?: string },
) => Promise<string>;

const at = (client: Client, path: string) =>
  path
    .split('.')
    .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], client);

async function invoke(client: Client, path: string, body: unknown) {
  const parts = path.split('.');
  const owner = at(client, parts.slice(0, -1).join('.')) as Record<string, unknown>;
  const method = owner?.[parts.at(-1)!];
  if (typeof method !== 'function') throw new Error(`the SDK has no ${path}`);
  return (method as (body: unknown) => Promise<unknown>).call(owner, body);
}

// Provider errors can echo part of a key ("Incorrect API key provided: sk-...abcd") or name the
// project, organization or account behind it ("proj_...", "org-...", Google's "projects/123");
// refit-bench logs and artifacts are public, so all of these are removed before a message is kept.
export function redact(text: string) {
  return text
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_*.-]{2,}/g, '[redacted]')
    .replace(/\bsk-ant-[A-Za-z0-9_*.-]+/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_*-]{4,}/g, '[redacted]')
    .replace(/(api[_ -]?key[^:]*:\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(?:proj|org|user|acct)[_-][A-Za-z0-9]{6,}/g, '[redacted]')
    .replace(/\b(projects?|organizations?|accounts?)\/[^\s/'",;)]+/gi, '$1/[redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted]')
    .replace(/(project[_ ]?(?:id|number)\W{0,3})[\w-]+/gi, '$1[redacted]')
    .replace(/\b\d{9,}\b/g, '[redacted]');
}

// A probe that cannot send its request with the proof project's model stays pending, never failed.
class ProofPending extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const TOOL = {
  type: 'function',
  function: {
    name: 'record',
    description: 'Record a word.',
    parameters: {
      type: 'object',
      properties: { word: { type: 'string' } },
      required: ['word'],
      additionalProperties: false,
    },
  },
};

const OPENAI_PROBES: Record<string, Probe> = {
  'chat.completions.create': async (client, model, call) => {
    const messages = [{ role: 'user', content: 'Reply with the single word ok.' }];
    const done: string[] = [];
    const response = (await invoke(client, call.call, {
      model,
      messages,
      max_completion_tokens: 256,
    })) as { choices?: { message?: { content?: unknown } }[] };
    expect(typeof response.choices?.[0]?.message?.content === 'string', 'no message content');
    done.push('text parsed');
    if (call.stream) {
      const stream = (await invoke(client, call.call, {
        model,
        messages,
        max_completion_tokens: 256,
        stream: true,
      })) as AsyncIterable<{ choices?: { delta?: unknown }[] }>;
      let chunks = 0;
      for await (const chunk of stream) {
        expect(Array.isArray(chunk.choices), 'a stream chunk without choices');
        chunks++;
      }
      expect(chunks > 0, 'an empty stream');
      done.push(`stream parsed (${chunks} chunks)`);
    }
    if (call.tools) {
      // "Starting with GPT-5.4, Chat Completions does not support tool calling with
      // `reasoning_effort` values other than `none`" (docs/ai-docs/pages/openai-migrate-to-responses.md).
      // gpt-6.1-sol supports no `none`, so the request is sent as a migrated call sends it and a
      // refusal over reasoning_effort leaves the shape pending; no other effort is tried.
      let tooled: {
        choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
      };
      try {
        tooled = (await invoke(client, call.call, {
          model,
          messages: [{ role: 'user', content: 'Record the word ok.' }],
          tools: [TOOL],
          tool_choice: { type: 'function', function: { name: 'record' } },
          max_completion_tokens: 512,
        })) as typeof tooled;
      } catch (error) {
        if (
          (error as { status?: unknown }).status === 400 &&
          /reasoning_effort/.test(String((error as Error).message))
        )
          throw new ProofPending(
            `${model} rejects function tools on Chat Completions at its default reasoning_effort and supports no \`none\`, so Chat with tools cannot be proved on it; the tools shape is proved on Responses (HTTP 400: ${redact((error as Error).message).slice(0, 200)})`,
          );
        throw error;
      }
      const argumentsText = tooled.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
      expect(typeof argumentsText === 'string', 'no tool call');
      expect(typeof JSON.parse(argumentsText).word === 'string', 'tool arguments lack `word`');
      done.push('tool call parsed');
    }
    if (call.json) {
      const json = (await invoke(client, call.call, {
        model,
        messages: [{ role: 'user', content: 'Return {"word": "ok"} as JSON.' }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 512,
      })) as { choices?: { message?: { content?: string } }[] };
      JSON.parse(json.choices?.[0]?.message?.content ?? '');
      done.push('JSON parsed');
    }
    return done.join(', ');
  },
  // Tool and JSON shapes as the Responses migration guide writes them
  // (docs/ai-docs/pages/openai-migrate-to-responses.md).
  'responses.create': async (client, model, call) => {
    const done: string[] = [];
    const response = (await invoke(client, call.call, {
      model,
      input: 'Reply with the single word ok.',
      max_output_tokens: 256,
    })) as { output_text?: unknown };
    expect(typeof response.output_text === 'string', 'no output_text');
    done.push('text parsed');
    if (call.stream) {
      const stream = (await invoke(client, call.call, {
        model,
        input: 'Reply with the single word ok.',
        max_output_tokens: 256,
        stream: true,
      })) as AsyncIterable<{ type?: string }>;
      const types = new Set<string>();
      for await (const event of stream) types.add(String(event.type));
      expect(types.has('response.completed'), 'the stream did not end with response.completed');
      done.push('stream parsed');
    }
    if (call.tools) {
      const tooled = (await invoke(client, call.call, {
        model,
        input: 'Record the word ok.',
        tools: [{ type: 'function', ...TOOL.function, strict: true }],
        tool_choice: { type: 'function', name: 'record' },
        max_output_tokens: 512,
      })) as { output?: { type?: string; arguments?: string }[] };
      const argumentsText = tooled.output?.find((item) => item.type === 'function_call')?.arguments;
      expect(typeof argumentsText === 'string', 'no function_call');
      expect(typeof JSON.parse(argumentsText).word === 'string', 'tool arguments lack `word`');
      done.push('tool call parsed');
    }
    if (call.json) {
      const json = (await invoke(client, call.call, {
        model,
        input: 'Record the word ok.',
        text: {
          format: {
            type: 'json_schema',
            name: 'record',
            strict: true,
            schema: TOOL.function.parameters,
          },
        },
        max_output_tokens: 512,
      })) as { output_text?: string };
      expect(typeof JSON.parse(json.output_text ?? '').word === 'string', 'JSON lacks `word`');
      done.push('JSON parsed');
    }
    return done.join(', ');
  },
  'embeddings.create': async (client, _model, call, models) => {
    if (!models.embedding)
      throw new ProofPending(
        `The deadline registry names no current OpenAI embedding model and ${OPENAI_EMBEDDING_ENV} is not set; no embeddings request was sent.`,
      );
    const response = (await invoke(client, call.call, {
      model: models.embedding,
      input: 'ok',
    })) as { data?: { embedding?: unknown }[] };
    expect(Array.isArray(response.data?.[0]?.embedding), 'no embedding');
    return `embedding parsed (${models.embedding})`;
  },
  'moderations.create': async (client, _model, call) => {
    const response = (await invoke(client, call.call, { input: 'ok' })) as {
      results?: { flagged?: unknown }[];
    };
    expect(typeof response.results?.[0]?.flagged === 'boolean', 'no moderation result');
    return 'result parsed';
  },
  'models.list': async (client, _model, call) => {
    const page = (await invoke(client, call.call, undefined)) as { data?: unknown };
    expect(Array.isArray(page.data), 'no model list');
    return 'list parsed';
  },
  'models.retrieve': async (client, model, call) => {
    const parts = call.call.split('.');
    const owner = at(client, parts[0]) as { retrieve: (id: string) => Promise<{ id?: unknown }> };
    const response = await owner.retrieve(model);
    expect(response.id === model, 'a different model came back');
    return 'model parsed';
  },
};

const ANTHROPIC_PROBES: Record<string, Probe> = {
  'messages.create': async (client, model, call) => {
    const done: string[] = [];
    const response = (await invoke(client, call.call, {
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
    })) as { content?: { type?: string; text?: unknown }[] };
    expect(
      response.content?.some((block) => block.type === 'text' && typeof block.text === 'string'),
      'no text block',
    );
    done.push('text parsed');
    if (call.stream) {
      const stream = (await invoke(client, call.call, {
        model,
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
      })) as AsyncIterable<{ type?: string }>;
      const types = new Set<string>();
      for await (const event of stream) types.add(String(event.type));
      expect(types.has('message_stop'), 'the stream did not end with message_stop');
      done.push('stream parsed');
    }
    if (call.tools) {
      const tooled = (await invoke(client, call.call, {
        model,
        max_tokens: 256,
        tools: [
          {
            name: 'record',
            description: 'Record a word.',
            input_schema: TOOL.function.parameters,
          },
        ],
        tool_choice: { type: 'tool', name: 'record' },
        messages: [{ role: 'user', content: 'Record the word ok.' }],
      })) as { content?: { type?: string; input?: { word?: unknown } }[] };
      const use = tooled.content?.find((block) => block.type === 'tool_use');
      expect(typeof use?.input?.word === 'string', 'no tool_use input');
      done.push('tool call parsed');
    }
    return done.join(', ');
  },
  'models.list': async (client, _model, call) => {
    const page = (await invoke(client, call.call, undefined)) as { data?: unknown };
    expect(Array.isArray(page.data), 'no model list');
    return 'list parsed';
  },
};

const GEMINI_PROBES: Record<string, Probe> = {
  'models.generateContent': async (client, model, call) => {
    const response = (await invoke(client, call.call, {
      model,
      contents: 'Reply with the single word ok.',
    })) as { text?: unknown };
    expect(typeof response.text === 'string', 'no response.text');
    return 'text parsed';
  },
  'models.generateContentStream': async (client, model, call) => {
    const stream = (await invoke(client, call.call, {
      model,
      contents: 'Reply with the single word ok.',
    })) as AsyncIterable<{ text?: unknown }>;
    let chunks = 0;
    for await (const chunk of stream) {
      expect(chunk.text === undefined || typeof chunk.text === 'string', 'a chunk without text');
      chunks++;
    }
    expect(chunks > 0, 'an empty stream');
    return `stream parsed (${chunks} chunks)`;
  },
};

const PROBES: Record<ProofProvider, Record<string, Probe>> = {
  openai: OPENAI_PROBES,
  anthropic: ANTHROPIC_PROBES,
  gemini: GEMINI_PROBES,
};

// The SDK is loaded from `sdkDirectory` (a directory where only the target release is installed),
// so the proof exercises the release the patch moves to, not Refit's own dependencies.
export async function proveRequests(options: {
  provider: ProofProvider;
  calls: ProofCall[];
  sdkDirectory?: string;
  packageName?: string;
  env?: NodeJS.ProcessEnv;
  load?: (packageName: string) => Promise<unknown>;
  // The deadline registry's entries; read from data/deadlines.json when a Gemini proof needs them.
  models?: DeadlineEntry[];
}): Promise<RequestProof> {
  const env = options.env ?? process.env;
  const key = PROOF_KEYS[options.provider];
  const pending = (reason: string): RequestProof => ({
    status: 'pending',
    reason,
    calls: options.calls.map((call) => ({ call: call.call, status: 'pending', detail: reason })),
  });
  if (!options.calls.length) return pending('No migrated call has a request to prove.');
  if (!env[key]?.trim())
    return pending(
      `${key} is not set in this environment, so no request was sent to ${options.provider}. The proof runs only in refit-bench Actions with Refit's own test key.`,
    );
  const packageName =
    options.packageName ??
    { openai: 'openai', anthropic: '@anthropic-ai/sdk', gemini: '@google/genai' }[options.provider];
  const load =
    options.load ??
    ((name: string) =>
      // Resolved from the SDK directory the way Node resolves it there (the package's exports).
      import(
        options.sdkDirectory
          ? pathToFileURL(createRequire(join(options.sdkDirectory, 'package.json')).resolve(name))
              .href
          : name
      ));
  const module = (await load(packageName)) as Record<string, unknown>;
  const Constructor = (module.OpenAI ??
    module.Anthropic ??
    module.GoogleGenAI ??
    module.default) as new (options: Record<string, unknown>) => Client;
  // `apiKey` is passed from the environment variable; it is never logged.
  const client = new Constructor(
    options.provider === 'gemini'
      ? { apiKey: env[key] }
      : { apiKey: env[key], maxRetries: 1, timeout: 60_000 },
  );
  let registry = options.models;
  const entries = async () => (registry ??= (await loadDeadlineRegistry()).deadlines);
  const model =
    env[PROOF_MODELS[options.provider].env]?.trim() ||
    PROOF_MODELS[options.provider].model ||
    proofGeminiModel(await entries());
  // Only for the proof request: other models never write code (openai.ts checkAiModel).
  const models = {
    embedding:
      options.provider === 'openai' &&
      options.calls.some((call) => call.call === 'embeddings.create')
        ? env[OPENAI_EMBEDDING_ENV]?.trim() || proofEmbeddingModel(await entries())
        : undefined,
  };
  if (!model)
    return pending(
      'The deadline registry names no current Gemini flash model to send the proof with.',
    );
  const calls: RequestProof['calls'] = [];
  for (const call of options.calls) {
    const probe = PROBES[options.provider][call.call];
    if (!probe) {
      calls.push({
        call: call.call,
        status: 'pending',
        detail: 'Refit has no minimal request for this call yet.',
      });
      continue;
    }
    try {
      calls.push({
        call: call.call,
        status: 'accepted',
        detail: await probe(client, model, call, models),
      });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (error instanceof ProofPending) {
        calls.push({ call: call.call, status: 'pending', detail: error.message });
        continue;
      }
      // The proof keys belong to Refit's own restricted projects, so a 403 means the project has
      // not enabled the model or endpoint, not that the call shape is wrong.
      if (status === 403) {
        const message = error instanceof Error ? redact(error.message).slice(0, 240) : '';
        calls.push({
          call: call.call,
          status: 'pending',
          detail: `${error instanceof Error && /\bmodel/i.test(error.message) ? 'model' : 'request'} not enabled for Refit's project (HTTP 403${message ? `: ${message}` : ''})`,
        });
        continue;
      }
      calls.push({
        call: call.call,
        status: 'rejected',
        detail: `${typeof status === 'number' ? `HTTP ${status}: ` : ''}${error instanceof Error ? redact(error.message).slice(0, 300) : 'failed'}`,
      });
    }
  }
  const rejected = calls.filter((call) => call.status === 'rejected');
  const unproved = calls.filter((call) => call.status === 'pending');
  return {
    status: rejected.length ? 'rejected' : unproved.length ? 'pending' : 'accepted',
    reason: rejected.length
      ? rejected.map((call) => `${call.call}: ${call.detail}`).join('; ')
      : unproved.length
        ? unproved.map((call) => `${call.call}: ${call.detail}`).join('; ')
        : `Accepted with ${model}.`,
    calls,
  };
}
