import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  loadDeadlineRegistry,
  type DeadlineEntry,
  type DeadlineRegistry,
} from './deadline-registry.ts';
import { proposeModelReplacements } from './model-retirements.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-model-retirements-'));
  roots.push(root);
  const manifest = {
    name: 'app',
    dependencies: { openai: '4.80.0', '@anthropic-ai/sdk': '0.40.0' },
  };
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify(manifest),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

function entry(
  overrides: Partial<DeadlineEntry> & Pick<DeadlineEntry, 'id' | 'provider' | 'versions'>,
): DeadlineEntry {
  return {
    kind: 'model',
    date: '2026-10-23',
    summary: `${overrides.id} retires.`,
    replacement: null,
    source: 'https://provider.example/deprecations',
    checkedAt: '2026-10-20',
    ...overrides,
  };
}

const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    entry({
      id: 'openai-gpt-4',
      provider: 'openai',
      versions: ['gpt-4'],
      replacement: 'gpt-5.6-sol',
    }),
    // A replacement that retires too is followed to the model that does not.
    entry({
      id: 'openai-o1-mini',
      provider: 'openai',
      versions: ['o1-mini'],
      date: '2025-10-27',
      replacement: 'o4-mini',
    }),
    entry({
      id: 'openai-o4-mini',
      provider: 'openai',
      versions: ['o4-mini'],
      replacement: 'gpt-5.6-terra',
    }),
    entry({
      id: 'openai-prose',
      provider: 'openai',
      versions: ['gpt-prose'],
      replacement: 'A newer model',
    }),
    entry({
      id: 'anthropic-claude-3-opus',
      provider: 'anthropic',
      versions: ['claude-3-opus-20240229'],
      date: '2026-01-05',
      replacement: 'claude-opus-4-8',
    }),
  ],
};
const NOW = new Date('2026-10-20T12:00:00Z');

