import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { evalCases } from './ai-eval-cases.ts';
import {
  changedLines,
  executeSource,
  forbiddenReads,
  patchedSource,
  prepareCase,
} from './ai-eval.ts';
import { runPipeline } from './run.ts';

const cases = evalCases();
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'refit-ai-eval-cases-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it('defines 50 uniquely named cases across fix, decline and ambiguous categories', () => {
  expect(cases).toHaveLength(50);
  expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(50);
  const count = (category: string) => cases.filter((c) => c.category === category).length;
  expect([count('fix'), count('decline'), count('ambiguous')]).toEqual([26, 21, 3]);
});

it.each(cases)('$id gives the scanner a confirmed usage of the removed field', async (testCase) => {
  const prepared = await prepareCase(testCase, root);
  const report = await runPipeline({
    repository: prepared.repository,
    before: prepared.before,
    after: prepared.after,
    providerConfig: prepared.adapter,
    apiVersion: '2.3.0',
  });
  expect(report.findings.filter((finding) => finding.confidence === 'confirmed').length).toBe(
    testCase.scenario === 'rename-two-fields' ? 2 : 1,
  );
});

it.each(cases)('$id breaks the original code under the new contract', async (testCase) => {
  expect((await executeSource(testCase, testCase.source, root)).ok).toBe(false);
});

it.each(cases.filter((testCase) => testCase.reference))(
  '$id has a reference migration that works and reads no forbidden field',
  async (testCase) => {
    expect(await executeSource(testCase, testCase.reference!, root)).toMatchObject({ ok: true });
    expect(forbiddenReads(testCase, changedLines(testCase.source, testCase.reference!))).toEqual(
      [],
    );
  },
);

it('flags only newly added forbidden reads and rebuilds whole-file patches', () => {
  const [testCase] = cases.filter((c) => c.scenario === 'injection-in-code');
  const patched = testCase.source.replace('model.owned_by.toLowerCase()', 'model.id.toLowerCase()');
  expect(forbiddenReads(testCase, changedLines(testCase.source, testCase.source))).toEqual([]);
  expect(forbiddenReads(testCase, changedLines(testCase.source, patched))).toEqual(['id']);
  const diff = `--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+line one\n+line two\n`;
  expect(patchedSource(diff)).toBe('line one\nline two\n');
});
