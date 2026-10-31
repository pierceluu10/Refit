import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INSTRUCTIONS,
  fallbackEligible,
  fallbackInput,
  itemExcerpts,
  stopCategory,
  openItems,
  outputGate,
  quotedSources,
  resolvesGate,
  runAiFallback,
  applyAnswerEdits,
  safePath,
  withRegistryTargets,
  scopeGate,
  secretGate,
  writtenCalls,
  type FallbackDependencies,
  type FallbackInput,
  type OpenItem,
  type ScanBundle,
} from './ai-fallback.ts';
import { fallbackCommand, proofEnvironment, savedModelSettings } from './ai-fallback-run.ts';
import { hiddenFindings, runtimeRequirements, unprovable } from './ai-fallback-shape.ts';
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

  it("takes a stop's target from the registry when the entry names one model", () => {
    const deadline = (id: string, replacement: string | null) => ({
      id,
      provider: 'anthropic' as const,
      kind: 'model' as const,
      versions: ['m'],
      date: '2025-01-01',
      summary: 's',
      replacement,
      source: null,
      checkedAt: '2026-10-29',
    });
    const stop = openItems(bundle).find((item) => item.kind === 'model-stop')!;
    expect(stop.target).toBe(null);
    expect(
      withRegistryTargets([stop], [deadline('anthropic-claude-2', 'claude-sonnet-5-5')])[0].target,
    ).toBe('claude-sonnet-5-5');
    // A replacement written as prose names no single model, so the AI gets no target.
    expect(
      withRegistryTargets([stop], [deadline('anthropic-claude-2', 'Claude Sonnet or Opus')])[0]
        .target,
    ).toBe(null);
  });

  it("offers every replacement the provider's page names, followed past retired ones", () => {
    const entry = (
      id: string,
      versions: string[],
      replacement: string | null,
      date = '2025-01-01',
    ) => ({
      id,
      provider: 'openai' as const,
      kind: 'model' as const,
      versions,
      date,
      summary: 's',
      replacement,
      source: null,
      checkedAt: '2026-10-29',
    });
    const item = { ...openItems(bundle)[0], ref: 'old-image', target: null };
    const [image] = withRegistryTargets(
      [item],
      [entry('old-image', ['dall-e-2'], null), entry('older', ['gpt-image-1'], 'gpt-image-3')],
      [
        {
          id: 'old-image',
          quotes: {
            'dall-e-2': '| `dall-e-2` | `gpt-image-2`, `gpt-image-1`, or `gpt-image-1-mini` |',
          },
        },
      ],
      new Date('2026-10-29'),
    );
    expect(image.target).toBe(null);
    // gpt-image-1 retired too, so its own replacement is offered instead.
    expect(image.options).toEqual(['gpt-image-1-mini', 'gpt-image-2', 'gpt-image-3']);
    const [chained] = withRegistryTargets(
      [{ ...item, ref: 'davinci' }],
      [
        entry('davinci', ['text-davinci-003'], 'gpt-3.5-turbo-instruct'),
        entry('instruct', ['gpt-3.5-turbo-instruct'], 'gpt-5.6-terra', '2026-09-28'),
      ],
      [],
      new Date('2026-10-29'),
    );
    expect(chained.target).toBe('gpt-5.6-terra');
    // A replacement that retires later is still live today.
    const [later] = withRegistryTargets(
      [{ ...item, ref: 'davinci' }],
      [
        entry('davinci', ['text-davinci-003'], 'gpt-3.5-turbo-instruct'),
        entry('instruct', ['gpt-3.5-turbo-instruct'], 'gpt-5.6-terra', '2027-09-28'),
      ],
      [],
      new Date('2026-10-29'),
    );
    expect(later.target).toBe('gpt-3.5-turbo-instruct');
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
    // A new test file only adds checks.
    expect(
      scopeGate([change('tests/test_ask.py', null, 'def test_x():\n    pass\n')], context).status,
    ).toBe('passed');
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

  it('request proof: finds Gemini calls the patch writes', () => {
    const before = "const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });\n";
    const after =
      "const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents });\n";
    expect(
      writtenCalls({ files: [], calls: [], notes: [], unresolved: [], patterns: [] }, [
        change('src/gemini.ts', before, after),
      ]).map((call) => call.call),
    ).toEqual(['models.generateContent']);
  });

  it('request proof: proves every call the patch writes, reported or not', () => {
    const calls = writtenCalls({ files: [], calls: [], notes: [], unresolved: [], patterns: [] }, [
      change('src/ask.ts', LEGACY, FIXED),
    ]);
    expect(calls).toEqual([{ call: 'messages.create', stream: false, tools: false, json: false }]);
  });
});

