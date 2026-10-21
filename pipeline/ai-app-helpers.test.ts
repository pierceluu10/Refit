import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  SCAN_LIMITS,
  SIZE_BUCKETS,
  appShape,
  candidateFile,
  compareCandidates,
  declaresSdk,
  detectModelCall,
  excludedName,
  findCandidates,
  followReplacement,
  isGenerated,
  languageOf,
  modelPattern,
  packBatches,
  seededSample,
  agreement,
  frozenListNames,
  scanLimitsFromTree,
  shallowCheckout,
  validRepoName,
  validSha,
  validateLabels,
  validWorkspaceManifest,
} from '../scripts/ai-app-helpers.mjs';

const blob = (path: string, size = 10) => ({ path, type: 'blob', size });

it('accepts only owner/name repository names without traversal or metacharacters', () => {
  expect(validRepoName('vercel/ai-chatbot')).toBe(true);
  for (const bad of ['a/b/c', '../x', 'a/..', 'a b/c', 'a/b;rm', '', './x', 'a/.'])
    expect(validRepoName(bad), bad).toBe(false);
});

it('accepts exactly 40 lowercase hex characters as a SHA', () => {
  expect(validSha('a'.repeat(40))).toBe(true);
  for (const bad of ['a'.repeat(39), 'A'.repeat(40), 'g'.repeat(40), `${'a'.repeat(40)}\n`])
    expect(validSha(bad), bad).toBe(false);
});

it('refuses to check out an invalid name or SHA before spawning git', async () => {
  await expect(shallowCheckout('/nonexistent-root', '../x', 'a'.repeat(40))).rejects.toThrow(
    /Invalid repository/,
  );
  await expect(shallowCheckout('/nonexistent-root', 'a/b', 'HEAD')).rejects.toThrow(
    /Invalid commit/,
  );
});

it('accepts one-level apps and packages manifests only', () => {
  expect(validWorkspaceManifest('apps/web/package.json')).toBe(true);
  expect(validWorkspaceManifest('packages/@x-core/package.json')).toBe(true);
  for (const bad of [
    'apps/a/b/package.json',
    'apps/../package.json',
    'lib/x/package.json',
    'apps/web/package.json.bak',
  ])
    expect(validWorkspaceManifest(bad), bad).toBe(false);
});

it('counts the SDK only when it is a runtime dependency', () => {
  expect(declaresSdk({ dependencies: { openai: '^4' } }, 'openai')).toBe(true);
  expect(declaresSdk({ devDependencies: { openai: '^4' } }, 'openai')).toBe(false);
  expect(declaresSdk({ peerDependencies: { openai: '^4' } }, 'openai')).toBe(false);
  expect(declaresSdk({}, 'openai')).toBe(false);
});

it('recognizes an application by private flag, missing publish fields, markers or a server', () => {
  expect(appShape({ private: true, main: 'x.js' })).toBe('private');
  expect(appShape({ name: 'a' })).toBe('no-publish-fields');
  const library = { main: 'index.js' };
  expect(appShape(library, ['next.config.mjs'])).toBe('marker:next.config.mjs');
  expect(appShape(library, ['vite.config.ts'])).toBe('marker:vite.config.ts');
  expect(appShape(library, ['wrangler.toml'])).toBe('marker:wrangler.toml');
  expect(appShape(library, ['app/page.tsx'])).toBe('marker:app/');
  expect(appShape(library, ['src/pages/index.tsx'])).toBe('marker:src/pages/');
  expect(appShape(library, ['apps/web/vite.config.js'], 'apps/web')).toBe('marker:vite.config.js');
  expect(appShape(library, ['vite.config.js'], 'apps/web')).toBeNull();
  expect(appShape({ ...library, dependencies: { express: '4' } })).toBe('server:express');
  expect(appShape({ ...library, dependencies: { hono: '4' } })).toBe('server:hono');
  expect(appShape(library, ['src/index.js'])).toBeNull();
});

it('excludes SDK, wrapper and framework names by name part or topic, never by owner', () => {
  expect(excludedName('acme/openai-sdk', [])).toBe(true);
  expect(excludedName('acme/chat-app', ['langchain'])).toBe(true);
  expect(excludedName('acme/My-Client-Portal', [])).toBe(true);
  expect(excludedName('sdk-labs/chat-app', ['nextjs'])).toBe(false);
  expect(excludedName('acme/chat-app', ['nextjs', 'ai'])).toBe(false);
});

