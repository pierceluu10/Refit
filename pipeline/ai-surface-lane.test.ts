import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aiSurfaceBody, runAiSurfaceMigrations } from './ai-migrations.ts';
import { loadAiRuleTables } from './ai-rules.ts';
import { changedOldLines, proposeAiSurfaceMigration } from './ai-surface-lane.ts';
import { readRepository } from './repository.ts';
import type { DeadlineEntry } from './deadline-registry.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const LEGACY = `import OpenAI from 'openai';
const client = new OpenAI();

export function greet(name: string) {
  return \`hello \${name}\`;
}

export async function complete(prompt: string) {
  const result = await client.completions.create({
    model: 'gpt-3.5-turbo-instruct',
    prompt,
    max_tokens: 200,
  });
  return result.choices[0].text;
}
`;
const MIGRATED = `import OpenAI from 'openai';
const client = new OpenAI();

export function greet(name: string) {
  return \`hello \${name}\`;
}

export async function complete(prompt: string) {
  const result = await client.responses.create({
    model: 'gpt-5.6-terra',
    input: prompt,
    max_output_tokens: 200,
  });
  return result.output_text;
}
`;

const registry: DeadlineEntry[] = [
  {
    id: 'openai-2026-09-28-gpt-3-5-turbo-instruct',
    provider: 'openai',
    kind: 'model',
    versions: ['gpt-3.5-turbo-instruct', 'davinci-002'],
    date: '2026-09-28',
    summary: 'shut down',
    replacement: 'gpt-5.6-terra',
    source: 'https://developers.openai.com/api/docs/deprecations',
    checkedAt: '2026-10-29',
  },
  {
    id: 'openai-2024-01-04-text-davinci-003',
    provider: 'openai',
    kind: 'model',
    versions: ['text-davinci-003'],
    date: '2024-01-04',
    summary: 'shut down',
    replacement: null,
    source: 'https://developers.openai.com/api/docs/deprecations',
    checkedAt: '2026-10-29',
  },
];
const surface = new Set(['responses.create', 'chat.completions.create', 'conversations.create']);

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-lane-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ dependencies: { openai: '^6.49.0' } }),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

function answer(files: { path: string; content: string }[], extra: Record<string, unknown> = {}) {
  const seen: unknown[] = [];
  const request = (async (input: { evidence: unknown }) => {
    seen.push(input.evidence);
    return {
      status: 'completed',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      responseId: 'resp_test',
      evidenceHash: 'x',
      usage: null,
      budget: { costUsd: 0.0123, spentUsd: 0.0123, limitUsd: 1 },
      content: JSON.stringify({
        files,
        calls: [{ call: 'responses.create', stream: false, tools: false, json: false }],
        notes: ['complete(): legacy Completions to Responses'],
        unchanged: [],
        ...extra,
      }),
    };
  }) as never;
  return { request, seen };
}

async function lane(files: Record<string, string>, reply: ReturnType<typeof answer>) {
  const directory = await project(files);
  return proposeAiSurfaceMigration({
    repository: await readRepository(directory, 'openai'),
    directory,
    tables: await loadAiRuleTables(),
    ai: { apiKey: 'test', model: 'gpt-5.6-luna' },
    models: { entries: registry, now: new Date('2026-10-29T00:00:00Z') },
    surface,
    request: reply.request,
  });
}