describe('edits', () => {
  const originals = new Map([['src/ask.ts', LEGACY]]);
  const answer = (
    edits: Array<{ path: string; old: string; new: string }>,
    files: Array<{ path: string; content: string }> = [],
  ) => ({
    edits,
    files,
    calls: [],
    notes: [],
    unresolved: [],
    patterns: [],
  });

  it('applies exact snippets in order and keeps new files', () => {
    const merged = applyAnswerEdits(
      answer(
        [
          { path: 'src/ask.ts', old: "'claude-2.1'", new: "'claude-sonnet-5-5'" },
          { path: 'src/ask.ts', old: 'completions.create', new: 'messages.create' },
        ],
        [{ path: 'src/new.ts', content: 'export {};\n' }],
      ),
      originals,
    );
    expect('files' in merged && merged.files.map((file) => file.path)).toEqual([
      'src/new.ts',
      'src/ask.ts',
    ]);
    const ask =
      'files' in merged ? merged.files.find((file) => file.path === 'src/ask.ts')!.content : '';
    expect(ask).toContain("client.messages.create({\n    model: 'claude-sonnet-5-5'");
  });

  it('refuses a snippet that is missing, repeated or empty, an unseen file, or a file edited and returned whole', () => {
    expect(
      applyAnswerEdits(answer([{ path: 'src/ask.ts', old: 'nowhere', new: 'x' }]), originals),
    ).toEqual({
      error: "An edit's snippet occurs nowhere in src/ask.ts.",
    });
    expect(
      applyAnswerEdits(answer([{ path: 'src/ask.ts', old: 'const ', new: 'let ' }]), originals),
    ).toEqual({
      error: "An edit's snippet occurs more than once in src/ask.ts.",
    });
    expect(
      applyAnswerEdits(answer([{ path: 'src/ask.ts', old: '', new: 'x' }]), originals),
    ).toEqual({
      error: 'An edit to src/ask.ts has an empty snippet.',
    });
    expect(applyAnswerEdits(answer([{ path: 'other.ts', old: 'a', new: 'b' }]), originals)).toEqual(
      {
        error: 'An edit targets other.ts, which was not in the input.',
      },
    );
    expect(
      applyAnswerEdits(
        answer(
          [{ path: 'src/ask.ts', old: "'claude-2.1'", new: "'x'" }],
          [{ path: 'src/ask.ts', content: FIXED }],
        ),
        originals,
      ),
    ).toEqual({ error: 'src/ask.ts is both edited and returned whole.' });
  });
});

describe('request proof environment', () => {
  it("sends a target model itself, and otherwise the fallback's own model", () => {
    const env = { OPENAI_MODEL: 'gpt-5.6-luna' };
    expect(proofEnvironment('openai', 'gpt-4o', env).REFIT_PROOF_OPENAI_MODEL).toBe('gpt-4o');
    expect(proofEnvironment('openai', null, env).REFIT_PROOF_OPENAI_MODEL).toBe('gpt-6.1-sol');
    expect(
      proofEnvironment('openai', null, { ...env, REFIT_PROOF_OPENAI_MODEL: 'gpt-5.6-luna' })
        .REFIT_PROOF_OPENAI_MODEL,
    ).toBe('gpt-5.6-luna');
    expect(proofEnvironment('anthropic', null, env).REFIT_PROOF_ANTHROPIC_MODEL).toBe(undefined);
    // Anthropic and Gemini proofs send their target with their own provider's key and SDK.
    expect(
      proofEnvironment('anthropic', 'claude-sonnet-5-5', env).REFIT_PROOF_ANTHROPIC_MODEL,
    ).toBe('claude-sonnet-5-5');
    expect(proofEnvironment('gemini', 'gemini-2.5-flash', env).REFIT_PROOF_GEMINI_MODEL).toBe(
      'gemini-2.5-flash',
    );
    expect(proofEnvironment('gemini', null, env).REFIT_PROOF_OPENAI_MODEL).toBe(undefined);
  });
});

