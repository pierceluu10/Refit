import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

// The compare and score command lines on hand-made results files, shaped like the benchmark's.
const execute = promisify(execFile);
const roots: string[] = [];
const COMMIT = 'a'.repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function files(contents: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-compare-test-'));
  roots.push(root);
  for (const [name, content] of Object.entries(contents))
    await writeFile(join(root, name), JSON.stringify(content));
  return (name: string) => join(root, name);
}

const affected = {
  read: 'ok',
  mappedMethods: 2,
  fullAdapter: { status: 'affected', confirmed: 1, review: 0, findings: [] },
};
const row = (repo: string, fields: Record<string, unknown>) => ({
  repo,
  commit: COMMIT,
  ...affected,
  ...fields,
});

it('reports outcome changes apart from infrastructure errors and missing repositories', async () => {
  const path = await files({
    'one.json': [
      row('a/changed', { workflow: { status: 'validated' } }),
      row('b/flaky', { workflow: { status: 'validated' } }),
      row('c/dropped', { workflow: { status: 'validated' } }),
      row('d/steady', { mappedMethods: 0 }),
    ],
    // Written before the harness: no outcomeClass, so rows are classified from their fields.
    'two.json': [
      row('a/changed', {
        workflow: { status: 'validation-failed', validation: 'regression' },
      }),
      row('b/flaky', { workflow: { status: 'missing-manifest' } }),
      null,
      row('d/steady', { mappedMethods: 0 }),
    ],
  });
  const compare = (...args: string[]) =>
    execute(process.execPath, ['scripts/stripe-benchmark-compare.mjs', ...args]);
  const { stdout } = await compare(path('one.json'), path('two.json'), '--json');
  const summary = JSON.parse(stdout);
  expect(summary).toMatchObject({
    repositories: 4,
    sameOutcome: 1,
    outcomeChanges: 1,
    infrastructureChanges: 1,
    missingChanges: 1,
    predates: ['/*/outcomeClass'],
  });
  expect(
    summary.rows.map((entry: { repo: string; outcomes: string[]; change: string }) => [
      entry.repo,
      entry.outcomes.join(' > '),
      entry.change,
    ]),
  ).toEqual([
    ['a/changed', 'validated > validation-regression', 'outcome'],
    ['b/flaky', 'validated > infrastructure-no-manifest', 'infrastructure'],
    ['c/dropped', 'validated > missing', 'missing'],
    ['d/steady', 'no-mapped-methods > no-mapped-methods', 'none'],
  ]);
  const text = (await compare(path('one.json'), path('two.json'))).stdout;
  expect(text).toContain(
    'Outcome changes: 1. Not outcome changes: 1 with an infrastructure error in some run, 1 missing from some run.',
  );
  expect(text).toContain('| a/changed | validated | validation-regression | differs');
  expect(text).toContain('| b/flaky | validated | infrastructure-no-manifest | infrastructure');

  await writeFile(path('bad.json'), JSON.stringify([{ repo: 'a/changed', commit: 'HEAD' }]));
  await expect(compare(path('one.json'), path('bad.json'))).rejects.toMatchObject({
    stderr: expect.stringContaining('/0/commit must match'),
  });
});

it('leaves labelled repositories with infrastructure errors out of the score', async () => {
  const labels = {
    repos: [
      { repo: 'a/fine', verdict: 'unaffected', reason: '', reads: [], requests: [] },
      {
        repo: 'b/clone',
        verdict: 'broken',
        reason: '',
        reads: [{ file: 'x.ts', line: 1, property: 'charges', label: 'breaking' }],
        requests: [],
      },
    ],
  };
  const path = await files({
    'labels.json': labels,
    'results.json': [
      row('a/fine', { fullAdapter: { status: 'clean', confirmed: 0, review: 0, findings: [] } }),
      {
        repo: 'b/clone',
        commit: COMMIT,
        outcomeClass: 'infrastructure',
        infrastructure: { kind: 'clone', message: 'no checkout at /work/root/repos/b__clone' },
      },
    ],
  });
  const { stdout } = await execute(process.execPath, [
    '--import',
    'tsx',
    resolve('pipeline/stripe-benchmark-score.ts'),
    '--results',
    path('results.json'),
    '--labels',
    path('labels.json'),
  ]);
  // The clone failure's breaking read is not counted as missed.
  expect(stdout).toContain('confirmed recall n/a (0/0)');
  expect(stdout).toContain('outcomes  strict 1/1');
  expect(stdout).toContain('not scored 1 infrastructure error(s): b/clone (clone)');
});
