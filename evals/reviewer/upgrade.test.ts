import { describe, expect, it } from 'vitest';
import type { ExternalTask, RunRecord } from '../../shared/types.ts';
import { BudgetLedger } from '../runner/budget.ts';
import { FakeModelClient } from './model.ts';
import { buildReviewPrompt, contextPaths, createReviewer, REVIEWER_SYSTEM } from './reviewer.ts';

// Illustrative upgrade PR for the reviewer. Not a real repo or run.
const task: ExternalTask = {
  id: 'example-org/api#node-18-eol',
  repo: 'example-org/api',
  priority: 1,
  change: {
    provider: 'nodejs',
    id: 'node-18-eol',
    kind: 'runtime-eol',
    dependencyKind: 'runtime',
    dependency: 'node',
    title: 'Example: Node.js 18 is end of life',
    fromVersions: ['18'],
    toVersion: '22',
    severity: 'deadline',
    source: { url: 'https://nodejs.org/en/about/previous-releases', quote: 'example quote' },
    affects: { versions: ['18'] },
  },
  usages: [],
  dependencies: [
    {
      repo: 'example-org/api',
      kind: 'runtime',
      name: 'node',
      version: '18',
      declaredIn: [
        { file: '.nvmrc', line: 1, text: '18' },
        { file: 'Dockerfile', line: 1, text: 'FROM node:18-bookworm' },
        { file: '.github/workflows/ci.yml', line: 12, text: 'node-version: 18' },
      ],
    },
  ],
};

const record: RunRecord = {
  taskId: task.id,
  outcome: 'verified',
  diff: 'diff --git a/.nvmrc b/.nvmrc\n--- a/.nvmrc\n+++ b/.nvmrc\n@@ -1 +1 @@\n-18\n+22\n',
  checks: [{ name: 'test', before: 'pass (node 18)', after: 'pass (node 22)' }],
  costUsd: 0,
  transcriptPath: '',
  pr: 'https://github.com/example-org/api/pull/1',
};

describe('reviewing upgrade PRs', () => {
  it('asks about every declared place and the new version', () => {
    expect(REVIEWER_SYSTEM).toContain('every place it is declared');
    const prompt = buildReviewPrompt(task, record);
    expect(prompt).toContain('Dependency: node (runtime) from 18 → 22');
    expect(prompt).toContain('- Dockerfile:1 node@18 (FROM node:18-bookworm)');
    expect(prompt).toContain('- .github/workflows/ci.yml:12');
  });

  it('reads the declared files as context, not only the touched ones', () => {
    expect(contextPaths(task, record)).toEqual([
      '.nvmrc',
      'Dockerfile',
      '.github/workflows/ci.yml',
    ]);
  });

  it('stays advisory: the review is returned next to the grade, which it never changes', async () => {
    const client = new FakeModelClient(
      JSON.stringify({
        opinion: 'has-concerns',
        summary: 'Dockerfile and CI still on 18.',
        concerns: [{ file: 'Dockerfile', issue: 'FROM still node:18', severity: 'high' }],
        checkFirst: ['Dockerfile'],
      }),
    );
    const before = structuredClone(record);
    const review = await createReviewer(client)({ task, record, meter: new BudgetLedger(1) });
    expect(review.opinion).toBe('has-concerns');
    expect(record).toEqual(before);
  });
});
