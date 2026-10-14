import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { afterEach, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { buildPatchContext } from './patch-context.ts';
import { applySourceEdits } from './patches.ts';
import { STRIPE, type ProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { createSourceImportResolver } from './source-imports.ts';
import type { Repository } from './types.ts';

const ROOT = '/alias-fixture';
const client = `import Stripe from 'stripe'; export default new Stripe('test', {apiVersion: '2022-08-01'});`;
const consumer = `import billing from '@/client';
export async function history() { const intent = await billing.paymentIntents.retrieve('pi'); return intent.charges.data; }`;
const removal = {
  id: 'charges',
  schema: 'payment_intent',
  property: 'charges',
  pointer: '/charges',
};
const aliases = JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } });
const roots: string[] = [];

function repository(
  files: Record<string, string>,
  configurations: Record<string, string> = { 'tsconfig.json': aliases },
): Repository {
  return {
    root: ROOT,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    configurations: Object.entries(configurations).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}

function analyze(
  extra: Record<string, string> = {},
  configurations?: Record<string, string>,
  provider = STRIPE,
) {
  const input = repository(
    { 'src/history.ts': consumer, 'src/client.ts': client, ...extra },
    configurations,
  );
  return { input, result: analyzeRepository(input, [removal], provider) };
}

async function writeRepository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-source-aliases-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('traces an aliased default client, records its API version and includes it as read-only AI context', () => {
  const { input, result } = analyze();
  expect(result.findings).toMatchObject([{ file: 'src/history.ts', confidence: 'confirmed' }]);
  expect(result.apiVersionDeclarations).toMatchObject([
    { kind: 'constructor', status: 'literal', value: '2022-08-01' },
    { kind: 'request', status: 'inherited' },
  ]);
  expect(result.edits).toHaveLength(1);
  expect(buildPatchContext(input, new Set(['src/history.ts']))).toEqual([input.files[1]]);
  const modified = {
    ...input,
    files: input.files.map((file) => ({
      ...file,
      content: applySourceEdits(
        file.content,
        result.edits.filter((edit) => edit.file === file.path),
      ),
    })),
  };
  expect(analyzeRepository(modified, [removal]).findings).toEqual([]);
});

it.each([
  `import billing from '@/client'; billing.paymentIntents.retrieve = replacement;`,
  `import billing from '@/client'; mutate(billing);`,
  `import * as clients from '@/client'; mutate(clients.default);`,
  `export {default} from '@/client';`,
])('carries mutation and escape evidence through an aliased consumer: %s', (mutator) => {
  const { result } = analyze({ 'src/mutator.ts': mutator });
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});

it('traces CommonJS alias consumers and preserves named export identity', () => {
  const input = repository(
    {
      'src/client.cjs': `const Stripe = require('stripe'); const client = Stripe('test', {apiVersion: '2022-08-01'}); module.exports = {client};`,
      'src/history.cjs': consumer.replace(
        "import billing from '@/client';",
        "const {client: billing} = require('@/client');",
      ),
    },
    { 'jsconfig.json': aliases },
  );
  const result = analyzeRepository(input, [removal]);
  expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(result.edits).toHaveLength(1);
  expect(buildPatchContext(input, new Set(['src/history.cjs']))).toEqual([input.files[0]]);
  input.files.push({
    path: 'src/mutator.cjs',
    content: "const {client} = require('@/client'); client.paymentIntents.retrieve = replacement;",
  });
  expect(analyzeRepository(input, [removal]).edits).toEqual([]);
});

it('uses provider mappings for a nested SDK resource through an alias', () => {
  const provider: ProviderAdapter = {
    id: 'openai',
    packageName: 'openai',
    defaultImport: true,
    namedExport: 'OpenAI',
    operations: [{ resource: 'chat.completions', method: 'create', schema: 'ChatCompletion' }],
    propertyRenames: [{ schema: 'ChatCompletion', removed: 'model', replacement: 'model_id' }],
  };
  const input = repository({
    'src/client.ts': `import OpenAI from 'openai'; export default new OpenAI({apiKey: 'simulated'});`,
    'src/model.ts': `import client from '@/client'; async function model() { const completion = await client.chat.completions.create({model: 'simulated', messages: []}); return completion.model; }`,
  });
  const result = analyzeRepository(
    input,
    [{ ...removal, schema: 'ChatCompletion', property: 'model' }],
    provider,
  );
  expect(result.sdkCalls).toMatchObject([{ resource: 'chat.completions', method: 'create' }]);
  expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(result.edits[0].replacement).toBe('model_id');
});

it.each([
  ['exact', { '@/client': ['./src/client.ts'] }],
  ['wildcard', { '@/*': ['./src/*'] }],
  ['suffix', { '@/*ent': ['./src/*ent'] }],
  ['fallback', { '@/*': ['./missing/*', './src/*'] }],
  ['longest prefix', { '*': ['./wrong/*'], '@/*': ['./src/*'] }],
  ['exact beats wildcard', { '@/*': ['./wrong/*'], '@/client': ['./src/client.ts'] }],
])('matches TypeScript path selection for %s', (_name, paths) => {
  const input = repository(
    { 'src/history.ts': consumer, 'src/client.ts': client },
    { 'tsconfig.json': JSON.stringify({ compilerOptions: { paths } }) },
  );
  const sources = new Map(input.files.map((file) => [resolve(ROOT, file.path), file.content]));
  const resolution = createSourceImportResolver(input, sources);
  const options = ts.parseJsonConfigFileContent(
    { compilerOptions: { paths } },
    {
      useCaseSensitiveFileNames: true,
      fileExists: (name) => sources.has(name),
      readFile: (name) => sources.get(name),
      readDirectory: () => [],
    },
    ROOT,
    undefined,
    join(ROOT, 'tsconfig.json'),
  ).options;
  const expected = ts.resolveModuleName(
    '@/client',
    join(ROOT, 'src/history.ts'),
    { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler },
    { fileExists: (name) => sources.has(name), readFile: (name) => sources.get(name) },
  ).resolvedModule?.resolvedFileName;
  expect(expected).toBe(join(ROOT, 'src/client.ts'));
  expect(resolution.resolve('@/client', join(ROOT, 'src/history.ts'))).toBe(expected);
});

it.each([
  [
    'root baseUrl',
    {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: './src', paths: { '@/*': ['./*'] } },
      }),
    },
  ],
  [
    'inherited paths origin',
    {
      'tsconfig.json': '{"extends":"./config/base"}',
      'config/base.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['../src/*'] } } }),
    },
  ],
  [
    'inherited baseUrl',
    {
      'tsconfig.json': '{"extends":"./config/base"}',
      'config/base.json': JSON.stringify({
        compilerOptions: { baseUrl: '../src', paths: { '@/*': ['./*'] } },
      }),
    },
  ],
  [
    'configDir inheritance',
    {
      'tsconfig.json': '{"extends":"./config/base"}',
      'config/base.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['${configDir}/src/*'] } },
      }),
    },
  ],
  [
    'last extends wins',
    {
      'tsconfig.json': '{"extends":["./wrong.json","./right.json"]}',
      'wrong.json': '{"compilerOptions":{"paths":{"@/*":["./wrong/*"]}}}',
      'right.json': aliases,
    },
  ],
  [
    'JSON comments',
    {
      'tsconfig.json':
        '{/* application aliases */ "compilerOptions": {"paths": {"@/*": ["./src/*"],},},}',
    },
  ],
])('resolves %s using repository configuration only', (_name, configurations) => {
  const { result } = analyze({}, configurations);
  expect(result.sourceWarnings).toEqual([]);
  expect(result.findings).toMatchObject([{ confidence: 'confirmed' }]);
});

