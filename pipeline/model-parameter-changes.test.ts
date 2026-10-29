import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import {
  checkParameterChanges,
  DEFAULT_PARAMETER_CHANGES,
  loadParameterChanges,
  type ParameterChangeTable,
} from './model-parameter-changes.ts';
import { modelFixBody } from './model-fixes.ts';
import { proposeModelReplacements } from './model-retirements.ts';

const NOW = new Date('2026-10-29T00:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-parameter-changes-'));
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

const entry = (
  id: string,
  provider: DeadlineEntry['provider'],
  versions: string[],
  replacement: string,
): DeadlineEntry => ({
  id,
  provider,
  kind: 'model',
  versions,
  date: '2026-12-11',
  summary: `${id} retires.`,
  replacement,
  source: 'https://provider.example/deprecations',
  checkedAt: '2026-10-29',
});

const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    entry('openai-gpt-4', 'openai', ['gpt-4'], 'gpt-5.6-sol'),
    entry('openai-gpt-4o-2024-08-06', 'openai', ['gpt-4o-2024-08-06'], 'gpt-6-luna'),
    entry(
      'anthropic-claude-3-5-sonnet',
      'anthropic',
      ['claude-3-5-sonnet-20241022'],
      'claude-sonnet-5-5',
    ),
    entry(
      'anthropic-claude-3-haiku',
      'anthropic',
      ['claude-3-haiku-20240307'],
      'claude-haiku-4-5-20251001',
    ),
  ],
};

const openai = (body: string) =>
  [
    "import OpenAI from 'openai';",
    'const client = new OpenAI();',
    'export async function ask(messages: any[]) {',
    `  return client.chat.completions.create(${body});`,
    '}',
  ].join('\n');
const anthropic = (body: string) =>
  [
    "import Anthropic from '@anthropic-ai/sdk';",
    'const client = new Anthropic();',
    'export async function ask(messages: any[]) {',
    `  return client.messages.create(${body});`,
    '}',
  ].join('\n');

async function propose(source: string, withChanges = true) {
  const root = await repository({ 'src/ai.ts': source });
  const parameterChanges = withChanges ? await loadParameterChanges() : undefined;
  return proposeModelReplacements(root, registry, NOW, { parameterChanges });
}

