import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { scanDeadlines } from './deadline-exposure.ts';
import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import { proposeModelReplacements } from './model-retirements.ts';
import { modelWrapperSites } from './model-wrappers.ts';
import { readRepository } from './repository.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-model-wrappers-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'app', dependencies: { ai: '5.0.0' } }),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const sites = async (files: Record<string, string>) =>
  modelWrapperSites(await readRepository(await repository(files))).map((site) => [
    `${site.file}:${site.line}`,
    site.provider,
    site.version,
    site.via,
    site.text,
    ...(site.custom ? [site.custom] : []),
  ]);

const entry = (
  id: string,
  provider: DeadlineEntry['provider'],
  version: string,
): DeadlineEntry => ({
  id,
  provider,
  kind: 'model',
  versions: [version],
  date: '2026-10-23',
  summary: `${version} retires.`,
  replacement: provider === 'openai' ? 'gpt-5.6-sol' : 'claude-opus-4-8',
  source: 'https://provider.example/deprecations',
  checkedAt: '2026-10-22',
});
const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    entry('openai-gpt-4', 'openai', 'gpt-4'),
    entry('anthropic-claude-3-opus', 'anthropic', 'claude-3-opus-20240229'),
  ],
};
const NOW = new Date('2026-10-22T12:00:00Z');

it('maps Vercel AI SDK provider calls to their provider and model', async () => {
  expect(
    await sites({
      'src/ai.ts': [
        "import { openai, createOpenAI } from '@ai-sdk/openai';",
        "import { anthropic as claude } from '@ai-sdk/anthropic';",
        "import { generateText, embed } from 'ai';",
        "export const a = generateText({ model: openai('gpt-4'), prompt: 'x' });",
        "export const b = generateText({ model: openai.responses('gpt-4o'), prompt: 'x' });",
        "export const c = generateText({ model: claude('claude-3-opus-20240229'), prompt: 'x' });",
        "export const d = embed({ model: openai.embedding('text-embedding-3-small'), value: 'x' });",
        'const custom = createOpenAI({ apiKey: process.env.KEY });',
        "export const e = custom.chat('gpt-4');",
        // Gateway and registry IDs name their provider.
        "export const f = generateText({ model: 'anthropic/claude-3-opus-20240229', prompt: 'x' });",
        'declare const registry: { languageModel(id: string): unknown };',
        "export const g = registry.languageModel('openai:gpt-4');",
        // Not a model: a bare string in a gateway position, another library's call.
        "export const h = generateText({ model: 'my-local-model', prompt: 'x' });",
        "export const i = [].map(() => 'gpt-4');",
      ].join('\n'),
    }),
  ).toEqual([
    ['src/ai.ts:4', 'openai', 'gpt-4', '@ai-sdk/openai openai()', true],
    ['src/ai.ts:5', 'openai', 'gpt-4o', '@ai-sdk/openai openai.responses()', true],
    ['src/ai.ts:6', 'anthropic', 'claude-3-opus-20240229', '@ai-sdk/anthropic claude()', true],
    ['src/ai.ts:7', 'openai', 'text-embedding-3-small', '@ai-sdk/openai openai.embedding()', false],
    ['src/ai.ts:9', 'openai', 'gpt-4', '@ai-sdk/openai custom.chat()', true],
    ['src/ai.ts:10', 'anthropic', 'claude-3-opus-20240229', 'ai generateText()', true],
    ['src/ai.ts:12', 'openai', 'gpt-4', 'ai registry.languageModel()', true],
  ]);
});

it('maps LangChain and LlamaIndex classes, including legacy entry points and initChatModel', async () => {
  expect(
    await sites({
      'src/chains.ts': [
        "import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';",
        "import { ChatAnthropic } from '@langchain/anthropic';",
        "import { initChatModel } from 'langchain/chat_models/universal';",
        "const { ChatOpenAI: Legacy } = require('langchain/chat_models/openai');",
        "export const a = new ChatOpenAI({ model: 'gpt-4', temperature: 0 });",
        "export const b = new ChatAnthropic({ modelName: 'claude-3-opus-20240229' });",
        "export const c = new OpenAIEmbeddings({ model: 'text-embedding-ada-002' });",
        "export const d = new Legacy({ modelName: 'gpt-4' });",
        "export const e = initChatModel('anthropic:claude-3-opus-20240229');",
        "export const f = initChatModel('gpt-4', { modelProvider: 'openai' });",
        // No model given: the class default, which is not a quoted ID.
        'export const g = new ChatOpenAI({ temperature: 0 });',
      ].join('\n'),
      'src/index.ts': [
        "import { OpenAI, Settings } from 'llamaindex';",
        "import { anthropic } from '@llamaindex/anthropic';",
        "Settings.llm = new OpenAI({ model: 'gpt-4' });",
        "export const llm = anthropic({ model: 'claude-3-opus-20240229' });",
      ].join('\n'),
    }),
  ).toEqual([
    ['src/chains.ts:5', 'openai', 'gpt-4', '@langchain/openai new ChatOpenAI()', true],
    [
      'src/chains.ts:6',
      'anthropic',
      'claude-3-opus-20240229',
      '@langchain/anthropic new ChatAnthropic()',
      true,
    ],
    [
      'src/chains.ts:7',
      'openai',
      'text-embedding-ada-002',
      '@langchain/openai new OpenAIEmbeddings()',
      false,
    ],
    ['src/chains.ts:8', 'openai', 'gpt-4', 'langchain/chat_models/openai new ChatOpenAI()', true],
    [
      'src/chains.ts:9',
      'anthropic',
      'claude-3-opus-20240229',
      'langchain/chat_models/universal initChatModel()',
      true,
    ],
    [
      'src/chains.ts:10',
      'openai',
      'gpt-4',
      'langchain/chat_models/universal initChatModel()',
      true,
    ],
    ['src/index.ts:3', 'openai', 'gpt-4', 'llamaindex new OpenAI()', true],
    [
      'src/index.ts:4',
      'anthropic',
      'claude-3-opus-20240229',
      '@llamaindex/anthropic anthropic()',
      true,
    ],
  ]);
});