it('selects a nested project configuration and supports bare baseUrl imports without guessing prefixes', () => {
  const input = repository(
    {
      'src/client.ts': client,
      'src/history.ts': consumer.replace("'@/client'", "'client'"),
      'packages/billing/src/client.ts': client,
      'packages/billing/src/history.ts': consumer,
    },
    {
      'tsconfig.json': '{"compilerOptions":{"baseUrl":"./src"}}',
      'packages/billing/tsconfig.json': aliases,
    },
  );
  const result = analyzeRepository(input, [removal]);
  expect(result.findings).toHaveLength(2);
  expect(result.findings.every((finding) => finding.confidence === 'confirmed')).toBe(true);
  const guessed = analyze({}, {}).result;
  expect(guessed.edits).toEqual([]);
});

it.each([
  'not JSON',
  '{"extends":"@vendor/tsconfig"}',
  '{"extends":"../outside.json"}',
  '{"extends":"./missing.json"}',
  '{"compilerOptions":{"paths":{"@/**":["./src/*"]}}}',
  '{"compilerOptions":{"paths":{"@/*":["../outside/*"]}}}',
  '{"compilerOptions":{"paths":{"@/*":[]}}}',
  '{"compilerOptions":{"moduleSuffixes":[".native",""]}}',
  '{"compilerOptions":{"rootDirs":["src","generated"]}}',
  '{"references":[{"path":"./tsconfig.app.json"}]}',
])('keeps unsupported configuration under review and refuses paid context: %s', (configuration) => {
  const { input, result } = analyze(
    { 'src/history.ts': consumer.replace("'@/client'", "'./client'") },
    { 'tsconfig.json': configuration },
  );
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
  expect(result.sourceWarnings.length).toBeGreaterThan(0);
  expect(() => buildPatchContext(input, new Set(['src/history.ts']))).toThrow(/unverified/);
});

