import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fallbackEligible,
  fallbackInput,
  openItems,
  outputGate,
  quotedSources,
  resolvesGate,
  runAiFallback,
  safePath,
  scopeGate,
  secretGate,
  writtenCalls,
  type FallbackDependencies,
  type FallbackInput,
  type OpenItem,
  type ScanBundle,
} from './ai-fallback.ts';
import { fallbackCommand } from './ai-fallback-run.ts';
import type { RequestProof } from './ai-migrations.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const LEGACY = `import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();

export async function ask(prompt: string) {
  const result = await client.completions.create({
    model: 'claude-2.1',
    prompt: \`\\n\\nHuman: \${prompt}\\n\\nAssistant:\`,
    max_tokens_to_sample: 300,
  });
  return result.completion;
}
`;
const FIXED = `import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();

export async function ask(prompt: string) {
  const result = await client.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = result.content[0];
  return block.type === 'text' ? block.text : '';
}
`;

const bundle: ScanBundle = {
  provider: 'anthropic',
  language: 'js',
  exposureSites: [
    {
      deadline: 'anthropic-claude-2',
      provider: 'anthropic',
      kind: 'model',
      replacement: 'claude-sonnet-5-5',
      evidence: [
        { file: 'src/ask.ts', line: 6, version: 'claude-2.1', text: "model: 'claude-2.1'," },
        { file: 'src/other.ts', line: 3, version: 'claude-2.1', text: "'claude-2.1'" },
      ],
    },
  ],
  replacements: [],
  stops: [
    {
      deadline: 'anthropic-claude-2',
      provider: 'anthropic',
      file: 'src/ask.ts',
      line: 5,
      call: 'completions.create',
      at: { file: 'src/ask.ts', line: 6 },
      model: 'claude-2.1',
      reason: 'The call is a Text Completions request, which `claude-sonnet-5-5` does not serve.',
    },
  ],
  unresolved: [],
  alerts: [],
  validation: null,
  migrations: {
    review: [
      {
        provider: 'anthropic',
        kind: 'api-surface',
        rule: 'anthropic-text-completions',
        status: 'review',
        file: 'src/ask.ts',
        line: 5,
        text: 'client.completions.create({',
        summary: 'Text Completions is legacy; the Messages API replaces it.',
      },
      {
        provider: 'anthropic',
        kind: 'api-surface',
        rule: 'anthropic-text-completions',
        status: 'review',
        file: 'test/ask.test.ts',
        line: 2,
        test: true,
      },
      {
        provider: 'anthropic',
        kind: 'beta-feature',
        rule: 'anthropic-beta-note',
        status: 'report',
        file: 'src/ask.ts',
        line: 1,
      },
    ],
    proposal: {
      provider: 'anthropic',
      packageName: '@anthropic-ai/sdk',
      targetMajor: 1,
      stops: [
        {
          file: 'src/ask.ts',
          line: 5,
          rule: 'anthropic-completions-removed',
          reason: 'gone in 1.x',
        },
        {
          file: 'src/sample.ts',
          line: 4,
          rule: 'anthropic-sampling',
          reason: 'optional',
          category: 'optional-upgrade',
        },
      ],
    },
  },
};

describe('open items', () => {
  it('lists every stop, review item and unfixed live match, without optional upgrades, reports or tests', () => {
    const items = openItems(bundle);
    expect(items.map((item) => `${item.kind} ${item.ref} ${item.file}:${item.line}`)).toEqual([
      'model-stop anthropic-claude-2 src/ask.ts:6',
      'sdk-major anthropic-completions-removed src/ask.ts:5',
      'review anthropic-text-completions src/ask.ts:5',
      // src/ask.ts:6 is the stop's site, so only the other live match is its own item.
      'exposure anthropic-claude-2 src/other.ts:3',
    ]);
    expect(items.find((item) => item.kind === 'sdk-major')!.target).toBe('@anthropic-ai/sdk@1');
    expect(items.find((item) => item.kind === 'review')!.changeType).toBe('legacy-endpoint');
    expect(items.find((item) => item.kind === 'exposure')!.target).toBe('claude-sonnet-5-5');
  });

  it('treats a validated replacement as fixing its site, and a failed one as open', () => {
    const replaced: ScanBundle = {
      provider: 'openai',
      exposureSites: [
        {
          deadline: 'openai-gpt-4-0613',
          provider: 'openai',
          kind: 'model',
          replacement: 'gpt-5.6-terra',
          evidence: [{ file: 'a.ts', line: 3, version: 'gpt-4-0613', text: "'gpt-4-0613'" }],
        },
      ],
      replacements: [
        {
          deadline: 'openai-gpt-4-0613',
          provider: 'openai',
          file: 'a.ts',
          line: 2,
          edited: { file: 'a.ts', line: 3 },
          from: 'gpt-4-0613',
          to: 'gpt-5.6-terra',
        },
      ],
    };
    expect(openItems({ ...replaced, validation: { status: 'validated' } })).toEqual([]);
    const failed = openItems({
      ...replaced,
      validation: { status: 'validation-failed', reason: 'patched tests failed' },
    });
    expect(failed.map((item) => item.kind)).toEqual(['model-fix-failed']);
    expect(failed[0].reason).toContain('patched tests failed');
  });

  it('keeps only the row provider', () => {
    expect(openItems({ ...bundle, provider: 'openai' })).toEqual([]);
  });

  it('sends every row Refit left open, whatever its outcome, except settled ones', () => {
    const items = openItems(bundle);
    for (const outcome of [
      'needs-review',
      'validation-failed',
      'no-checks',
      'detection-only',
      'validated',
    ])
      expect(fallbackEligible(outcome, items)).toBe(true);
    for (const outcome of [
      'optional-upgrade',
      'report-only',
      'unaffected',
      'error',
      'infrastructure',
    ])
      expect(fallbackEligible(outcome, items)).toBe(false);
    expect(fallbackEligible('needs-review', [])).toBe(false);
  });
});

describe('sources and input', () => {
  it('quotes the registry page line for a deadline and the rule table for a rule', () => {
    const items = openItems(bundle);
    const sources = quotedSources(items, {
      deadlines: [
        {
          id: 'anthropic-claude-2',
          provider: 'anthropic',
          kind: 'model',
          versions: ['claude-2.1'],
          date: '2025-07-21',
          summary: 'Claude 2 retired',
          replacement: 'claude-sonnet-5-5',
          source: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
          checkedAt: '2026-10-29',
        },
      ],
      quotes: [
        { id: 'anthropic-claude-2', quotes: { 'claude-2.1': '| 2025-07-21 | claude-2.1 |' } },
      ],
      tables: [
        {
          formatVersion: 1,
          provider: 'anthropic',
          kind: 'sdk-major',
          pages: {
            p: { url: 'https://github.com/anthropics/x', file: 'f', capturedAt: '2026-10-29' },
          },
          rules: [
            {
              rule: 'anthropic-completions-removed',
              family: 'f',
              status: 'review',
              page: 'p',
              quote: 'completions were removed',
              checkedAt: '2026-10-29',
              origin: 'docs',
              summary: 's',
              data: {},
            },
          ],
        },
      ],
      findings: [
        {
          rule: 'anthropic-text-completions',
          source: { url: 'https://docs.anthropic.com/t', quote: 'legacy' },
        },
      ],
    });
    expect(sources).toEqual([
      expect.objectContaining({ ref: 'anthropic-claude-2', quote: '| 2025-07-21 | claude-2.1 |' }),
      expect.objectContaining({
        ref: 'anthropic-completions-removed',
        quote: 'completions were removed',
      }),
      expect.objectContaining({ ref: 'anthropic-text-completions', quote: 'legacy' }),
    ]);
  });

  it('sends whole files while they fit and names the rest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-fallback-input-'));
    roots.push(root);
    await writeFile(join(root, 'package.json'), '{"name":"x"}');
    await writeFile(join(root, 'big.ts'), 'x'.repeat(70 * 1024));
    await writeFile(join(root, 'small.ts'), 'const a = 1;\n');
    const item = (file: string): OpenItem => ({
      id: `review:r:${file}:1`,
      kind: 'review',
      provider: 'openai',
      ref: 'r',
      changeType: 'other',
      file,
      line: 1,
      text: '',
      reason: 'x',
      target: null,
    });
    const input = await fallbackInput({
      directory: root,
      provider: 'openai',
      language: 'js',
      items: [item('big.ts'), item('big.ts'), item('small.ts'), item('../escape.ts')],
      sources: [],
      partial: [],
    });
    expect(input.files.map((file) => file.path)).toEqual(['small.ts', 'package.json']);
    expect(input.omitted).toEqual(['big.ts']);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(64 * 1024);
  });

  it('accepts only plain repository paths', () => {
    expect(safePath('src/a.ts')).toBe(true);
    for (const path of ['../a.ts', '/etc/passwd', 'a/../../b', '.git/config', 'C:/x', ''])
      expect(safePath(path)).toBe(false);
  });
});

