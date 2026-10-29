import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAiRuleTables } from './ai-rules.ts';
import {
  proposeAnthropicSdkMajor,
  proposeGeminiSdkSwap,
  proposeOpenAiSdkMajor,
} from './ai-sdk-majors.ts';
import { applySourceEdits } from './patches.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function lockfile(version: string) {
  return JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', dependencies: { openai: `^${version}` } },
      'node_modules/openai': {
        version,
        resolved: `https://registry.npmjs.org/openai/-/openai-${version}.tgz`,
      },
    },
  });
}

async function repository(version: string, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-sdk-majors-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'app', dependencies: { openai: `^${version}` } }),
    'package-lock.json': lockfile(version),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

async function propose(version: string, files: Record<string, string>) {
  const proposal = await proposeOpenAiSdkMajor(
    await repository(version, files),
    await loadAiRuleTables(),
  );
  const changed = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      applySourceEdits(
        content,
        (proposal?.edits ?? []).filter((edit) => edit.file === path),
      ),
    ]),
  );
  return { proposal: proposal!, changed };
}

describe('openai v3 to 6', () => {
  it('rewrites the documented client, method and response shapes', async () => {
    const { proposal, changed } = await propose('3.3.0', {
      'src/ai.ts': `import { Configuration, OpenAIApi } from 'openai';

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

export async function ask(prompt: string) {
  const completion = await openai.createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });
  return completion.data.choices[0].message?.content;
}

export async function embed(input: string) {
  const { data } = await openai.createEmbedding({ model: 'text-embedding-3-small', input });
  return data.data[0].embedding;
}

export async function moderate(input: string) {
  return (await openai.createModeration({ input })).data.results[0].flagged;
}
`,
    });
    expect(proposal.stops).toEqual([]);
    expect(proposal.major).toBe(3);
    expect(changed['src/ai.ts']).toBe(`import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function ask(prompt: string) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });
  return completion.choices[0].message?.content;
}

export async function embed(input: string) {
  const data = await openai.embeddings.create({ model: 'text-embedding-3-small', input });
  return data.data[0].embedding;
}

export async function moderate(input: string) {
  return (await openai.moderations.create({ input })).results[0].flagged;
}
`);
    expect(proposal.rules.map((rule) => rule.rule)).toContain('openai-node-v4-response-data');
  });

  it('follows an exported client into another file and maps createTranscription', async () => {
    const { proposal, changed } = await propose('3.2.1', {
      'lib/openai.js': `const { Configuration, OpenAIApi } = require('openai');
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.KEY }));
module.exports = { openai };
`,
      'routes/audio.js': `const fs = require('fs');
const { openai } = require('../lib/openai');

async function transcribe(path) {
  const response = await openai.createTranscription(fs.createReadStream(path), 'whisper-1');
  return response.data.text;
}
module.exports = { transcribe };
`,
    });
    expect(proposal.stops).toEqual([]);
    expect(changed['lib/openai.js']).toBe(`const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.KEY });
module.exports = { openai };
`);
    expect(changed['routes/audio.js']).toContain(
      `await openai.audio.transcriptions.create({ file: fs.createReadStream(path), model: 'whisper-1' });`,
    );
    expect(changed['routes/audio.js']).toContain('return response.text;');
  });

  it('stops where the guide gives no mapping, and never edits those sites', async () => {
    const source = `import { Configuration, OpenAIApi, ChatCompletionRequestMessage } from 'openai';
const openai = new OpenAIApi(new Configuration({ apiKey: 'k', basePath: 'https://proxy' }));
export async function run(messages: ChatCompletionRequestMessage[]) {
  const response = await openai.createChatCompletion({ model: 'gpt-4o', messages }, { responseType: 'stream' });
  try {
    const edit = await openai.createEdit({ model: 'x', input: 'a', instruction: 'b' });
    return [response, edit.headers];
  } catch (error: any) {
    return error.response.status;
  }
}
export const other = (client: any) => client.createCompletion({ model: 'x' });
`;
    const { proposal, changed } = await propose('3.3.0', { 'src/run.ts': source });
    const reasons = proposal.stops.map((item) => item.rule);
    // Each of these leaves v3 code that breaks on 6, so none may ship as a partial upgrade.
    expect(proposal.stops.every((item) => item.blocking)).toBe(true);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'openai-node-v4-types',
        'openai-node-v4-client',
        'openai-node-v4-request-options',
        'openai-node-v4-create-edit',
        'openai-node-v4-errors',
        'openai-node-untraced-v3-call',
      ]),
    );
    expect(changed['src/run.ts']).not.toContain('chat.completions.create');
    expect(changed['src/run.ts']).not.toContain('edits.create');
  });

  it('stops when the result is used whole', async () => {
    const { proposal } = await propose('3.3.0', {
      'a.ts': `import { Configuration, OpenAIApi } from 'openai';
const configuration = new Configuration({ apiKey: process.env.K });
const openai = new OpenAIApi(configuration);
export async function f() {
  const response = await openai.createCompletion({ model: 'gpt-3.5-turbo-instruct', prompt: 'x' });
  console.log(response.status);
  return response.data.choices[0].text;
}
`,
    });
    expect(proposal.stops).toEqual([
      expect.objectContaining({ rule: 'openai-node-v4-response-data', line: 5 }),
    ]);
  });

  it('re-indents the merged options and keeps guarded error reads advisory', async () => {
    const { proposal, changed } = await propose('3.3.0', {
      'bot.js': `const { Configuration, OpenAIApi } = require('openai');
const api = new OpenAIApi(
  new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
  })
);
async function reply(text) {
  try {
    const completion = await api.createChatCompletion({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: text }] });
    return completion.data.choices[0].message.content;
  } catch (error) {
    if (error.response) console.log(error.response.status);
    else console.log(error.message);
  }
}
module.exports = { reply };
`,
    });
    expect(changed['bot.js']).toContain(`const api = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});`);
    expect(proposal.stops).toEqual([
      expect.objectContaining({ rule: 'openai-node-v4-errors', blocking: false, line: 12 }),
    ]);
  });

  it('blocks on an unguarded error read', async () => {
    const { proposal } = await propose('3.3.0', {
      'a.js': `const { Configuration, OpenAIApi } = require('openai');
const api = new OpenAIApi(new Configuration({ apiKey: 'k' }));
async function f() {
  try {
    await api.createModeration({ input: 'x' });
  } catch (e) {
    return e.response.status;
  }
}
module.exports = { f };
`,
    });
    expect(proposal.stops).toEqual([
      expect.objectContaining({ rule: 'openai-node-v4-errors', blocking: true }),
    ]);
  });

  it('proposes nothing for a project already on 6', async () => {
    const proposal = await proposeOpenAiSdkMajor(
      await repository('6.2.0', { 'a.ts': "import OpenAI from 'openai';\n" }),
      await loadAiRuleTables(),
    );
    expect(proposal).toBeNull();
  });
});