describe('checks command', () => {
  it("is the repository's own test script, else its build, as the rule lanes choose", () => {
    expect(
      fallbackCommand({
        scripts: { test: 'vitest run', build: 'vite build' },
        devDependencies: { typescript: '5' },
      }),
    ).toEqual({ command: ['npm', 'test'] });
    expect(fallbackCommand({ scripts: { build: 'tsc -b' } })).toEqual({
      command: ['npm', 'run', 'build'],
    });
    expect(fallbackCommand({ scripts: { test: 'echo "Error: no test specified"' } })).toBe(null);
  });
});

describe('gate gaps found by the October 29 baseline review (synthetic fixtures)', () => {
  // The baseline round's hand-checked rows are measurement data and never fixtures
  // (docs/benchmarks/AI-PROVIDER-SETS.md); these reproduce each failure class on made-up code.
  const CLIENT_BEFORE = `import Anthropic from '@anthropic-ai/sdk';

export class Assistant {
  client = new Anthropic();
  constructor() {}

  async ask(prompt: string) {
    const result = await this.client.completions.create({ model: 'claude-2.1', prompt, max_tokens_to_sample: 300 });
    return result.completion;
  }
}
`;
  const CALLER = `import { Assistant } from './assistant';\nexport const assistant = new Assistant();\n`;

  it('1: refuses a fix that needs a constructor option no caller passes', () => {
    const wrong = CLIENT_BEFORE.replace(
      'constructor() {}',
      `model: string;
  constructor(options?: { model?: string }) {
    if (!options?.model) throw new Error('model is required');
    this.model = options.model;
  }`,
    ).replace(
      "model: 'claude-2.1', prompt, max_tokens_to_sample: 300",
      'model: this.model, max_tokens: 300, messages: [{ role: "user", content: prompt }]',
    );
    const problems = runtimeRequirements(
      [{ path: 'src/assistant.ts', before: CLIENT_BEFORE, after: wrong }],
      [{ path: 'src/index.ts', content: CALLER }],
    );
    expect(problems.join(' ')).toContain(
      'Assistant now takes 1 parameter, and no call site passes more than 0',
    );
    expect(problems.join(' ')).toContain('the patch throws when `!options?.model`');
    // The same fix with the caller updated still trips the throw check, which asks for review.
    const right = CLIENT_BEFORE.replace(
      "model: 'claude-2.1', prompt, max_tokens_to_sample: 300",
      "model: 'claude-sonnet-5-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }]",
    );
    expect(
      runtimeRequirements(
        [{ path: 'src/assistant.ts', before: CLIENT_BEFORE, after: right }],
        [{ path: 'src/index.ts', content: CALLER }],
      ),
    ).toEqual([]);
  });

  it('2: proves a tool call with its tools, and refuses a shape the probe cannot send', () => {
    const before = `const r = await client.messages.create({ model: 'claude-2.1', max_tokens: 9, messages });\n`;
    const after = `const r = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 9, messages, tools, tool_choice: { type: 'auto' } });\n`;
    const [shape] = writtenCalls(
      { files: [], calls: [], notes: [], unresolved: [], patterns: [] },
      [{ path: 'a.ts', before, after }],
    );
    expect(shape).toEqual({ call: 'messages.create', stream: false, tools: true, json: false });
    expect(unprovable('anthropic', shape)).toBe(null);
    const responses = writtenCalls(
      { files: [], calls: [], notes: [], unresolved: [], patterns: [] },
      [
        {
          path: 'b.ts',
          before: '',
          after: `const r = await openai.responses.create({ model: 'gpt-5.6-terra', input, tools });\n`,
        },
      ],
    );
    expect(unprovable('openai', responses[0])).toContain('cannot send tools');
    const spread = writtenCalls({ files: [], calls: [], notes: [], unresolved: [], patterns: [] }, [
      {
        path: 'c.ts',
        before: '',
        after: `await openai.chat.completions.create({ ...params, model: 'gpt-5.6-terra' });\n`,
      },
    ]);
    expect(unprovable('openai', spread[0])).toContain('could not read the request');
  });

  it('3: refuses a rename that hides a finding, a removed dependency and an emptied file', () => {
    const items: OpenItem[] = [
      {
        id: 'review:anthropic-text-completions:src/ask.ts:5',
        kind: 'review',
        provider: 'anthropic',
        ref: 'anthropic-text-completions',
        changeType: 'legacy-endpoint',
        file: 'src/ask.ts',
        line: 5,
        text: 'client.completions.create({',
        reason: 'legacy',
        target: null,
      },
    ];
    const renamed = LEGACY.replace(
      'const client = new Anthropic();',
      'const ai = new Anthropic();',
    ).replace('client.completions.create', 'ai.completions.create');
    expect(hiddenFindings(items, [], new Map([['src/ask.ts', renamed]]))).toEqual([
      "src/ask.ts: `completions.create` is still called, but Refit's rule anthropic-text-completions no longer matches it.",
    ]);
    expect(hiddenFindings(items, [], new Map([['src/ask.ts', FIXED]]))).toEqual([]);
    const context = {
      repositoryModels: new Set(['claude-2.1']),
      targets: new Set(['claude-sonnet-5-5']),
    };
    const manifest = '{"dependencies":{"@anthropic-ai/sdk":"^0.30.0","zod":"^3.0.0"}}';
    expect(
      scopeGate(
        [
          {
            path: 'package.json',
            before: manifest,
            after: '{"dependencies":{"@anthropic-ai/sdk":"^1.2.0"}}',
          },
        ],
        context,
      ).detail,
    ).toBe('The patch removes zod from package.json, which no finding is about.');
    expect(
      scopeGate(
        [
          {
            path: 'package.json',
            before: '{"dependencies":{"@google/generative-ai":"^0.1.0"}}',
            after: '{"dependencies":{"@google/genai":"^2.0.0"}}',
          },
        ],
        context,
      ).status,
    ).toBe('passed');
    expect(
      scopeGate([{ path: 'src/util.ts', before: 'export const a = 1;\n', after: '' }], context)
        .detail,
    ).toBe('The patch deletes the contents of src/util.ts.');
  });

  it('4: refuses relabelled metadata and fails the rescan on a saved setting left behind', async () => {
    const items = withRegistryTargets(openItems(bundle), [
      {
        id: 'anthropic-claude-2',
        provider: 'anthropic',
        kind: 'model',
        versions: ['claude-2.1'],
        date: '2025-07-21',
        summary: 's',
        replacement: 'claude-sonnet-5-5',
        source: null,
        checkedAt: '2026-10-29',
      },
    ]);
    const labels = `export const MODELS = [\n  { id: 'x', label: 'claude-2.1' },\n];\n`;
    expect(
      scopeGate(
        [
          {
            path: 'src/labels.ts',
            before: labels,
            after: labels.replace('claude-2.1', 'claude-sonnet-5-5'),
          },
        ],
        {
          repositoryModels: new Set(['claude-2.1']),
          targets: new Set(['claude-sonnet-5-5']),
          items,
        },
      ).detail,
    ).toBe(
      'The patch changes the model string claude-2.1 at src/labels.ts:2, which no finding names.',
    );
    const root = await mkdtemp(join(tmpdir(), 'refit-fallback-settings-'));
    roots.push(root);
    await writeFile(join(root, '.env.example'), 'ANTHROPIC_MODEL=claude-2.1\n');
    await writeFile(join(root, 'config.json'), '{"model": "claude-sonnet-5-5"}\n');
    const left = await savedModelSettings(
      root,
      ['.env.example', 'config.json', 'package.json'],
      items,
    );
    expect(left.map((item) => `${item.file}:${item.line} ${item.ref}`)).toEqual([
      '.env.example:1 anthropic-claude-2',
    ]);
    expect(resolvesGate(items, left).status).toBe('failed');
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
      'runtime passed',
      'resolves passed',
      'checks passed',
      'request-proof passed',
      'endpoint passed',
    ]);
    expect(result.patch).toBe('diff for src/ask.ts\n');
    expect(result.ai).toEqual({ model: 'gpt-6.1-sol', responseId: 'resp_1', costUsd: 0.04 });
    expect(result.patterns[0].pattern).toContain('Text Completions');
  });

  it('validates a fix returned as edits', async () => {
    const request = (async () => ({
      status: 'completed',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      responseId: 'resp_2',
      evidenceHash: 'h',
      usage: null,
      budget: { costUsd: 0.02, spentUsd: 0.02, limitUsd: 1 },
      content: JSON.stringify({
        edits: [
          {
            path: 'src/ask.ts',
            old: LEGACY.slice(LEGACY.indexOf('export')),
            new: FIXED.slice(FIXED.indexOf('export')),
          },
        ],
        files: [],
        calls: [],
        notes: [],
        unresolved: [],
        patterns: [],
      }),
    })) as never;
    const result = await run(request);
    expect(result.status).toBe('validated');
    expect(result.calls.map((call) => call.call)).toEqual(['messages.create']);
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
    const python = `import anthropic\nclient = anthropic.Anthropic()\nreply = client.completions.create(model="claude-2.1", prompt=p)\n`;
    const result = await runAiFallback({
      input: {
        ...input,
        language: 'py',
        items: [{ ...input.items[0], file: 'app.py', line: 3, text: '' }],
        files: [{ path: 'app.py', content: python }],
      },
      ai: { apiKey: 'k', model: 'gpt-6.1-sol' },
      repositoryModels: new Set(['claude-2.1']),
      exists: async () => false,
      environment: {},
      dependencies: {
        ...dependencies(),
        request: reply([
          {
            path: 'app.py',
            content: python
              .replace('completions.create', 'messages.create')
              .replace('claude-2.1', 'claude-sonnet-5-5')
              .replace('prompt=p', 'max_tokens=300, messages=m'),
          },
        ]),
      },
    });
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

  it('refuses any model but the fallback model', async () => {
    await expect(
      runAiFallback({
        input,
        ai: { apiKey: 'k', model: 'gpt-5.6-luna' },
        repositoryModels: new Set(),
        exists: async () => false,
        dependencies: dependencies(),
      }),
    ).rejects.toThrow('The AI fallback runs only on gpt-6.1-sol, not gpt-5.6-luna.');
  });

  it('does not call the AI when nothing is open or no file fits', async () => {
    let called = false;
    const request = (async () => {
      called = true;
    }) as never;
    const empty = await runAiFallback({
      input: { ...input, items: [] },
      ai: { apiKey: 'k', model: 'gpt-6.1-sol' },
      repositoryModels: new Set(),
      exists: async () => false,
      dependencies: { ...dependencies(), request },
    });
    expect(empty.status).toBe('no-attempt');
    const unfit = await runAiFallback({
      input: { ...input, files: [], omitted: ['src/ask.ts'] },
      ai: { apiKey: 'k', model: 'gpt-6.1-sol' },
      repositoryModels: new Set(),
      exists: async () => false,
      dependencies: { ...dependencies(), request },
    });
    expect(unfit.reason).toContain('src/ask.ts');
    expect(called).toBe(false);
  });
});