describe('sourced parameter changes applied with the swap', () => {
  it('renames max_tokens for a GPT-5.6 replacement and names the change', async () => {
    const proposal = await propose(
      openai("{\n    model: 'gpt-4',\n    max_tokens: 300,\n    messages,\n  }"),
    );
    expect(proposal.stops).toEqual([]);
    expect(proposal.replacements).toHaveLength(1);
    expect(proposal.replacements[0].parameters).toEqual([
      {
        file: 'src/ai.ts',
        line: 6,
        name: 'max_tokens',
        action: 'rename',
        to: 'max_completion_tokens',
        change: 'openai-chat-max-tokens',
        note: expect.stringContaining('also counts the reasoning tokens'),
      },
    ]);
    expect(proposal.patch).toContain("-    model: 'gpt-4',\n-    max_tokens: 300,");
    expect(proposal.patch).toContain(
      "+    model: 'gpt-5.6-sol',\n+    max_completion_tokens: 300,",
    );
  });

  it('keeps the stop when the table is not passed (off by default)', async () => {
    const proposal = await propose(openai("{ model: 'gpt-4', max_tokens: 300, messages }"), false);
    expect(proposal.replacements).toEqual([]);
    expect(proposal.stops[0].reason).toBe(
      'The request sets max_tokens, which gpt-5.6-sol may reject or treat differently.',
    );
  });

  it('still stops on a parameter no page covers for that replacement', async () => {
    const proposal = await propose(
      openai("{ model: 'gpt-4', temperature: 0.2, max_tokens: 300, messages }"),
    );
    expect(proposal.replacements).toEqual([]);
    expect(proposal.stops[0].reason).toBe(
      'The request sets temperature, which gpt-5.6-sol may reject or treat differently.',
    );
  });

  it('removes sampling parameters Anthropic says to omit on Claude 4.7 and later', async () => {
    const proposal = await propose(
      anthropic(
        "{\n    model: 'claude-3-5-sonnet-20241022',\n    max_tokens: 1024,\n    temperature: 0.2,\n    top_p: 0.9,\n    messages,\n  }",
      ),
    );
    expect(proposal.stops).toEqual([]);
    expect(proposal.replacements[0].parameters?.map((edit) => [edit.action, edit.name])).toEqual([
      ['remove', 'temperature'],
      ['remove', 'top_p'],
    ]);
    expect(proposal.patch).toContain('-    temperature: 0.2,\n-    top_p: 0.9,');
    expect(proposal.patch).toContain(
      "+    model: 'claude-sonnet-5-5',\n+    max_tokens: 1024,\n+    messages,\n+  });",
    );
  });

  it('removes the last property with the separator before it', async () => {
    const proposal = await propose(
      anthropic(
        "{ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, messages, temperature: 0 }",
      ),
    );
    expect(proposal.patch).toContain(
      "+  return client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 1024, messages });",
    );
  });

  it('leaves sampling alone on an earlier Claude replacement', async () => {
    const proposal = await propose(
      anthropic("{ model: 'claude-3-haiku-20240307', max_tokens: 64, temperature: 0.2, messages }"),
    );
    expect(proposal.replacements[0].to).toBe('claude-haiku-4-5-20251001');
    expect(proposal.replacements[0].parameters).toBeUndefined();
    expect(proposal.patch).toContain('temperature: 0.2');
  });

  it('stops where the statement depends on reasoning effort', async () => {
    const proposal = await propose(
      openai(
        "{ model: 'gpt-4o-2024-08-06', temperature: 0.2, reasoning_effort: 'none', messages }",
      ),
    );
    expect(proposal.replacements).toEqual([]);
    expect(proposal.stops[0].reason).toContain(
      'The request sets temperature and reasoning_effort; whether gpt-6-luna accepts temperature depends on reasoning_effort',
    );
  });

  it('stops on functions with why the response changes too, with or without the table', async () => {
    const body = "{ model: 'gpt-4', functions: [], function_call: 'auto', messages }";
    const withTable = await propose(openai(body));
    expect(withTable.replacements).toEqual([]);
    expect(withTable.stops[0].reason).toContain('`message.tool_calls`');
    const without = await propose(openai(body), false);
    expect(without.stops[0].reason).toBe(
      'The request sets functions, function_call, which gpt-5.6-sol may reject or treat differently.',
    );
  });

  it('stops a Chat Completions request with tools moving to GPT-6, with or without the table', async () => {
    const body = "{ model: 'gpt-4o-2024-08-06', tools: [], messages }";
    expect((await propose(openai(body))).stops[0].reason).toContain(
      'only with `reasoning_effort: \"none\"`',
    );
    expect((await propose(openai(body), false)).stops[0].reason).toBe(
      'The request sets tools, which gpt-6-luna may reject or treat differently.',
    );
    // A GPT-5.6 replacement takes tools in Chat Completions as before.
    const sol = await propose(openai("{ model: 'gpt-4', tools: [], messages }"), false);
    expect(sol.replacements.map((item) => item.to)).toEqual(['gpt-5.6-sol']);
  });

  it('stops every request of a function-calling flow together', async () => {
    const source = [
      "import OpenAI from 'openai';",
      'const client = new OpenAI();',
      'export async function run(messages: any[], functions: any[]) {',
      "  const first = await client.chat.completions.create({ model: 'gpt-4', messages, functions });",
      "  messages.push({ role: 'function', name: 'f', content: '{}' });",
      "  return client.chat.completions.create({ model: 'gpt-4', messages });",
      '}',
    ].join('\n');
    for (const withChanges of [true, false]) {
      const proposal = await propose(source, withChanges);
      expect(proposal.replacements).toEqual([]);
      expect(proposal.stops.map((stop) => stop.line)).toEqual([4, 6]);
      expect(proposal.stops[1].reason).toContain('function-calling flow');
    }
  });

  it('never drops a comment with a removed parameter', async () => {
    const proposal = await propose(
      anthropic(
        "{\n    model: 'claude-3-5-sonnet-20241022',\n    temperature: 0.2, // keep answers stable\n    max_tokens: 64,\n    messages,\n  }",
      ),
    );
    expect(proposal.replacements).toEqual([]);
    expect(proposal.stops[0].reason).toBe(
      'Removing temperature would drop a comment or empty the request; remove it by hand.',
    );
  });

  it('never renames onto a name the request already sets', async () => {
    const proposal = await propose(
      openai("{ model: 'gpt-4', max_tokens: 1, max_completion_tokens: 2, messages }"),
    );
    expect(proposal.stops[0].reason).toBe(
      'The request sets both max_tokens and max_completion_tokens; keep one by hand.',
    );
  });
});

