import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATION_KINDS,
  clearFetchCache,
  loadPlaybookMeta,
  type FetchLike,
} from '../toolkit/index.ts';
import { createToolPack, resetOpenAiCache } from './tools.ts';

const ctx = { repoDir: '.' };
const offline = createToolPack({
  fetch: null,
  specCacheDir: mkdtempSync(join(tmpdir(), 'oai-test-')),
});
const tool = (name: string, pack = offline) => {
  const found = pack.tools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

beforeEach(() => {
  clearFetchCache();
  resetOpenAiCache();
});

describe('toolpack shape', () => {
  it('has the expected tools with valid names', () => {
    const names = offline.tools.map((t) => t.name);
    expect(names).toEqual([
      'openai_model_lookup',
      'openai_check_request',
      'openai_sdk_migration',
      'openai_search_docs',
    ]);
    for (const name of names) expect(name).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(offline.provider).toBe('openai');
  });

  it('has a playbook for every migration kind with front matter', () => {
    for (const kind of MIGRATION_KINDS) expect(offline.playbooks[kind]).toBeTruthy();
    const meta = loadPlaybookMeta(new URL('./playbooks/', import.meta.url));
    for (const kind of MIGRATION_KINDS) {
      expect(meta[kind].provider).toBe('openai');
      expect(meta[kind].kind).toBe(kind);
      expect(meta[kind].reviewed).toBe('false');
    }
  });

  it('ships dated snapshots with sources', () => {
    for (const file of [
      'deprecations.json',
      'models.json',
      'params.json',
      'request-notes.json',
      'sdk-migration.json',
    ]) {
      const json = JSON.parse(
        readFileSync(new URL(`./tools-data/${file}`, import.meta.url), 'utf8'),
      ) as { source: unknown; retrieved: string };
      expect(json.source).toBeTruthy();
      expect(json.retrieved).toBe('2026-11-01');
    }
    const index = JSON.parse(
      readFileSync(new URL('./tools-data/docs-index.json', import.meta.url), 'utf8'),
    ) as { provider: string; pages: unknown[] };
    expect(index.provider).toBe('openai');
    expect(index.pages.length).toBeGreaterThanOrEqual(15);
  });
});

describe('openai_model_lookup', () => {
  const lookup = (input: Record<string, unknown>) =>
    tool('openai_model_lookup').run({ now: '2026-11-01', ...input }, ctx);

  it('reports a shut-down legacy model with its replacement', async () => {
    const out = await lookup({ model: 'text-davinci-003' });
    expect(out).toContain('shut down (since 2024-01-04)');
    expect(out).toContain('gpt-3.5-turbo-instruct');
    expect(out).toContain('developers.openai.com/api/docs/deprecations#2023-07-06');
  });

  it('follows a replacement that was itself shut down to one that still runs', async () => {
    const out = await lookup({ model: 'text-davinci-003' });
    expect(out).toContain(
      'gpt-3.5-turbo-instruct was itself shut down on 2026-09-28; its recommended replacement is gpt-5.6-terra',
    );
    const before = await lookup({ model: 'text-davinci-003', now: '2026-09-01' });
    expect(before).not.toContain('was itself shut down');
  });

  it('uses the firmest, latest entry when a model was announced twice', async () => {
    const out = await lookup({ model: 'gpt-4-0314' });
    expect(out).toContain('Shutdown date: 2026-03-26');
    expect(out).toContain('Earlier entry');
  });

  it('computes deprecated vs shut down from now', async () => {
    const before = await lookup({ model: 'gpt-4o-2024-08-06', now: '2026-11-01' });
    expect(before).toContain('deprecated, shutdown scheduled 2027-01-14');
    expect(before).toContain('gpt-6-luna');
    const after = await lookup({ model: 'gpt-4o-2024-08-06', now: '2027-02-01' });
    expect(after).toContain('shut down (since 2027-01-14)');
  });

  it('follows an alias to its snapshot', async () => {
    const out = await lookup({ model: 'gpt-4o' });
    expect(out).toContain('alias');
    expect(out).toContain('gpt-4o-2024-08-06');
    expect(out).toContain('v1/chat/completions');
  });

  it('handles vision preview, o1-preview, gpt-4.5-preview, dall-e-2 and whisper-1', async () => {
    expect(await lookup({ model: 'gpt-4-vision-preview' })).toContain('2024-12-06');
    expect(await lookup({ model: 'o1-preview' })).toContain('2025-07-28');
    expect(await lookup({ model: 'gpt-4.5-preview' })).toContain('gpt-4.1');
    expect(await lookup({ model: 'dall-e-2' })).toContain('2026-05-12');
    const whisper = await lookup({ model: 'whisper-1' });
    expect(whisper).toContain('2027-02-26');
    expect(whisper).toContain('gpt-transcribe');
  });

  it('reports a catalog model with no deprecation as active', async () => {
    const out = await lookup({ model: 'text-embedding-ada-002' });
    expect(out).toContain('active');
    expect(out).toContain('v1/embeddings');
  });

  it('handles fine-tuned ids and router prefixes', async () => {
    const out = await lookup({ model: 'ft:gpt-4o-mini-2024-07-18:acme::abc123' });
    expect(out).toContain('fine-tuned');
    expect(out).toContain('2027-01-14');
    expect(await lookup({ model: 'openai/gpt-3.5-turbo-0613' })).toContain('2024-09-13');
  });

  it('answers unknown ids with closest matches, never a refusal', async () => {
    const out = await lookup({ model: 'gpt-4o-2099-01-01' });
    expect(out).toContain('not in the snapshot');
    expect(out).toContain('gpt-4o');
    expect(out).toContain('check https://developers.openai.com/api/docs/deprecations');
  });

  it('accepts several models and a bare string', async () => {
    const out = await lookup({ models: ['gpt-3.5-turbo-0613', 'o1-mini'] });
    expect(out).toContain('## gpt-3.5-turbo-0613');
    expect(out).toContain('## o1-mini');
    expect(await tool('openai_model_lookup').run('davinci', ctx)).toContain('davinci-002');
    expect(await lookup({})).toContain('Pass "model"');
  });

  it('adds a live check from the deprecations page when online', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => '<p>2027-05-01 gpt-6-luna is deprecated, use gpt-7</p>',
    });
    const pack = createToolPack({ fetch });
    const out = await tool('openai_model_lookup', pack).run({ model: 'gpt-6-luna' }, ctx);
    expect(out).toContain('Live deprecations page (fetched now) mentions "gpt-6-luna"');
    const failing: FetchLike = async () => ({ ok: false, status: 503, text: async () => '' });
    clearFetchCache();
    const out2 = await tool('openai_model_lookup', createToolPack({ fetch: failing })).run(
      { model: 'gpt-6-luna' },
      ctx,
    );
    expect(out2).toContain('relying on the snapshot');
  });
});