it('proposes registry replacements for literal models in traced OpenAI and Anthropic calls', async () => {
  const root = await repository({
    'src/ai.ts': [
      "import OpenAI from 'openai';",
      "import Anthropic from '@anthropic-ai/sdk';",
      'const openai = new OpenAI();',
      'const anthropic = new Anthropic();',
      'export async function chat(messages: any[]) {',
      "  await openai.chat.completions.create({ model: 'gpt-4', messages });",
      "  await openai.responses.create({ model: process.env.MODEL ?? 'o1-mini', input: 'hi' });",
      '  return anthropic.messages.create({ model: "claude-3-opus-20240229", max_tokens: 64, messages });',
      '}',
    ].join('\n'),
    'src/bot.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'export class Bot {',
      '  private client = new Anthropic();',
      '  stream(messages: any[]) {',
      '    return this.client.messages.stream({',
      "      model: 'claude-3-opus-20240229',",
      '      max_tokens: 64,',
      '      messages,',
      '    });',
      '  }',
      '}',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(
    proposal.replacements.map((item) => [
      `${item.file}:${item.line}`,
      item.call,
      item.from,
      item.to,
      item.via,
      item.days,
    ]),
  ).toEqual([
    ['src/ai.ts:6', 'chat.completions.create', 'gpt-4', 'gpt-5.6-sol', ['openai-gpt-4'], 3],
    [
      'src/ai.ts:7',
      'responses.create',
      'o1-mini',
      'gpt-5.6-terra',
      ['openai-o1-mini', 'openai-o4-mini'],
      -358,
    ],
    [
      'src/ai.ts:8',
      'messages.create',
      'claude-3-opus-20240229',
      'claude-opus-4-8',
      ['anthropic-claude-3-opus'],
      -288,
    ],
    [
      'src/bot.ts:5',
      'messages.stream',
      'claude-3-opus-20240229',
      'claude-opus-4-8',
      ['anthropic-claude-3-opus'],
      -288,
    ],
  ]);
  expect(proposal.stops).toEqual([]);
  // The patch applies cleanly and changes only the model strings, keeping each quote style.
  await execute('git', ['init', '-q', root]);
  await writeFile(join(root, 'model.patch'), proposal.patch!);
  await execute('git', ['-C', root, 'apply', 'model.patch']);
  const ai = await readFile(join(root, 'src/ai.ts'), 'utf8');
  expect(ai).toContain("openai.chat.completions.create({ model: 'gpt-5.6-sol', messages })");
  expect(ai).toContain("model: process.env.MODEL ?? 'gpt-5.6-terra'");
  expect(ai).toContain('model: "claude-opus-4-8"');
  expect(await readFile(join(root, 'src/bot.ts'), 'utf8')).toContain("model: 'claude-opus-4-8',");
});

it('stops for review where a swap could change the request, and skips what it cannot trace', async () => {
  const root = await repository({
    'src/ai.ts': [
      "import OpenAI from 'openai';",
      "import Anthropic from '@anthropic-ai/sdk';",
      'const openai = new OpenAI();',
      'const anthropic = new Anthropic();',
      "export const MODEL = 'gpt-4'; console.log(MODEL);",
      'export async function chat(messages: any[], options: object) {',
      "  await openai.chat.completions.create({ model: 'gpt-4', max_tokens: 100, messages });",
      "  await anthropic.messages.create({ model: 'claude-3-opus-20240229', temperature: 0.2, max_tokens: 9, messages });",
      "  await openai.chat.completions.create({ ...options, model: 'gpt-4', messages });",
      '  await openai.chat.completions.create({ model: MODEL, messages });',
      "  await openai.chat.completions.create({ model: 'gpt-prose', messages });",
      // Not a text-generation call: it stops for review. Not the SDK, or not a retiring model: nothing.
      "  await openai.embeddings.create({ model: 'gpt-4', input: 'x' });",
      "  await fetch('https://api.openai.com', { body: JSON.stringify({ model: 'gpt-4' }) });",
      "  await openai.chat.completions.create({ model: 'gpt-4o', messages });",
      "  await anthropic.messages.create({ model: 'anthropic.claude-3-opus-20240229-v1:0', max_tokens: 9, messages });",
      "  // await openai.chat.completions.create({ model: 'gpt-4', messages });",
      '}',
    ].join('\n'),
    'src/ai.test.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      "openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  expect(proposal.stops.map((item) => [item.line, item.model, item.reason])).toEqual([
    [7, 'gpt-4', 'The request sets max_tokens, which gpt-5.6-sol may reject or treat differently.'],
    [
      9,
      'gpt-4',
      'The request spreads other options, which may set parameters the replacement rejects.',
    ],
    [
      10,
      'gpt-4',
      'The model comes from the constant MODEL (src/ai.ts:5), which is used 2 times; change it by hand to gpt-5.6-sol.',
    ],
    [11, 'gpt-prose', 'The registry names no concrete replacement model ID.'],
    [
      12,
      'gpt-4',
      '`embeddings.create` is not a call Refit edits; gpt-5.6-sol may change formats or parameters; change it by hand to gpt-5.6-sol.',
    ],
    [
      8,
      'claude-3-opus-20240229',
      'The request sets temperature, which claude-opus-4-8 may reject or treat differently.',
    ],
  ]);
});

it('resolves every shipped Anthropic retirement to a model that is not retiring', async () => {
  const shipped = await loadDeadlineRegistry(undefined, NOW);
  const anthropic = shipped.deadlines.filter((item) => item.provider === 'anthropic');
  expect(anthropic.length).toBeGreaterThan(0);
  const root = await repository({
    'src/ai.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      ...anthropic.map(
        (item) =>
          `anthropic.messages.create({ model: '${item.versions[0]}', max_tokens: 9, messages: [] });`,
      ),
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, shipped, NOW);
  expect(proposal.stops).toEqual([]);
  expect(proposal.replacements).toHaveLength(anthropic.length);
  const retiring = new Set(anthropic.flatMap((item) => item.versions));
  for (const item of proposal.replacements) expect(retiring.has(item.to)).toBe(false);
});

// Shapes found on the deadline benchmark: the openai v3 SDK and openai-edge, request objects held in
// a const, and a model const used by one call.
it('follows v3 and openai-edge clients, request consts and model consts used once', async () => {
  const root = await repository({
    'package.json': JSON.stringify({
      name: 'app',
      dependencies: { openai: '3.2.1', 'openai-edge': '1.2.2' },
    }),
    'src/v3.ts': [
      "import { Configuration, OpenAIApi } from 'openai';",
      'export const openai = new OpenAIApi(new Configuration({ apiKey: process.env.KEY }));',
      'export async function ask(content: string) {',
      "  return openai.createChatCompletion({ model: 'gpt-4', messages: [{ role: 'user', content }] });",
      '}',
      // Legacy completions and other methods stop for review.
      "openai.createCompletion({ model: 'gpt-4', prompt: 'x' });",
    ].join('\n'),
    'src/uses.ts': [
      "import { openai } from './v3';",
      "const MODEL = 'gpt-4';",
      'export async function summarize(messages: any[]) {',
      '  const params = { model: MODEL, messages } as const;',
      '  return openai.createChatCompletion(params);',
      '}',
    ].join('\n'),
    'src/edge.ts': [
      "import { Configuration, OpenAIApi } from 'openai-edge';",
      'const openai = new OpenAIApi(new Configuration({ apiKey: process.env.KEY }));',
      'export async function POST(prompt: string) {',
      "  const model = 'gpt-4';",
      "  return openai.createChatCompletion({ model, stream: true, messages: [{ role: 'user', content: prompt }] });",
      '}',
    ].join('\n'),
    'src/shared.ts': [
      "import { openai } from './v3';",
      'export async function twice(messages: any[]) {',
      "  const request = { model: 'gpt-4', messages };",
      '  await openai.createChatCompletion(request);',
      '  log(request);',
      "  const tuned = { model: 'gpt-4', messages, temperature: 0.7 };",
      '  return openai.createChatCompletion(tuned);',
      '}',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(
    proposal.replacements.map((item) => [`${item.file}:${item.line}`, item.call, item.to]),
  ).toEqual([
    ['src/v3.ts:4', 'createChatCompletion', 'gpt-5.6-sol'],
    ['src/uses.ts:5', 'createChatCompletion', 'gpt-5.6-sol'],
    ['src/edge.ts:5', 'createChatCompletion', 'gpt-5.6-sol'],
  ]);
  expect(proposal.stops.map((item) => [`${item.file}:${item.line}`, item.reason])).toEqual([
    [
      'src/v3.ts:6',
      '`createCompletion` is not a call Refit edits; gpt-5.6-sol may change formats or parameters; change it by hand to gpt-5.6-sol.',
    ],
    [
      'src/shared.ts:4',
      'The request object request (src/shared.ts:3) is used 2 times; change its model by hand to gpt-5.6-sol.',
    ],
    [
      'src/shared.ts:7',
      'The request sets temperature, which gpt-5.6-sol may reject or treat differently.',
    ],
  ]);
  await execute('git', ['init', '-q', root]);
  await writeFile(join(root, 'model.patch'), proposal.patch!);
  await execute('git', ['-C', root, 'apply', 'model.patch']);
  expect(await readFile(join(root, 'src/uses.ts'), 'utf8')).toContain(
    "const MODEL = 'gpt-5.6-sol';",
  );
  expect(await readFile(join(root, 'src/edge.ts'), 'utf8')).toContain(
    "const model = 'gpt-5.6-sol';",
  );
  expect(await readFile(join(root, 'src/v3.ts'), 'utf8')).toContain(
    "openai.createCompletion({ model: 'gpt-4', prompt: 'x' });",
  );
});

// Shapes left after the first two rounds on the deadline benchmark: models behind imports, enum
// members and helper parameters, and raw HTTP requests to the official endpoints.
it('follows imported constants, enum members, helper parameters and raw HTTP requests', async () => {
  const root = await repository({
    'src/models.ts': [
      "export enum Model { Default = 'gpt-4' }",
      "export const SUMMARY_MODEL = 'gpt-4';",
      "export const LABEL_MODEL = 'gpt-4';",
    ].join('\n'),
    'src/client.ts': ["import OpenAI from 'openai';", 'export const openai = new OpenAI();'].join(
      '\n',
    ),
    'src/chat.ts': [
      "import { openai } from './client';",
      "import { Model, SUMMARY_MODEL, LABEL_MODEL } from './models';",
      'export const chat = (messages: any[]) =>',
      '  openai.chat.completions.create({ model: Model.Default, messages });',
      'export const summarize = (messages: any[]) =>',
      '  openai.chat.completions.create({ model: SUMMARY_MODEL, messages });',
      'export const label = (messages: any[]) =>',
      '  openai.chat.completions.create({ model: LABEL_MODEL, messages });',
      'export const LABEL = `Model: ${LABEL_MODEL}`;',
    ].join('\n'),
    // A CommonJS helper whose default and callers pass the model.
    'lib/ai.js': [
      "const { OpenAI } = require('openai');",
      'const openai = new OpenAI();',
      "const ask = async function (messages, model = 'gpt-4') {",
      '  return openai.chat.completions.create({ model, messages });',
      '};',
      'module.exports = { ask };',
    ].join('\n'),
    'lib/commands.js': [
      "const ai = require('./ai');",
      'ai.ask([]);',
      "ai.ask([], 'o1-mini');",
      "ai.ask([], 'gpt-4o');",
    ].join('\n'),
    'src/raw.ts': [
      "const URL = 'https://api.openai.com/v1/chat/completions';",
      'export async function rawChat(prompt: string) {',
      '  await fetch(URL, {',
      "    method: 'POST',",
      "    body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: prompt }] }),",
      '  });',
      "  await axios.post('https://api.anthropic.com/v1/messages', {",
      "    model: 'claude-3-opus-20240229',",
      '    max_tokens: 64,',
      '    messages: [],',
      '  });',
      '  UrlFetchApp.fetch(`https://api.openai.com/v1/chat/completions`, {',
      "    payload: JSON.stringify({ model: 'gpt-4', messages: [], temperature: 0 }),",
      '  });',
      // Another host is not proposed; another official endpoint stops for review.
      "  await fetch('https://proxy.example/v1/chat/completions', { body: JSON.stringify({ model: 'gpt-4' }) });",
      "  await fetch('https://api.openai.com/v1/embeddings', { body: JSON.stringify({ model: 'gpt-4' }) });",
      '}',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(
    proposal.replacements.map((item) => [
      `${item.file}:${item.line}`,
      item.call,
      `${item.edited.file}:${item.edited.line}`,
      item.from,
      item.to,
    ]),
  ).toEqual([
    ['lib/ai.js:4', 'chat.completions.create', 'lib/ai.js:3', 'gpt-4', 'gpt-5.6-sol'],
    ['lib/ai.js:4', 'chat.completions.create', 'lib/commands.js:3', 'o1-mini', 'gpt-5.6-terra'],
    ['src/chat.ts:4', 'chat.completions.create', 'src/models.ts:1', 'gpt-4', 'gpt-5.6-sol'],
    ['src/chat.ts:6', 'chat.completions.create', 'src/models.ts:2', 'gpt-4', 'gpt-5.6-sol'],
    ['src/raw.ts:3', 'fetch /v1/chat/completions', 'src/raw.ts:5', 'gpt-4', 'gpt-5.6-sol'],
    [
      'src/raw.ts:7',
      'post /v1/messages',
      'src/raw.ts:8',
      'claude-3-opus-20240229',
      'claude-opus-4-8',
    ],
  ]);
  expect(proposal.stops.map((item) => [`${item.file}:${item.line}`, item.reason])).toEqual([
    [
      'src/chat.ts:8',
      'The model comes from the constant LABEL_MODEL (src/models.ts:3), which is used 2 times; change it by hand to gpt-5.6-sol.',
    ],
    [
      'src/raw.ts:12',
      'The request sets temperature, which gpt-5.6-sol may reject or treat differently.',
    ],
    [
      'src/raw.ts:16',
      '`fetch /v1/embeddings` is not a call Refit edits; gpt-5.6-sol may change formats or parameters; change it by hand to gpt-5.6-sol.',
    ],
  ]);
  await execute('git', ['init', '-q', root]);
  await writeFile(join(root, 'model.patch'), proposal.patch!);
  await execute('git', ['-C', root, 'apply', 'model.patch']);
  expect(await readFile(join(root, 'lib/commands.js'), 'utf8')).toBe(
    [
      "const ai = require('./ai');",
      'ai.ask([]);',
      "ai.ask([], 'gpt-5.6-terra');",
      "ai.ask([], 'gpt-4o');",
    ].join('\n'),
  );
});

it('stops when a helper that carries the model is passed around or spread into', async () => {
  const root = await repository({
    'src/ai.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      "export function ask(messages: any[], model = 'gpt-4') {",
      '  return openai.chat.completions.create({ model, messages });',
      '}',
      'export const handlers = [ask];',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.stops.map((item) => item.reason)).toEqual([
    'The helper ask (src/ai.ts:3) is also passed as a value; change its model by hand to gpt-5.6-sol.',
  ]);
  expect(proposal.stops[0].at).toEqual({ file: 'src/ai.ts', line: 3 });
});

// Anthropic rejects non-default temperature, top_p and top_k only on Claude 4.7 and later models,
// so a swap to an earlier replacement keeps them.
it('keeps Anthropic sampling parameters when the replacement predates Claude 4.7', async () => {
  const root = await repository({
    'src/ai.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      "anthropic.messages.create({ model: 'claude-3-haiku-20240307', temperature: 0, max_tokens: 9, messages: [] });",
      "anthropic.messages.create({ model: 'claude-3-opus-20240229', top_k: 5, max_tokens: 9, messages: [] });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(
    root,
    {
      formatVersion: 1,
      deadlines: [
        ...registry.deadlines,
        entry({
          id: 'anthropic-claude-3-haiku',
          provider: 'anthropic',
          versions: ['claude-3-haiku-20240307'],
          date: '2026-04-20',
          replacement: 'claude-haiku-4-5-20251001',
        }),
      ],
    },
    NOW,
  );
  expect(proposal.replacements.map((item) => [item.line, item.to])).toEqual([
    [3, 'claude-haiku-4-5-20251001'],
  ]);
  expect(proposal.stops.map((item) => [item.line, item.reason])).toEqual([
    [4, 'The request sets top_k, which claude-opus-4-8 may reject or treat differently.'],
  ]);
});

const NON_TEXT = (call: string, to: string) =>
  `\`${call}\` is not a call Refit edits; ${to} may change formats or parameters; change it by hand to ${to}.`;
const nonTextRegistry: DeadlineRegistry = {
  ...registry,
  deadlines: [
    ...registry.deadlines,
    entry({
      id: 'openai-dall-e-3',
      provider: 'openai',
      versions: ['dall-e-3'],
      replacement: 'gpt-image-2',
    }),
    entry({
      id: 'openai-tts-1',
      provider: 'openai',
      versions: ['tts-1'],
      replacement: 'gpt-4o-mini-tts',
    }),
    entry({
      id: 'openai-whisper-1',
      provider: 'openai',
      versions: ['whisper-1'],
      replacement: 'gpt-4o-transcribe',
    }),
  ],
};

it('stops non-text OpenAI and Anthropic calls with a named reason and never edits them', async () => {
  const root = await repository({
    'package.json': JSON.stringify({
      name: 'app',
      dependencies: { openai: '4.80.0', '@anthropic-ai/sdk': '0.40.0', 'openai-edge': '1.2.2' },
    }),
    'src/ai.ts': [
      "import OpenAI from 'openai';",
      "import Anthropic from '@anthropic-ai/sdk';",
      'const openai = new OpenAI();',
      'const anthropic = new Anthropic();',
      'export async function all(prompt: string) {',
      "  await openai.images.generate({ model: 'dall-e-3', prompt });",
      "  await openai.images.edit({ model: 'dall-e-3', prompt });",
      "  await openai.audio.speech.create({ model: 'tts-1', input: prompt, voice: 'alloy' });",
      "  await openai.audio.transcriptions.create({ model: 'whisper-1', file: prompt });",
      "  await openai.embeddings.create({ model: 'gpt-4', input: prompt });",
      "  await openai.moderations.create({ model: 'gpt-4', input: prompt });",
      "  await openai.completions.create({ model: 'gpt-4', prompt });",
      "  await openai.beta.assistants.create({ model: 'gpt-4' });",
      "  await anthropic.completions.create({ model: 'claude-3-opus-20240229', prompt, max_tokens_to_sample: 9 });",
      // No model, and a lookup by name: nothing to report.
      '  await openai.embeddings.create({ input: prompt });',
      "  await openai.models.retrieve('gpt-4');",
      '}',
    ].join('\n'),
    'src/v3.ts': [
      "import { Configuration, OpenAIApi } from 'openai-edge';",
      'const api = new OpenAIApi(new Configuration({ apiKey: process.env.KEY }));',
      "api.createCompletion({ model: 'gpt-4', prompt: 'x' });",
    ].join('\n'),
    // One literal reaches a text call and an embeddings call: the merged decision stops.
    'src/shared.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      "const MODEL = 'gpt-4';",
      'openai.chat.completions.create({ model: MODEL, messages: [] });',
      'openai.embeddings.create({ model: MODEL, input: "x" });',
    ].join('\n'),
    'src/raw.ts': [
      'export async function raw(key: string) {',
      "  await fetch('https://api.openai.com/v1/images/generations', { body: JSON.stringify({ model: 'dall-e-3' }) });",
      "  await fetch('https://api.openai.com/v1/embeddings', { body: JSON.stringify({ model: 'gpt-4' }) });",
      "  await axios.post('https://api.anthropic.com/v1/complete', { model: 'claude-3-opus-20240229', prompt: key });",
      // Multipart body, lookalike endpoints and a request without a model: nothing.
      "  formData.append('model', 'whisper-1');",
      "  await fetch('https://api.anthropic.com/v1/completed', { body: JSON.stringify({ model: 'claude-3-opus-20240229' }) });",
      "  await fetch('https://api.openai.com/v1/embeddings-x', { body: JSON.stringify({ model: 'gpt-4' }) });",
      "  await fetch('https://api.openai.com/v1/embeddings', { body: JSON.stringify({ input: key }) });",
      '}',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, nonTextRegistry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  const stops = proposal.stops.map((item) => [`${item.file}:${item.line}`, item.call, item.reason]);
  expect(stops.sort()).toEqual(
    [
      ['src/ai.ts:10', 'embeddings.create', NON_TEXT('embeddings.create', 'gpt-5.6-sol')],
      ['src/ai.ts:11', 'moderations.create', NON_TEXT('moderations.create', 'gpt-5.6-sol')],
      ['src/ai.ts:12', 'completions.create', NON_TEXT('completions.create', 'gpt-5.6-sol')],
      ['src/ai.ts:13', 'beta.assistants.create', NON_TEXT('beta.assistants.create', 'gpt-5.6-sol')],
      ['src/ai.ts:14', 'completions.create', NON_TEXT('completions.create', 'claude-opus-4-8')],
      ['src/ai.ts:6', 'images.generate', NON_TEXT('images.generate', 'gpt-image-2')],
      ['src/ai.ts:7', 'images.edit', NON_TEXT('images.edit', 'gpt-image-2')],
      ['src/ai.ts:8', 'audio.speech.create', NON_TEXT('audio.speech.create', 'gpt-4o-mini-tts')],
      [
        'src/ai.ts:9',
        'audio.transcriptions.create',
        NON_TEXT('audio.transcriptions.create', 'gpt-4o-transcribe'),
      ],
      [
        'src/raw.ts:2',
        'fetch /v1/images/generations',
        NON_TEXT('fetch /v1/images/generations', 'gpt-image-2'),
      ],
      ['src/raw.ts:3', 'fetch /v1/embeddings', NON_TEXT('fetch /v1/embeddings', 'gpt-5.6-sol')],
      ['src/raw.ts:4', 'post /v1/complete', NON_TEXT('post /v1/complete', 'claude-opus-4-8')],
      [
        'src/shared.ts:4',
        'chat.completions.create',
        'The model comes from the constant MODEL (src/shared.ts:3), which is used 2 times; change it by hand to gpt-5.6-sol.',
      ],
      ['src/v3.ts:3', 'createCompletion', NON_TEXT('createCompletion', 'gpt-5.6-sol')],
    ].sort(),
  );
});

it('reports raw fetch and axios requests to the official hosts at the exact line', async () => {
  const root = await repository({
    'src/raw.ts': [
      'export async function raw(messages: any[], input: string) {',
      "  await axios.post('https://api.openai.com/v1/chat/completions', { model: 'gpt-4', messages });",
      "  const request = { model: 'gpt-4', messages };",
      "  await fetch('https://api.openai.com/v1/chat/completions', { body: JSON.stringify(request) });",
      "  await fetch('https://api.anthropic.com/v1/messages', {",
      '    method: "POST",',
      '    body: JSON.stringify({',
      '      max_tokens: 9,',
      "      model: 'claude-3-opus-20240229',",
      '      messages,',
      '    }),',
      '  });',
      '  const http = axios.create();',
      "  await http.post('https://api.openai.com/v1/responses', { model: process.env.M ?? 'gpt-4', input });",
      // Another host and an untraced library: nothing.
      "  await got.post('https://api.openai.com/v1/chat/completions', { json: { model: 'gpt-4' } });",
      '}',
    ].join('\n'),
    'src/anthropic.ts': [
      "await fetch('https://api.anthropic.com/v1/messages', {",
      "  body: JSON.stringify({ model: 'claude-3-opus-20240229', temperature: 0.2, max_tokens: 9 }),",
      '});',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(
    proposal.replacements.map((item) => [
      `${item.file}:${item.line}`,
      item.call,
      `${item.edited.file}:${item.edited.line}`,
      item.to,
    ]),
  ).toEqual([
    ['src/raw.ts:2', 'post /v1/chat/completions', 'src/raw.ts:2', 'gpt-5.6-sol'],
    ['src/raw.ts:4', 'fetch /v1/chat/completions', 'src/raw.ts:3', 'gpt-5.6-sol'],
    ['src/raw.ts:5', 'fetch /v1/messages', 'src/raw.ts:9', 'claude-opus-4-8'],
    ['src/raw.ts:14', 'post /v1/responses', 'src/raw.ts:14', 'gpt-5.6-sol'],
  ]);
  expect(proposal.stops.map((item) => [`${item.file}:${item.line}`, item.reason])).toEqual([
    [
      'src/anthropic.ts:1',
      'The request sets temperature, which claude-opus-4-8 may reject or treat differently.',
    ],
  ]);
  await execute('git', ['init', '-q', root]);
  await writeFile(join(root, 'model.patch'), proposal.patch!);
  await execute('git', ['-C', root, 'apply', 'model.patch']);
  const raw = await readFile(join(root, 'src/raw.ts'), 'utf8');
  expect(raw).toContain("model: 'gpt-5.6-sol', messages });");
  expect(raw).toContain("model: 'claude-opus-4-8',");
  expect(raw).toContain("process.env.M ?? 'gpt-5.6-sol'");
  expect(raw).toContain(
    "got.post('https://api.openai.com/v1/chat/completions', { json: { model: 'gpt-4' } })",
  );
});

it('traces axios request-config calls and axios.create instances like axios.post', async () => {
  const root = await repository({
    'src/default.ts': [
      "import axios from 'axios';",
      'export async function direct(messages: any[]) {',
      '  await axios({',
      "    method: 'post',",
      "    url: 'https://api.openai.com/v1/chat/completions',",
      "    data: { model: 'gpt-4', messages },",
      '  });',
      '  await axios.request({',
      "    url: 'https://api.anthropic.com/v1/messages',",
      "    data: { model: 'claude-3-opus-20240229', max_tokens: 9, messages },",
      '  });',
      '}',
    ].join('\n'),
    'src/instance.js': [
      "const axios = require('axios');",
      'const http = axios.create({ timeout: 1000 });',
      'async function viaInstance(messages, input) {',
      "  await http({ url: 'https://api.openai.com/v1/chat/completions', data: { model: 'gpt-4', messages } });",
      "  await http.request({ url: 'https://api.openai.com/v1/responses', data: { model: 'gpt-4', input } });",
      '}',
    ].join('\n'),
    'src/other.ts': [
      // Another host, and functions that only share the names: nothing.
      "import axios from 'axios';",
      "axios({ url: 'https://proxy.example/v1/chat/completions', data: { model: 'gpt-4' } });",
      'function request(config: any) {}',
      "request({ url: 'https://api.openai.com/v1/chat/completions', data: { model: 'gpt-4' } });",
      'const client = { request(config: any) {} };',
      "client.request({ url: 'https://api.openai.com/v1/chat/completions', data: { model: 'gpt-4' } });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(
    proposal.replacements.map((item) => [
      `${item.file}:${item.line}`,
      item.call,
      `${item.edited.file}:${item.edited.line}`,
      item.to,
    ]),
  ).toEqual([
    ['src/default.ts:3', 'axios /v1/chat/completions', 'src/default.ts:6', 'gpt-5.6-sol'],
    ['src/default.ts:8', 'request /v1/messages', 'src/default.ts:10', 'claude-opus-4-8'],
    ['src/instance.js:4', 'axios /v1/chat/completions', 'src/instance.js:4', 'gpt-5.6-sol'],
    ['src/instance.js:5', 'request /v1/responses', 'src/instance.js:5', 'gpt-5.6-sol'],
  ]);
  await execute('git', ['init', '-q', root]);
  await writeFile(join(root, 'model.patch'), proposal.patch!);
  await execute('git', ['-C', root, 'apply', 'model.patch']);
  expect(await readFile(join(root, 'src/default.ts'), 'utf8')).toContain(
    "data: { model: 'gpt-5.6-sol', messages },",
  );
  expect(await readFile(join(root, 'src/other.ts'), 'utf8')).not.toContain('gpt-5.6-sol');
});

const edited = (proposal: Awaited<ReturnType<typeof proposeModelReplacements>>) =>
  proposal.replacements
    .map((item) => `${item.edited.file}:${item.edited.line} ${item.from}`)
    .sort();

it('follows class fields, this assignments and constructor parameters to their literals', async () => {
  const root = await repository({
    'src/chat.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export class Chat {',
      "  private model = 'gpt-4';",
      '  ask() {',
      '    return openai.chat.completions.create({ model: this.model, messages: [] });',
      '  }',
      '}',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(edited(proposal)).toEqual(['src/chat.ts:4 gpt-4']);
  await execute('git', ['init', '-q', root]);
  await writeFile(join(root, 'model.patch'), proposal.patch!);
  await execute('git', ['-C', root, 'apply', 'model.patch']);
  expect(await readFile(join(root, 'src/chat.ts'), 'utf8')).toContain(
    "private model = 'gpt-5.6-sol';",
  );
});