it.each([
  ["import Stripe from 'stripe'; const billing = new Stripe('test');", 'billing.ts'],
  ["const Stripe = require('stripe'); const billing = Stripe('test');", 'billing.cjs'],
  ["const {Stripe} = require('stripe'); const billing = new Stripe('test');", 'billing.cjs'],
])(
  'does not identify a configured local Stripe replacement as the vendor SDK: %s',
  (initialization, file) => {
    const input = repository(
      {
        [file]:
          initialization +
          `async function history() { const intent = await billing.paymentIntents.retrieve('pi'); return intent.charges; }`,
        'src/fake.ts': 'export default class Stripe {}',
      },
      { 'tsconfig.json': '{"compilerOptions":{"paths":{"stripe":["./src/fake.ts"]}}}' },
    );
    const result = analyzeRepository(input, [removal]);
    expect(result.sdkCalls).toEqual([]);
    expect(result.edits).toEqual([]);
  },
);

it('refuses an ambiguous earlier target instead of choosing its fallback, including mutations', () => {
  const { result } = analyze({
    'src/client.js': client,
    'src/mutator.ts': "import billing from '@/client'; mutate(billing);",
  });
  expect(result.edits).toEqual([]);
  expect(result.sourceWarnings.join(' ')).toContain('Ambiguous');
});

it('reads only local regular configuration inputs and includes them in scan identity', async () => {
  const root = await writeRepository({
    'tsconfig.json': '{"extends":"./config/base"}',
    'config/base.json': aliases.replace('./src/*', '../src/*'),
    'src/client.ts': client,
    'src/history.ts': consumer,
    'not-a-config.json': 'secret fixture not used',
  });
  const input = await readRepository(root);
  expect(input.configurations?.map((file) => file.path)).toEqual([
    'config/base.json',
    'tsconfig.json',
  ]);
  const options = {
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    apiVersionPolicy: 'source-verified' as const,
    proposePatch: true,
  };
  const before = await runPipeline(options);
  expect(before.findings).toMatchObject([{ confidence: 'confirmed' }]);
  expect(before.repository.configurations).toMatchObject([
    { path: 'config/base.json', sha256: expect.any(String), bytes: expect.any(Number) },
    { path: 'tsconfig.json', sha256: expect.any(String), bytes: expect.any(Number) },
  ]);
  await writeFile(join(root, 'config/base.json'), aliases.replace('./src/*', '../wrong/*'));
  const after = await runPipeline(options);
  expect(after.runId).not.toBe(before.runId);
  expect(after.patch.status).toBe('unsupported');
});

it.each(['symlink', 'declaration', 'excluded directory'])(
  'refuses a skipped %s before an otherwise matching fallback',
  async (kind) => {
    const root = await writeRepository({
      'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./hidden/*","./src/*"]}}}',
      'src/client.ts': client,
      'src/history.ts': consumer,
    });
    if (kind === 'symlink') await symlink(join(root, 'src'), join(root, 'hidden'));
    if (kind === 'declaration') {
      await mkdir(join(root, 'hidden'));
      await writeFile(join(root, 'hidden/client.d.ts'), 'export declare const client: unknown;');
    }
    if (kind === 'excluded directory') {
      await mkdir(join(root, 'node_modules/hidden'), { recursive: true });
      await writeFile(
        join(root, 'tsconfig.json'),
        '{"compilerOptions":{"paths":{"@/*":["./node_modules/hidden/*","./src/*"]}}}',
      );
    }
    const input = await readRepository(root);
    const result = analyzeRepository(input, [removal]);
    expect(result.edits).toEqual([]);
    expect(result.sourceWarnings.length).toBeGreaterThan(0);
  },
);

it('downgrades an otherwise traced client when a separate unresolved project might expose it', () => {
  const { result } = analyze(
    { 'other/mutator.ts': "import billing from '@/client'; mutate(billing);" },
    { 'tsconfig.json': aliases, 'other/tsconfig.json': '{"extends":"@vendor/tsconfig"}' },
  );
  expect(result.findings).toMatchObject([{ confidence: 'review' }]);
  expect(result.edits).toEqual([]);
});