describe('openai_check_request', () => {
  const check = (input: Record<string, unknown>) =>
    tool('openai_check_request').run({ now: '2026-11-01', ...input }, ctx);

  it('flags deprecated chat params and suggests replacements', async () => {
    const out = await check({
      endpoint: 'chat.completions',
      body: {
        model: 'gpt-4.1-mini',
        messages: [],
        functions: [],
        function_call: 'auto',
        max_tokens: 10,
        user: 'u1',
      },
    });
    expect(out).toContain('functions');
    expect(out).toContain('tools');
    expect(out).toContain('tool_choice');
    expect(out).toContain('max_completion_tokens');
    expect(out).toContain('safety_identifier');
    expect(out).toContain('If moving this call to Responses');
    expect(out).toContain('messages -> input');
  });

  it('suggests a name for unknown params and lists missing required ones', async () => {
    const out = await check({
      endpoint: '/v1/chat/completions',
      body: { model: 'gpt-6-luna', temprature: 1 },
    });
    expect(out).toContain('temprature');
    expect(out).toContain('did you mean temperature');
    expect(out).toContain('missing: messages');
  });

  it('notes sampling params on reasoning models', async () => {
    const out = await check({
      endpoint: 'responses',
      body: { model: 'gpt-6-astra', input: 'hi', temperature: 0.2, reasoning: { effort: 'none' } },
    });
    expect(out).toContain('does not support reasoning effort "none"');
    const mixed = await check({
      endpoint: 'responses',
      body: { model: 'gpt-6-luna', messages: [], response_format: {} },
    });
    expect(mixed).toContain('messages: a Chat Completions parameter');
    expect(mixed).toContain('text.format');
    const chat = await check({
      endpoint: 'chat.completions',
      body: { model: 'o3', messages: [], temperature: 0.2, max_tokens: 5 },
    });
    expect(chat).toContain('temperature is not supported');
    expect(chat).toContain('max_tokens is not compatible');
  });

  it('explains the Assistants sunset and resolves concrete thread paths', async () => {
    const out = await check({
      endpoint: 'POST https://api.openai.com/v1/threads/thread_abc/runs',
      body: { assistant_id: 'asst_1' },
    });
    expect(out).toContain('/threads/{thread_id}/runs');
    expect(out).toContain('2026-08-26');
    expect(out).toContain('Conversations');
    const assistants = await check({ endpoint: 'assistants', body: { model: 'gpt-4o' } });
    expect(assistants).toContain('shut down');
  });

  it('notes legacy completions and engines endpoints', async () => {
    const out = await check({
      endpoint: 'completions',
      body: { model: 'text-davinci-003', prompt: 'x' },
    });
    expect(out).toContain('legacy');
    expect(out).toContain('Model text-davinci-003: shut down');
    const engines = await check({ endpoint: '/v1/engines', body: {} });
    expect(engines).toContain('/v1/models');
  });

  it('covers embeddings, images and audio', async () => {
    expect(
      await check({
        endpoint: 'embeddings',
        body: { model: 'text-embedding-3-small', input: 'x' },
      }),
    ).toContain('Unknown parameters: none.');
    const images = await check({
      endpoint: 'images',
      body: { model: 'gpt-image-2', prompt: 'x', style: 'vivid' },
    });
    expect(images).toContain('style');
    const audio = await check({
      endpoint: 'audio.transcriptions',
      body: { model: 'whisper-1', file: 'f' },
    });
    expect(audio).toContain('2027-02-26');
  });

  it('answers unknown endpoints with suggestions', async () => {
    const out = await check({ endpoint: '/v1/chat/completion', body: {} });
    expect(out).toContain('not an endpoint in the snapshot');
    expect(out).toContain('/chat/completions');
    expect(await check({})).toContain('Pass "endpoint"');
  });

  it('uses a live spec when asked, caching it in the given dir', async () => {
    const spec = {
      paths: {
        '/embeddings': {
          post: {
            operationId: 'createEmbedding',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [{ $ref: '#/components/schemas/Base' }],
                    properties: { brand_new: { description: 'A new param. More text.' } },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Base: {
            required: ['model', 'input'],
            properties: {
              model: { description: 'Model.' },
              input: { description: 'Input.' },
              legacy: { deprecated: true, description: 'Old.' },
            },
          },
        },
      },
    };
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return { ok: true, status: 200, text: async () => JSON.stringify(spec) };
    };
    const dir = mkdtempSync(join(tmpdir(), 'oai-spec-'));
    const pack = createToolPack({ fetch, specCacheDir: dir });
    const out = await tool('openai_check_request', pack).run(
      {
        endpoint: 'embeddings',
        body: { model: 'm', input: 'x', brand_new: 1, legacy: 1 },
        live: true,
      },
      ctx,
    );
    expect(out).toContain('fetched now');
    expect(out).toContain('legacy: deprecated in spec');
    expect(out).not.toContain('brand_new: not a top-level');
    expect(calls).toBe(1);
    // Second call reads the cache file, even offline.
    const cached = await tool(
      'openai_check_request',
      createToolPack({ fetch: null, specCacheDir: dir }),
    ).run({ endpoint: 'embeddings', body: { model: 'm', input: 'x' }, live: true }, ctx);
    expect(cached).toContain('cached copy');
  });

  it('falls back to the snapshot when the live spec is unavailable', async () => {
    const pack = createToolPack({
      fetch: null,
      specCacheDir: mkdtempSync(join(tmpdir(), 'oai-empty-')),
    });
    const out = await tool('openai_check_request', pack).run(
      { endpoint: 'embeddings', body: { model: 'm', input: 'x' }, live: true },
      ctx,
    );
    expect(out).toContain('live spec unavailable');
  });
});

