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
      "const MODEL = 'gpt-4';",
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
      'The model comes from the constant MODEL (src/ai.ts:5), which may feed other code; change it by hand to gpt-5.6-sol.',
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