describe('checkParameterChanges', () => {
  const page = 'Quoted text that the provider page states verbatim.';
  const pages = {
    'p.md': { text: page, sha256: createHash('sha256').update(page).digest('hex') },
  };
  const table = (change: Record<string, unknown>) => ({
    formatVersion: 1,
    changes: [
      {
        id: 'x',
        provider: 'openai',
        apis: ['chat.completions'],
        models: ['gpt-5.6-sol'],
        parameters: ['max_tokens'],
        action: 'rename',
        to: 'max_completion_tokens',
        page: 'p.md',
        quote: 'Quoted text that the provider page states',
        checkedAt: '2026-10-29',
        note: 'n',
        ...change,
      },
    ],
  });

  it('accepts a quote on its saved page', () => {
    expect(checkParameterChanges(table({}), pages).errors).toEqual([]);
  });

  it('rejects a quote that is not on the page, an edited page and a rename without a target', () => {
    expect(
      checkParameterChanges(table({ quote: 'Something the page never says.' }), pages).errors,
    ).toEqual(['x: the quote is not on p.md verbatim.']);
    expect(
      checkParameterChanges(table({}), { 'p.md': { ...pages['p.md'], text: `${page}!` } }).errors,
    ).toEqual(['x: p.md does not match its recorded SHA-256.']);
    expect(checkParameterChanges(table({ to: undefined }), pages).errors).toEqual([
      'x: a rename names one parameter and its new name; nothing else has to.',
    ]);
  });
});

it('ships a table whose every quote is on its saved page', async () => {
  const table: ParameterChangeTable = await loadParameterChanges();
  expect(table.changes.map((change) => change.id)).toEqual([
    'openai-chat-max-tokens',
    'openai-gpt-6-sampling',
    'anthropic-sampling-4-7',
    'openai-gpt-6-chat-tools',
    'openai-chat-functions',
  ]);
  expect(JSON.parse(await readFile(DEFAULT_PARAMETER_CHANGES, 'utf8')).formatVersion).toBe(1);
});

it('lists each parameter change with its note in the model-fix draft', async () => {
  const proposal = await propose(
    openai("{\n    model: 'gpt-4',\n    max_tokens: 300,\n    messages,\n  }"),
  );
  const outcome = { status: 'passed', exitCode: 0, stdout: '', stderr: '' };
  const body = modelFixBody({
    replacements: proposal.replacements,
    stops: [],
    registry,
    validation: {
      revision: 'a'.repeat(40),
      image: 'node:22-alpine',
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      baseline: outcome,
      patched: outcome,
    },
  });
  expect(body).toContain('## Request parameters changed with the model');
  expect(body).toContain(
    '- `src/ai.ts:6` `max_tokens` → `max_completion_tokens` (`openai-chat-max-tokens`): `max_completion_tokens` also counts the reasoning tokens',
  );
  expect(body).toContain('and the request parameters listed with them');
});