describe('openai_sdk_migration', () => {
  it('maps python v0 calls', async () => {
    const out = await tool('openai_sdk_migration').run(
      {
        code: 'import openai\nopenai.api_key = "x"\nr = openai.ChatCompletion.create(model="gpt-4")\nprint(r["choices"][0])\nopenai.Embedding.create(input="x")',
        sdk: 'python',
      },
      ctx,
    );
    expect(out).toContain('openai.ChatCompletion.create -> client.chat.completions.create');
    expect(out).toContain('openai.Embedding.create -> client.embeddings.create');
    expect(out).toContain('pydantic');
    expect(out).toContain('openai-python 3.0.0');
  });

  it('maps node v3 calls and v5 changes', async () => {
    const out = await tool('openai_sdk_migration').run(
      {
        code: 'const openai = new OpenAIApi(new Configuration({apiKey}));\nconst r = await openai.createChatCompletion({});\nr.data.choices;\nclient.files.del("f")',
        sdk: 'node',
      },
      ctx,
    );
    expect(out).toContain('createChatCompletion -> chat.completions.create');
    expect(out).toContain('OpenAIApi -> OpenAI');
    expect(out).toContain('del() methods were renamed');
    expect(out).toContain('openai-node 7.0.0');
  });

  it('reads a repo file and never claims the code is current', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oai-repo-'));
    writeFileSync(join(dir, 'a.py'), 'client = openai.Completion.create(model="x")');
    const out = await tool('openai_sdk_migration').run({ path: 'a.py' }, { repoDir: dir });
    expect(out).toContain('openai.Completion.create -> client.completions.create');
    const clean = await tool('openai_sdk_migration').run(
      { code: 'client.responses.create()' },
      ctx,
    );
    expect(clean).toContain('not proof');
    const missing = await tool('openai_sdk_migration').run(
      { path: '../../etc/passwd' },
      { repoDir: dir },
    );
    expect(missing).toContain('Could not read');
  });
});

describe('openai_search_docs', () => {
  it('finds snapshot passages offline', async () => {
    const out = await tool('openai_search_docs').run(
      { query: 'assistants sunset conversations' },
      ctx,
    );
    expect(out).toContain('Assistants');
    expect(out).toContain('(snapshot)');
  });

  it('ranks webhook signature docs and uses live text with a stub fetch', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '<p>webhook-signature header verification with unwrap and the signing secret</p>',
    });
    const pack = createToolPack({ fetch });
    const out = await tool('openai_search_docs', pack).run(
      { query: 'webhook signature verification' },
      ctx,
    );
    expect(out).toContain('webhook');
    expect(out).toContain('(live)');
  });
});
