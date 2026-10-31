import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { loadAiRuleTables, type AiRuleTable } from './ai-rules.ts';
import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import { loadParameterChanges } from './model-parameter-changes.ts';
import { modelFixBody, requestEvidence } from './model-fixes.ts';
import { EMPTY_REQUEST_PROOFS } from './model-request-proofs.ts';
import { proposeModelReplacements } from './model-retirements.ts';

// Synthetic fixtures for the legacy completion rewrites (pipeline/legacy-completions.ts). Their
// shapes follow what the dev sets use (openai-dev-30, anthropic-dev-30); no fixture copies a
// repository's code, and no measurement set was opened.

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>, sdk: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-legacy-completions-'));
  roots.push(root);
  const manifest = {
    name: 'app',
    dependencies: { openai: '5.20.1', '@anthropic-ai/sdk': '0.27.3', ...sdk },
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
    date: '2026-09-28',
    summary: `${overrides.id} retires.`,
    replacement: null,
    source: 'https://provider.example/deprecations',
    checkedAt: '2026-10-29',
    ...overrides,
  };
}

// The registry's chains for these models, as data/deadlines.json has them.
const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    entry({
      id: 'openai-text-davinci-003',
      provider: 'openai',
      versions: ['text-davinci-003'],
      date: '2024-01-04',
      replacement: 'gpt-3.5-turbo-instruct',
    }),
    entry({
      id: 'openai-gpt-3-5-turbo-instruct',
      provider: 'openai',
      versions: ['gpt-3.5-turbo-instruct'],
      replacement: 'gpt-5.6-terra',
    }),
    entry({
      id: 'anthropic-claude-2',
      provider: 'anthropic',
      versions: ['claude-2.0', 'claude-2.1'],
      date: '2025-07-21',
      replacement: 'claude-opus-4-8',
    }),
    entry({
      id: 'anthropic-claude-1',
      provider: 'anthropic',
      versions: ['claude-instant-1.2'],
      date: '2024-11-06',
      replacement: 'claude-haiku-4-5-20251001',
    }),
  ],
};
const NOW = new Date('2026-10-31T12:00:00Z');

async function propose(root: string, options: { aiRules?: AiRuleTable[] } = {}) {
  return proposeModelReplacements(root, registry, NOW, {
    parameterChanges: await loadParameterChanges(),
    ...options,
  });
}

async function applied(root: string, patch: string | null) {
  expect(patch).not.toBeNull();
  await execute('git', ['init', '-q', root]);
  await writeFile(join(root, 'legacy.patch'), patch!);
  await execute('git', ['-C', root, 'apply', 'legacy.patch']);
}

const stopReasons = (proposal: Awaited<ReturnType<typeof propose>>) =>
  proposal.stops.map((item) => [`${item.file}:${item.line}`, item.reason]);

it('moves an OpenAI legacy Completions request and its text read to Responses', async () => {
  const root = await repository({
    'src/lore.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function lore(topic: string) {',
      '  const prompt = `Write a short lore entry about ${topic}.`;',
      '  const completion = await openai.completions.create({',
      '    model: "gpt-3.5-turbo-instruct",',
      '    prompt: prompt,',
      '    max_tokens: 200,',
      '  });',
      '  return completion.choices[0].text.trim();',
      '}',
    ].join('\n'),
    'src/inline.js': [
      "const OpenAI = require('openai');",
      'const openai = new OpenAI();',
      'exports.tagline = async (name) => {',
      "  const text = (await openai.completions.create({ model: 'text-davinci-003', prompt: 'Tagline for ' + name, max_tokens: 32 })).choices[0]?.text;",
      "  return text ?? '';",
      '};',
    ].join('\n'),
  });
  const proposal = await propose(root);
  expect(proposal.stops).toEqual([]);
  expect(
    proposal.replacements.map((item) => [
      `${item.file}:${item.line}`,
      item.from,
      item.to,
      item.rewrites?.map((rewrite) => [rewrite.from, rewrite.to]),
    ]),
  ).toEqual([
    [
      'src/inline.js:4',
      'text-davinci-003',
      'gpt-5.6-terra',
      [['completions.create', 'responses.create']],
    ],
    [
      'src/lore.ts:5',
      'gpt-3.5-turbo-instruct',
      'gpt-5.6-terra',
      [['completions.create', 'responses.create']],
    ],
  ]);
  expect(proposal.replacements[1].rewrites![0].rules).toEqual([
    'openai-legacy-completions-to-responses',
    'openai-legacy-completions-sdk-release',
    'openai-legacy-completions-max-output-tokens',
    'openai-legacy-completions-input',
    'openai-legacy-completions-output-text',
  ]);
  await applied(root, proposal.patch);
  expect(await readFile(join(root, 'src/lore.ts'), 'utf8')).toBe(
    [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function lore(topic: string) {',
      '  const prompt = `Write a short lore entry about ${topic}.`;',
      '  const completion = await openai.responses.create({',
      '    model: "gpt-5.6-terra",',
      '    input: prompt,',
      '    max_output_tokens: 200,',
      '  });',
      '  return completion.output_text.trim();',
      '}',
    ].join('\n'),
  );
  expect(await readFile(join(root, 'src/inline.js'), 'utf8')).toContain(
    "const text = (await openai.responses.create({ model: 'gpt-5.6-terra', input: 'Tagline for ' + name, max_output_tokens: 32 })).output_text;",
  );
});