describe('openai v4 to 6', () => {
  it('renames v5 methods and namespaces on traced clients and import paths', async () => {
    const { proposal, changed } = await propose('4.67.0', {
      'src/files.ts': `import OpenAI from 'openai';
import type { ParsedChatCompletion } from 'openai/resources/beta/chat/completions';
const client = new OpenAI();
export async function clean(id: string) {
  await client.files.del(id);
  const parsed: ParsedChatCompletion<null> = await client.beta.chat.completions.parse({ model: 'gpt-4o', messages: [] });
  return client.chat.completions
    .runTools({ model: 'gpt-4o', messages: [], tools: [] })
    .on('functionCall', (call) => console.log(call));
}
`,
    });
    expect(proposal.stops).toEqual([]);
    expect(changed['src/files.ts']).toContain('await client.files.delete(id);');
    expect(changed['src/files.ts']).toContain('await client.chat.completions.parse(');
    expect(changed['src/files.ts']).toContain("from 'openai/resources/chat/completions'");
    expect(changed['src/files.ts']).toContain(".on('functionToolCall'");
  });

  it('stops on a renamed call that also moved to named path parameters', async () => {
    const { proposal } = await propose('4.104.0', {
      'v.ts': `import OpenAI from 'openai';
const openai = new OpenAI();
export const drop = (store: string, file: string) => openai.vectorStores.files.del(store, file);
`,
    });
    expect(proposal.stops).toEqual([
      expect.objectContaining({
        rule: 'openai-node-v5-named-path-params',
        line: 3,
        blocking: true,
      }),
    ]);
  });

  it('blocks a v4 call the 6.x release no longer has', async () => {
    const { proposal } = await propose('4.40.0', {
      'v.ts': `import OpenAI from 'openai';\nconst openai = new OpenAI();\nexport const make = () => openai.beta.vectorStores.create({ name: 'x' });\n`,
    });
    expect(proposal.stops).toEqual([
      expect.objectContaining({ rule: 'sdk-surface', line: 3, blocking: true }),
    ]);
  });

  it('stops on withResponse only where the Web response is read', async () => {
    const { proposal } = await propose('4.67.0', {
      'w.ts': `import OpenAI from 'openai';
const client = new OpenAI();
export async function a() {
  const { data } = await client.chat.completions.create({ model: 'm', messages: [] }).withResponse();
  return data.id;
}
export async function b() {
  const result = await client.chat.completions.create({ model: 'm', messages: [] }).withResponse();
  return result.data.id;
}
export async function c() {
  const { data, response } = await client.chat.completions.create({ model: 'm', messages: [] }).withResponse();
  return [data.id, response.headers.get('x-request-id')];
}
export const d = () => client.files.content('f').asResponse();
`,
    });
    expect(proposal.stops.map((item) => [item.rule, item.line])).toEqual([
      ['openai-node-v5-web-response', 12],
      ['openai-node-v5-web-response', 15],
    ]);
  });

  it('maps fileFromPath(path) to createReadStream from node:fs', async () => {
    const { proposal, changed } = await propose('4.40.0', {
      'up.ts': `import OpenAI, { fileFromPath } from 'openai';
const client = new OpenAI();
export const upload = async (p: string) => client.files.create({ file: await fileFromPath(p), purpose: 'assistants' });
export const other = async (p: string) => client.files.create({ file: await OpenAI.fileFromPath(p), purpose: 'batch' });
`,
      'up.js': `const { OpenAI, fileFromPath } = require('openai');
const client = new OpenAI();
module.exports = async (p) => client.files.create({ file: await fileFromPath(p, 'name.txt'), purpose: 'batch' });
`,
    });
    expect(changed['up.ts']).toBe(`import { createReadStream } from 'node:fs';
import OpenAI from 'openai';
const client = new OpenAI();
export const upload = async (p: string) => client.files.create({ file: await createReadStream(p), purpose: 'assistants' });
export const other = async (p: string) => client.files.create({ file: await createReadStream(p), purpose: 'batch' });
`);
    // A second argument (the file name) has no mapped form.
    expect(
      proposal.stops.filter((item) => item.file === 'up.js').map((item) => item.rule),
    ).toContain('openai-node-v5-file-from-path');
    expect(proposal.stops.some((item) => item.file === 'up.ts')).toBe(false);
  });

  it('stops on runFunctions, fileFromPath and httpAgent', async () => {
    const { proposal } = await propose('4.20.0', {
      'a.ts': `import OpenAI from 'openai';
import { Agent } from 'http';
const client = new OpenAI({ httpAgent: new Agent() });
export const file = OpenAI.fileFromPath('x', 'name');
export const run = () => client.beta.chat.completions.runFunctions({ model: 'x', messages: [], functions: [] });
`,
    });
    expect(proposal.stops.map((item) => item.rule).sort()).toEqual([
      'openai-node-v5-file-from-path',
      'openai-node-v5-http-agent',
      'openai-node-v5-run-functions',
    ]);
  });
});

