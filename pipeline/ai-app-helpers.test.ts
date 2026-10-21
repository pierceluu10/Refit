import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  SCAN_LIMITS,
  SIZE_BUCKETS,
  appShape,
  compareCandidates,
  declaresSdk,
  detectModelCall,
  excludedName,
  frozenListNames,
  scanLimitsFromTree,
  shallowCheckout,
  validRepoName,
  validSha,
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