describe('gates', () => {
  const change = (path: string, before: string | null, after: string) => ({ path, before, after });

  it('output: refuses no change, unparseable code, unseen files and unsafe paths', async () => {
    const originals = new Map([['src/ask.ts', LEGACY]]);
    const answer = (path: string, content: string) => ({
      files: [{ path, content }],
      calls: [],
      notes: [],
      unresolved: [],
      patterns: [],
    });
    expect((await outputGate(answer('src/ask.ts', LEGACY), originals)).detail).toBe(
      'The AI changed no file.',
    );
    expect((await outputGate(answer('src/ask.ts', 'const = ;'), originals)).detail).toBe(
      'src/ask.ts does not parse.',
    );
    expect((await outputGate(answer('app.py', 'def f(:\n'), originals)).detail).toBe(
      'app.py does not parse as Python.',
    );
    expect((await outputGate(answer('package.json', '{'), originals)).detail).toBe(
      'package.json is not valid JSON.',
    );
    expect(
      (await outputGate(answer('src/seen-not.ts', 'x;'), originals, new Set(['src/seen-not.ts'])))
        .detail,
    ).toContain('was not in the input');
    expect((await outputGate(answer('../x.ts', 'x;'), originals)).status).toBe('failed');
    expect((await outputGate(answer('src/ask.ts', FIXED), originals)).status).toBe('passed');
    expect((await outputGate(answer('app.py', 'def f():\n    return 1\n'), originals)).status).toBe(
      'passed',
    );
  });

  it('secrets: refuses key shapes, environment key values and .env files', () => {
    expect(secretGate([change('src/ask.ts', LEGACY, FIXED)], {}).status).toBe('passed');
    const key = `const key = 'sk-ant-${'a'.repeat(30)}';\n`;
    expect(secretGate([change('src/ask.ts', LEGACY, LEGACY + key)], {}).detail).toBe(
      'An added line in src/ask.ts holds an Anthropic key.',
    );
    expect(
      secretGate([change('src/g.ts', '', `const k = "AIza${'b'.repeat(35)}";\n`)], {}).detail,
    ).toContain('Google API key');
    const value = 'refit-test-value-0123456789';
    expect(
      secretGate([change('src/x.ts', '', `fetch(u, { h: '${value}' });\n`)], {
        OPENAI_API_KEY: value,
      }).detail,
    ).toBe("An added line in src/x.ts holds the value of a key in Refit's environment.");
    expect(secretGate([change('.env.local', null, 'A=1\n')], {}).detail).toBe(
      'The patch writes .env.local, an environment file.',
    );
    // A key already in the file is not the patch's doing.
    const kept = `const old = 'sk-proj-${'c'.repeat(30)}';\n`;
    expect(secretGate([change('src/k.ts', kept, `${kept}export {};\n`)], {}).status).toBe('passed');
  });

  it('scope: refuses tests, check configuration, CI, lockfiles, scripts and invented models', () => {
    const context = {
      repositoryModels: new Set(['claude-2.1']),
      targets: new Set(['claude-sonnet-5-5']),
    };
    expect(scopeGate([change('src/ask.ts', LEGACY, FIXED)], context).status).toBe('passed');
    const manifest = '{"scripts":{"test":"vitest"},"dependencies":{"@anthropic-ai/sdk":"^0.30.0"}}';
    expect(
      scopeGate([change('package.json', manifest, manifest.replace('^0.30.0', '^1.2.0'))], context)
        .status,
    ).toBe('passed');
    expect(
      scopeGate([change('package.json', manifest, manifest.replace('vitest', 'true'))], context)
        .detail,
    ).toContain('changes the scripts');
    for (const [path, words] of [
      ['src/ask.test.ts', 'test file'],
      ['tests/test_ask.py', 'test file'],
      ['package-lock.json', 'lockfile'],
      ['.github/workflows/ci.yml', 'decides what the checks run'],
      ['tsconfig.json', 'decides what the checks run'],
      ['vitest.config.ts', 'decides what the checks run'],
    ])
      expect(scopeGate([change(path, 'a', 'b')], context).detail).toContain(words);
    expect(
      scopeGate(
        [change('src/ask.ts', LEGACY, FIXED.replace('claude-sonnet-5-5', 'claude-opus-9'))],
        context,
      ).detail,
    ).toBe(
      'The patch names the model claude-opus-9, which is neither in the repository nor a registry target.',
    );
  });

  it('resolves: passes only when the rescan finds none of the items and nothing new', () => {
    const items = openItems(bundle);
    expect(resolvesGate(items, []).status).toBe('passed');
    const left = resolvesGate(items, [{ ...items[0], line: 9 }]);
    expect(left.status).toBe('failed');
    expect(left.detail).toContain('still finds 1 of 4 open items');
    const fresh = resolvesGate(items, [{ ...items[0], ref: 'new-deadline' }]);
    expect(fresh.detail).toContain('1 new ones');
  });

  it('request proof: proves every call the patch writes, reported or not', () => {
    const calls = writtenCalls({ files: [], calls: [], notes: [], unresolved: [], patterns: [] }, [
      change('src/ask.ts', LEGACY, FIXED),
    ]);
    expect(calls).toEqual([{ call: 'messages.create', stream: false, tools: false, json: false }]);
  });
});