describe('@anthropic-ai/sdk 0.x to 1', () => {
  async function anthropic(
    version: string,
    files: Record<string, string>,
    extra: Record<string, string> = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), 'refit-ai-sdk-majors-'));
    roots.push(root);
    for (const [name, content] of Object.entries({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { '@anthropic-ai/sdk': `^${version}`, ...extra },
      }),
      'package-lock.json': JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: { '': { name: 'app' }, 'node_modules/@anthropic-ai/sdk': { version } },
      }),
      ...files,
    })) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), content);
    }
    return (await proposeAnthropicSdkMajor(root, await loadAiRuleTables()))!;
  }

  it('needs no code edit for plain Messages calls and records their shapes', async () => {
    const proposal = await anthropic('0.79.0', {
      'src/llm.ts': `import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
export async function ask(text: string) {
  const response = await client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: text }] });
  return response.content;
}
export const stream = (text: string) => client.messages.stream({ model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: text }], tools: [] });
`,
    });
    expect(proposal.edits).toEqual([]);
    expect(proposal.stops).toEqual([]);
    expect(proposal.calls).toEqual([
      expect.objectContaining({ call: 'messages.create', tools: false }),
      expect.objectContaining({ call: 'messages.stream', tools: true }),
    ]);
  });

  it('moves models.list with betas to client.beta.models', async () => {
    const source = `import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
export const models = () => client.models.list({ betas: ['x'] });
export const plain = () => client.models.list();
`;
    const proposal = await anthropic('0.79.0', { 'm.ts': source });
    expect(applySourceEdits(source, proposal.edits)).toContain('client.beta.models.list({ betas');
    expect(applySourceEdits(source, proposal.edits)).toContain(
      'plain = () => client.models.list();',
    );
  });

  it('blocks on what 2026-10-21 or v1 rejects', async () => {
    const proposal = await anthropic(
      '0.40.0',
      {
        'a.ts': `import Anthropic, { HUMAN_PROMPT } from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: 'a', authToken: 'b' });
export const one = () => client.messages.create({ model: 'm', max_tokens: 1, temperature: 0, messages: [] });
export const two = (body: any) => client.messages.create(body);
export const three = () => client.completions.create({ model: 'm', prompt: HUMAN_PROMPT, max_tokens_to_sample: 1 });
export const four = () => client.messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'document', source: { type: 'text', data: 'x', media_type: 'text/plain' } }] }] });
export interface Stored extends Anthropic.MessageParam { id: string }
`,
        'b.js': `module.exports = (holder) => holder.client.messages.create({ model: 'm', max_tokens: 1, top_k: 5, messages: [] });\n`,
      },
      { '@anthropic-ai/vertex-sdk': '^0.14.0' },
    );
    // The literal temperature on a traced call is removed (non-blocking); the opaque body and the
    // untraced call with top_k still block.
    expect(
      [...new Set(proposal.stops.filter((item) => item.blocking).map((item) => item.rule))].sort(),
    ).toEqual([
      'anthropic-2026-10-21-assistant-documents',
      'anthropic-2026-10-21-sampling',
      'anthropic-ts-message-param-union',
      'anthropic-ts-one-credential',
      'anthropic-ts-text-completions-removed',
    ]);
    expect(proposal.stops.filter((item) => !item.blocking).map((item) => item.rule)).toEqual([
      'anthropic-2026-10-21-sampling-remove',
    ]);
    expect(proposal.stops.filter((item) => item.file === 'b.js')).toHaveLength(1);
  });

  it('reads conditional spreads of literals, and blocks calls the 1.x release does not have', async () => {
    const proposal = await anthropic('0.20.9', {
      'a.ts': `import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
export const ok = (beta: boolean) => client.beta.messages.create({ model: 'm', max_tokens: 1, messages: [], ...(beta ? { betas: ['x'] } : {}) });
export const hot = (beta: boolean) => client.messages.create({ model: 'm', max_tokens: 1, messages: [], ...(beta ? { temperature: 0 } : {}) });
export const old = () => client.beta.tools.messages.create({ model: 'm', max_tokens: 1, messages: [], tools: [] });
`,
    });
    expect(proposal.stops.map((item) => [item.line, item.rule])).toEqual([
      [4, 'anthropic-2026-10-21-sampling-remove'],
      [5, 'sdk-surface'],
    ]);
    expect(proposal.stops[1].reason).toContain('does not exist in @anthropic-ai/sdk 1.3.0');
  });

  it('removes literal sampling parameters with the upgrade, as the 2026-10-21 guide says', async () => {
    const source = `import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
export const ask = (t: number) =>
  client.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 100,
    temperature: t,
    top_k: 5,
    messages: [],
  });
export const inline = () => client.messages.create({ model: 'm', max_tokens: 1, top_p: 0.9, messages: [] });
export const last = () => client.messages.create({ model: 'm', max_tokens: 1, messages: [], temperature: 0 });
`;
    const proposal = await anthropic('0.79.0', { 'a.ts': source });
    expect(proposal.stops.every((item) => !item.blocking)).toBe(true);
    expect(proposal.stops[0].reason).toContain('Removed `temperature: t`, `top_k: 5`');
    expect(proposal.stops[0].reason).toContain('answers can be more or less varied');
    expect(applySourceEdits(source, proposal.edits))
      .toBe(`import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();
export const ask = (t: number) =>
  client.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 100,
    messages: [],
  });
export const inline = () => client.messages.create({ model: 'm', max_tokens: 1, messages: [] });
export const last = () => client.messages.create({ model: 'm', max_tokens: 1, messages: [] });
`);
  });

  it('stops on X-Api-Key only where the SDK sends it', async () => {
    const proposal = await anthropic('0.79.0', {
      'a.ts': `import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ defaultHeaders: { 'X-Api-Key': process.env.K } });
export const ask = () => client.messages.create({ model: 'm', max_tokens: 1, messages: [] }, { headers: { 'x-api-key': 'other' } });
export const own = (req: { headers: Record<string, string> }) => req.headers['x-api-key'];
export const cors = { allowedHeaders: ['Content-Type', 'x-api-key'] };
export const forward = (key: string) => fetch('https://example.test', { headers: { 'x-api-key': key } });
`,
    });
    expect(proposal.stops.map((item) => [item.rule, item.line])).toEqual([
      ['anthropic-ts-x-api-key-header', 2],
      ['anthropic-ts-x-api-key-header', 3],
    ]);
  });

  it('blocks on a declared platform package', async () => {
    const proposal = await anthropic(
      '0.79.0',
      {
        'a.ts':
          "import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';\nexport const c = new AnthropicVertex();\n",
      },
      { '@anthropic-ai/vertex-sdk': '^0.14.0' },
    );
    expect(proposal.stops).toEqual([
      expect.objectContaining({ rule: 'anthropic-ts-companions', blocking: true }),
    ]);
  });
});

