import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  CHANGE_TYPES,
  changeTypes,
  checkIneligibility,
  declaredJs,
  declaredPy,
  fillSets,
  languageOf,
  lockedVersion,
  majorOf,
  metadataIneligibility,
  PROVIDERS,
  retiredModels,
  retiredPattern,
  usesSdk,
  applicationFiles,
} from '../scripts/ai-provider-sets-select.mjs';

const registry = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'data/deadlines.json'), 'utf8'),
);

it('reads SDK declarations from root manifests, not from wrapper packages', () => {
  expect(declaredJs('{"dependencies":{"openai":"^4.20.0"}}', ['openai'])).toEqual({
    openai: '^4.20.0',
  });
  expect(declaredJs('{"dependencies":{"@langchain/openai":"^0.1"}}', ['openai'])).toEqual({});
  expect(declaredJs('not json', ['openai'])).toEqual({});
  expect(declaredPy('openai==0.28.1\nlangchain-openai>=0.1\n', ['openai'])).toEqual({
    openai: '==0.28.1',
  });
  expect(declaredPy('langchain-openai>=0.1\nllama_index.llms.openai\n', ['openai'])).toEqual({});
  expect(declaredPy('dependencies = [\n  "openai>=1.3.0",\n]', ['openai'])).toEqual({
    openai: '>=1.3.0',
  });
  expect(declaredPy('[tool.poetry.dependencies]\nanthropic = "^0.25.0"', ['anthropic'])).toEqual({
    anthropic: '^0.25.0',
  });
  expect(declaredPy('google-generativeai\n', ['google-genai', 'google-generativeai'])).toEqual({
    'google-generativeai': '',
  });
});

it('reads the locked SDK from npm, pnpm and Yarn lockfiles', () => {
  const npm = JSON.stringify({ packages: { 'node_modules/openai': { version: '4.1.0' } } });
  expect(lockedVersion(npm, 'npm', 'openai')).toBe('4.1.0');
  const pnpm = "      '@anthropic-ai/sdk':\n        specifier: ^0.20.0\n        version: 0.20.9\n";
  expect(lockedVersion(pnpm, 'pnpm', '@anthropic-ai/sdk')).toBe('0.20.9');
  const yarn = '"@anthropic-ai/sdk@^0.20.0":\n  version "0.20.9"\n';
  expect(lockedVersion(yarn, 'yarn', '@anthropic-ai/sdk')).toBe('0.20.9');
  expect(lockedVersion('{', 'npm', 'openai')).toBeNull();
  expect(majorOf('^4.20.0')).toBe(4);
  expect(majorOf('==0.28.1')).toBe(0);
  expect(majorOf('latest')).toBeNull();
});

it('counts registry models retired before the freeze and the ones retired before the registry', () => {
  const openai = retiredModels(registry, 'openai', '2026-10-29');
  expect(openai).toContain('gpt-3.5-turbo');
  expect(openai).toContain('text-davinci-003');
  expect(openai).not.toContain('gpt-5-2025-08-07');
  expect(retiredModels(registry, 'anthropic', '2026-10-29')).toContain('claude-3-opus-20240229');
  expect(retiredModels(registry, 'gemini', '2026-10-29')).toContain('gemini-1.5-flash');
  const pattern = retiredPattern(openai);
  expect(pattern.test('model: "gpt-3.5-turbo"')).toBe(true);
  expect(pattern.test('model: "gpt-4o"')).toBe(false);
  expect(pattern.exec("'gpt-4-32k'")?.[1]).toBe('gpt-4-32k');
});

it('tags change types from application code and the SDK major', () => {
  const retired = retiredPattern(retiredModels(registry, 'openai', '2026-10-29'));
  const files = [
    {
      path: 'src/ai.ts',
      text: 'const r = await openai.completions.create({ model: "o3-mini", max_tokens: 5 });\nr.data.choices[0]',
    },
  ];
  expect(
    changeTypes({
      files,
      provider: 'openai',
      retired,
      sdkVersions: { openai: '4.20.0' },
      language: 'js',
    }),
  ).toEqual([
    'retired-model',
    'parameter-change',
    'legacy-endpoint',
    'old-sdk-major',
    'response-parsing',
  ]);
  expect(
    changeTypes({
      files: [{ path: 'a.ts', text: 'client.chat.completions.create({ model: "gpt-3.5-turbo" })' }],
      provider: 'openai',
      retired,
      sdkVersions: { openai: '7.1.0' },
      language: 'js',
    }),
  ).toEqual(['retired-model']);
  const gemini = retiredPattern(retiredModels(registry, 'gemini', '2026-10-29'));
  expect(
    changeTypes({
      files: [{ path: 'a.py', text: 'model.embed_content("x")' }],
      provider: 'gemini',
      retired: gemini,
      sdkVersions: { 'google-generativeai': '' },
      language: 'py',
    }),
  ).toEqual(['old-sdk-major', 'embeddings-fine-tunes']);
  expect(Object.keys(PROVIDERS.anthropic.tags).sort()).toEqual(
    CHANGE_TYPES.filter((type) => type !== 'retired-model' && type !== 'old-sdk-major').sort(),
  );
});

