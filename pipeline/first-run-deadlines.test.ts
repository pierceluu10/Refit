import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

// What `refit deadlines` tells a new user on a repository with an expired API version, a retiring
// model and only test-file hits (docs/FIRST-RUN.md).
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-first-run-deadlines-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

// Dates relative to today, so one entry has passed and the other has not.
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const entry = (overrides: Record<string, unknown>) => ({
  summary: `${overrides.id} sunsets.`,
  replacement: null,
  source: 'https://provider.example/deprecations',
  checkedAt: day(-1),
  ...overrides,
});

async function deadlines(files: Record<string, string>) {
  const registry = await directory({
    'registry.json': JSON.stringify({
      formatVersion: 1,
      deadlines: [
        entry({
          id: 'openai-gpt-4',
          provider: 'openai',
          kind: 'model',
          versions: ['gpt-4'],
          date: day(30),
          replacement: 'gpt-5.6-sol',
          summary: 'OpenAI shuts down gpt-4.',
        }),
        entry({
          id: 'shopify-2025-10',
          provider: 'shopify',
          kind: 'api-version',
          versions: ['2025-10'],
          date: day(-6),
          summary: 'Shopify API version 2025-10 stops being accessible.',
        }),
      ],
    }),
  });
  const root = await directory(files);
  const { stdout } = await execute(process.execPath, [
    resolve('bin/refit.mjs'),
    'deadlines',
    '--repository',
    root,
    '--registry',
    join(registry, 'registry.json'),
  ]);
  return stdout;
}

it('marks a deadline that has passed as already in effect', async () => {
  const stdout = await deadlines({
    'package.json': JSON.stringify({ dependencies: { '@shopify/shopify-api': '11.0.0' } }),
    // As Hujjat/easy-product-recommendations pins it.
    'app/shopify.server.ts':
      "import { ApiVersion } from '@shopify/shopify-api';\nexport const apiVersion = ApiVersion.October25;\n",
  });
  // Before: the summary read as a future change and the line said only "(passed 6 days ago)".
  expect(stdout).toContain('\nPast due: Shopify API version 2025-10 stops being accessible.\n');
  expect(stdout).toContain(`  Deadline     ${day(-6)} (passed 6 days ago; already in effect)\n`);
});

it('points a retiring model at the model-fix proposal, not an API contract run', async () => {
  const stdout = await deadlines({
    'package.json': JSON.stringify({ dependencies: { openai: '4.20.0' } }),
    'src/chat.ts': "send({ model: 'gpt-4' });\n",
  });
  // Before: "Add it with `refit agents --add openai`, save reviewed contracts, then approve the
  // configuration with `refit enroll`".
  expect(stdout).toContain(
    '  Migration    Run `refit deadlines --propose-model-fixes` to see a patch that moves each traced call to gpt-5.6-sol; it applies nothing. `refit serve --model-fixes` can validate it and open a draft pull request.\n',
  );
});

it('says nothing in live code is exposed when a model is named only in tests', async () => {
  const stdout = await deadlines({
    'package.json': JSON.stringify({ dependencies: { openai: '4.20.0' } }),
    'test/chat.spec.js': "expect(model).toBe('gpt-4');\n",
  });
  expect(stdout).toContain(
    '\nNo API version or model this repository uses in live code has a deadline in the registry.\n',
  );
  expect(stdout).toMatch(
    /Named only outside live code[\s\S]*Not live\s+test\s+1\s+test\/chat\.spec\.js:1/,
  );
});
