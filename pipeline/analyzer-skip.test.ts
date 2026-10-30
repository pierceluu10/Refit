import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { analyzeRepository } from './analyzer.ts';
import { readProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('scans the rest of a repository when one file cannot be parsed, and reports it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-skip-'));
  roots.push(root);
  await cp(resolve('pipeline/fixtures/repository'), root, { recursive: true });
  await writeFile(join(root, 'broken.ts'), 'export const value = {,};\n');
  const report = await runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
  });
  expect(report.findings.some((finding) => finding.confidence === 'confirmed')).toBe(true);
  expect(report.warnings).toContainEqual(
    expect.stringMatching(
      /^Skipped unparseable file; its API usage was not scanned\. broken\.ts: /,
    ),
  );
});

it('reads a manifest and a shebang script that start with a byte order mark', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-skip-'));
  roots.push(root);
  await cp(resolve('pipeline/fixtures/repository'), root, { recursive: true });
  const manifest = join(root, 'package.json');
  await writeFile(manifest, `\uFEFF${await readFile(manifest, 'utf8')}`);
  await writeFile(
    join(root, 'seed.mjs'),
    "\uFEFF#!/usr/bin/env node\nimport Stripe from 'stripe';\nconst stripe = new Stripe('sk_test');\nconst intent = await stripe.paymentIntents.retrieve('pi_1');\nconsole.log(intent.charges.data);\n",
  );
  const report = await runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
  });
  expect(report.repository.dependencies[0]).toMatchObject({
    file: 'package.json',
    version: '^10.0.0',
  });
  expect(report.warnings.filter((warning) => warning.includes('unparseable'))).toEqual([]);
  expect(
    report.findings.filter((finding) => finding.file === 'seed.mjs').map((finding) => finding.line),
  ).toEqual([5]);
});

it('counts an untraced read of a removed field as unresolved, so the draft needs review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-skip-'));
  roots.push(root);
  await cp(resolve('pipeline/fixtures/repository'), root, { recursive: true });
  await writeFile(
    join(root, 'legacy.ts'),
    "import type Stripe from 'stripe';\nexport type Client = Stripe;\nexport function legacyCharges(intent: any) {\n  return intent.charges.data;\n}\n",
  );
  const report = await runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    proposePatch: true,
  });
  expect(
    report.findings.map(({ file, confidence, untraced }) => ({ file, confidence, untraced })),
  ).toEqual([
    { file: 'billing.ts', confidence: 'confirmed', untraced: undefined },
    { file: 'legacy.ts', confidence: 'review', untraced: true },
  ]);
  expect(report.patch).toMatchObject({ status: 'proposed', unresolvedFindings: 1 });
});

it('gives the same analysis when adapters share one snapshot as when each reads its own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-skip-'));
  roots.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { openai: '4.80.0', '@anthropic-ai/sdk': '0.40.0' } }),
  );
  await writeFile(
    join(root, 'ai.ts'),
    [
      "import OpenAI from 'openai';",
      "import Anthropic from '@anthropic-ai/sdk';",
      'const openai = new OpenAI();',
      'const anthropic = new Anthropic();',
      "openai.chat.completions.create({ model: 'gpt-4', messages: [] });",
      "anthropic.messages.create({ model: 'claude-3-opus-20240229', max_tokens: 9, messages: [] });",
    ].join('\n'),
  );
  const adapters = await Promise.all(
    ['openai', 'anthropic'].map((name) => readProviderAdapter(`examples/${name}.provider.json`)),
  );
  const calls = (analysis: ReturnType<typeof analyzeRepository>) =>
    analysis.sdkCalls.map((call) => `${call.line}:${call.resource}.${call.method}`);
  const shared = await readRepository(root);
  const together = adapters.map((adapter) =>
    calls(analyzeRepository({ ...shared, files: shared.files }, [], adapter)),
  );
  const apart = await Promise.all(
    adapters.map(async (adapter) =>
      calls(analyzeRepository(await readRepository(root, adapter.packageName), [], adapter)),
    ),
  );
  expect(together).toEqual([['5:chat.completions.create'], ['6:messages.create']]);
  expect(together).toEqual(apart);
});

it('does not flag a removed field name read through a field the before contract never sent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-skip-'));
  roots.push(root);
  await cp(resolve('pipeline/fixtures/repository'), root, { recursive: true });
  // `latest_attempt` is not a payment_intent field at the before version, so `charges` read through
  // it is not the removed payment_intent.charges; the direct read still is.
  await writeFile(
    join(root, 'attempts.ts'),
    "import Stripe from 'stripe';\nconst stripe = new Stripe('sk_test');\nexport async function attempts() {\n  const intent = await stripe.paymentIntents.retrieve('pi_1');\n  const nested = (intent as any).latest_attempt?.charges;\n  const deeper = intent.latest_attempt?.details?.charges;\n  return [nested, deeper, intent.charges];\n}\n",
  );
  const report = await runPipeline({
    repository: root,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
  });
  expect(
    report.findings
      .filter((finding) => finding.file === 'attempts.ts')
      .map(({ line, confidence }) => ({ line, confidence })),
  ).toEqual([{ line: 7, confidence: 'confirmed' }]);
});

it('does not flag an untraced read compared only with a string the removed field never held', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-skip-'));
  roots.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { stripe: '16.0.0' } }),
  );
  const contract = (after: boolean) => ({
    openapi: '3.0.3',
    info: {
      title: 'Simulated Stripe contract',
      version: after ? '2025-03-31.basil' : '2024-06-20',
    },
    paths: {},
    components: {
      schemas: {
        payment_intent: { type: 'object', properties: { id: { type: 'string' } } },
        line_item: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            ...(after ? {} : { type: { type: 'string', enum: ['invoiceitem', 'subscription'] } }),
          },
        },
      },
    },
  });
  await writeFile(join(root, 'before.json'), JSON.stringify(contract(false)));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract(true)));
  // A raw webhook body checked for a v2 event type, then a comparison with a value the removed
  // field did hold, and one with a value that is not a string literal.
  await writeFile(
    join(root, 'events.ts'),
    "import Stripe from 'stripe';\nexport const stripe = new Stripe('sk_test');\nexport function kind(body: string, wanted: string) {\n  const parsed = JSON.parse(body) as Record<string, unknown>;\n  if (parsed && parsed.type === 'v2.core.event') return 'ping';\n  if ((parsed.type) !== 'v2.core.event') return 'other';\n  if (parsed.type === 'subscription') return 'line';\n  return parsed.type === wanted;\n}\n",
  );
  const report = await runPipeline({
    repository: root,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    apiVersion: '2024-06-20',
  });
  expect(
    report.findings.filter((finding) => finding.file === 'events.ts').map(({ line }) => line),
  ).toEqual([7, 8]);
});