it('needs an SDK import and a client in application code, not tests or examples', () => {
  const files = applicationFiles([
    { path: 'tests/ai.test.ts', text: "import OpenAI from 'openai'; new OpenAI()" },
    { path: 'examples/chat.py', text: 'from openai import OpenAI\nOpenAI()' },
  ]);
  expect(files).toEqual([]);
  const app = [
    { path: 'src/ai.ts', text: "import OpenAI from 'openai';\nconst c = new OpenAI();" },
  ];
  expect(usesSdk(app, 'openai', 'js')).toBe(true);
  expect(
    usesSdk(
      [{ path: 'app.py', text: 'import anthropic\nc = anthropic.Anthropic()' }],
      'anthropic',
      'py',
    ),
  ).toBe(true);
  expect(
    usesSdk(
      [{ path: 'app.py', text: 'from google import genai\nc = genai.Client()' }],
      'gemini',
      'py',
    ),
  ).toBe(true);
  expect(
    usesSdk(
      [{ path: 'a.ts', text: "import { x } from '@langchain/openai'; new OpenAI()" }],
      'openai',
      'js',
    ),
  ).toBe(false);
  expect(languageOf({ uses: { js: true, py: true } })).toBe('js');
  expect(languageOf({ uses: { js: false, py: true } })).toBe('py');
  expect(checkIneligibility({ uses: { js: false, py: false } })).toBe(
    'no SDK client in application code',
  );
  expect(checkIneligibility({ error: 'ETIMEDOUT' })).toBe('clone failed');
});

it("applies the holdout sets' metadata filters and needs a root SDK declaration", () => {
  const record = {
    isArchived: false,
    isFork: false,
    diskUsage: 100,
    pushedAt: '2025-01-01T00:00:00Z',
    defaultBranchRef: { target: { oid: 'a'.repeat(40) } },
    declared: { js: { openai: '^4' }, py: {} },
  };
  expect(metadataIneligibility(record)).toBeNull();
  expect(metadataIneligibility({ ...record, isFork: true })).toBe('fork');
  expect(metadataIneligibility({ ...record, diskUsage: 60 * 1024 })).toBe('over 50 MB');
  expect(metadataIneligibility({ ...record, pushedAt: '2023-12-31T00:00:00Z' })).toBe(
    'no push since 2024-01-01',
  );
  expect(metadataIneligibility({ ...record, declared: { js: {}, py: {} } })).toBe(
    'SDK not in a root manifest',
  );
  expect(metadataIneligibility(null)).toBe('unavailable');
});

it('fills each language with every change type minimum first, then seeded order, using a repository once', async () => {
  const pool = [
    { repo: 'a/1', language: 'js', changeTypes: [] },
    { repo: 'a/2', language: 'js', changeTypes: ['beta-header'] },
    { repo: 'a/3', language: 'py', changeTypes: ['retired-model'] },
    { repo: 'a/4', language: 'js', changeTypes: ['retired-model'] },
    { repo: 'a/5', language: 'js', changeTypes: [] },
    { repo: 'a/6', language: 'py', changeTypes: [] },
  ];
  const used = new Set<string>();
  const next = async (
    _stratum: string,
    language: string,
    accept: (c: (typeof pool)[0]) => boolean,
  ) => {
    const found = pool.find((c) => !used.has(c.repo) && c.language === language && accept(c));
    if (found) used.add(found.repo);
    return found ?? null;
  };
  const minimum = { js: 1, py: 1 };
  const [first, second] = await fillSets(
    [
      { name: 'm', js: 2, py: 1, minimum },
      { name: 'd', js: 2, py: 1, minimum },
    ],
    next,
  );
  expect(first.repos.map((r: { repo: string }) => r.repo)).toEqual(['a/4', 'a/2', 'a/3']);
  expect(second.repos.map((r: { repo: string }) => r.repo)).toEqual(['a/1', 'a/5', 'a/6']);
  expect(second.shortfall['js retired-model']).toBe(1);
  await expect(
    fillSets([{ name: 'x', js: 1, py: 0, minimum: { js: 0, py: 0 } }], next),
  ).rejects.toThrow('x needs 1 js repositories, got 0');
});
