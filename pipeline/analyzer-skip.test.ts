import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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
