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
      // Not a text-generation call, not the SDK, and not a retiring model: no proposal.
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

// Gemini is report only: replacing a Gemini model, or the old SDK with the new one, is an owner
// decision, so neither the CLI proposal nor `refit serve --model-fixes` (which uses it) edits them.
it('never proposes Gemini model or SDK replacements', async () => {
  const gemini: DeadlineRegistry = {
    formatVersion: 1,
    deadlines: [
      ...registry.deadlines,
      entry({
        id: 'gemini-flash',
        provider: 'gemini',
        versions: ['gemini-1.5-flash'],
        replacement: 'gemini-2.0-flash',
      }),
      entry({
        id: 'gemini-old-sdk',
        provider: 'gemini',
        kind: 'sdk',
        versions: ['@google/generative-ai'],
        replacement: '@google/genai',
      }),
    ],
  };
  const root = await repository({
    'package.json': JSON.stringify({
      name: 'app',
      dependencies: {
        '@google/genai': '2.30.0',
        '@google/generative-ai': '0.24.1',
        openai: '4.80.0',
      },
    }),
    'src/gemini.ts': [
      "import { GoogleGenAI } from '@google/genai';",
      "import { GoogleGenerativeAI } from '@google/generative-ai';",
      'const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });',
      "await ai.models.generateContent({ model: 'gemini-1.5-flash', contents: 'Hi' });",
      "new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-1.5-flash' });",
    ].join('\n'),
  });
  expect(await proposeModelReplacements(root, gemini, NOW)).toEqual({
    replacements: [],
    stops: [],
    patch: null,
  });
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
      // Legacy completions and other methods are not proposed.
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
      // Another host, or another endpoint, is not proposed.
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