// Fix 2 of the accuracy plan: every stop Refit's rules make goes to the AI with its reason, and
// the gates, not the prompt, decide what is kept. Synthetic fixtures; reasons are the engines'
// own wording (pipeline/model-retirements.ts, pipeline/python/model-reports.ts).
describe('every stop reaches the AI (fix 2)', () => {
  const reasons: Array<[string, Pick<OpenItem, 'kind' | 'reason'>]> = [
    [
      'custom-host',
      {
        kind: 'model-stop',
        reason:
          "The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to gpt-5.5.",
      },
    ],
    [
      'custom-host',
      {
        kind: 'model-stop',
        reason:
          "The request goes to a host other than the official API, so the model may name another provider's model or a deployment; change it by hand to gpt-5.5.",
      },
    ],
    [
      'custom-endpoint',
      {
        kind: 'model-stop',
        reason:
          "The repository mentions a custom endpoint (src/config.ts:3), but this request's client (new OpenAI()) sets none; editing it waits on an owner decision on endpoint tracing; change it by hand to gpt-5.5.",
      },
    ],
    [
      'platform',
      {
        kind: 'model-stop',
        reason:
          "The client is Claude on Amazon Bedrock, where model IDs and retirement dates are Amazon Bedrock's, not the Claude API's; check Amazon Bedrock's model lifecycle and change it by hand.",
      },
    ],
    [
      'untraced-client',
      {
        kind: 'model-stop',
        reason:
          'The client `this.client` is not one Refit can trace to the SDK constructor (a `let` variable, a typed parameter or field, or an object member), so this request is listed but not edited; change it by hand to gpt-5.5.',
      },
    ],
    [
      'untraced-model',
      {
        kind: 'model-stop',
        reason:
          'The model reaches this request through a variable, which Refit reports but does not edit yet; change it by hand to gpt-5.5.',
      },
    ],
    [
      'untraced-model',
      {
        kind: 'model-stop',
        reason:
          'The request takes its model from the options it spreads (`...options`), which Refit reports but does not edit; change it by hand to gpt-5.5.',
      },
    ],
    ['untraced-model', { kind: 'model-unresolved', reason: 'No traced request sends this model.' }],
    [
      'unreadable-body',
      {
        kind: 'model-stop',
        reason:
          'The request spreads other options, which may set parameters the replacement rejects.',
      },
    ],
    [
      'unreadable-body',
      {
        kind: 'model-stop',
        reason:
          'The request sets a computed property, which may be a parameter the replacement rejects; change it by hand to gpt-5.5.',
      },
    ],
    [
      'not-edited-call',
      {
        kind: 'model-stop',
        reason:
          '`images.generate` is not a call Refit edits; gpt-image-2 may change formats or parameters; change it by hand to gpt-image-2.',
      },
    ],
    [
      'no-replacement',
      { kind: 'model-stop', reason: 'The registry names no concrete replacement model ID.' },
    ],
    [
      'parameter',
      {
        kind: 'model-stop',
        reason: 'The request sets temperature, which gpt-5.5 may reject or treat differently.',
      },
    ],
    ['checks', { kind: 'model-fix-failed', reason: 'Refit proposed a → b; its checks failed.' }],
    [
      'unfixed-match',
      { kind: 'exposure', reason: 'A live use of gpt-4 that no Refit lane fixed.' },
    ],
    ['rule-gap', { kind: 'sdk-major', reason: 'gone in 1.x' }],
    // Reasons seen on the dev sets (openai-dev-30, anthropic-dev-30, gemini-dev-15).
    [
      'custom-host',
      {
        kind: 'model-stop',
        reason:
          'OpenRouter model openai/o1: it routes to openai, so change it in the OpenRouter call.',
      },
    ],
    [
      'untraced-model',
      {
        kind: 'model-stop',
        reason:
          'The model comes from the constant SONNET (api/chunk.js:30), which is used 3 times; change it by hand to claude-sonnet-5-5.',
      },
    ],
    [
      'not-edited-call',
      {
        kind: 'model-stop',
        reason:
          'Refit reports Python requests but does not edit Python code yet; change it by hand to claude-sonnet-5-5.',
      },
    ],
    [
      'not-edited-call',
      {
        kind: 'model-stop',
        reason:
          'Gemini is report only, so Refit never edits its models; change it by hand to gemini-embedding-2.',
      },
    ],
    [
      'no-replacement',
      {
        kind: 'model-alert',
        reason:
          '`ft:x` is fine-tuned on `gpt-4o`, which retires on 2026-10-23, and a fine-tuned model stops with its base model. No model ID replaces it: it needs a new fine-tune.',
      },
    ],
  ];

  it('names the kind of every stop', () => {
    for (const [category, item] of reasons) expect(stopCategory(item), item.reason).toBe(category);
  });

  const customRow: ScanBundle = {
    provider: 'openai',
    language: 'js',
    replacements: [],
    unresolved: [],
    alerts: [],
    validation: null,
    stops: reasons
      .filter(([, item]) => item.kind === 'model-stop')
      .map(([, item], index) => ({
        deadline: 'openai-gpt-4-0613',
        provider: 'openai',
        file: `src/site${index}.ts`,
        line: 4,
        call: 'chat.completions.create',
        at: { file: `src/site${index}.ts`, line: 5 },
        model: 'gpt-4-0613',
        reason: item.reason,
      })),
  };

  it('makes every model stop an open item with its kind, and sends the row', () => {
    const items = openItems(customRow);
    expect(items).toHaveLength(customRow.stops!.length);
    expect(new Set(items.map((item) => item.stop))).toEqual(
      new Set([
        'custom-host',
        'custom-endpoint',
        'platform',
        'untraced-client',
        'untraced-model',
        'unreadable-body',
        'not-edited-call',
        'no-replacement',
        'parameter',
      ]),
    );
    expect(fallbackEligible('needs-review', items)).toBe(true);
  });

  it('sends a row whose fix lane crashed after the scan, but not a row Refit never read', () => {
    const items = openItems(customRow);
    expect(fallbackEligible('error', items, true)).toBe(true);
    expect(fallbackEligible('error', items)).toBe(false);
    expect(fallbackEligible('error', [], true)).toBe(false);
    expect(fallbackEligible('infrastructure', items, true)).toBe(false);
  });

  it('puts no limit on what the AI may edit in the prompt, and says the reasons are not one', () => {
    expect(INSTRUCTIONS).not.toMatch(
      /\b(?:do not|don't|never|must not) (?:modify|change|edit|touch)\b/i,
    );
    expect(INSTRUCTIONS).toContain('is not a limit on you');
    expect(INSTRUCTIONS).toContain('"stop"');
  });

  it('sends a file too large to send whole as the lines around its items', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-fallback-excerpt-'));
    roots.push(root);
    const lines = Array.from({ length: 4000 }, (_, index) => `const v${index} = ${index}; // pad`);
    lines[1999] = "const model = 'gpt-4-0613';";
    await writeFile(join(root, 'big.ts'), lines.join('\n'));
    const item: OpenItem = {
      id: 'model-stop:d:big.ts:2000',
      kind: 'model-stop',
      provider: 'openai',
      ref: 'd',
      changeType: 'retired-model',
      file: 'big.ts',
      line: 2000,
      text: '',
      reason: 'x',
      target: null,
    };
    const input = await fallbackInput({
      directory: root,
      provider: 'openai',
      language: 'js',
      items: [item],
      sources: [],
      partial: [],
    });
    expect(input.files).toEqual([]);
    expect(input.omitted).toEqual([]);
    expect(input.excerpts).toEqual([
      expect.objectContaining({ path: 'big.ts', from: 1960, to: 2040 }),
    ]);
    expect(input.excerpts![0].text).toContain("const model = 'gpt-4-0613';");
    expect(itemExcerpts('a\nb\nc', [1, 3])).toEqual([{ from: 1, to: 3, text: 'a\nb\nc' }]);
  });

  it('tells the AI how many items did not fit, and records those as never seen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-fallback-items-'));
    roots.push(root);
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n');
    const many = Array.from({ length: 65 }, (_, index) => ({
      id: `review:r:a.ts:${index + 1}`,
      kind: 'review' as const,
      provider: 'openai',
      ref: 'r',
      changeType: 'other' as const,
      file: 'a.ts',
      line: index + 1,
      text: '',
      reason: 'x',
      target: null,
    }));
    const input = await fallbackInput({
      directory: root,
      provider: 'openai',
      language: 'js',
      items: many,
      sources: [],
      partial: [],
    });
    expect(input.items).toHaveLength(60);
    expect(input.omittedItems).toBe(5);
  });

  const CUSTOM = `import OpenAI from 'openai';
const client = new OpenAI({ baseURL: process.env.LLM_BASE_URL });

export async function ask(content: string) {
  const reply = await client.chat.completions.create({
    model: 'gpt-4-0613',
    messages: [{ role: 'user', content }],
  });
  return reply.choices[0].message.content;
}
`;
  const OFFICIAL = CUSTOM.replace('{ baseURL: process.env.LLM_BASE_URL }', '');
  const site = (stop: OpenItem['stop'], reason: string): OpenItem => ({
    id: 'model-stop:openai-gpt-4-0613:src/ask.ts:6',
    kind: 'model-stop',
    provider: 'openai',
    ref: 'openai-gpt-4-0613',
    changeType: 'retired-model',
    file: 'src/ask.ts',
    line: 6,
    text: 'chat.completions.create',
    reason,
    target: 'gpt-5.5',
    stop,
  });
  const answer = (edits: Array<{ path: string; old: string; new: string }>) =>
    (async () => ({
      status: 'completed',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      responseId: 'resp_fix2',
      evidenceHash: 'h',
      usage: null,
      budget: { costUsd: 0.01, spentUsd: 0.01, limitUsd: 1 },
      content: JSON.stringify({
        edits,
        files: [],
        calls: [{ call: 'chat.completions.create', stream: false, tools: false, json: false }],
        notes: [],
        unresolved: [],
        patterns: [],
      }),
    })) as never;
  const passing: FallbackDependencies = {
    render: async () => ({ patch: 'diff --git a/src/ask.ts b/src/ask.ts\n', refusal: null }),
    rescan: async () => [],
    validate: async () => ({ status: 'passed', command: ['npm', 'test'], reason: '' }),
    prove: async () => ({
      status: 'accepted',
      reason: 'Accepted with gpt-5.5.',
      calls: [{ call: 'chat.completions.create', status: 'accepted', detail: 'text parsed' }],
    }),
  };
  const attempt = (
    item: OpenItem,
    content: string,
    request: never,
    extra: Partial<FallbackInput> = {},
    read?: (path: string) => Promise<string | null>,
  ) =>
    runAiFallback({
      input: {
        provider: 'openai',
        language: 'js',
        items: [item],
        sources: [],
        targets: [{ item: item.id, target: 'gpt-5.5' }],
        partial: [],
        files: [{ path: 'src/ask.ts', content }],
        omitted: [],
        ...extra,
      },
      ai: { apiKey: 'k', model: 'gpt-6.1-sol' },
      repositoryModels: new Set(['gpt-4-0613']),
      exists: async () => true,
      read,
      environment: {},
      dependencies: { ...passing, request },
    });
  const swap = [{ path: 'src/ask.ts', old: "model: 'gpt-4-0613',", new: "model: 'gpt-5.5'," }];

  it('keeps a fix behind a custom base URL a suggestion even when every other gate passes', async () => {
    const result = await attempt(
      site(
        'custom-host',
        "The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to gpt-5.5.",
      ),
      CUSTOM,
      answer(swap),
    );
    expect(result.status).toBe('needs-review');
    expect(result.suggestion).toBe(true);
    expect(result.gates.map((gate) => `${gate.gate} ${gate.status}`)).toEqual([
      'output passed',
      'secrets passed',
      'scope passed',
      'runtime passed',
      'resolves passed',
      'checks passed',
      'request-proof passed',
      'endpoint failed',
    ]);
    expect(result.gates.at(-1)!.detail).toContain("Refit's request proof cannot reach");
  });

  it('validates a fix on an official client when the repository only mentions an endpoint', async () => {
    const result = await attempt(
      site(
        'custom-endpoint',
        "The repository mentions a custom endpoint (src/config.ts:3), but this request's client (new OpenAI()) sets none; editing it waits on an owner decision on endpoint tracing; change it by hand to gpt-5.5.",
      ),
      OFFICIAL,
      answer(swap),
    );
    expect(result.status).toBe('validated');
    expect(result.gates.at(-1)).toEqual(
      expect.objectContaining({ gate: 'endpoint', status: 'passed' }),
    );
  });

  it('never validates a model the registry does not name for a no-replacement stop', async () => {
    const result = await attempt(
      {
        ...site('no-replacement', 'The registry names no concrete replacement model ID.'),
        target: null,
      },
      OFFICIAL,
      answer([{ path: 'src/ask.ts', old: "model: 'gpt-4-0613',", new: "model: 'gpt-9-made-up'," }]),
      { targets: [] },
    );
    expect(result.status).toBe('needs-review');
    expect(result.gates.find((gate) => gate.gate === 'scope')).toEqual(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('never validates a replacement the provider rejects (a 404 model)', async () => {
    const result = await runAiFallback({
      input: {
        provider: 'openai',
        language: 'js',
        items: [
          site(
            'untraced-model',
            'The model reaches this request through a variable, which Refit reports but does not edit yet; change it by hand to gpt-5.5.',
          ),
        ],
        sources: [],
        targets: [{ item: 'x', target: 'gpt-5.5' }],
        partial: [],
        files: [{ path: 'src/ask.ts', content: OFFICIAL }],
        omitted: [],
      },
      ai: { apiKey: 'k', model: 'gpt-6.1-sol' },
      repositoryModels: new Set(['gpt-4-0613']),
      exists: async () => true,
      environment: {},
      dependencies: {
        ...passing,
        prove: async () => ({
          status: 'rejected',
          reason: 'chat.completions.create: HTTP 404 model not found',
          calls: [],
        }),
        request: answer(swap),
      },
    });
    expect(result.status).toBe('needs-review');
    expect(result.gates.at(-1)!.detail).toContain('HTTP 404');
  });

  it('applies an edit made from an excerpt to the whole file', async () => {
    const big = `${'// filler line\n'.repeat(3000)}${CUSTOM.replace('{ baseURL: process.env.LLM_BASE_URL }', '')}`;
    const item = {
      ...site(
        'untraced-model',
        'The model reaches this request through a variable, which Refit reports but does not edit yet; change it by hand to gpt-5.5.',
      ),
      line: 3006,
    };
    const excerpt = { path: 'src/ask.ts', ...itemExcerpts(big, [3006])[0] };
    const result = await attempt(
      item,
      '',
      answer(swap),
      { files: [], excerpts: [excerpt] },
      async (path) => (path === 'src/ask.ts' ? big : null),
    );
    expect(result.status).toBe('validated');
    let called = false;
    const unread = await attempt(
      item,
      '',
      (async () => {
        called = true;
      }) as never,
      { files: [], excerpts: [excerpt], omitted: [] },
    );
    expect(unread.status).toBe('no-attempt');
    expect(called).toBe(false);
  });
});