describe('AI surface lane', () => {
  it('keeps a faithful migration and marks the AI-written lines', async () => {
    const reply = answer([{ path: 'src/llm.ts', content: MIGRATED }]);
    const proposal = (await lane({ 'src/llm.ts': LEGACY }, reply))!;
    expect(proposal.stops).toEqual([]);
    expect(proposal.edits).toEqual([
      expect.objectContaining({ file: 'src/llm.ts', replacement: MIGRATED }),
    ]);
    expect(proposal.aiLines).toEqual([{ file: 'src/llm.ts', lines: [9, 10, 11, 12, 14] }]);
    expect(proposal.ai).toEqual({
      model: 'gpt-5.6-luna',
      responseId: 'resp_test',
      costUsd: 0.0123,
    });
    // The model is given, never chosen: the retired one maps to the registry's replacement.
    const evidence = reply.seen[0] as {
      models: Record<string, string>;
      sites: unknown[];
      guides: string[];
    };
    expect(evidence.models['gpt-3.5-turbo-instruct']).toBe('gpt-5.6-terra');
    expect(evidence.sites).toHaveLength(1);
    expect(evidence.guides[0]).toContain('```javascript');
    expect(evidence.guides[0]).not.toContain('```python');
  });

  it.each([
    ['an invented model', MIGRATED.replace('gpt-5.6-terra', 'gpt-6-sol'), 'names model gpt-6-sol'],
    [
      'the retired model kept',
      MIGRATED.replace('gpt-5.6-terra', 'gpt-3.5-turbo-instruct'),
      'names model gpt-3.5-turbo-instruct',
    ],
    [
      'an edit outside the flagged statement',
      MIGRATED.replace('hello', 'hi'),
      'outside the statements',
    ],
    [
      'a call openai 6 lacks',
      MIGRATED.replace('responses.create', 'responses.generate'),
      'which openai 6 does not have',
    ],
    [
      'a legacy call left',
      `${MIGRATED}export const old = () => client.completions.create({ model: 'gpt-5.6-terra', prompt: 'x' });\n`,
      'legacy Completions',
    ],
    [
      'code that does not parse',
      MIGRATED.replace('return result.output_text;', 'return result.output_text'.concat(' {')),
      'does not parse',
    ],
  ])('rejects %s', async (_name, content, reason) => {
    const proposal = (await lane(
      { 'src/llm.ts': LEGACY },
      answer([{ path: 'src/llm.ts', content }]),
    ))!;
    expect(proposal.edits).toEqual([]);
    expect(proposal.stops).toEqual([
      expect.objectContaining({ reason: expect.stringContaining(reason) }),
    ]);
  });

  it('rejects a change to a file with no flagged site', async () => {
    const proposal = (await lane(
      { 'src/llm.ts': LEGACY, 'src/other.ts': 'export const x = 1;\n' },
      answer([
        { path: 'src/llm.ts', content: MIGRATED },
        { path: 'src/other.ts', content: 'export const x = 2;\n' },
      ]),
    ))!;
    expect(proposal.edits.map((item) => item.file)).toEqual(['src/llm.ts']);
    expect(proposal.stops).toEqual([
      expect.objectContaining({
        file: 'src/other.ts',
        reason: expect.stringContaining('no flagged site'),
      }),
    ]);
  });

  it('sends nothing for a retired model the registry gives no replacement', async () => {
    const reply = answer([]);
    const proposal = (await lane(
      {
        'a.ts': LEGACY.replace('gpt-3.5-turbo-instruct', 'davinci-002').replace(
          /'davinci-002'/,
          "'text-davinci-003'",
        ),
      },
      reply,
    ))!;
    expect(reply.seen).toHaveLength(0);
    expect(proposal.stops[0].reason).toContain('names no replacement');
  });

  it('records a site the AI left unchanged, with its reason', async () => {
    const proposal = (await lane(
      { 'src/llm.ts': LEGACY },
      answer([], { unchanged: ['The thread state lives in OpenAI.'] }),
    ))!;
    expect(proposal.stops).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining('The thread state lives in OpenAI.'),
      }),
    ]);
  });

  it('is not run outside GitHub Actions', async () => {
    await expect(
      runAiSurfaceMigrations({
        repository: await project({}),
        tables: await loadAiRuleTables(),
        checks: { image: 'node:22-alpine', command: ['npm', 'test'] },
        ai: { apiKey: 'test', model: 'm' },
        environment: {},
      }),
    ).rejects.toThrow(/only in GitHub Actions/);
  });

  it('marks AI lines, says outputs may differ and lists every reason for review', () => {
    const body = aiSurfaceBody({
      lane: {
        findings: [],
        edits: [],
        aiLines: [{ file: 'src/llm.ts', lines: [9, 10] }],
        calls: [{ call: 'responses.create' }],
        notes: ['complete(): moved'],
        stops: [],
        ai: { model: 'gpt-5.6-luna', responseId: 'resp_test', costUsd: 0.01 },
      },
      reasons: ['Request proof: pending.'],
      requestProof: { status: 'pending', reason: 'pending.', calls: [] },
      validation: {
        revision: 'a'.repeat(40),
        image: 'node:22-alpine',
        command: ['npm', 'test'],
        baseline: { status: 'passed' },
        patched: { status: 'passed' },
      },
    });
    expect(body).toContain('## Why this needs review');
    expect(body).toContain('an AI model drafted this migration');
    expect(body).toContain('Outputs may differ');
    expect(body).toContain('`src/llm.ts`: lines 9, 10');
    expect(body).toContain('response resp_test, $0.0100');
  });
});

it('diffs lines by their longest common subsequence', () => {
  expect(changedOldLines('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({
    removed: [2],
    added: [2, 4],
    anchors: [2, 3],
  });
});