it('applies the repository scan limits to a tree listing', () => {
  expect(scanLimitsFromTree({ tree: [blob('src/a.ts'), blob('package.json')] })).toBeNull();
  expect(scanLimitsFromTree({ truncated: true, tree: [] })).toMatch(/truncated/);
  const many = Array.from({ length: SCAN_LIMITS.files + 1 }, (_, i) => blob(`src/f${i}.ts`, 1));
  expect(scanLimitsFromTree({ tree: many })).toMatch(/10,000/);
  expect(scanLimitsFromTree({ tree: [blob('src/big.ts', SCAN_LIMITS.fileBytes + 1)] })).toMatch(
    /2 MiB/,
  );
  expect(scanLimitsFromTree({ tree: [blob('pnpm-lock.yaml', SCAN_LIMITS.fileBytes + 1)] })).toMatch(
    /2 MiB/,
  );
  const heavy = Array.from({ length: 26 }, (_, i) => blob(`src/f${i}.ts`, SCAN_LIMITS.fileBytes));
  expect(scanLimitsFromTree({ tree: heavy })).toMatch(/50 MiB/);
});

it('does not count declarations, non-source files, nested lockfiles or excluded directories', () => {
  const big = SCAN_LIMITS.fileBytes + 1;
  const ignored = [
    blob('src/types.d.ts', big),
    blob('assets/photo.png', big),
    blob('data.json', big),
    blob('node_modules/x/index.js', big),
    blob('web/.next/server.js', big),
    blob('dist/app.js', big),
    blob('apps/web/pnpm-lock.yaml', big),
    { path: 'src', type: 'tree' },
  ];
  expect(scanLimitsFromTree({ tree: ignored })).toBeNull();
});

it('keeps the scan limits equal to pipeline/repository.ts', () => {
  const text = readFileSync(new URL('./repository.ts', import.meta.url), 'utf8');
  const constant = (name: string) => {
    const match = new RegExp(`const ${name} = ([^;]+);`).exec(text);
    return Function(`return ${match?.[1].replaceAll('_', '')}`)() as number;
  };
  expect(SCAN_LIMITS).toEqual({
    files: constant('MAX_FILES'),
    fileBytes: constant('MAX_FILE_BYTES'),
    totalBytes: constant('MAX_TOTAL_BYTES'),
  });
});

it('detects a non-test file that imports the SDK and makes a model call', () => {
  const call = "import OpenAI from 'openai';\nawait client.chat.completions.create({});";
  expect(detectModelCall('src/a.ts', call, 'openai')).toBe(true);
  expect(detectModelCall('src/a.ts', "import OpenAI from 'openai';", 'openai')).toBe(false);
  expect(detectModelCall('src/a.ts', "const OpenAI = require('openai');", 'openai')).toBe(false);
  expect(
    detectModelCall(
      'src/a.js',
      "const O = require('openai');\nc.audio.transcriptions.create(",
      'openai',
    ),
  ).toBe(true);
  for (const path of [
    'test/a.ts',
    'tests/a.ts',
    'src/__tests__/a.ts',
    'spec/a.ts',
    'e2e/a.ts',
    'fixtures/a.ts',
    'src/a.test.ts',
    'src/a.spec.js',
  ])
    expect(detectModelCall(path, call, 'openai'), path).toBe(false);
  const claude = "import Anthropic from '@anthropic-ai/sdk';\nawait c.messages.create({});";
  expect(detectModelCall('src/a.ts', claude, 'anthropic')).toBe(true);
  expect(
    detectModelCall(
      'a.ts',
      "import A from '@anthropic-ai/sdk';\nc.beta.messages.create(",
      'anthropic',
    ),
  ).toBe(true);
  expect(detectModelCall('a.ts', "import A from '@anthropic-ai/sdk';", 'anthropic')).toBe(false);
  expect(detectModelCall('a.ts', call, 'anthropic')).toBe(false);
});

it('orders by stars descending then full name with a plain comparison', () => {
  const list = [
    { repo: 'b/x', stars: 5 },
    { repo: 'a/x', stars: 5 },
    { repo: 'c/x', stars: 9 },
    { repo: 'B/x', stars: 5 },
  ];
  expect(list.sort(compareCandidates).map((entry) => entry.repo)).toEqual([
    'c/x',
    'B/x',
    'a/x',
    'b/x',
  ]);
});