it('maps a streamed OpenAI completion read in a for await loop to output text deltas', async () => {
  const root = await repository({
    'src/stream.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function write(prompt: string) {',
      '  const stream = await openai.completions.create({',
      "    model: 'gpt-3.5-turbo-instruct',",
      '    prompt,',
      '    max_tokens: 64,',
      '    stream: true,',
      '  });',
      '  for await (const chunk of stream) {',
      "    process.stdout.write(chunk.choices[0]?.text || '');",
      '  }',
      '}',
    ].join('\n'),
  });
  const proposal = await propose(root);
  expect(proposal.stops).toEqual([]);
  await applied(root, proposal.patch);
  expect(await readFile(join(root, 'src/stream.ts'), 'utf8')).toBe(
    [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function write(prompt: string) {',
      '  const stream = await openai.responses.create({',
      "    model: 'gpt-5.6-terra',",
      '    input: prompt,',
      '    max_output_tokens: 64,',
      '    stream: true,',
      '  });',
      '  for await (const chunk of stream) {',
      "    process.stdout.write((chunk.type === 'response.output_text.delta' ? chunk.delta : '') || '');",
      '  }',
      '}',
    ].join('\n'),
  );
});

it('stops an OpenAI legacy request it cannot map, naming what it could not follow', async () => {
  const line = (body: string, read = 'return r.choices[0].text;') =>
    [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function ask(question: string, options: any) {',
      `  const r = await openai.completions.create({ model: 'gpt-3.5-turbo-instruct', ${body} });`,
      `  ${read}`,
      '}',
    ].join('\n');
  const root = await repository({
    // Sampling on a replacement no page says accepts it: the existing parameter rules decide.
    'src/temperature.ts': line('prompt: question, max_tokens: 100, temperature: 0.7'),
    'src/stop.ts': line("prompt: question, max_tokens: 100, stop: ['\\n']"),
    'src/batch.ts': line("prompt: [question, 'second'], max_tokens: 100"),
    'src/small.ts': line('prompt: question, max_tokens: 8'),
    'src/length.ts': line('prompt: question, max_tokens: options.limit'),
    'src/untyped.ts': line('prompt: options.prompt, max_tokens: 100'),
    'src/usage.ts': line(
      'prompt: question, max_tokens: 100',
      'return [r.choices[0].text, r.usage];',
    ),
    'src/whole.ts': line('prompt: question, max_tokens: 100', 'return r.choices;'),
    'src/spread.ts': line('prompt: question, ...options'),
    'src/returned.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export function ask(question: string) {',
      "  return openai.completions.create({ model: 'gpt-3.5-turbo-instruct', prompt: question, max_tokens: 100 });",
      '}',
    ].join('\n'),
    // A stream handed to a library helper (the Vercel AI SDK's OpenAIStream) cannot be followed.
    'src/vercel.ts': [
      "import OpenAI from 'openai';",
      "import { OpenAIStream } from 'ai';",
      'const openai = new OpenAI();',
      'export async function POST(question: string) {',
      "  const response = await openai.completions.create({ model: 'gpt-3.5-turbo-instruct', prompt: question, max_tokens: 100, stream: true });",
      '  return OpenAIStream(response);',
      '}',
    ].join('\n'),
  });
  const proposal = await propose(root);
  expect(proposal.replacements).toEqual([]);
  const model = ' The replacement model is gpt-5.6-terra.';
  expect(Object.fromEntries(stopReasons(proposal))).toEqual({
    'src/temperature.ts:4':
      'The request sets temperature, which gpt-5.6-terra may reject or treat differently.',
    'src/stop.ts:4': `The request sets \`stop\`, which the Responses API has no parameter for; move this call by hand.${model}`,
    'src/batch.ts:4': `Refit cannot show that \`prompt\` is one string (legacy Completions also takes arrays of prompts or tokens, which \`input\` does not); move this call by hand.${model}`,
    'src/small.ts:4': `\`max_tokens\` is 8, below the minimum of 16 for Responses's \`max_output_tokens\`; move this call by hand.${model}`,
    'src/length.ts:4': `\`max_tokens\` is not written as a number, and Responses's \`max_output_tokens\` takes no value below 16; move this call by hand.${model}`,
    'src/untyped.ts:4': `Refit cannot show that \`prompt\` is one string (legacy Completions also takes arrays of prompts or tokens, which \`input\` does not); move this call by hand.${model}`,
    'src/usage.ts:4': `The response \`r\` is read as something other than \`choices[0].text\` (r.usage), which has no mapping; move this call by hand.${model}`,
    'src/whole.ts:4': `The response \`r\` is read as something other than \`choices[0].text\` (r.choices), which has no mapping; move this call by hand.${model}`,
    'src/spread.ts:4': `The request spreads or computes properties, so Refit cannot see every parameter it sends to Responses.${model}`,
    'src/returned.ts:4': `The request's promise is not awaited where it is made (it is returned, chained or passed on), so Refit cannot follow every read of the response; move this call by hand.${model}`,
    'src/vercel.ts:5': `The streamed response is handed to code Refit does not follow rather than read in one \`for await\` loop, so Refit cannot map its events; move this call by hand.${model}`,
  });
});

