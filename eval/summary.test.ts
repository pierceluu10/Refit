import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RESULT_COLUMNS, RUN_COLUMNS, type ResultRow, type RunRow, writeCsv } from './results.ts';
import { renderSummary, summarize } from './summary.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('reports labeled confirmed precision, review count, and successful zero-finding repos', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-eval-summary-'));
  temporaryDirectories.push(directory);
  const resultsPath = join(directory, 'labeled.csv');
  const runsPath = join(directory, 'labeled.runs.csv');
  const results: ResultRow[] = [
    {
      repo: 'https://github.com/example/one',
      commit: 'a',
      file: 'one.js',
      line: '1',
      modelId: 'old',
      confidence: 'confirmed',
      label: 'correct',
      notes: 'direct call, checked',
    },
    {
      repo: 'https://github.com/example/two',
      commit: 'b',
      file: 'two.js',
      line: '2',
      modelId: 'old',
      confidence: 'confirmed',
      label: 'wrong',
      notes: 'fixture says "not runtime"',
    },
    {
      repo: 'https://github.com/example/two',
      commit: 'b',
      file: 'two.js',
      line: '3',
      modelId: 'old',
      confidence: 'needs-review',
      label: '',
      notes: '',
    },
    {
      repo: 'https://github.com/example/four',
      commit: 'd',
      file: 'four.js',
      line: '4',
      modelId: 'old',
      confidence: 'confirmed',
      label: '',
      notes: '',
    },
  ];
  const runs: RunRow[] = [
    {
      repo: 'https://github.com/example/one',
      commit: 'a',
      status: 'scanned',
      findingCount: '1',
      notes: '',
    },
    {
      repo: 'https://github.com/example/three',
      commit: 'c',
      status: 'scanned',
      findingCount: '0',
      notes: '',
    },
    {
      repo: 'https://github.com/example/failed',
      commit: '',
      status: 'clone-failed',
      findingCount: '',
      notes: 'not cloned',
    },
  ];
  await writeCsv(resultsPath, RESULT_COLUMNS, results);
  await writeCsv(runsPath, RUN_COLUMNS, runs);

  const summary = await summarize(resultsPath);

  expect(summary).toEqual({
    confirmedCorrect: 1,
    confirmedLabeled: 2,
    confirmedUnlabeled: 1,
    needsReview: 1,
    repositoriesWithNoFindings: ['https://github.com/example/three'],
  });
  expect(renderSummary(summary)).toContain('Confirmed precision: 1/2 (50.0%)');
  expect(renderSummary(summary)).toContain('Needs-review count: 1');
  expect(renderSummary(summary)).toContain('https://github.com/example/three');
});