it('collects lower-cased names from array and object lists and ignores invalid ones', () => {
  expect(frozenListNames([{ repo: 'A/B' }, { repo: 'bad name/x' }])).toEqual(['a/b']);
  expect(
    frozenListNames({ repos: [{ repository: 'C/d' }, { fullName: 'E/f' }, { name: 'g/H' }] }),
  ).toEqual(['c/d', 'e/f', 'g/h']);
  expect(frozenListNames({ repos: [] })).toEqual([]);
});

it('splits search into size buckets that never overlap or touch', () => {
  for (const buckets of Object.values(SIZE_BUCKETS)) {
    const ranges = buckets
      .map((bucket) => {
        const between = /^(\d+)\.\.(\d+)$/.exec(bucket);
        if (between) return [Number(between[1]), Number(between[2])];
        if (bucket.startsWith('<=')) return [0, Number(bucket.slice(2))];
        if (bucket.startsWith('<')) return [0, Number(bucket.slice(1)) - 1];
        return [Number(bucket.slice(2)), Infinity];
      })
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i += 1) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1);
  }
});

const registry = {
  deadlines: [
    {
      id: 'a',
      provider: 'openai',
      kind: 'model',
      versions: ['gpt-4-turbo', 'gpt-4-turbo-2024-04-09'],
      replacement: 'gpt-5',
    },
    {
      id: 'b',
      provider: 'openai',
      kind: 'model',
      versions: ['gpt-4.5-preview'],
      replacement: 'gpt-4.1',
    },
    { id: 'c', provider: 'openai', kind: 'model', versions: ['gpt-4.1'], replacement: 'gpt-5.6' },
    {
      id: 'd',
      provider: 'anthropic',
      kind: 'model',
      versions: ['claude-2.1'],
      replacement: 'claude-x',
    },
  ],
};

it('matches whole quoted registry IDs of one provider, longest first', () => {
  const pattern = modelPattern(registry, 'openai');
  const text = `a("gpt-4-turbo-2024-04-09", 'gpt-4-turbo') \`gpt-4-turbo\` "gpt-4o" "gpt-4-turbo-x" gpt-4-turbo "claude-2.1"`;
  expect(findCandidates(text, pattern).map((c) => c.model)).toEqual([
    'gpt-4-turbo-2024-04-09',
    'gpt-4-turbo',
    'gpt-4-turbo',
  ]);
  expect(findCandidates('x = "claude-2.1"', modelPattern(registry, 'openai'))).toEqual([]);
});

it('reports 1-based line and column, two on one line included', () => {
  const pattern = modelPattern(registry, 'openai');
  expect(findCandidates('\n  ["gpt-4-turbo", "gpt-4-turbo"]', pattern)).toEqual([
    { line: 2, column: 5, model: 'gpt-4-turbo' },
    { line: 2, column: 20, model: 'gpt-4-turbo' },
  ]);
});

it('applies the file exclusions and keeps other text files', () => {
  const text = new TextEncoder().encode('x');
  for (const path of [
    'node_modules/a.js',
    'a/.git/b',
    'package-lock.json',
    'x/yarn.lock',
    'bun.lockb',
  ])
    expect(candidateFile(path, text), path).toBe(false);
  expect(candidateFile('a.js', new Uint8Array(2 * 1024 * 1024 + 1))).toBe(false);
  expect(candidateFile('a.bin', new Uint8Array([65, 0, 66]))).toBe(false);
  for (const path of ['a.json', 'c.yaml', '.env.local', 'a.py', 'dist/app.js'])
    expect(candidateFile(path, text), path).toBe(true);
});

it('maps languages and generated paths', () => {
  expect(
    ['a.tsx', 'a.mjs', 'a.py', 'a.json', 'a.yml', '.env.local', 'a.mdx', 'a.toml'].map(languageOf),
  ).toEqual(['typescript', 'javascript', 'python', 'json', 'yaml', 'env', 'markdown', 'other']);
  expect(['dist/a.js', 'x/build/a.js', '.next/a', 'out/a', 'a/b.min.js'].every(isGenerated)).toBe(
    true,
  );
  expect(isGenerated('src/dist.js')).toBe(false);
});