it('stops OpenAI legacy requests on SDK releases without the Responses API', async () => {
  const root = await repository(
    {
      'src/old.ts': [
        "import OpenAI from 'openai';",
        'const openai = new OpenAI();',
        'export async function ask(question: string) {',
        "  const r = await openai.completions.create({ model: 'gpt-3.5-turbo-instruct', prompt: question, max_tokens: 100 });",
        '  return r.choices[0].text;',
        '}',
      ].join('\n'),
      // A nested project with its own, newer SDK is judged by its own package.json.
      'tools/package.json': JSON.stringify({ name: 'tools', dependencies: { openai: '^4.87.0' } }),
      'tools/ask.ts': [
        "import OpenAI from 'openai';",
        'const openai = new OpenAI();',
        'export async function ask(question: string) {',
        "  const r = await openai.completions.create({ model: 'gpt-3.5-turbo-instruct', prompt: question, max_tokens: 100 });",
        '  return r.choices[0].text;',
        '}',
      ].join('\n'),
    },
    { openai: '4.78.1' },
  );
  const proposal = await propose(root);
  expect(stopReasons(proposal)).toEqual([
    [
      'src/old.ts:4',
      'openai 4.78.1 predates 4.87.0, the first release with the Responses API; upgrade the SDK, then move this call by hand. The replacement model is gpt-5.6-terra.',
    ],
  ]);
  expect(proposal.replacements.map((item) => item.file)).toEqual(['tools/ask.ts']);
});