describe('checks command', () => {
  it('chains tests, build and type check', () => {
    expect(
      fallbackCommand(
        {
          scripts: { test: 'vitest run', build: 'vite build' },
          devDependencies: { typescript: '5' },
        },
        true,
      ),
    ).toEqual({
      command: ['sh', '-c', 'npm test && npm run build && npx --no-install tsc --noEmit'],
      compareTypeErrors: true,
    });
    expect(
      fallbackCommand({ scripts: { build: 'tsc -b' }, devDependencies: { typescript: '5' } }, true),
    ).toEqual({ command: ['npm', 'run', 'build'], compareTypeErrors: true });
    expect(fallbackCommand({ scripts: { test: 'echo "Error: no test specified"' } }, false)).toBe(
      null,
    );
  });
});

describe('runAiFallback', () => {
  const input: FallbackInput = {
    provider: 'anthropic',
    language: 'js',
    items: openItems(bundle).filter((item) => item.file === 'src/ask.ts'),
    sources: [],
    targets: [{ item: 'x', target: 'claude-sonnet-5-5' }],
    partial: [],
    files: [{ path: 'src/ask.ts', content: LEGACY }],
    omitted: [],
  };
  const accepted: RequestProof = {
    status: 'accepted',
    reason: 'Accepted with claude-haiku-5-5.',
    calls: [{ call: 'messages.create', status: 'accepted', detail: 'text parsed' }],
  };
  const reply = (files: Array<{ path: string; content: string }>, costUsd = 0.04) =>
    (async () => ({
      status: 'completed',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      responseId: 'resp_1',
      evidenceHash: 'h',
      usage: null,
      budget: { costUsd, spentUsd: costUsd, limitUsd: 1 },
      content: JSON.stringify({
        files,
        calls: [{ call: 'messages.create', stream: false, tools: false, json: false }],
        notes: ['moved to Messages'],
        unresolved: [],
        patterns: [
          { item: input.items[0].id, pattern: 'A Text Completions call with a prompt template.' },
        ],
      }),
    })) as never;
  const dependencies = (overrides: Partial<FallbackDependencies> = {}): FallbackDependencies => ({
    render: async (changed) => ({
      patch: `diff for ${changed.map((file) => file.path).join(',')}\n`,
      refusal: null,
    }),
    rescan: async () => [],
    validate: async () => ({
      status: 'passed',
      command: ['npm', 'test'],
      reason: 'Baseline passed, patched passed.',
    }),
    prove: async () => accepted,
    ...overrides,
  });
  const run = (request: never, deps = dependencies(), language: 'js' | 'py' = 'js') =>
    runAiFallback({
      input: { ...input, language },
      ai: { apiKey: 'k', model: 'gpt-6.1-sol' },
      repositoryModels: new Set(['claude-2.1']),
      exists: async () => false,
      environment: {},
      dependencies: { ...deps, request },
    });

  it('proposes the patch only when every gate passes, with its cost', async () => {
    const result = await run(reply([{ path: 'src/ask.ts', content: FIXED }]));
    expect(result.status).toBe('validated');
    expect(result.suggestion).toBe(false);
    expect(result.gates.map((gate) => `${gate.gate} ${gate.status}`)).toEqual([
      'output passed',
      'secrets passed',
      'scope passed',
      'resolves passed',
      'checks passed',
      'request-proof passed',
    ]);
    expect(result.patch).toBe('diff for src/ask.ts\n');
    expect(result.ai).toEqual({ model: 'gpt-6.1-sol', responseId: 'resp_1', costUsd: 0.04 });
    expect(result.patterns[0].pattern).toContain('Text Completions');
  });

  it('keeps a patch whose checks fail as a suggestion, never a fix', async () => {
    const result = await run(
      reply([{ path: 'src/ask.ts', content: FIXED }]),
      dependencies({
        validate: async () => ({
          status: 'failed',
          command: ['npm', 'test'],
          reason: 'patched failed',
        }),
      }),
    );
    expect(result.status).toBe('needs-review');
    expect(result.suggestion).toBe(true);
    expect(result.patch).toBe('diff for src/ask.ts\n');
    expect(result.reason).toContain('AI attempt kept as a suggestion');
    expect(result.gates.at(-1)).toEqual(
      expect.objectContaining({ gate: 'checks', status: 'failed' }),
    );
  });

  it('stops before the checks when the rescan still finds an item', async () => {
    let validated = false;
    const result = await run(
      reply([{ path: 'src/ask.ts', content: FIXED }]),
      dependencies({
        rescan: async () => [input.items[0]],
        validate: async () => {
          validated = true;
          return { status: 'passed', command: ['npm', 'test'], reason: '' };
        },
      }),
    );
    expect(result.status).toBe('needs-review');
    expect(validated).toBe(false);
  });

  it('keeps no patch at all when it holds a secret', async () => {
    const result = await run(
      reply([{ path: 'src/ask.ts', content: `${FIXED}const k = 'sk-ant-${'z'.repeat(30)}';\n` }]),
    );
    expect(result.status).toBe('needs-review');
    expect(result.patch).toBe(null);
    expect(result.suggestion).toBe(false);
  });

  it('fails a rejected or pending request proof', async () => {
    const result = await run(
      reply([{ path: 'src/ask.ts', content: FIXED }]),
      dependencies({
        prove: async () => ({ status: 'rejected', reason: 'messages.create: HTTP 400', calls: [] }),
      }),
    );
    expect(result.status).toBe('needs-review');
    expect(result.gates.at(-1)!.detail).toContain('HTTP 400');
  });

  it('never validates Python, which has no check runner yet', async () => {
    const result = await run(
      reply([{ path: 'app.py', content: 'def f():\n    return 1\n' }]),
      dependencies(),
      'py',
    );
    expect(result.status).toBe('needs-review');
    expect(result.gates.find((gate) => gate.gate === 'checks')!.detail).toContain(
      'no offline Python',
    );
  });

  it('records a failed request as no attempt instead of throwing', async () => {
    const result = await run((async () => {
      throw new Error('AI budget exhausted');
    }) as never);
    expect(result.status).toBe('no-attempt');
    expect(result.reason).toContain('AI budget exhausted');
  });

  it('marks a refused key, model access or quota as AI unavailable, not a failure', async () => {
    for (const status of [401, 403, 429]) {
      const result = await run((async () => {
        throw new Error(`OpenAI response request failed with HTTP ${status}. No retry was made.`);
      }) as never);
      expect(result.status).toBe('ai-unavailable');
      expect(result.reason).toContain('not a miss');
    }
    const other = await run((async () => {
      throw new Error('OpenAI response request failed with HTTP 500. No retry was made.');
    }) as never);
    expect(other.status).toBe('no-attempt');
  });

  it('does not call the AI when nothing is open or no file fits', async () => {
    let called = false;
    const request = (async () => {
      called = true;
    }) as never;
    const empty = await runAiFallback({
      input: { ...input, items: [] },
      ai: { apiKey: 'k', model: 'm' },
      repositoryModels: new Set(),
      exists: async () => false,
      dependencies: { ...dependencies(), request },
    });
    expect(empty.status).toBe('no-attempt');
    const unfit = await runAiFallback({
      input: { ...input, files: [], omitted: ['src/ask.ts'] },
      ai: { apiKey: 'k', model: 'm' },
      repositoryModels: new Set(),
      exists: async () => false,
      dependencies: { ...dependencies(), request },
    });
    expect(unfit.reason).toContain('src/ask.ts');
    expect(called).toBe(false);
  });
});