it('follows replacement chains and throws on a cycle', () => {
  expect(followReplacement(registry, 'gpt-4.5-preview')).toBe('gpt-5.6');
  expect(followReplacement(registry, 'gpt-4-turbo')).toBe('gpt-5');
  const loop = {
    deadlines: [
      { id: 'a', provider: 'openai', kind: 'model', versions: ['m1'], replacement: 'm2' },
      { id: 'b', provider: 'openai', kind: 'model', versions: ['m2'], replacement: 'm1' },
    ],
  };
  expect(() => followReplacement(loop, 'm1')).toThrow(/cycle/);
});

it('packs whole groups up to the limit', () => {
  const g = (n: number) => Array.from({ length: n }, () => n);
  const batches = packBatches([g(30), g(20), g(50), g(5)], 40);
  expect(batches.map((b) => b.length)).toEqual([30, 20, 50, 5]);
  expect(packBatches([g(10), g(20), g(15)], 40).map((b) => b.length)).toEqual([30, 15]);
});

const candidate = {
  repo: 'o/r',
  provider: 'openai',
  file: 'a.ts',
  line: 3,
  column: 5,
  model: 'gpt-4-turbo',
  replacement: 'gpt-5',
};
const good = {
  ...candidate,
  live: true,
  via: 'sdk-text',
  notes: 'default model passed to the SDK',
};

it('validates labels', () => {
  const run = (label: Record<string, unknown> | null, extra: Record<string, unknown>[] = []) =>
    validateLabels([candidate], label ? [label, ...extra] : extra, [
      'const secret = "gpt-4-turbo";',
    ]).map((e) => e.kind);
  expect(run(good)).toEqual([]);
  expect(run({ ...good, via: 'wrapper:@ai-sdk/openai' })).toEqual([]);
  expect(run({ ...good, live: false, via: null, reason: 'test' })).toEqual([]);
  expect(run(null)).toEqual(['missing']);
  expect(run(good, [good])).toContain('duplicate');
  expect(run(good, [{ ...good, line: 9 }])).toContain('extra');
  expect(run({ ...good, color: 1 })).toContain('unknown-key:color');
  expect(run({ ...good, live: 'yes' })).toContain('live');
  expect(run({ ...good, via: 'magic' })).toContain('via');
  expect(run({ ...good, via: 'wrapper:Bad Name' })).toContain('via');
  expect(run({ ...good, live: false, via: 'sdk-text', reason: 'test' })).toContain('via-not-null');
  expect(run({ ...good, live: false, via: null })).toContain('reason');
  expect(run({ ...good, live: false, via: null, reason: 'nope' })).toContain('reason');
  expect(run({ ...good, reason: 'test' })).toContain('reason-present');
  expect(run({ ...good, replacement: 'gpt-4.1' })).toContain('replacement');
  for (const notes of ['', 'a\nb', 'x'.repeat(161), 'uses const secret = "gpt-4-turbo"; here'])
    expect(run({ ...good, notes }), notes).toContain(
      notes.includes('secret') ? 'notes-source-text' : 'notes',
    );
});

it('seededSample is deterministic, sorted-input independent and ceil-sized', () => {
  const keys = Array.from({ length: 100 }, (_, i) => `k${i}`);
  const a = seededSample(keys, 7, 0.1);
  expect(a).toHaveLength(10);
  expect(seededSample([...keys].reverse(), 7, 0.1)).toEqual(a);
  expect(seededSample(keys, 8, 0.1)).not.toEqual(a);
  expect(seededSample(keys.slice(0, 11), 7, 0.1)).toHaveLength(2);
  expect(seededSample([], 7, 0.1)).toEqual([]);
});

it('agreement counts live and via and lists disagreeing keys', () => {
  const l = (line: number, live: boolean, via: string | null) => ({
    repo: 'o/r',
    provider: 'openai',
    file: 'a.ts',
    line,
    column: 1,
    model: 'm',
    live,
    via,
  });
  const result = agreement(
    [l(1, true, 'sdk-text'), l(2, false, null), l(3, true, 'sdk-text')],
    [l(1, true, 'sdk-text'), l(2, false, null), l(3, true, 'raw-http')],
  );
  expect(result.live).toEqual({ agree: 3, total: 3 });
  expect(result.via).toEqual({ agree: 2, total: 3 });
  expect(result.disagreements).toEqual(['o/r|openai|a.ts|3|1|m']);
});
