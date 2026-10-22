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
import type { ModelParameterEntry, ModelParameterTable } from './model-parameters.ts';
import { proposeModelReplacements as proposeDirect } from './model-retirements.ts';

// Most cases exercise the full resolver, with indirect edits (D-06 to D-08) enabled. The default,
// which reports indirect sites without editing them, is pinned by its own tests below.
const proposeModelReplacements: typeof proposeDirect = (directory, registry, now, options) =>
  proposeDirect(directory, registry, now, { indirect: true, ...options });

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
      // Not a text-generation call, or an Amazon Bedrock ID: it stops for review. Not the SDK, or
      // not a retiring model: nothing.
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
    [
      15,
      'anthropic.claude-3-opus-20240229-v1:0',
      "`anthropic.claude-3-opus-20240229-v1:0` is a model ID for Amazon Bedrock, where model IDs and retirement dates are Amazon Bedrock's, not the Claude API's (the Claude API retires claude-3-opus-20240229 on 2026-01-05); check Amazon Bedrock's model lifecycle and change it by hand to its ID for claude-opus-4-8.",
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
      "import { VertexAI } from '@google-cloud/vertexai';",
      'const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });',
      "await ai.models.generateContent({ model: 'gemini-1.5-flash', contents: 'Hi' });",
      'const genAI = new GoogleGenerativeAI(key);',
      "const MODEL = process.env.GEMINI_MODEL ?? 'gemini-1.5-flash';",
      'genAI.getGenerativeModel({ model: MODEL });',
      "const vertex = new VertexAI({ project: 'p', location: 'us-central1' });",
      "vertex.getGenerativeModel({ model: 'gemini-1.5-flash' });",
      "new GoogleGenerativeAI(key).getGenerativeModel({ model: 'gemini-1.5-flash' });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, gemini, NOW);
  // Reported, never edited.
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  expect(
    proposal.stops.map((stop) => `${stop.line} ${stop.call} ${stop.at.line}: ${stop.reason}`),
  ).toEqual([
    '5 models.generateContent 5: Gemini is report only, so Refit never edits its models (an owner decision); change it by hand to gemini-2.0-flash.',
    '8 getGenerativeModel 7: Gemini is report only, so Refit never edits its models (an owner decision); change it by hand to gemini-2.0-flash.',
    "10 getGenerativeModel 10: The client is Vertex AI, whose model retirement dates differ from the Gemini API's; check Google Cloud's model versions page and change it by hand, for example to gemini-2.0-flash.",
  ]);
  expect(proposal.unresolved.map((item) => item.line)).toEqual([11]);
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
      'export { ask };',
    ].join('\n'),
    'lib/commands.js': [
      "import * as ai from './ai';",
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
      "import * as ai from './ai';",
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
      // Claude 4.7 and later reject `thinking: { type: 'enabled' }`; Claude Haiku 4.5 keeps it.
      "anthropic.messages.create({ model: 'claude-3-opus-20240229', thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 4096, messages: [] });",
      "anthropic.messages.create({ model: 'claude-3-haiku-20240307', thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: 4096, messages: [] });",
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
    [6, 'claude-haiku-4-5-20251001'],
  ]);
  expect(proposal.stops.map((item) => [item.line, item.reason])).toEqual([
    [4, 'The request sets top_k, which claude-opus-4-8 may reject or treat differently.'],
    [5, 'The request sets thinking, which claude-opus-4-8 may reject or treat differently.'],
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
      // The constant is shared, so it stops on the use count (D-09 is on hold).
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

const HEAD = ["import OpenAI from 'openai';", 'const openai = new OpenAI();'];
const send = (model: string) =>
  `openai.chat.completions.create({ model: ${model}, messages: [] });`;

it('follows this assignments, constructor parameters and private fields from every writer', async () => {
  const root = await repository({
    // The default and the caller literal are edited separately.
    'src/b.ts': [
      ...HEAD,
      'export class B {',
      "  constructor(private model = 'o1-mini') {}",
      `  ask() { return ${send('this.model')} }`,
      '}',
      "new B('gpt-4');",
    ].join('\n'),
    'src/c.ts': [
      ...HEAD,
      'export class C {',
      '  private model: string;',
      '  constructor(opts: any) {',
      "    this.model = opts.model ?? 'gpt-4';",
      '  }',
      `  ask() { return ${send('this.model')} }`,
      '}',
      "new C({ model: 'o1-mini' });",
    ].join('\n'),
    // `new D()` has no argument: the default is what runs.
    'src/d.ts': [
      ...HEAD,
      'export class D {',
      "  constructor(private model = 'gpt-4') {}",
      `  ask() { return ${send('this.model')} }`,
      '}',
      'new D();',
    ].join('\n'),
    'src/e.js': [
      ...HEAD,
      'export class E {',
      '  constructor(opts) {',
      '    this.model = opts.model || "gpt-4";',
      '  }',
      '  reset() { this.model = "o1-mini"; }',
      `  ask() { return ${send('this.model')} }`,
      '}',
    ].join('\n'),
    'src/f.ts': [
      ...HEAD,
      'export class F {',
      "  #model = 'gpt-4';",
      `  ask() { return ${send('this.#model')} }`,
      '}',
    ].join('\n'),
    'src/g.ts': [
      ...HEAD,
      'export class G {',
      '  private options: any;',
      '  constructor(options: any) { this.options = options; }',
      `  ask() { return ${send('this.options.model')} }`,
      '}',
      "new G({ model: 'gpt-4' });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(edited(proposal)).toEqual([
    'src/b.ts:4 o1-mini',
    'src/b.ts:7 gpt-4',
    'src/c.ts:10 o1-mini',
    'src/c.ts:6 gpt-4',
    'src/d.ts:4 gpt-4',
    'src/e.js:5 gpt-4',
    'src/e.js:7 o1-mini',
    'src/f.ts:4 gpt-4',
    'src/g.ts:8 gpt-4',
  ]);
});

it('follows const object members, env fallbacks, conditionals, returned literals and destructuring defaults', async () => {
  const root = await repository({
    'src/members.ts': [
      ...HEAD,
      "const MODELS = { GPT4: 'gpt-4', FAST: 'o1-mini' } as const;",
      "const config = { model: 'gpt-4' };",
      "enum Model { Default = 'o1-mini' }",
      `export const a = () => ${send('MODELS.GPT4')}`,
      `export const b = () => ${send('config.model')}`,
      `export const c = () => ${send('Model.Default')}`,
    ].join('\n'),
    'src/fallbacks.ts': [
      ...HEAD,
      "const ENV_MODEL = process.env.MODEL ?? 'gpt-4';",
      "const PICKED = process.argv.length ? 'gpt-4' : 'o1-mini';",
      `export const a = () => ${send('ENV_MODEL')}`,
      `export const b = () => ${send('PICKED')}`,
    ].join('\n'),
    'src/returns.ts': [
      ...HEAD,
      "function getModel() { return 'gpt-4'; }",
      'export class R {',
      "  getDefaultModel() { return 'o1-mini'; }",
      `  ask() { return ${send('this.getDefaultModel()')} }`,
      '}',
      `export const a = () => ${send('getModel()')}`,
    ].join('\n'),
    'src/destructuring.ts': [
      ...HEAD,
      `function run({ model = 'gpt-4' }) { return ${send('model')} }`,
      "run({ model: 'o1-mini' });",
      `export function fromVariable(opts: any) { const { model = 'o1-mini' } = opts; return ${send('model')} }`,
      `function viaOptions(opts: any) { return ${send("opts.model ?? 'o1-mini'")} }`,
      "viaOptions({ model: 'gpt-4' });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(edited(proposal)).toEqual([
    'src/destructuring.ts:3 gpt-4',
    'src/destructuring.ts:4 o1-mini',
    'src/destructuring.ts:5 o1-mini',
    'src/destructuring.ts:6 o1-mini',
    'src/destructuring.ts:7 gpt-4',
    'src/fallbacks.ts:3 gpt-4',
    'src/fallbacks.ts:4 gpt-4',
    'src/fallbacks.ts:4 o1-mini',
    'src/members.ts:3 gpt-4',
    'src/members.ts:4 gpt-4',
    'src/members.ts:5 o1-mini',
    'src/returns.ts:3 gpt-4',
    'src/returns.ts:5 o1-mini',
  ]);
});

it('follows constants imported from another module', async () => {
  const root = await repository({
    'src/models.ts': "export const MODEL = 'gpt-4';",
    'src/chat.ts': [
      ...HEAD,
      "import { MODEL } from './models';",
      `export const a = () => ${send('MODEL')}`,
    ].join('\n'),
    'app/models.js': "export const MODEL = 'o1-mini';",
    'app/chat.js': [
      "const { OpenAI } = require('openai');",
      "import { MODEL } from './models';",
      'const openai = new OpenAI();',
      `export const a = () => ${send('MODEL')}`,
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(edited(proposal)).toEqual(['app/models.js:1 o1-mini', 'src/models.ts:1 gpt-4']);
});

it('keeps a call-context argument to the call that passes it', async () => {
  const root = await repository({
    'src/pick.ts': [
      ...HEAD,
      'function pick(m: string) { return m; }',
      'declare function encodingForModel(m: string): unknown;',
      `export const a = () => ${send("pick('gpt-4')")}`,
      "export const b = () => encodingForModel(pick('o1-mini'));",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(edited(proposal)).toEqual(['src/pick.ts:5 gpt-4']);
});

it('still traces a descriptor-keyed model the scan classifies as catalog', async () => {
  const root = await repository({
    'src/catalog.ts': [
      ...HEAD,
      "const MODEL = { id: 'gpt-4', label: 'GPT-4' };",
      `export const a = () => ${send('MODEL.id')}`,
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(edited(proposal)).toEqual(['src/catalog.ts:3 gpt-4']);
});

it('stops on a shared source even when every use is a traced request (D-09 on hold)', async () => {
  const root = await repository({
    // Two requests share a constant, and two share a const object member. Editing a shared source
    // waits on an owner decision, so both stop.
    'src/shared.ts': [
      ...HEAD,
      "const MODEL = 'gpt-4';",
      "const MODELS = { GPT4: 'o1-mini' } as const;",
      'type Known = (typeof MODELS)[keyof typeof MODELS];',
      `export const a = () => ${send('MODEL')}`,
      'export const b = () => openai.responses.create({ model: MODEL, input: "x" });',
      `export const c = () => ${send('MODELS.GPT4')}`,
      'export const d = () => openai.responses.create({ model: MODELS.GPT4, input: "x" });',
    ].join('\n'),
  });
  const used = (kind: string, name: string, at: string, times: number, to = 'gpt-5.6-sol') =>
    `The model comes from the ${kind} ${name} (${at}), which is used ${times} times; change it by hand to ${to}.`;
  const shared = await proposeModelReplacements(root, registry, NOW);
  expect(edited(shared)).toEqual([]);
  expect([...new Set(shared.stops.map((item) => item.reason))].sort()).toEqual(
    [
      used('constant', 'MODEL', 'src/shared.ts:3', 2),
      used('constant', 'MODELS', 'src/shared.ts:4', 4, 'gpt-5.6-terra'),
    ].sort(),
  );

  const stopped = await repository({
    'src/log.ts': [
      ...HEAD,
      "const MODEL = 'gpt-4';",
      'console.log(MODEL);',
      `export const a = () => ${send('MODEL')}`,
    ].join('\n'),
    'src/compare.ts': [
      ...HEAD,
      'export class C {',
      "  private model = 'gpt-4';",
      "  is() { return this.model === 'x'; }",
      `  ask() { return ${send('this.model')} }`,
      '}',
    ].join('\n'),
    'src/values.ts': [
      ...HEAD,
      "const MODELS = { GPT4: 'gpt-4' } as const;",
      'export const all = Object.values(MODELS);',
      `export const a = () => ${send('MODELS.GPT4')}`,
    ].join('\n'),
    'src/temperature.ts': [
      ...HEAD,
      "const MODEL = 'gpt-4';",
      `export const a = () => ${send('MODEL')}`,
      'export const b = () => openai.responses.create({ model: MODEL, temperature: 0.2, input: "x" });',
    ].join('\n'),
    'src/in-test.ts': [
      ...HEAD,
      "export const MODEL = 'gpt-4';",
      `export const a = () => ${send('MODEL')}`,
    ].join('\n'),
    'src/in-test.test.ts': [...HEAD, "import { MODEL } from './in-test';", `${send('MODEL')}`].join(
      '\n',
    ),
    // A type position (`typeof MODEL`) is not a use.
    'src/type-use.ts': [
      ...HEAD,
      "export const MODEL = 'o1-mini';",
      'export type Known = typeof MODEL;',
      `export const a = () => ${send('MODEL')}`,
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(stopped, registry, NOW);
  expect(proposal.stops.map((item) => [item.file, item.reason]).sort()).toEqual(
    [
      ['src/compare.ts', used('field', 'model', 'src/compare.ts:4', 2)],
      ['src/in-test.ts', used('constant', 'MODEL', 'src/in-test.ts:3', 2)],
      ['src/log.ts', used('constant', 'MODEL', 'src/log.ts:3', 2)],
      ['src/temperature.ts', used('constant', 'MODEL', 'src/temperature.ts:3', 2)],
      ['src/values.ts', used('constant', 'MODELS', 'src/values.ts:3', 2)],
    ].sort(),
  );
  expect(edited(proposal)).toEqual(['src/type-use.ts:3 o1-mini']);
});

it('follows helper and method parameters to every caller site, including default exports', async () => {
  const root = await repository({
    // Two caller literals on one line, and a method called through `this`.
    'src/ask.ts': [
      ...HEAD,
      `export function ask(messages: any[], model = 'gpt-4') { return ${send('model')} }`,
      "ask([], 'o1-mini'); ask([], 'gpt-4');",
      'export class Runner {',
      `  run(model = 'gpt-4') { return ${send('model')} }`,
      "  go() { return this.run('o1-mini'); }",
      '}',
    ].join('\n'),
    // No callers: only the default.
    'src/lonely.ts': [
      ...HEAD,
      `export function lonely(model = 'gpt-4') { return ${send('model')} }`,
    ].join('\n'),
    'src/default-fn.ts': [
      ...HEAD,
      `export default function renamed(m: any[], model = 'gpt-4') { return ${send('model')} }`,
    ].join('\n'),
    'src/use-default-fn.ts': ["import ask from './default-fn';", "ask([], 'o1-mini');"].join('\n'),
    'src/default-class.ts': [
      ...HEAD,
      'export default class Chat {',
      "  constructor(private model = 'gpt-4') {}",
      `  ask() { return ${send('this.model')} }`,
      '}',
    ].join('\n'),
    'src/use-default-class.ts': [
      "import Chat from './default-class';",
      "new Chat('o1-mini');",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(edited(proposal)).toEqual([
    'src/ask.ts:3 gpt-4',
    'src/ask.ts:4 gpt-4',
    'src/ask.ts:4 o1-mini',
    'src/ask.ts:6 gpt-4',
    'src/ask.ts:7 o1-mini',
    'src/default-class.ts:4 gpt-4',
    'src/default-fn.ts:3 gpt-4',
    'src/lonely.ts:3 gpt-4',
    'src/use-default-class.ts:2 o1-mini',
    'src/use-default-fn.ts:2 o1-mini',
  ]);
  // Both literals on one line are edited and the patch applies.
  await execute('git', ['init', '-q', root]);
  await writeFile(join(root, 'model.patch'), proposal.patch!);
  await execute('git', ['-C', root, 'apply', 'model.patch']);
  expect(await readFile(join(root, 'src/ask.ts'), 'utf8')).toContain(
    "ask([], 'gpt-5.6-terra'); ask([], 'gpt-5.6-sol');",
  );
});

it('applies by-value helper stops regardless of file order', async () => {
  // The by-value use sits before the caller in one layout and after it in the other.
  const ask = `export function ask(messages: any[], model = 'gpt-4') { return ${send('model')} }`;
  const layouts = [
    [ask, 'export const handlers = [ask];', "ask([], 'o1-mini');"],
    [ask, "ask([], 'o1-mini');", 'export const handlers = [ask];'],
  ];
  const results: string[][] = [];
  for (const lines of layouts) {
    const root = await repository({ 'src/ask.ts': [...HEAD, ...lines].join('\n') });
    const proposal = await proposeModelReplacements(root, registry, NOW);
    expect(proposal.replacements).toEqual([]);
    expect(proposal.patch).toBeNull();
    results.push(proposal.stops.map((item) => `${item.model} ${item.reason}`).sort());
  }
  const stop = (model: string, to: string) =>
    `${model} The helper ask (src/ask.ts:3) is also passed as a value; change its model by hand to ${to}.`;
  expect(results[0]).toEqual(
    [stop('gpt-4', 'gpt-5.6-sol'), stop('o1-mini', 'gpt-5.6-terra')].sort(),
  );
  expect(results[1]).toEqual(results[0]);
});

it('stops with the limit named when tracing is cut by the work budget or depth', async () => {
  const limit = (what: string) =>
    `Tracing this model stopped at the ${what}, so not every source and use could be checked; change it by hand to gpt-5.6-sol.`;
  const fanOut = await repository({
    'src/ask.ts': [...HEAD, `export function ask(model: string) { return ${send('model')} }`].join(
      '\n',
    ),
    // More callers than the work budget allows the precise trace to follow.
    'src/callers.ts': [
      "import { ask } from './ask';",
      ...Array.from({ length: 2500 }, () => "ask('gpt-4');"),
    ].join('\n'),
  });
  const wide = await proposeModelReplacements(fanOut, registry, NOW);
  expect(wide.replacements).toEqual([]);
  expect(wide.patch).toBeNull();
  expect(wide.stops).toHaveLength(2500);
  expect(new Set(wide.stops.map((item) => item.reason))).toEqual(
    new Set([limit('work budget of 2,000 steps')]),
  );
  expect(new Set(wide.stops.map((item) => `${item.at.file}:${item.at.line}`)).size).toBe(2500);

  const deep = await repository({
    'src/chain.ts': [
      ...HEAD,
      ...Array.from({ length: 11 }, (_, index) => `const A${index} = A${index + 1};`),
      "const A11 = 'gpt-4';",
      `export const a = () => ${send('A0')}`,
    ].join('\n'),
  });
  const chain = await proposeModelReplacements(deep, registry, NOW);
  expect(chain.replacements).toEqual([]);
  expect(chain.patch).toBeNull();
  expect(chain.stops.map((item) => [item.at.line, item.model, item.reason])).toEqual([
    [14, 'gpt-4', limit('depth limit of 10')],
  ]);

  // Cut, but nothing retiring to name: silent (documented limit).
  const quiet = await repository({
    'src/chain.ts': [
      ...HEAD,
      ...Array.from({ length: 11 }, (_, index) => `const A${index} = A${index + 1};`),
      "const A11 = 'gpt-5.6-sol';",
      `export const a = () => ${send('A0')}`,
    ].join('\n'),
  });
  const silent = await proposeModelReplacements(quiet, registry, NOW);
  expect([silent.replacements, silent.stops]).toEqual([[], []]);
});

it('stops tracing within the work budget on self-referencing assignments', async () => {
  const root = await repository({
    'src/dalle.ts': [
      ...HEAD,
      'export class Dalle {',
      "  model = 'gpt-4';",
      '  constructor(fields?: any) {',
      '    this.model = fields?.model ?? fields?.modelName ?? this.model;',
      '  }',
      `  ask() { return ${send('this.model')} }`,
      '}',
    ].join('\n'),
  });
  const first = await proposeModelReplacements(root, registry, NOW);
  // The field's own read inside the assignment is a use no request reaches, so it stops.
  expect(first.replacements).toEqual([]);
  expect(first.stops.map((item) => [item.at.line, item.model, item.reason])).toEqual([
    [
      4,
      'gpt-4',
      'The model comes from the field model (src/dalle.ts:4), which is used 2 times; change it by hand to gpt-5.6-sol.',
    ],
  ]);
  expect(await proposeModelReplacements(root, registry, NOW)).toEqual(first);
});

it('counts uses written under another name before editing a shared constant', async () => {
  const reason =
    'The model comes from the constant MODEL (src/c.ts:1), which is used 2 times; change it by hand to gpt-5.6-sol.';
  const cases: Record<string, Record<string, string>> = {
    'renamed import': {
      'src/b.ts': [
        "import { MODEL as LEGACY } from './c';",
        "if (LEGACY === 'gpt-4') console.log(1);",
        "export const label = 'Using ' + LEGACY;",
      ].join('\n'),
    },
    'renamed re-export': {
      'src/index.ts': "export { MODEL as DEFAULT_MODEL } from './c';",
      'src/b.ts': [
        "import { DEFAULT_MODEL } from './index';",
        "export const label = 'Using ' + DEFAULT_MODEL;",
      ].join('\n'),
    },
    'export default X under another name': {
      'src/c.ts': ["export const MODEL = 'gpt-4';", 'export default MODEL;'].join('\n'),
      'src/b.ts': ["import Chosen from './c';", "export const label = 'Using ' + Chosen;"].join(
        '\n',
      ),
    },
  };
  for (const [label, extra] of Object.entries(cases)) {
    const root = await repository({
      'src/c.ts': "export const MODEL = 'gpt-4';",
      'src/a.ts': [
        ...HEAD,
        "import { MODEL } from './c';",
        `export const a = () => ${send('MODEL')}`,
      ].join('\n'),
      ...extra,
    });
    const proposal = await proposeModelReplacements(root, registry, NOW);
    expect([label, proposal.replacements]).toEqual([label, []]);
    expect([label, proposal.stops.map((item) => item.reason)]).toEqual([
      label,
      [reason.replace('2 times', label === 'renamed import' ? '3 times' : '2 times')],
    ]);
  }
});

it('stops when another read of the parameter an edited default or caller literal feeds is not a request', async () => {
  const root = await repository({
    'src/default.ts': [
      ...HEAD,
      "export function ask(m: string, model = 'gpt-4') {",
      "  if (model === 'gpt-4') console.log('legacy');",
      '  return openai.chat.completions.create({ model, messages: [] });',
      '}',
    ].join('\n'),
    'src/caller.ts': [
      ...HEAD,
      'export function ask(model: string) {',
      "  if (model === 'gpt-4') console.log('legacy');",
      '  return openai.chat.completions.create({ model, messages: [] });',
      '}',
      "ask('gpt-4');",
    ].join('\n'),
    'src/destructured.ts': [
      ...HEAD,
      "export function ask({ model = 'gpt-4', label }: { model?: string; label?: string }) {",
      '  console.log(model);',
      '  return openai.chat.completions.create({ model, messages: [] });',
      '}',
    ].join('\n'),
    // Reading another property of an options object does not change the model.
    'src/options.ts': [
      ...HEAD,
      'export function ask(options: { model?: string; label?: string }) {',
      '  console.log(options.label);',
      '  return openai.chat.completions.create({ model: options.model, messages: [] });',
      '}',
      "ask({ model: 'o1-mini', label: 'x' });",
    ].join('\n'),
    'src/leaked.ts': [
      ...HEAD,
      'export function ask(options: { model?: string }) {',
      '  console.log(options);',
      '  return openai.chat.completions.create({ model: options.model, messages: [] });',
      '}',
      "ask({ model: 'gpt-4' });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(edited(proposal)).toEqual(['src/options.ts:7 o1-mini']);
  expect(proposal.stops.map((item) => [item.file, item.at.line, item.reason]).sort()).toEqual([
    [
      'src/caller.ts',
      7,
      'The model comes from the parameter model (src/caller.ts:3), which is used 2 times; change it by hand to gpt-5.6-sol.',
    ],
    [
      'src/default.ts',
      3,
      'The model comes from the parameter model (src/default.ts:3), which is used 2 times; change it by hand to gpt-5.6-sol.',
    ],
    [
      'src/destructured.ts',
      3,
      'The model comes from the parameter model (src/destructured.ts:3), which is used 2 times; change it by hand to gpt-5.6-sol.',
    ],
    [
      'src/leaked.ts',
      7,
      'The model comes from the parameter options (src/leaked.ts:3), which is used 2 times; change it by hand to gpt-5.6-sol.',
    ],
  ]);
});

it('stops instead of editing when a client sets a custom base URL or is an Azure client', async () => {
  const reason =
    "The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to gpt-5.6-sol.";
  const root = await repository({
    'src/proxy.ts': [
      ...HEAD.slice(0, 1),
      "const openai = new OpenAI({ baseURL: 'https://my-proxy.example/v1' });",
      `export const a = () => ${send("'gpt-4'")}`,
    ].join('\n'),
    'src/azure.ts': [
      "import { AzureOpenAI } from 'openai';",
      'const client = new AzureOpenAI({ endpoint: process.env.AZURE_ENDPOINT, apiVersion: "2024-10-21" });',
      "export const a = () => client.chat.completions.create({ model: 'gpt-4', messages: [] });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  expect(proposal.stops.map((item) => [item.file, item.model, item.reason]).sort()).toEqual([
    ['src/azure.ts', 'gpt-4', reason],
    [
      'src/proxy.ts',
      'gpt-4',
      "The client sets `baseURL` (src/proxy.ts:2), so the model may name another provider's model or a deployment; change it by hand to gpt-5.6-sol.",
    ],
  ]);

  // Without a base URL or an Azure client the same request is edited, and a raw request to the
  // official host is not held back by a custom client elsewhere.
  const plain = await repository({
    'src/a.ts': [...HEAD, `export const a = () => ${send("'gpt-4'")}`].join('\n'),
    'src/raw.ts':
      "fetch('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'o1-mini', input: 'x' }) });",
  });
  expect(edited(await proposeModelReplacements(plain, registry, NOW))).toEqual([
    'src/a.ts:3 gpt-4',
    'src/raw.ts:1 o1-mini',
  ]);
  const mixed = await repository({
    'src/a.ts': [...HEAD, `export const a = () => ${send("'gpt-4'")}`].join('\n'),
    'src/proxy.ts':
      "import OpenAI from 'openai'; export const other = new OpenAI({ baseUrl: 'https://x.example' });",
    'src/raw.ts':
      "fetch('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'o1-mini', input: 'x' }) });",
  });
  const held = await proposeModelReplacements(mixed, registry, NOW);
  expect(edited(held)).toEqual(['src/raw.ts:1 o1-mini']);
  expect(held.stops.map((item) => [item.file, item.reason])).toEqual([
    [
      'src/a.ts',
      "The repository mentions a custom endpoint (src/proxy.ts:1), but this request's client (src/a.ts:2) sets none; editing it waits on an owner decision on endpoint tracing; change it by hand to gpt-5.6-sol.",
    ],
  ]);
});

it('stops on overridden methods, subclass fields and super(...) arguments instead of dropping them', async () => {
  const root = await repository({
    'src/abstract.ts': [
      ...HEAD,
      'abstract class Base {',
      '  abstract getModel(): string;',
      `  run() { return ${send('this.getModel()')} }`,
      '}',
      "class Impl extends Base { getModel() { return 'gpt-4'; } }",
    ].join('\n'),
    'src/field.ts': [
      ...HEAD,
      'class Base {',
      "  model = 'o1-mini';",
      `  run() { return ${send('this.model')} }`,
      '}',
      "class Impl extends Base { model = 'gpt-4'; }",
    ].join('\n'),
    'src/super.ts': [
      ...HEAD,
      'class Base {',
      '  constructor(private model: string) {}',
      `  run() { return ${send('this.model')} }`,
      '}',
      "class Impl extends Base { constructor() { super('gpt-4'); } }",
    ].join('\n'),
    'src/inherited-constructor.ts': [
      ...HEAD,
      'class Base {',
      '  constructor(private model: string) {}',
      `  run() { return ${send('this.model')} }`,
      '}',
      'class Impl extends Base {}',
      "new Impl('gpt-4');",
    ].join('\n'),
    'src/override-method.ts': [
      ...HEAD,
      'class Base {',
      "  getModel() { return 'o1-mini'; }",
      `  run() { return ${send('this.getModel()')} }`,
      '}',
      "class Impl extends Base { getModel() { return 'gpt-4'; } }",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  const stop = (what: string, to: string) =>
    `${what} is declared or overridden in another class, is an accessor, or sits in a class tree the tracer cannot fully resolve, so the model cannot be traced through class inheritance; change it by hand to ${to}.`;
  const rows = proposal.stops.map((item) => [item.file, item.at.line, item.model, item.reason]);
  expect(rows.sort()).toEqual(
    [
      ['src/abstract.ts', 7, 'gpt-4', stop('The method getModel', 'gpt-5.6-sol')],
      ['src/field.ts', 4, 'o1-mini', stop('The field model', 'gpt-5.6-terra')],
      ['src/field.ts', 7, 'gpt-4', stop('The field model', 'gpt-5.6-sol')],
      ['src/inherited-constructor.ts', 8, 'gpt-4', stop('The class Base', 'gpt-5.6-sol')],
      ['src/override-method.ts', 4, 'o1-mini', stop('The method getModel', 'gpt-5.6-terra')],
      ['src/override-method.ts', 7, 'gpt-4', stop('The method getModel', 'gpt-5.6-sol')],
      ['src/super.ts', 7, 'gpt-4', stop('The class Base', 'gpt-5.6-sol')],
    ].sort(),
  );
});

it('stops every SDK request when any file mentions a custom endpoint, in any shape', async () => {
  const reason =
    "The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to gpt-5.6-sol.";
  const request = `export const a = () => ${send("'gpt-4'")}`;
  const variants: Record<string, Record<string, string>> = {
    'options object': {
      'src/client.ts': [
        "import OpenAI from 'openai';",
        "const opts = { baseURL: 'http://localhost:11434/v1' };",
        'export const other = new OpenAI(opts);',
      ].join('\n'),
    },
    spread: {
      'src/client.ts': [
        "import OpenAI from 'openai';",
        "const base = { baseURL: 'http://x' };",
        'export const other = new OpenAI({ ...base, apiKey: "k" });',
      ].join('\n'),
    },
    assignment: {
      'src/client.ts': [
        "import OpenAI from 'openai';",
        'const c = new OpenAI();',
        "c.baseURL = 'http://x';",
      ].join('\n'),
    },
    withOptions: {
      'src/client.ts': [
        "import OpenAI from 'openai';",
        'export const c = new OpenAI().withOptions({ timeout: 5 });',
      ].join('\n'),
    },
    'process.env variable': {
      'src/client.ts': 'export const url = process.env.OPENAI_BASE_URL;',
    },
    '.env file': { '.env': 'OPENAI_BASE_URL=http://localhost:11434/v1\n' },
    'config yaml': { 'deploy/config.yml': 'openai_api_base: http://x\n' },
  };
  for (const [label, extra] of Object.entries(variants)) {
    const root = await repository({
      'src/a.ts': [...HEAD, request].join('\n'),
      ...extra,
    });
    const proposal = await proposeModelReplacements(root, registry, NOW);
    expect([label, proposal.replacements]).toEqual([label, []]);
    // Where only another client's constructor sets the endpoint, the stop says so; with the
    // endpoint-tracing option (off by default, pending an owner decision) the request is edited.
    const elsewhere = ['options object', 'spread'].includes(label);
    expect([label, proposal.stops.map((item) => [item.file, item.reason])]).toEqual([
      label,
      [
        [
          'src/a.ts',
          elsewhere
            ? "The repository mentions a custom endpoint (src/client.ts:2), but this request's client (src/a.ts:2) sets none; editing it waits on an owner decision on endpoint tracing; change it by hand to gpt-5.6-sol."
            : reason,
        ],
      ],
    ]);
    const traced = await proposeModelReplacements(root, registry, NOW, { endpoints: true });
    expect([label, traced.replacements.length, traced.stops.length]).toEqual([
      label,
      elsewhere ? 1 : 0,
      elsewhere ? 0 : 1,
    ]);
  }
  // A compiler `baseUrl`, files in node_modules, and words that only contain `base`
  // (`firebase_url`, `DATABASE_URL`, `databasePath`) do not count.
  const quiet = await repository({
    'src/a.ts': [...HEAD, request].join('\n'),
    'src/storage.ts': 'export const firebase_url = process.env.DATABASE_URL ?? databasePath;',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":"."}}',
    'node_modules/pkg/config.json': '{"baseURL":"x"}',
  });
  expect(edited(await proposeModelReplacements(quiet, registry, NOW))).toEqual([
    'src/a.ts:3 gpt-4',
  ]);
});

it('stops when the declaring module is loaded in a way the tracer cannot follow', async () => {
  const reason =
    'The module that declares this model is also loaded dynamically or through a namespace the tracer cannot follow; change it by hand to gpt-5.6-sol.';
  const embed = (model: string) => `c.embeddings.create({ model: ${model}, input: 'x' })`;
  const loaders: Record<string, Record<string, string>> = {
    'dynamic import': {
      'src/b.ts': `const c: any = {}; export const f = async () => { const m = await import('./models'); ${embed('m.MODEL')}; };`,
    },
    'dynamic import then': {
      'src/b.js': `const c = {}; import('./models.js').then((m) => ${embed('m.MODEL')});`,
    },
    'TypeScript require': {
      'src/b.ts': `declare const require: any; const c: any = {}; const m = require('./models'); ${embed('m.MODEL')};`,
    },
    'JavaScript require': {
      'src/b.js': `const c = {}; const m = require('./models'); ${embed('m.MODEL')};`,
    },
    'computed namespace key': {
      'src/b.ts': `import * as m from './models'; const c: any = {}; const k = 'MODEL'; ${embed('(m as any)[k]')};`,
    },
    'namespace passed along': {
      'src/b.ts': "import * as m from './models'; export const all = Object.values(m);",
    },
    'export star': { 'src/b.ts': "export * from './models';" },
    'glob import': { 'src/b.ts': "export const all = import.meta.glob('./*.ts');" },
    'unreadable specifier': {
      'src/b.ts': 'export const load = (name: string) => import(name);',
    },
    'barrel namespace': {
      'src/index.ts': "export { MODEL } from './models';",
      'src/b.ts':
        "import * as m from './index'; export const k = (key: string) => (m as any)[key];",
    },
  };
  for (const [label, extra] of Object.entries(loaders)) {
    const root = await repository({
      'src/models.ts': "export const MODEL = 'gpt-4';",
      'src/a.ts': [
        ...HEAD,
        "import { MODEL } from './models';",
        `export const a = () => ${send('MODEL')}`,
      ].join('\n'),
      ...extra,
    });
    const proposal = await proposeModelReplacements(root, registry, NOW);
    expect([label, proposal.replacements]).toEqual([label, []]);
    expect([label, proposal.stops.map((item) => item.reason)]).toEqual([label, [reason]]);
  }
  // A namespace read only as `ns.NAME` is followed, so a shared constant is still edited.
  const followed = await repository({
    'src/models.ts': "export const MODEL = 'gpt-4';",
    'src/a.ts': [
      ...HEAD,
      "import * as m from './models';",
      `export const a = () => ${send('m.MODEL')}`,
    ].join('\n'),
  });
  expect(edited(await proposeModelReplacements(followed, registry, NOW))).toEqual([
    'src/models.ts:1 gpt-4',
  ]);
});

it('stops for mixins, class expressions, aliased bases and accessor models', async () => {
  const stop = (what: string, to: string) =>
    `${what} is declared or overridden in another class, is an accessor, or sits in a class tree the tracer cannot fully resolve, so the model cannot be traced through class inheritance; change it by hand to ${to}.`;
  const cases: Record<
    string,
    { files: Record<string, string>; rows: [string, number, string, string][] }
  > = {
    mixin: {
      files: {
        'src/a.ts': [
          ...HEAD,
          'const Mix = (B: any) => class extends B {};',
          'class A {',
          "  model = 'gpt-4';",
          `  run() { return ${send('this.model')} }`,
          '}',
          "class B2 extends Mix(A) { model = 'o1-mini'; }",
        ].join('\n'),
      },
      rows: [
        ['src/a.ts', 5, 'gpt-4', stop('The field model', 'gpt-5.6-sol')],
        ['src/a.ts', 8, 'o1-mini', stop('The field model', 'gpt-5.6-terra')],
      ],
    },
    'class expression': {
      files: {
        'src/a.ts': [
          ...HEAD,
          'const A = class {',
          "  model = 'gpt-4';",
          `  run() { return ${send('this.model')} }`,
          '};',
          "class B extends A { model = 'o1-mini'; }",
        ].join('\n'),
      },
      rows: [
        ['src/a.ts', 4, 'gpt-4', stop('The field model', 'gpt-5.6-sol')],
        ['src/a.ts', 7, 'o1-mini', stop('The field model', 'gpt-5.6-terra')],
      ],
    },
    'aliased base': {
      files: {
        'src/a.ts': [
          ...HEAD,
          'class A {',
          "  model = 'gpt-4';",
          `  run() { return ${send('this.model')} }`,
          '}',
          'const Base = A;',
          "class B extends Base { model = 'o1-mini'; }",
        ].join('\n'),
      },
      rows: [
        ['src/a.ts', 4, 'gpt-4', stop('The field model', 'gpt-5.6-sol')],
        ['src/a.ts', 8, 'o1-mini', stop('The field model', 'gpt-5.6-terra')],
      ],
    },
    getter: {
      files: {
        'src/a.ts': [
          ...HEAD,
          'class A {',
          "  get model() { return 'gpt-4'; }",
          `  run() { return ${send('this.model')} }`,
          '}',
        ].join('\n'),
      },
      rows: [['src/a.ts', 4, 'gpt-4', stop('The accessor model', 'gpt-5.6-sol')]],
    },
    'abstract getter': {
      files: {
        'src/a.ts': [
          ...HEAD,
          'abstract class A {',
          '  abstract get model(): string;',
          `  run() { return ${send('this.model')} }`,
          '}',
          "class B extends A { get model() { return 'gpt-4'; } }",
        ].join('\n'),
      },
      rows: [['src/a.ts', 7, 'gpt-4', stop('The accessor model', 'gpt-5.6-sol')]],
    },
    'object getter': {
      files: {
        'src/a.ts': [
          ...HEAD,
          "const config = { get model() { return 'gpt-4'; } };",
          `export const a = () => ${send('config.model')}`,
        ].join('\n'),
      },
      rows: [['src/a.ts', 3, 'gpt-4', stop('The accessor model', 'gpt-5.6-sol')]],
    },
    setter: {
      files: {
        'src/a.ts': [
          ...HEAD,
          'class A {',
          "  model = 'gpt-4';",
          '  set model(value: string) { console.log(value); }',
          `  run() { return ${send('this.model')} }`,
          '}',
        ].join('\n'),
      },
      rows: [['src/a.ts', 4, 'gpt-4', stop('The field model', 'gpt-5.6-sol')]],
    },
  };
  for (const [label, { files, rows }] of Object.entries(cases)) {
    const proposal = await proposeModelReplacements(await repository(files), registry, NOW);
    expect([label, proposal.replacements]).toEqual([label, []]);
    expect([
      label,
      proposal.stops.map((item) => [item.file, item.at.line, item.model, item.reason]).sort(),
    ]).toEqual([label, [...rows].sort()]);
  }
});

it('follows default-exported literals and objects and string-literal element access', async () => {
  const root = await repository({
    'src/default-string.ts': "export default 'gpt-4';",
    'src/default-object.ts': "export default { chat: 'o1-mini' };",
    'src/chat.ts': [
      ...HEAD,
      "import model from './default-string';",
      "import models from './default-object';",
      `export const a = () => ${send('model')}`,
      `export const b = () => ${send('models.chat')}`,
    ].join('\n'),
    'src/table.ts': [
      ...HEAD,
      "const MODELS = { fast: 'gpt-4', slow: { id: 'o1-mini' } } as const;",
      `export const a = () => ${send("MODELS['fast']")}`,
      `export const b = () => ${send("MODELS['slow']['id']")}`,
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.stops).toEqual([]);
  expect(edited(proposal)).toEqual([
    'src/default-object.ts:1 o1-mini',
    'src/default-string.ts:1 gpt-4',
    'src/table.ts:3 gpt-4',
    'src/table.ts:3 o1-mini',
  ]);

  // A second use of a default-exported literal is not a request, so it stops.
  const shared = await repository({
    'src/default-string.ts': "export default 'gpt-4';",
    'src/chat.ts': [
      ...HEAD,
      "import model from './default-string';",
      `export const a = () => ${send('model')}`,
      'console.log(model);',
    ].join('\n'),
  });
  const held = await proposeModelReplacements(shared, registry, NOW);
  expect(held.replacements).toEqual([]);
  expect(held.stops).toHaveLength(1);

  // Still untraced and silent, and listed under Limits in docs/DEADLINES.md.
  const untraced = await repository({
    'src/a.ts': [
      ...HEAD,
      "let model = 'gpt-4';",
      `export const a = () => ${send('model')}`,
      "const MODELS = { fast: 'gpt-4' } as const;",
      "export const key = (k: 'fast') => " + send('MODELS[k]'),
      "export const each = ['gpt-4'].forEach((m) => { " + send('m') + ' });',
    ].join('\n'),
  });
  const silent = await proposeModelReplacements(untraced, registry, NOW);
  expect([silent.replacements, silent.stops]).toEqual([[], []]);
});

it('stops when an enum, class or object holding the model is read as a whole or written to', async () => {
  const whole = (kind: string, name: string, at: string) =>
    `The model comes from the ${kind} ${name} (${at}), and its ${kind === 'enum member' ? 'enum' : 'class'} is also used as a whole, so a change shows up elsewhere; change it by hand to gpt-5.6-sol.`;
  const overwritten = (name: string) =>
    `The ${name} member is also assigned to elsewhere, so a request may send another value; change it by hand to gpt-5.6-sol.`;
  const enumUse = (use: string) => ({
    'src/a.ts': [
      ...HEAD,
      "enum E { A = 'gpt-4', B = 'o1-mini' }",
      use,
      `export const a = () => ${send('E.A')}`,
    ].join('\n'),
  });
  const classUse = (use: string) => ({
    'src/a.ts': [
      ...HEAD,
      'class C {',
      "  m = 'gpt-4';",
      `  go() { return ${send('this.m')} }`,
      '}',
      use,
    ].join('\n'),
  });
  const wholeCases: [string, Record<string, string>, string][] = [
    [
      'Object.values(E)',
      enumUse('export const v = Object.values(E);'),
      whole('enum member', 'A', 'src/a.ts:3'),
    ],
    ['const X = E', enumUse('export const X = E;'), whole('enum member', 'A', 'src/a.ts:3')],
    [
      'E[k]',
      enumUse('export const f = (k: string) => (E as any)[k];'),
      whole('enum member', 'A', 'src/a.ts:3'),
    ],
    [
      'for in E',
      enumUse('for (const k in E) console.log(k);'),
      whole('enum member', 'A', 'src/a.ts:3'),
    ],
    [
      'enum in another file',
      {
        'src/e.ts': "export enum E { A = 'gpt-4' }",
        'src/a.ts': [
          ...HEAD,
          "import { E } from './e';",
          `export const a = () => ${send('E.A')}`,
        ].join('\n'),
        'src/b.ts': "import { E } from './e'; export const v = Object.values(E);",
      },
      whole('enum member', 'A', 'src/e.ts:1'),
    ],
    [
      'destructured instance',
      classUse('export const { m } = new C();'),
      whole('field', 'm', 'src/a.ts:4'),
    ],
    [
      'Object.entries(instance)',
      classUse('const c = new C(); export const e = Object.entries(c);'),
      whole('field', 'm', 'src/a.ts:4'),
    ],
    [
      'JSON.stringify(instance)',
      classUse('export const j = JSON.stringify(new C());'),
      whole('field', 'm', 'src/a.ts:4'),
    ],
    [
      'instance passed on',
      classUse('const c = new C(); console.log(c);'),
      whole('field', 'm', 'src/a.ts:4'),
    ],
    ['class as a value', classUse('export const k = [C];'), whole('field', 'm', 'src/a.ts:4')],
    [
      'this as a value',
      {
        'src/a.ts': [
          ...HEAD,
          'class C {',
          "  m = 'gpt-4';",
          `  go() { console.log(Object.keys(this)); return ${send('this.m')} }`,
          '}',
        ].join('\n'),
      },
      whole('field', 'm', 'src/a.ts:4'),
    ],
    [
      'static field written',
      {
        'src/a.ts': [
          ...HEAD,
          'class C { static M = "gpt-4"; }',
          "C.M = 'other';",
          `export const a = () => ${send('C.M')}`,
        ].join('\n'),
      },
      overwritten('M'),
    ],
    [
      'object member assigned',
      {
        'src/a.ts': [
          ...HEAD,
          "const o = { M: 'gpt-4' };",
          "o.M = 'other';",
          `export const a = () => ${send('o.M')}`,
        ].join('\n'),
      },
      overwritten('M'),
    ],
  ];
  for (const [label, files, reason] of wholeCases) {
    const proposal = await proposeModelReplacements(await repository(files), registry, NOW);
    expect([label, proposal.replacements]).toEqual([label, []]);
    expect([
      label,
      proposal.stops.map((item) => item.reason).filter((item) => item === reason).length > 0,
    ]).toEqual([label, true]);
  }
  // Writes to a const object that never reach the member-assignment path still stop.
  for (const write of ["o['M'] = 'other';", 'Object.assign(o, { M: "other" });', 'delete o.M;']) {
    const proposal = await proposeModelReplacements(
      await repository({
        'src/a.ts': [
          ...HEAD,
          "const o: any = { M: 'gpt-4' };",
          write,
          `export const a = () => ${send('o.M')}`,
        ].join('\n'),
      }),
      registry,
      NOW,
    );
    expect([write, proposal.replacements]).toEqual([write, []]);
    expect([write, proposal.stops.length]).toEqual([write, 1]);
  }
  // Plain member reads, an instance read through `.member` and `this.member` stay edits.
  const plain = await repository({
    'src/a.ts': [
      ...HEAD,
      "enum E { A = 'gpt-4' }",
      'type K = keyof typeof E;',
      `export const a = () => ${send('E.A')}`,
    ].join('\n'),
    'src/c.ts': [
      ...HEAD,
      'class C {',
      "  m = 'o1-mini';",
      `  go() { return ${send('this.m')} }`,
      '}',
      'const c = new C(); c.go(); new C().go();',
    ].join('\n'),
  });
  expect(edited(await proposeModelReplacements(plain, registry, NOW))).toEqual([
    'src/a.ts:3 gpt-4',
    'src/c.ts:4 o1-mini',
  ]);
});

it('follows the right side of && and keeps the other shapes untraced', async () => {
  const root = await repository({
    'src/a.ts': [
      ...HEAD,
      'declare const flag: boolean;',
      `export const a = () => ${send("flag && 'gpt-4'")}`,
    ].join('\n'),
  });
  expect(edited(await proposeModelReplacements(root, registry, NOW))).toEqual(['src/a.ts:4 gpt-4']);
  // Silent and listed under Limits in docs/DEADLINES.md.
  const shapes: Record<string, string[]> = {
    'numeric index': ["const L = ['gpt-4'];", send('L[0]')],
    'array destructuring': ["const [A] = ['gpt-4'];", send('A')],
    'rest parameter': [
      'function ask(...args: string[]) {',
      `  return ${send('args[0]')}`,
      '}',
      "ask('gpt-4');",
    ],
    arguments: ['function ask() {', `  return ${send('arguments[0]')}`, '}', "ask('gpt-4');"],
    'this in an object method': ["const o = { m: 'gpt-4', go() { " + send('this.m') + ' } };'],
  };
  for (const [label, lines] of Object.entries(shapes)) {
    const proposal = await proposeModelReplacements(
      await repository({ 'src/a.ts': [...HEAD, ...lines].join('\n') }),
      registry,
      NOW,
    );
    expect([label, proposal.replacements, proposal.stops]).toEqual([label, [], []]);
  }
  // A model spread in from a `const` object is reported, not edited.
  const spread = await proposeModelReplacements(
    await repository({
      'src/a.ts': [
        ...HEAD,
        "const base = { model: 'gpt-4' };",
        'openai.chat.completions.create({ ...base, messages: [] });',
      ].join('\n'),
    }),
    registry,
    NOW,
  );
  expect(spread.replacements).toEqual([]);
  expect(spread.stops).toMatchObject([
    {
      model: 'gpt-4',
      reason:
        'The request takes its model from the options it spreads (`...base`), which Refit reports but does not edit; change it by hand to gpt-5.6-sol.',
    },
  ]);
});
it('reports class property models at their initializers and assignments without editing them', async () => {
  const root = await repository({
    'src/chat.ts': [
      "import OpenAI from 'openai';",
      'export class Chat {',
      '  private client = new OpenAI();',
      "  model = 'gpt-4';",
      '  ask(messages: any[]) {',
      '    return this.client.chat.completions.create({ model: this.model, messages });',
      '  }',
      '}',
    ].join('\n'),
    'src/summary.ts': [
      "import OpenAI from 'openai';",
      'export class Summary {',
      '  private client = new OpenAI();',
      '  constructor(private readonly model: string = "o1-mini") {}',
      '  run(messages: any[]) {',
      '    return this.client.chat.completions.create({ model: this.model, messages });',
      '  }',
      '}',
    ].join('\n'),
    // JavaScript declares the property by assigning it in the constructor.
    'src/agent.js': [
      "const { OpenAI } = require('openai');",
      'class Agent {',
      '  constructor(options) {',
      '    this.client = new OpenAI();',
      "    this.model = options.model || 'gpt-4';",
      '  }',
      '  ask(messages) {',
      '    return this.client.chat.completions.create({ model: this.model, messages });',
      '  }',
      '}',
      'module.exports = { Agent };',
    ].join('\n'),
    // Read again to price the request, so it stops for review.
    'src/priced.ts': [
      "import OpenAI from 'openai';",
      'const PRICES: Record<string, number> = {};',
      'export class Priced {',
      '  private client = new OpenAI();',
      '  private model: string;',
      '  constructor(model?: string) {',
      "    this.model = model ?? 'gpt-4';",
      '  }',
      '  ask(messages: any[]) {',
      '    return this.client.chat.completions.create({ model: this.model, messages });',
      '  }',
      '  cost() {',
      '    return PRICES[this.model];',
      '  }',
      '}',
    ].join('\n'),
  });
  const proposal = await proposeDirect(root, registry, NOW);
  // Until an owner decision covers class properties, each one is reported with where its model is
  // written, and none is edited.
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  expect(
    proposal.stops
      .map((item) => [item.file, item.at, item.model, item.reason])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
  ).toEqual([
    [
      'src/agent.js',
      { file: 'src/agent.js', line: 5 },
      'gpt-4',
      'The model reaches this request through the class field model (src/agent.js:5), which Refit reports but does not edit yet; change it by hand to gpt-5.6-sol.',
    ],
    [
      'src/chat.ts',
      { file: 'src/chat.ts', line: 4 },
      'gpt-4',
      'The model reaches this request through the class field model (src/chat.ts:4), which Refit reports but does not edit yet; change it by hand to gpt-5.6-sol.',
    ],
    [
      'src/priced.ts',
      { file: 'src/priced.ts', line: 7 },
      'gpt-4',
      'The model comes from the field model (src/priced.ts:5), which is used 2 times; change it by hand to gpt-5.6-sol.',
    ],
    [
      'src/summary.ts',
      { file: 'src/summary.ts', line: 4 },
      'o1-mini',
      'The model reaches this request through the class field model (src/summary.ts:4), which Refit reports but does not edit yet; change it by hand to gpt-5.6-terra.',
    ],
  ]);
});

it('never proposes edits in build output committed beside the sources', async () => {
  const request = [
    "import OpenAI from 'openai';",
    'const openai = new OpenAI();',
    "export const ask = () => openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
  ].join('\n');
  const compiled = [
    "const { OpenAI } = require('openai');",
    'const openai = new OpenAI();',
    "exports.ask = () => openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
  ].join('\n');
  const root = await repository({
    'packages/agent/src/ask.ts': request,
    'packages/agent/lib/ask.js': compiled,
    'src/inline.ts': request,
    'src/inline.js': compiled,
    'ts-out/ask.js': compiled,
    'public/app.min.js': compiled,
    // JavaScript with no TypeScript source is the source.
    'lib/only.js': compiled,
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements.map((item) => item.file)).toEqual([
    'lib/only.js',
    'packages/agent/src/ask.ts',
    'src/inline.ts',
  ]);
});

// Until the owner decision on indirect edits (D-06 to D-08) lands, the default proposal edits only
// what the rule edited before: literals, `??` and `||` defaults, constants and enum members used
// once, and helper parameter defaults and callers' literals. Every other site the resolver reaches
// stops with where the model comes from.
it('reports indirect model sources without editing them by default', async () => {
  const root = await repository({
    'src/direct.ts': [
      ...HEAD,
      "const MODEL = 'gpt-4';",
      "export function ask(model = 'o1-mini') { return openai.chat.completions.create({ model, messages: [] }); }",
      `export const a = () => ${send("process.env.MODEL ?? 'gpt-4'")}`,
      `export const b = () => ${send('MODEL')}`,
    ].join('\n'),
    'src/indirect.ts': [
      ...HEAD,
      "const MODELS = { fast: 'gpt-4' } as const;",
      "const COMPUTED = process.env.MODEL ?? 'gpt-4';",
      "function pick() { return 'gpt-4'; }",
      `export const c = () => ${send('MODELS.fast')}`,
      `export const d = () => ${send('COMPUTED')}`,
      `export const e = () => ${send('pick()')}`,
      `export const f = (x: boolean) => ${send("x ? 'gpt-4' : 'o1-mini'")}`,
    ].join('\n'),
    'src/axios.ts': [
      "import axios from 'axios';",
      "export const g = () => axios({ url: 'https://api.openai.com/v1/chat/completions', data: { model: 'gpt-4', messages: [] } });",
    ].join('\n'),
  });
  const reported = await proposeDirect(root, registry, NOW);
  expect(edited(reported)).toEqual([
    'src/direct.ts:3 gpt-4',
    'src/direct.ts:4 o1-mini',
    'src/direct.ts:5 gpt-4',
  ]);
  const later = (source: string, to = 'gpt-5.6-sol') =>
    `The model reaches this request through ${source}, which Refit reports but does not edit yet; change it by hand to ${to}.`;
  expect(
    reported.stops.map((item) => [`${item.at.file}:${item.at.line}`, item.reason]).sort(),
  ).toEqual(
    [
      [
        'src/axios.ts:2',
        '`axios /v1/chat/completions` is an axios request config, which Refit reports but does not edit yet; change it by hand to gpt-5.6-sol.',
      ],
      ['src/indirect.ts:3', later('the object member MODELS.fast (src/indirect.ts:3)')],
      ['src/indirect.ts:4', later('the computed constant COMPUTED (src/indirect.ts:4)')],
      ['src/indirect.ts:5', later('the value returned by pick (src/indirect.ts:8)')],
      ['src/indirect.ts:9', later('a conditional, fallback or computed value')],
      ['src/indirect.ts:9', later('a conditional, fallback or computed value', 'gpt-5.6-terra')],
    ].sort(),
  );
  // With indirect edits enabled, every one of them is edited.
  const enabled = await proposeModelReplacements(root, registry, NOW);
  expect(enabled.stops).toEqual([]);
  expect(edited(enabled)).toHaveLength(9);
});

it('stops on a computed property name in a request, which may hide a sampling parameter', async () => {
  const root = await repository({
    'src/ai.ts': [
      "import OpenAI from 'openai';",
      "import Anthropic from '@anthropic-ai/sdk';",
      'const openai = new OpenAI();',
      'const anthropic = new Anthropic();',
      "const KEY = 'max_tokens';",
      "openai.chat.completions.create({ model: 'gpt-4', ['max_tokens']: 5, messages: [] });",
      "openai.chat.completions.create({ model: 'gpt-4', [KEY]: 5, messages: [] });",
      "anthropic.messages.create({ model: 'claude-3-opus-20240229', [`top_k`]: 5, max_tokens: 9, messages: [] });",
      // A plain request with the same model is still edited.
      "openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  const computed = (to: string) =>
    `The request sets a computed property, which may be a parameter the replacement rejects; change it by hand to ${to}.`;
  expect(proposal.stops.map((item) => [item.line, item.reason])).toEqual([
    [6, computed('gpt-5.6-sol')],
    [7, computed('gpt-5.6-sol')],
    [8, computed('claude-opus-4-8')],
  ]);
  expect(proposal.replacements.map((item) => item.line)).toEqual([9]);
});

// Shapes from the 2026-10-21 Anthropic application benchmark: a model constant with an environment
// or config fallback, a raw fetch to a configurable base URL, a tsconfig extending a generated file,
// and model IDs that no traced request sends.
it('replaces the fallback literal of a model constant used once', async () => {
  const root = await repository({
    'src/agent.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const client = new Anthropic();',
      'export async function run(messages: Anthropic.MessageParam[]) {',
      "  const model = process.env.AGENT_MODEL ?? 'claude-3-opus-20240229';",
      '  return client.messages.create({ model, max_tokens: 64, messages });',
      '}',
    ].join('\n'),
    'src/shared.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const client = new Anthropic();',
      "export const MODEL = process.env.MODEL_ID || process.env.ANTHROPIC_MODEL || 'claude-3-opus-20240229';",
      'export const first = () => client.messages.create({ model: MODEL, max_tokens: 8, messages: [] });',
      'export const second = () => client.messages.create({ model: MODEL, max_tokens: 8, messages: [] });',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toMatchObject([
    {
      file: 'src/agent.ts',
      edited: { file: 'src/agent.ts', line: 4 },
      from: 'claude-3-opus-20240229',
      to: 'claude-opus-4-8',
    },
  ]);
  expect(proposal.patch).toContain(
    "+  const model = process.env.AGENT_MODEL ?? 'claude-opus-4-8';",
  );
  expect(proposal.stops).toMatchObject([
    {
      at: { file: 'src/shared.ts', line: 3 },
      reason:
        'The model comes from the constant MODEL (src/shared.ts:3), which is used 2 times; change it by hand to claude-opus-4-8.',
    },
  ]);
  expect(proposal.unresolved).toEqual([]);
});

// Its URL is not the official host, so it is a custom endpoint and stops rather than being edited.
it('stops on a fetch that sets anthropic-version to another host', async () => {
  const root = await repository({
    'src/probe.ts': [
      'export async function probe(endpoint: { url: string }, apiKey: string) {',
      '  return fetch(endpoint.url, {',
      "    method: 'POST',",
      "    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },",
      "    body: JSON.stringify({ model: 'claude-3-opus-20240229', max_tokens: 1, messages: [] }),",
      '  });',
      '}',
      // Without `messages` the body is not a Messages API request.
      'export async function other(url: string) {',
      '  return fetch(url, {',
      "    headers: { 'anthropic-version': '2023-06-01' },",
      "    body: JSON.stringify({ model: 'claude-3-opus-20240229' }),",
      '  });',
      '}',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  expect(proposal.stops).toMatchObject([
    {
      file: 'src/probe.ts',
      line: 2,
      call: 'fetch with anthropic-version',
      at: { file: 'src/probe.ts', line: 5 },
      reason:
        "The request goes to a host other than the official API, so the model may name another provider's model or a deployment; change it by hand to claude-opus-4-8.",
    },
  ]);
  expect(proposal.unresolved).toMatchObject([
    { file: 'src/probe.ts', line: 11, model: 'claude-3-opus-20240229', to: 'claude-opus-4-8' },
  ]);
});

it('stops for review when the SDK import sits under an unreadable tsconfig', async () => {
  const root = await repository({
    // SvelteKit generates this base file; it is not in a fresh checkout.
    'tsconfig.json': JSON.stringify({
      extends: './.svelte-kit/tsconfig.json',
      compilerOptions: { strict: true },
    }),
    'src/lib/server/claude.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'let client: Anthropic | null = null;',
      'function getClient(): Anthropic {',
      '  if (!client) client = new Anthropic();',
      '  return client;',
      '}',
      'export async function ask(content: string) {',
      '  const claude = getClient();',
      "  return claude.messages.create({ model: 'claude-3-opus-20240229', max_tokens: 64, messages: [{ role: 'user', content }] });",
      '}',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  expect(proposal.stops).toMatchObject([
    {
      file: 'src/lib/server/claude.ts',
      line: 9,
      call: 'messages.create',
      reason: expect.stringContaining('cannot be fully read'),
    },
  ]);
  expect(proposal.unresolved).toEqual([]);
});

it('explains every live model ID that no traced request sends', async () => {
  const withSdk = await repository({
    'src/config.ts': [
      "export const converter = { defaultModel: 'claude-3-opus-20240229', retries: 2 };",
      "export const fallback = process.env.MODEL ?? 'claude-3-opus-20240229';",
    ].join('\n'),
    'src/client.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'export const anthropic = new Anthropic();',
    ].join('\n'),
  });
  const explained = await proposeModelReplacements(withSdk, registry, NOW);
  expect(explained.replacements).toEqual([]);
  expect(explained.stops).toEqual([]);
  expect(explained.unresolved).toEqual([
    {
      deadline: 'anthropic-claude-3-opus',
      provider: 'anthropic',
      file: 'src/config.ts',
      line: 1,
      model: 'claude-3-opus-20240229',
      to: 'claude-opus-4-8',
      reason:
        'No traced request sends it as its model; it is the `defaultModel` value of an object. Check where it is used and change it by hand if it reaches the API.',
    },
    expect.objectContaining({
      line: 2,
      reason: expect.stringContaining('it is assigned to `fallback`'),
    }),
  ]);

  const withoutSdk = await repository({
    'package.json': JSON.stringify({ name: 'app', dependencies: { '@ai-sdk/anthropic': '1.0.0' } }),
    'src/model.ts': [
      "import { anthropic } from '@ai-sdk/anthropic';",
      "export const model = anthropic('claude-3-opus-20240229');",
    ].join('\n'),
  });
  // An AI wrapper SDK call is listed by the wrapper detector (pipeline/model-wrappers.ts).
  const wrapped = await proposeModelReplacements(withoutSdk, registry, NOW);
  expect(wrapped.unresolved).toEqual([]);
  expect(wrapped.stops).toMatchObject([
    { file: 'src/model.ts', line: 2, call: '@ai-sdk/anthropic anthropic()' },
  ]);
  // Without the detector, the same match is unresolved, with where it is written.
  expect(
    (await proposeModelReplacements(withoutSdk, registry, NOW, { reportOnly: [] })).unresolved,
  ).toMatchObject([
    {
      file: 'src/model.ts',
      line: 2,
      reason: expect.stringMatching(
        /^No file imports `@anthropic-ai\/sdk`, `@anthropic-ai\/bedrock-sdk` or `@anthropic-ai\/vertex-sdk`, so the model may reach the API through another library or a wrapper \(it is passed to anthropic\(\)\)\./,
      ),
    },
  ]);
  // A report-only detector's site is listed as its stop, with its reason, instead.
  const wrapper = {
    file: 'src/model.ts',
    line: 2,
    model: 'claude-3-opus-20240229',
    call: '@ai-sdk/anthropic anthropic()',
    reason: 'Reported by a wrapper detector.',
  };
  const reported = await proposeModelReplacements(withoutSdk, registry, NOW, {
    reportOnly: [() => [wrapper], () => [{ ...wrapper, line: 9 }]],
  });
  expect(reported.unresolved).toEqual([]);
  expect(reported.patch).toBeNull();
  expect(reported.stops).toEqual([
    {
      deadline: 'anthropic-claude-3-opus',
      provider: 'anthropic',
      ...wrapper,
      at: { file: 'src/model.ts', line: 2 },
    },
  ]);
});

// A catch-all `paths` entry, common in older Node backends, maps every bare name to `baseUrl` and
// falls back to node_modules, so the SDK package is still the SDK unless a source file shadows it.
it('treats the SDK as the package under a catch-all paths entry unless a source shadows it', async () => {
  const files = {
    'server/tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '../', paths: { '*': ['*'], 'src/*': ['src/*'] } },
    }),
    'server/src/summarize.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export const summarize = (content: string) =>',
      "  anthropic.messages.create({ model: 'claude-3-opus-20240229', max_tokens: 64, messages: [{ role: 'user', content }] });",
    ].join('\n'),
  };
  const package_ = await proposeModelReplacements(await repository(files), registry, NOW);
  expect(package_.replacements).toMatchObject([
    { file: 'server/src/summarize.ts', line: 4, to: 'claude-opus-4-8' },
  ]);

  const shadowed = await proposeModelReplacements(
    await repository({
      ...files,
      '@anthropic-ai/sdk.ts': 'export default class Anthropic { messages = { create() {} }; }',
    }),
    registry,
    NOW,
  );
  expect(shadowed.replacements).toEqual([]);
  expect(shadowed.patch).toBeNull();
  expect(shadowed.unresolved).toMatchObject([{ file: 'server/src/summarize.ts', line: 4 }]);
});

// Messages API shapes real applications use: streaming, beta.messages and a tool-use loop are
// plain requests and are edited; the rest are reported with why they are not.
it('edits streaming, beta and tool-loop Messages requests and stops on helpers, batches and spreads', async () => {
  const root = await repository({
    'src/chat.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export async function chat(messages: any[], tools: any[]) {',
      "  const stream = await anthropic.messages.create({ model: 'claude-3-opus-20240229', max_tokens: 9, messages, stream: true });",
      '  for await (const event of stream) console.log(event);',
      "  await anthropic.messages.stream({ model: 'claude-3-opus-20240229', max_tokens: 9, messages }).on('text', console.log).finalMessage();",
      "  await anthropic.beta.messages.create({ model: 'claude-3-opus-20240229', max_tokens: 9, messages, betas: ['x'] });",
      "  anthropic.beta.messages.stream({ model: 'claude-3-opus-20240229', max_tokens: 9, messages });",
      '  while (true) {',
      "    const response = await anthropic.messages.create({ model: 'claude-3-opus-20240229', max_tokens: 9, tools, messages });",
      "    if (response.stop_reason !== 'tool_use') return response;",
      "    messages.push({ role: 'assistant', content: response.content });",
      '  }',
      '}',
    ].join('\n'),
    'src/other.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export async function other(messages: any[], tools: any[]) {',
      "  await anthropic.beta.messages.toolRunner({ model: 'claude-3-opus-20240229', max_tokens: 9, tools, messages });",
      "  await anthropic.beta.tools.messages.create({ model: 'claude-3-opus-20240229', max_tokens: 9, tools, messages });",
      '  await anthropic.messages.batches.create({',
      "    requests: [{ custom_id: 'a', params: { model: 'claude-3-opus-20240229', max_tokens: 9, messages } }],",
      '  });',
      "  const params = { model: 'claude-3-opus-20240229', max_tokens: 9, tools };",
      '  await anthropic.messages.create({ ...params, messages });',
      '}',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements.map((item) => [item.file, item.line, item.call])).toEqual([
    ['src/chat.ts', 4, 'messages.create'],
    ['src/chat.ts', 6, 'messages.stream'],
    ['src/chat.ts', 7, 'beta.messages.create'],
    ['src/chat.ts', 8, 'beta.messages.stream'],
    ['src/chat.ts', 10, 'messages.create'],
  ]);
  expect(proposal.stops.map((item) => [item.at.line, item.call, item.reason])).toEqual([
    [
      4,
      'beta.messages.toolRunner',
      '`beta.messages.toolRunner` is a Messages API helper or retired beta path, which Refit reports but does not edit; change it by hand to claude-opus-4-8.',
    ],
    [
      5,
      'beta.tools.messages.create',
      '`beta.tools.messages.create` is a Messages API helper or retired beta path, which Refit reports but does not edit; change it by hand to claude-opus-4-8.',
    ],
    [
      7,
      'messages.batches.create',
      '`messages.batches.create` is a Message Batches request, which Refit reports but does not edit; change it by hand to claude-opus-4-8.',
    ],
    [
      9,
      'messages.create',
      'The request takes its model from the options it spreads (`...params`), which Refit reports but does not edit; change it by hand to claude-opus-4-8.',
    ],
  ]);
  expect(proposal.unresolved).toEqual([]);
});

// Claude on Amazon Bedrock and Google Cloud Vertex AI keeps its own model IDs and retirement
// dates, so its requests are reported with the Claude API model they name and never edited.
it('stops on Bedrock and Vertex AI clients and on platform model IDs', async () => {
  const root = await repository({
    'package.json': JSON.stringify({
      name: 'app',
      dependencies: {
        '@anthropic-ai/sdk': '0.40.0',
        '@anthropic-ai/bedrock-sdk': '0.12.0',
        '@anthropic-ai/vertex-sdk': '0.6.0',
      },
    }),
    'src/bedrock.ts': [
      "import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';",
      'const bedrock = new AnthropicBedrock();',
      'export const ask = (messages: any[]) =>',
      "  bedrock.messages.create({ model: 'us.anthropic.claude-3-opus-20240229-v1:0', max_tokens: 9, messages });",
    ].join('\n'),
    'src/vertex.ts': [
      "import AnthropicVertex from '@anthropic-ai/vertex-sdk';",
      "const vertex = new AnthropicVertex({ region: 'us-east5', projectId: 'p' });",
      'export const ask = (messages: any[]) =>',
      "  vertex.messages.stream({ model: 'claude-3-opus@20240229', max_tokens: 9, messages });",
      'export const plain = (messages: any[]) =>',
      "  vertex.messages.create({ model: 'claude-3-opus-20240229', max_tokens: 9, messages });",
    ].join('\n'),
    // A Bedrock ID on the Claude API client (a gateway, say) stops too; the next model is not.
    'src/api.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export const ask = (messages: any[]) =>',
      "  anthropic.messages.create({ model: 'anthropic.claude-3-opus-20240229-v1:0', max_tokens: 9, messages });",
      'export const keep = (messages: any[]) =>',
      "  anthropic.messages.create({ model: 'anthropic.claude-opus-4-8-v1:0', max_tokens: 9, messages });",
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  const bedrock =
    "where model IDs and retirement dates are Amazon Bedrock's, not the Claude API's (the Claude API retires claude-3-opus-20240229 on 2026-01-05); check Amazon Bedrock's model lifecycle and change it by hand to its ID for claude-opus-4-8.";
  const vertex =
    "The client is Claude on Google Cloud Vertex AI, where model IDs and retirement dates are Google Cloud Vertex AI's, not the Claude API's (the Claude API retires claude-3-opus-20240229 on 2026-01-05); check Google Cloud Vertex AI's model lifecycle and change it by hand to its ID for claude-opus-4-8.";
  expect(
    proposal.stops
      .map((item) => [item.file, item.model, item.reason])
      .sort((a, b) => a[0].localeCompare(b[0])),
  ).toEqual([
    [
      'src/api.ts',
      'anthropic.claude-3-opus-20240229-v1:0',
      `\`anthropic.claude-3-opus-20240229-v1:0\` is a model ID for Amazon Bedrock, ${bedrock}`,
    ],
    [
      'src/bedrock.ts',
      'us.anthropic.claude-3-opus-20240229-v1:0',
      `The client is Claude on Amazon Bedrock, ${bedrock}`,
    ],
    ['src/vertex.ts', 'claude-3-opus@20240229', vertex],
    ['src/vertex.ts', 'claude-3-opus-20240229', vertex],
  ]);
});

// A client the analyzer cannot trace to `new Anthropic()` is still the SDK when its declaration
// names the SDK export; its requests are listed with that reason and never edited.
it('lists requests on clients it cannot trace to the SDK constructor', async () => {
  const create = "messages.create({ model: 'claude-3-opus-20240229', max_tokens: 9, messages })";
  const root = await repository({
    'src/clients.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'let lazy: Anthropic | null = null;',
      'try { lazy = new Anthropic(); } catch {}',
      'const maybe: Anthropic | undefined = process.env.KEY ? new Anthropic() : undefined;',
      'const held = { claude: new Anthropic() };',
      'export async function all(messages: any[], given: Anthropic) {',
      `  if (lazy) await lazy.${create};`,
      `  await maybe!.${create};`,
      `  await held.claude.${create};`,
      `  await given.${create};`,
      '}',
      'export class Service {',
      '  constructor(private readonly client: Anthropic) {}',
      `  run(messages: any[]) { return this.client.${create}; }`,
      '}',
    ].join('\n'),
    // Not the SDK: an ORM table that happens to be called `messages`.
    'src/store.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'declare const db: { messages: { create(row: object): void } };',
      "export const save = () => db.messages.create({ model: 'claude-3-opus-20240229' });",
      'export type Client = Anthropic;',
    ].join('\n'),
  });
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.patch).toBeNull();
  const reason = (client: string) =>
    `The client \`${client}\` is not one Refit can trace to the SDK constructor (a \`let\` variable, a typed parameter or field, or an object member), so this request is listed but not edited; change it by hand to claude-opus-4-8.`;
  expect(proposal.stops.map((item) => [item.line, item.reason])).toEqual([
    [7, reason('lazy')],
    [8, reason('maybe')],
    [9, reason('held.claude')],
    [10, reason('given')],
    [14, reason('this.client')],
  ]);
  expect(proposal.unresolved).toMatchObject([{ file: 'src/store.ts', line: 3 }]);
});

// The custom-endpoint stop names the request's own client where its constructor shows one, and
// keeps the repository-wide wording where the client cannot be followed.
it("ties the custom-endpoint stop to the request's own client where it can", async () => {
  const create = "chat.completions.create({ model: 'gpt-4', messages: [] })";
  const root = await repository({
    'src/field.ts': [
      "import OpenAI from 'openai';",
      'export class Chat {',
      "  client = new OpenAI({ apiKey: 'k', baseURL: 'https://router.example/v1' });",
      `  ask() { return this.client.${create}; }`,
      '}',
    ].join('\n'),
    'src/fetch.ts': [
      "import OpenAI from 'openai';",
      'const traced = new OpenAI({ fetch: globalThis.fetch });',
      `export const ask = () => traced.${create};`,
    ].join('\n'),
    // A lazy getter over a `let` is followed through its assignments.
    'src/lazy.ts': [
      "import OpenAI from 'openai';",
      'let cached: OpenAI | null = null;',
      'function client() {',
      '  if (!cached) cached = new OpenAI({ apiKey: process.env.KEY, baseURL: process.env.URL });',
      '  return cached;',
      '}',
      `export const ask = () => client().${create};`,
    ].join('\n'),
    'src/helper.ts': [
      "import OpenAI from 'openai';",
      'const helped = new OpenAI();',
      `const run = (client: OpenAI) => client.${create};`,
      'export const ask = () => run(helped);',
    ].join('\n'),
  });
  for (const endpoints of [false, true]) {
    const proposal = await proposeModelReplacements(root, registry, NOW, { endpoints });
    expect(proposal.replacements).toEqual([]);
    expect(proposal.stops.map((item) => [item.file, item.reason]).sort()).toEqual([
      [
        'src/fetch.ts',
        "The client sets `fetch` (src/fetch.ts:2), so the model may name another provider's model or a deployment; change it by hand to gpt-5.6-sol.",
      ],
      [
        'src/field.ts',
        "The client sets `baseURL` (src/field.ts:3), so the model may name another provider's model or a deployment; change it by hand to gpt-5.6-sol.",
      ],
      [
        'src/helper.ts',
        "The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to gpt-5.6-sol.",
      ],
      [
        'src/lazy.ts',
        "The client sets `baseURL` (src/lazy.ts:4), so the model may name another provider's model or a deployment; change it by hand to gpt-5.6-sol.",
      ],
    ]);
  }
});

// Fixture tables stand in for data/model-parameters.json; no test reads the live file or calls a provider.
const OFFICIAL = 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview';
const table = (...models: Pick<ModelParameterEntry, 'provider' | 'model' | 'parameters'>[]) =>
  ({
    formatVersion: 1,
    models: models.map((model) => ({
      ...model,
      source: OFFICIAL,
      defaultSource: OFFICIAL,
      checkedAt: '2026-10-21',
    })),
  }) as ModelParameterTable;
const PARAMETERS = table(
  {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    parameters: {
      temperature: { accepts: 'default-only', default: 1 },
      top_k: { accepts: 'none' },
    },
  },
  {
    provider: 'anthropic',
    model: 'claude-range-test',
    parameters: { temperature: { accepts: 'any', min: 0, max: 1 } },
  },
  {
    provider: 'openai',
    model: 'gpt-5.6-sol',
    parameters: {
      temperature: { accepts: 'any', min: 0, max: 2 },
      top_p: { accepts: 'default-only', default: 1 },
      max_tokens: { accepts: 'none', renamedTo: 'max_completion_tokens' },
    },
  },
);
const parameterRegistry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    ...registry.deadlines,
    entry({
      id: 'a-sonnet',
      provider: 'anthropic',
      versions: ['claude-3-5-sonnet-20241022'],
      replacement: 'claude-sonnet-5-5',
    }),
    entry({
      id: 'a-range',
      provider: 'anthropic',
      versions: ['claude-range-old'],
      replacement: 'claude-range-test',
    }),
    entry({
      id: 'a-haiku',
      provider: 'anthropic',
      versions: ['claude-3-haiku-20240307'],
      replacement: 'claude-haiku-4-5-20251001',
    }),
    entry({
      id: 'o-nano',
      provider: 'openai',
      versions: ['gpt-4.1-nano'],
      replacement: 'gpt-5.6-luna',
    }),
  ],
};

async function propose(
  target: readonly [provider: 'openai' | 'anthropic', model: string],
  extra: string,
  options: { parameters?: ModelParameterTable } = { parameters: PARAMETERS },
) {
  const [provider, model] = target;
  const call =
    provider === 'openai'
      ? `openai.chat.completions.create({ model: '${model}', messages: [], ${extra} })`
      : `anthropic.messages.create({ model: '${model}', max_tokens: 9, messages: [], ${extra} })`;
  const root = await repository({
    'src/ai.ts': [
      "import OpenAI from 'openai';",
      "import Anthropic from '@anthropic-ai/sdk';",
      'const openai = new OpenAI();',
      'const anthropic = new Anthropic();',
      'const T = 1; const options = {};',
      `export const call = (temperature: number) => ${call};`,
    ].join('\n'),
  });
  return proposeModelReplacements(root, parameterRegistry, NOW, options);
}

const stopped = (reason: string) => [expect.objectContaining({ reason })];
const SONNET = ['anthropic', 'claude-3-5-sonnet-20241022'] as const;
const GPT = ['openai', 'gpt-4'] as const;

it('parameter table: is off unless passed, so the heuristic stop stays', async () => {
  const proposal = await propose(SONNET, 'temperature: 1', {});
  expect(proposal.patch).toBeNull();
  expect(proposal.stops).toEqual(
    stopped(
      'The request sets temperature, which claude-sonnet-5-5 may reject or treat differently.',
    ),
  );
});

it('parameter table: continues for a sourced literal and edits only the model', async () => {
  for (const [args, extra, to] of [
    [SONNET, 'temperature: 1', 'claude-sonnet-5-5'],
    [GPT, 'temperature: 0.7', 'gpt-5.6-sol'],
    [['anthropic', 'claude-range-old'], 'temperature: 0.5', 'claude-range-test'],
  ] as const) {
    const proposal = await propose(args, extra);
    expect(proposal.stops).toEqual([]);
    expect(proposal.replacements.map((item) => item.to)).toEqual([to]);
    // Only the model ID differs between the removed and added text; every parameter is untouched.
    const lines = (proposal.patch ?? '').split('\n');
    const side = (mark: string) =>
      lines.filter((line) => line.startsWith(mark) && !line.startsWith(mark.repeat(3)));
    const removed = side('-').map((line) => line.slice(1));
    const added = side('+').map((line) => line.slice(1));
    expect(added.join('\n')).toBe(removed.join('\n').replace(/model: '[^']+'/, `model: '${to}'`));
  }
});

it.each([
  [
    'unproven top_p on claude-sonnet-5-5',
    SONNET,
    'top_p: 1',
    'The request sets top_p 1, which no official page read for claude-sonnet-5-5 proves it accepts; change it by hand to claude-sonnet-5-5.',
  ],
  [
    'non-default temperature',
    SONNET,
    'temperature: 0.2',
    'The request sets temperature 0.2, which claude-sonnet-5-5 accepts only at 1 (non-default value); change it by hand to claude-sonnet-5-5.',
  ],
  [
    'top_k',
    SONNET,
    'top_k: 5',
    'The request sets top_k 5, which claude-sonnet-5-5 does not accept; change it by hand to claude-sonnet-5-5.',
  ],
  [
    'a constant',
    SONNET,
    'temperature: T',
    'The request sets temperature to a value that is not a numeric literal, so it cannot be checked against what claude-sonnet-5-5 accepts; change it by hand to claude-sonnet-5-5.',
  ],
  [
    'a shorthand property',
    SONNET,
    'temperature',
    'The request sets temperature to a value that is not a numeric literal, so it cannot be checked against what claude-sonnet-5-5 accepts; change it by hand to claude-sonnet-5-5.',
  ],
  [
    'an Anthropic value out of range',
    ['anthropic', 'claude-range-old'] as const,
    'temperature: 1.5',
    'The request sets temperature 1.5, outside the 0 to 1 range claude-range-test accepts; change it by hand to claude-range-test.',
  ],
  [
    'an OpenAI value out of range',
    GPT,
    'temperature: -1',
    'The request sets temperature -1, outside the 0 to 2 range gpt-5.6-sol accepts; change it by hand to gpt-5.6-sol.',
  ],
  [
    'an OpenAI non-default top_p',
    GPT,
    'top_p: 0.5',
    'The request sets top_p 0.5, which gpt-5.6-sol accepts only at 1 (non-default value); change it by hand to gpt-5.6-sol.',
  ],
  [
    'an OpenAI parameter without a spec',
    GPT,
    'presence_penalty: 0',
    'The request sets presence_penalty 0, which no official page read for gpt-5.6-sol proves it accepts; change it by hand to gpt-5.6-sol.',
  ],
  [
    'a string numeral',
    GPT,
    "temperature: '0.7'",
    'The request sets temperature to a value that is not a numeric literal, so it cannot be checked against what gpt-5.6-sol accepts; change it by hand to gpt-5.6-sol.',
  ],
  [
    'a renamed parameter',
    GPT,
    'max_tokens: 100',
    'The request sets max_tokens 100, which gpt-5.6-sol does not accept; it takes max_completion_tokens instead, and Refit does not rename parameters; change it by hand to gpt-5.6-sol.',
  ],
  [
    'only the failing parameter in a mix',
    GPT,
    'temperature: 0.7, top_p: 0.5',
    'The request sets top_p 0.5, which gpt-5.6-sol accepts only at 1 (non-default value); change it by hand to gpt-5.6-sol.',
  ],
  [
    'a spread, ahead of the table',
    GPT,
    '...options, temperature: 0.7',
    'The request spreads other options, which may set parameters the replacement rejects.',
  ],
  [
    'a computed string key',
    SONNET,
    "['temperature']: 0.5",
    'The request sets a computed property, which may be a parameter the replacement rejects; change it by hand to claude-sonnet-5-5.',
  ],
  [
    'a computed template key',
    SONNET,
    '[`top_k`]: 5',
    'The request sets a computed property, which may be a parameter the replacement rejects; change it by hand to claude-sonnet-5-5.',
  ],
  [
    'a computed OpenAI key',
    GPT,
    "['max_tokens']: 5",
    'The request sets a computed property, which may be a parameter the replacement rejects; change it by hand to gpt-5.6-sol.',
  ],
  [
    'a computed variable key',
    GPT,
    '[T]: 5',
    'The request sets a computed property, which may be a parameter the replacement rejects; change it by hand to gpt-5.6-sol.',
  ],
])('parameter table: stops for %s', async (_name, args, extra, reason) => {
  const proposal = await propose(args, extra);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.stops).toEqual(stopped(reason));
  // Nothing is rewritten, renamed parameters included.
  expect(proposal.patch).toBeNull();
});

it("parameter table: keeps today's behavior for replacements with no entry", async () => {
  const haiku = await propose(['anthropic', 'claude-3-haiku-20240307'], 'temperature: 0');
  expect(haiku.replacements.map((item) => item.to)).toEqual(['claude-haiku-4-5-20251001']);
  const opus = await propose(['anthropic', 'claude-3-opus-20240229'], 'temperature: 1');
  expect(opus.stops).toEqual(
    stopped('The request sets temperature, which claude-opus-4-8 may reject or treat differently.'),
  );
  const nano = await propose(['openai', 'gpt-4.1-nano'], 'temperature: 0.7');
  expect(nano.stops).toEqual(
    stopped('The request sets temperature, which gpt-5.6-luna may reject or treat differently.'),
  );
});

it('stops on a computed property name for replacements with no entry too', async () => {
  const computed = (to: string) =>
    stopped(
      `The request sets a computed property, which may be a parameter the replacement rejects; change it by hand to ${to}.`,
    );
  const haiku = await propose(['anthropic', 'claude-3-haiku-20240307'], "['temperature']: 0");
  expect(haiku.replacements).toEqual([]);
  expect(haiku.stops).toEqual(computed('claude-haiku-4-5-20251001'));
  const nano = await propose(['openai', 'gpt-4.1-nano'], "['max_tokens']: 5");
  expect(nano.replacements).toEqual([]);
  expect(nano.stops).toEqual(computed('gpt-5.6-luna'));
});