it('follows constants, object members and environment fallbacks, also across files', async () => {
  expect(
    await sites({
      'src/config.ts': [
        "export const MODEL = process.env.OPENAI_MODEL || 'gpt-4';",
        "export const SETTINGS = { claude: 'claude-3-opus-20240229' } as const;",
      ].join('\n'),
      'src/ai.ts': [
        "import { openai } from '@ai-sdk/openai';",
        "import { ChatAnthropic } from '@langchain/anthropic';",
        "import { MODEL, SETTINGS } from './config';",
        'export const a = openai(MODEL);',
        'export const b = new ChatAnthropic({ model: SETTINGS.claude });',
        "export const c = openai(process.env.FAST ? 'gpt-4' : process.env.OTHER ?? 'gpt-4o');",
        // Not followed: a `let`, a parameter.
        "let mutable = 'gpt-4';",
        'export const d = openai(mutable);',
        'export const e = (model: string) => openai(model);',
      ].join('\n'),
    }),
  ).toEqual([
    ['src/config.ts:1', 'openai', 'gpt-4', '@ai-sdk/openai openai()', true],
    [
      'src/config.ts:2',
      'anthropic',
      'claude-3-opus-20240229',
      '@langchain/anthropic new ChatAnthropic()',
      true,
    ],
    ['src/ai.ts:6', 'openai', 'gpt-4', '@ai-sdk/openai openai()', true],
    ['src/ai.ts:6', 'openai', 'gpt-4o', '@ai-sdk/openai openai()', true],
  ]);
});

it('names a provider set to another endpoint, such as an OpenAI-compatible host', async () => {
  expect(
    await sites({
      'src/ai.ts': [
        "import { createOpenAI } from '@ai-sdk/openai';",
        "import { createOpenAICompatible } from '@ai-sdk/openai-compatible';",
        "import { ChatOpenAI } from '@langchain/openai';",
        "const groq = createOpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: 'k' });",
        "export const a = groq('gpt-4');",
        "const together = createOpenAICompatible({ name: 'together', baseURL: 'https://api.together.xyz/v1' });",
        "export const b = together('gpt-4');",
        "export const c = new ChatOpenAI({ model: 'gpt-4', configuration: { baseURL: 'https://api.fireworks.ai/inference/v1' } });",
      ].join('\n'),
    }),
  ).toEqual([
    ['src/ai.ts:5', 'openai', 'gpt-4', '@ai-sdk/openai groq()', true, '`baseURL` (src/ai.ts:4)'],
    [
      'src/ai.ts:7',
      'openai',
      'gpt-4',
      '@ai-sdk/openai-compatible together()',
      true,
      '`createOpenAICompatible` from @ai-sdk/openai-compatible (src/ai.ts:6)',
    ],
    [
      'src/ai.ts:8',
      'openai',
      'gpt-4',
      '@langchain/openai new ChatOpenAI()',
      true,
      '`configuration` (src/ai.ts:8)',
    ],
  ]);
});

it('skips files that import no wrapper, test files are reported, and type-only imports are not', async () => {
  expect(
    await sites({
      'src/plain.ts': "export const model = openai('gpt-4');",
      'src/types.ts': [
        "import type { ChatOpenAI } from '@langchain/openai';",
        'declare const ChatOpenAIish: new (o: object) => ChatOpenAI;',
        "export const a = new ChatOpenAIish({ model: 'gpt-4' });",
      ].join('\n'),
    }),
  ).toEqual([]);
});

it('feeds gateway IDs and wrapper calls into the deadline scan and lists them as stops', async () => {
  const root = await repository({
    'src/ai.ts': [
      "import { openai, createOpenAI } from '@ai-sdk/openai';",
      "import { generateText } from 'ai';",
      "export const a = generateText({ model: openai('gpt-4'), prompt: 'x' });",
      "export const b = generateText({ model: 'anthropic/claude-3-opus-20240229', prompt: 'x' });",
      "const groq = createOpenAI({ baseURL: 'https://api.groq.com/openai/v1' });",
      "export const c = groq('anthropic/claude-3-opus-20240229');",
    ].join('\n'),
  });
  const scan = await scanDeadlines(root, registry, NOW);
  expect(
    scan.exposures.map((exposure) => [
      exposure.deadline.id,
      exposure.evidence.map((item) => [item.line, item.use, item.via]),
    ]),
  ).toEqual([
    ['anthropic-claude-3-opus', [[4, 'live', 'ai generateText()']]],
    ['openai-gpt-4', [[3, 'live', '@ai-sdk/openai openai()']]],
  ]);
  const proposal = await proposeModelReplacements(root, registry, NOW);
  expect(proposal.replacements).toEqual([]);
  expect(proposal.unresolved).toEqual([]);
  expect(
    proposal.stops
      .map((item) => [item.line, item.model, item.call, item.reason])
      .sort((x, y) => Number(x[0]) - Number(y[0])),
  ).toEqual([
    [
      3,
      'gpt-4',
      '@ai-sdk/openai openai()',
      'The model is sent through @ai-sdk/openai openai() (src/ai.ts:3), a Vercel AI SDK call Refit reports but does not edit; change it by hand.',
    ],
    [
      4,
      'claude-3-opus-20240229',
      'ai generateText()',
      'The model is sent through ai generateText() (src/ai.ts:4), a Vercel AI SDK call Refit reports but does not edit; change it by hand.',
    ],
  ]);
});