describe('@google/generative-ai to @google/genai', () => {
  async function gemini(files: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), 'refit-ai-sdk-majors-'));
    roots.push(root);
    for (const [name, content] of Object.entries({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { '@google/generative-ai': '^0.24.1' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/@google/generative-ai': { version: '0.24.1' },
        },
      }),
      ...files,
    })) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), content);
    }
    const proposal = (await proposeGeminiSdkSwap(root, await loadAiRuleTables()))!;
    const changed = Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        applySourceEdits(
          content,
          proposal.edits.filter((item) => item.file === path),
        ),
      ]),
    );
    return { proposal, changed };
  }

  it('rewrites the documented client, generate, stream and text shapes', async () => {
    const { proposal, changed } = await gemini({
      'src/story.ts': `import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-3.8-flash" });

export async function story(prompt: string) {
  const result = await model.generateContent(\`Tell me \${prompt}\`);
  return result.response.text();
}

export async function stream() {
  const result = await model.generateContentStream("Write a story.");
  let text = "";
  for await (const chunk of result.stream) text += chunk.text();
  return text;
}
`,
    });
    expect(proposal.stops).toEqual([]);
    expect(proposal.packageName).toBe('@google/genai');
    expect(proposal.replaces).toBe('@google/generative-ai');
    expect(changed['src/story.ts']).toBe(`import { GoogleGenAI } from "@google/genai";

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function story(prompt: string) {
  const result = await genAI.models.generateContent({ model: "gemini-3.8-flash", contents: \`Tell me \${prompt}\` });
  return result.text;
}

export async function stream() {
  const result = await genAI.models.generateContentStream({ model: "gemini-3.8-flash", contents: "Write a story." });
  let text = "";
  for await (const chunk of result) text += chunk.text;
  return text;
}
`);
    expect(proposal.calls.map((call) => call.call)).toEqual([
      'models.generateContent',
      'models.generateContentStream',
    ]);
  });

  it('follows a response alias and moves a documented generationConfig to config', async () => {
    const { proposal, changed } = await gemini({
      'a.js': `const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.KEY);
const model = genAI.getGenerativeModel({ model: "m", generationConfig: { temperature: 0.2, maxOutputTokens: 100 } });
async function ask(prompt) {
  const p = \`Q: \${prompt}\`;
  const result = await model.generateContent(p);
  const response = await result.response;
  return (await response.text()).trim();
}
// const old = genAI.getGenerativeModel({ model: "x", safetySettings });
module.exports = { ask };
`,
    });
    expect(proposal.stops).toEqual([]);
    expect(changed['a.js']).toContain(
      'const result = await genAI.models.generateContent({ model: "m", contents: p, config: { temperature: 0.2, maxOutputTokens: 100 } });',
    );
    expect(changed['a.js']).toContain('const response = await result;');
    expect(changed['a.js']).toContain('return (await response.text).trim();');
    expect(proposal.rules.map((rule) => rule.rule)).toContain('gemini-swap-config');
  });

  describe('retired models', () => {
    const entry = (id: string, date: string, replacement: string | null) => ({
      id,
      provider: 'gemini' as const,
      kind: 'model' as const,
      versions: [id],
      date,
      summary: 'retires',
      replacement,
      source: 'https://ai.google.dev/gemini-api/docs/deprecations',
      checkedAt: '2026-10-29',
    });
    const models = {
      now: new Date('2026-10-29T00:00:00Z'),
      entries: [
        entry('gemini-pro', '2025-02-15', 'gemini-1.5-flash'),
        entry('gemini-1.5-flash', '2025-09-24', 'gemini-2.5-flash'),
        entry('gemini-1.0-pro-vision', '2025-01-01', null),
        entry('gemini-2.5-flash', '2027-06-01', 'gemini-3.8-flash'),
      ],
    };
    async function swap(files: Record<string, string>) {
      const root = await mkdtemp(join(tmpdir(), 'refit-ai-sdk-majors-'));
      roots.push(root);
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { '@google/generative-ai': '^0.24.1' } }),
      );
      for (const [name, content] of Object.entries(files))
        await writeFile(join(root, name), content);
      const proposal = (await proposeGeminiSdkSwap(root, await loadAiRuleTables(), models))!;
      return {
        proposal,
        changed: Object.fromEntries(
          Object.entries(files).map(([path, content]) => [
            path,
            applySourceEdits(
              content,
              proposal.edits.filter((item) => item.file === path),
            ),
          ]),
        ),
      };
    }
    const header =
      'import { GoogleGenerativeAI } from "@google/generative-ai";\nconst genAI = new GoogleGenerativeAI("k");\n';

    it('replaces a retired model with the replacement Google names, followed while retired', async () => {
      const { proposal, changed } = await swap({
        'a.ts': `${header}const model = genAI.getGenerativeModel({ model: "gemini-pro" });\nexport const f = async () => (await model.generateContent("x")).response.text();\n`,
      });
      expect(proposal.stops.filter((item) => item.blocking)).toEqual([]);
      expect(changed['a.ts']).toContain(
        'genAI.models.generateContent({ model: "gemini-2.5-flash", contents: "x" })',
      );
      const note = proposal.stops.find((item) => item.rule === 'gemini-model-deadline')!;
      expect(note.blocking).toBe(false);
      expect(note.reason).toContain('was retired on 2025-02-15');
      expect(note.reason).toContain('(via gemini-1.5-flash)');
      expect(note.reason).toContain('check their quality');
    });

    it('replaces a model const where it is written', async () => {
      const { changed } = await swap({
        'a.ts': `${header}const MODEL = 'gemini-pro';\nconst model = genAI.getGenerativeModel({ model: MODEL });\nexport const f = async () => (await model.generateContent("x")).response.text();\n`,
      });
      expect(changed['a.ts']).toContain("const MODEL = 'gemini-2.5-flash';");
      expect(changed['a.ts']).toContain(
        'genAI.models.generateContent({ model: MODEL, contents: "x" })',
      );
    });

    it('stops where Google names no replacement, or a retired model is named elsewhere in the file', async () => {
      const none = await swap({
        'a.ts': `${header}const model = genAI.getGenerativeModel({ model: "gemini-1.0-pro-vision" });\nexport const f = async () => (await model.generateContent("x")).response.text();\n`,
      });
      expect(none.proposal.stops.every((item) => item.blocking)).toBe(true);
      expect(none.proposal.stops[0].reason).toContain('names no single replacement');
      const elsewhere = await swap({
        'a.ts': `${header}const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });\nexport const f = async () => (await model.generateContent("x")).response.text();\nexport const fallback = "gemini-pro";\n`,
      });
      expect(elsewhere.proposal.stops.filter((item) => item.blocking)).toEqual([
        expect.objectContaining({
          line: 5,
          reason: expect.stringContaining('swaps every model reference in a file together'),
        }),
      ]);
      // gemini-2.5-flash retires later: kept, and listed.
      expect(
        elsewhere.proposal.stops.some(
          (item) => !item.blocking && item.reason.includes('retires on 2027-06-01'),
        ),
      ).toBe(true);
    });
  });

  it('keeps blocking on systemInstruction, safetySettings and other config keys', async () => {
    const { proposal } = await gemini({
      'a.ts': `import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI("k");
const model = genAI.getGenerativeModel({ model: "m", systemInstruction: "be brief", generationConfig: { responseMimeType: "application/json" } });
export const f = async () => (await model.generateContent("x")).response.text();
`,
    });
    expect(proposal.stops.some((item) => item.reason.includes('systemInstruction'))).toBe(true);
  });

  it('blocks on config, chat, request objects, other reads and models from another file', async () => {
    const { proposal } = await gemini({
      'a.js': `const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.KEY);
const tuned = genAI.getGenerativeModel({ model: "m", generationConfig: { temperature: 0 } });
const plain = genAI.getGenerativeModel({ model: "m" });
module.exports = {
  chat: () => plain.startChat(),
  tuned: () => tuned.generateContent("x"),
};
`,
      'b.ts': `import { GoogleGenerativeAI, HarmCategory } from "@google/generative-ai";
export const c = new GoogleGenerativeAI("k");
`,
      'c.ts': `import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI("k");
const model = genAI.getGenerativeModel({ model: "m" });
export const f = async (request: any) => (await model.generateContent(request)).response.text();
export const g = async () => { const r = await model.generateContent("x"); return r.response.candidates; };
`,
      'd.ts': `import { model } from './shared';\nexport const h = async () => (await model.generateContent('x')).response.text();\n`,
    });
    expect(proposal.stops.length).toBeGreaterThanOrEqual(5);
    expect(proposal.stops.every((item) => item.blocking)).toBe(true);
    expect(new Set(proposal.stops.map((item) => item.file))).toEqual(
      new Set(['a.js', 'b.ts', 'c.ts', 'd.ts']),
    );
  });
});