it('moves an Anthropic Text Completions request to Messages, splitting its turns', async () => {
  const root = await repository({
    'src/single.ts': [
      "import Anthropic, { HUMAN_PROMPT, AI_PROMPT } from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export async function ask(question: string) {',
      '  const completion = await anthropic.completions.create({',
      "    model: 'claude-2.1',",
      '    max_tokens_to_sample: 300,',
      '    prompt: `${HUMAN_PROMPT} ${question}${AI_PROMPT}`,',
      '  });',
      '  return completion.completion;',
      '}',
    ].join('\n'),
    // A leading `Human:` without blank lines still opens the Human turn; stop_sequences stay.
    'src/provider.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'export class Provider {',
      '  private anthropic = new Anthropic();',
      '  async generate(prompt: string) {',
      '    const completion = await this.anthropic.completions.create({',
      '      model: "claude-instant-1.2",',
      '      max_tokens_to_sample: 500,',
      '      prompt: `Human: ${prompt}\\n\\nAssistant:`,',
      '      stop_sequences: ["\\n\\nHuman:"],',
      '    });',
      '    console.log(completion.completion);',
      '    return { content: completion.completion };',
      '  }',
      '}',
    ].join('\n'),
    'src/turns.ts': [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export async function follow(question: string) {',
      '  const completion = await anthropic.completions.create({',
      "    model: 'claude-2.0',",
      '    max_tokens_to_sample: 300,',
      "    prompt: '\\n\\nHuman: Hello.\\n\\nAssistant: Hi! How can I help?\\n\\nHuman: ' + question + '\\n\\nAssistant:',",
      '  });',
      '  return completion.completion;',
      '}',
    ].join('\n'),
    // A constant prompt used only by the request keeps its name and holds the user message.
    'src/constant.ts': [
      "import Anthropic, { HUMAN_PROMPT, AI_PROMPT } from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export async function summarize(text: string) {',
      '  const prompt = `${HUMAN_PROMPT} Summarize:',
      '${text}',
      '${AI_PROMPT}`;',
      "  const completion = await anthropic.completions.create({ model: 'claude-2.1', max_tokens_to_sample: 200, prompt });",
      '  return completion.completion;',
      '}',
    ].join('\n'),
  });
  const proposal = await propose(root);
  expect(proposal.stops).toEqual([]);
  expect(
    proposal.replacements.map((item) => [item.file, item.to, item.rewrites?.[0].to]).sort(),
  ).toEqual([
    ['src/constant.ts', 'claude-opus-4-8', 'messages.create'],
    ['src/provider.ts', 'claude-haiku-4-5-20251001', 'messages.create'],
    ['src/single.ts', 'claude-opus-4-8', 'messages.create'],
    ['src/turns.ts', 'claude-opus-4-8', 'messages.create'],
  ]);
  await applied(root, proposal.patch);
  const text = ".content.map((block) => (block.type === 'text' ? block.text : '')).join('')";
  // The prompt markers the moved prompts used are no longer imported.
  expect(await readFile(join(root, 'src/single.ts'), 'utf8')).toBe(
    [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export async function ask(question: string) {',
      '  const completion = await anthropic.messages.create({',
      "    model: 'claude-opus-4-8',",
      '    max_tokens: 300,',
      "    messages: [{ role: 'user', content: `${question}` }],",
      '  });',
      `  return completion${text};`,
      '}',
    ].join('\n'),
  );
  const provider = await readFile(join(root, 'src/provider.ts'), 'utf8');
  expect(provider).toContain('this.anthropic.messages.create({');
  expect(provider).toContain('      max_tokens: 500,');
  expect(provider).toContain('      messages: [{ role: "user", content: `${prompt}` }],');
  expect(provider).toContain('      stop_sequences: ["\\n\\nHuman:"],');
  expect(provider).toContain(`console.log(completion${text});`);
  expect(provider).toContain(`return { content: completion${text} };`);
  expect(await readFile(join(root, 'src/turns.ts'), 'utf8')).toContain(
    "    messages: [{ role: 'user', content: 'Hello.' }, { role: 'assistant', content: 'Hi! How can I help?' }, { role: 'user', content: `${question}` }],",
  );
  const constant = await readFile(join(root, 'src/constant.ts'), 'utf8');
  expect(constant).toContain("import Anthropic from '@anthropic-ai/sdk';\n");
  expect(constant).toContain('  const prompt = `Summarize:\n${text}`;');
  expect(constant).toContain(
    "anthropic.messages.create({ model: 'claude-opus-4-8', max_tokens: 200, messages: [{ role: 'user', content: prompt }] });",
  );
});

it('maps a streamed Text Completion read in a for await loop to text deltas', async () => {
  const root = await repository({
    'src/stream.js': [
      "const Anthropic = require('@anthropic-ai/sdk');",
      'const anthropic = new Anthropic();',
      'exports.write = async (question) => {',
      '  for await (const part of await anthropic.completions.create({',
      "    model: 'claude-2.1',",
      '    max_tokens_to_sample: 300,',
      '    prompt: `\\n\\nHuman: ${question}\\n\\nAssistant:`,',
      '    stream: true,',
      '  })) process.stdout.write(part.completion);',
      '};',
    ].join('\n'),
  });
  const proposal = await propose(root);
  expect(proposal.stops).toEqual([]);
  await applied(root, proposal.patch);
  expect(await readFile(join(root, 'src/stream.js'), 'utf8')).toContain(
    "  })) process.stdout.write((part.type === 'content_block_delta' && part.delta.type === 'text_delta' ? part.delta.text : ''));",
  );
});

it('stops an Anthropic Text Completions request whose prompt or reads it cannot map', async () => {
  const call = (prompt: string, read = 'return c.completion;', extra = '') =>
    [
      "import Anthropic from '@anthropic-ai/sdk';",
      'const anthropic = new Anthropic();',
      'export async function ask(question: string, history: string) {',
      `  const c = await anthropic.completions.create({ model: 'claude-2.1', max_tokens_to_sample: 300, ${extra}prompt: ${prompt} });`,
      `  ${read}`,
      '}',
    ].join('\n');
  const root = await repository({
    'src/system.ts': call('`You are terse.\\n\\nHuman: ${question}\\n\\nAssistant:`'),
    'src/prefill.ts': call('`\\n\\nHuman: ${question}\\n\\nAssistant: {`'),
    'src/open.ts': call('`\\n\\nHuman: ${question}`'),
    'src/hidden.ts': call('`${history}\\n\\nAssistant:`'),
    'src/parameter.ts': call('question'),
    'src/reason.ts': call(
      '`\\n\\nHuman: ${question}\\n\\nAssistant:`',
      'return [c.completion, c.stop_reason];',
    ),
    // Sampling on the new request is the parameter-change table's decision, as for any swap:
    // anthropic-sampling-4-7 removes it for claude-opus-4-8, in the same patch.
    'src/sampling.ts': call('`\\n\\nHuman: ${question}\\n\\nAssistant:`', undefined, 'top_k: 5, '),
  });
  const proposal = await propose(root);
  expect(
    proposal.replacements.map((item) => [
      item.file,
      item.rewrites?.[0].to,
      item.parameters?.map((edit) => [edit.name, edit.action, edit.change]),
    ]),
  ).toEqual([
    ['src/sampling.ts', 'messages.create', [['top_k', 'remove', 'anthropic-sampling-4-7']]],
  ]);
  const model = ' The replacement model is claude-opus-4-8.';
  expect(Object.fromEntries(stopReasons(proposal))).toEqual({
    'src/system.ts:4': `The prompt has text before its first Human turn, which no saved Anthropic page maps to a Messages field; move this call by hand.${model}`,
    'src/prefill.ts:4': `The prompt puts words in the Assistant turn (prefill), which newer Claude models reject with a 400 error; move this call by hand.${model}`,
    'src/open.ts:4': `The prompt does not end with an \`\\n\\nAssistant:\` turn, so Refit cannot tell where the conversation ends; move this call by hand.${model}`,
    'src/hidden.ts:4': `The prompt does not open with a \`\\n\\nHuman:\` turn Refit can see; the markers may be inside a value it cannot read, so move this call by hand.${model}`,
    'src/parameter.ts:4': `The prompt is not written as a string or template literal Refit can split into Human and Assistant turns (or a constant used only here), so the conversation it sends is unknown; move this call by hand.${model}`,
    'src/reason.ts:4': `The response \`c\` is read as something other than \`completion\` (c.stop_reason), which has no mapping; move this call by hand.${model}`,
  });
  await applied(root, proposal.patch);
  expect(await readFile(join(root, 'src/sampling.ts'), 'utf8')).toContain(
    "  const c = await anthropic.messages.create({ model: 'claude-opus-4-8', max_tokens: 300, messages: [{ role: 'user', content: `${question}` }] });",
  );
});

it('stops Anthropic Text Completions on SDK releases before Messages was generally available', async () => {
  const root = await repository(
    {
      'src/old.ts': [
        "import Anthropic from '@anthropic-ai/sdk';",
        'const anthropic = new Anthropic();',
        'export async function ask(question: string) {',
        "  const c = await anthropic.completions.create({ model: 'claude-2.1', max_tokens_to_sample: 300, prompt: `\\n\\nHuman: ${question}\\n\\nAssistant:` });",
        '  return c.completion;',
        '}',
      ].join('\n'),
    },
    { '@anthropic-ai/sdk': '0.5.10' },
  );
  expect(stopReasons(await propose(root))).toEqual([
    [
      'src/old.ts:4',
      '@anthropic-ai/sdk 0.5.10 predates 0.14.0, the first release with the Messages API; upgrade the SDK, then move this call by hand. The replacement model is claude-opus-4-8.',
    ],
  ]);
});

it('keeps the old stop when a rewrite rule is not auto', async () => {
  const root = await repository({
    'src/lore.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function lore(topic: string) {',
      "  const r = await openai.completions.create({ model: 'gpt-3.5-turbo-instruct', prompt: topic, max_tokens: 50 });",
      '  return r.choices[0].text;',
      '}',
    ].join('\n'),
  });
  const tables = (await loadAiRuleTables()).map((table) => ({
    ...table,
    rules: table.rules.map((rule) =>
      rule.rule === 'openai-legacy-completions-output-text'
        ? { ...rule, status: 'review' as const }
        : rule,
    ),
  }));
  const proposal = await propose(root, { aiRules: tables });
  expect(stopReasons(proposal)).toEqual([
    [
      'src/lore.ts:4',
      "The rewrite rule openai-legacy-completions-output-text is not an auto rule in Refit's tables, so this legacy completion request is not moved; move it by hand. The replacement model is gpt-5.6-terra.",
    ],
  ]);
});

it('proves a moved request as the call it becomes and says so in the draft', async () => {
  const root = await repository({
    'src/lore.ts': [
      "import OpenAI from 'openai';",
      'const openai = new OpenAI();',
      'export async function lore(topic: string) {',
      "  const r = await openai.completions.create({ model: 'gpt-3.5-turbo-instruct', prompt: topic, max_tokens: 50 });",
      '  return r.choices[0].text;',
      '}',
    ].join('\n'),
  });
  const { replacements } = await propose(root);
  const proofs = {
    ...EMPTY_REQUEST_PROOFS,
    proofs: [
      {
        provider: 'openai' as const,
        model: 'gpt-5.6-terra',
        api: 'responses' as const,
        parameters: ['max_output_tokens'],
        checks: { request: 'passed' as const },
        run: 'https://github.com/refit-dev/refit-bench/actions/runs/1',
        date: '2026-10-31',
      },
    ],
  };
  expect(requestEvidence(replacements, proofs)).toEqual([
    expect.objectContaining({
      to: 'gpt-5.6-terra',
      call: 'responses.create',
      proof: proofs.proofs[0],
    }),
  ]);
  const body = modelFixBody({
    replacements,
    stops: [],
    registry,
    proofs,
    validation: {
      revision: '0123456789abcdef',
      image: 'node:22-alpine',
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      baseline: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      patched: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
    },
  });
  expect(body).toContain('## Retired APIs moved to the current API');
  expect(body).toContain(
    '- `src/lore.ts:4` `completions.create` → `responses.create` with `gpt-5.6-terra`',
  );
  expect(body).toContain('`max_output_tokens` also counts');
  expect(body).toContain('- `gpt-5.6-terra` `responses`: accepted');
  expect(body).toContain('the calls moved to the current API');
});
