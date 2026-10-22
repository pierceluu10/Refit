import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  checkClaims,
  evaluate,
  numericTokens,
  parseSays,
  reproduces,
  scopedLines,
  wilson,
} from '../scripts/benchmark-claims.mjs';

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tokens = (text: string) => numericTokens(text).map((token) => token.token);

it('finds the numbers a sentence claims, and skips dates, versions, names and references', () => {
  expect(
    tokens(
      'On October 16, 171 of 381 (45%) moved to `2026-09-30.endive` for $0.07 in [#156](https://github.com/x/y/pull/156), 2–4 seconds each.',
    ),
  ).toEqual(['171', '381', '45%', '$0.07', '2–4']);
  expect(
    tokens('**28/28, 100%** (88–100) on 2026-10-16 with stripe-node 23.0.0 and v25.0'),
  ).toEqual(['28/28', '100%', '88–100']);
  expect(tokens('6,512 repositories since 2024, from 2022–2023 pins, c7i and gpt4 aside')).toEqual([
    '6,512',
  ]);
  expect(tokens('costs $0.16–1.25 per repository, 0.7 s per app')).toEqual(['$0.16–1.25', '0.7']);
});

it('reads only the scoped sections, outside code fences and headings', () => {
  const markdown = [
    '# Title 1',
    'Intro with 3 numbers.',
    '## Kept',
    'Kept   has   4.',
    '```sh',
    'run --limit 5',
    '```',
    '### Sub 6',
    'Also 7.',
    '## Dropped',
    'Not 8.',
  ].join('\n');
  expect(scopedLines(markdown, ['Kept'])).toEqual([
    { number: 4, text: 'Kept has 4.' },
    { number: 9, text: 'Also 7.' },
  ]);
  expect(scopedLines(markdown).map((line) => line.number)).toEqual([2, 4, 9, 11]);
});

it('computes counts, sums, rates, fractions, intervals and values from result rows', () => {
  const data: Record<string, unknown> = {
    'a.json': {
      summary: { exposed: 3 },
      rows: [
        { outcome: 'validated', calls: 4, fields: ['x'], exposures: [{ id: 'gpt-4' }] },
        { outcome: 'not-affected', calls: 2, fields: [], exposures: [] },
        { outcome: 'stopped', calls: 10, fields: ['x', 'y'], exposures: [{ id: 'o1' }] },
      ],
    },
    'b.json': [{ outcome: 'validated', calls: 1, fields: ['y'] }],
  };
  const read = (file: string) => data[file];
  const both = { results: ['a.json', 'b.json'], rows: '' };
  const rows = (query: Record<string, unknown>) =>
    evaluate({ results: ['a.json'], rows: '/rows', ...query }, read);
  expect(rows({ where: [{ field: 'outcome', notIn: ['not-affected'] }] })).toBe(2);
  expect(rows({ measure: 'sum', field: 'calls' })).toBe(16);
  expect(rows({ where: [{ field: 'fields', includes: 'y' }] })).toBe(1);
  expect(rows({ where: [{ not: { field: 'calls', equalsField: 'fields.length' } }] })).toBe(3);
  expect(rows({ where: [{ field: 'exposures.length', equalsField: 'fields.length' }] })).toBe(2);
  expect(rows({ where: [{ field: 'exposures', some: [{ field: 'id', equals: 'o1' }] }] })).toBe(1);
  expect(rows({ flatten: 'exposures', measure: 'distinct', field: 'id' })).toBe(2);
  expect(rows({ measure: 'median', field: 'calls' })).toBe(4);
  expect(
    evaluate(
      { results: ['a.json', 'b.json'], rows: '', measure: 'median', field: 'calls' },
      (file) => (file === 'a.json' ? [{ calls: 1 }, { calls: 4 }] : [{ calls: 2 }, { calls: 9 }]),
    ),
  ).toBe(3);
  expect(rows({ measure: 'max', field: 'calls' })).toBe(10);
  expect(rows({ measure: 'range', field: 'calls' })).toEqual([2, 10]);
  expect(rows({ measure: 'mean', field: 'calls' })).toBeCloseTo(5.33);
  // The same list read twice: its one repository is in both.
  expect(
    evaluate({ results: ['b.json', 'b.json'], measure: 'repeated', field: 'outcome' }, read),
  ).toBe(1);
  expect(evaluate({ results: ['a.json'], value: '/summary/exposed', scale: 100 }, read)).toBe(300);
  expect(rows({ measure: 'ratio', field: 'calls', of: 'calls' })).toBe(100);
  expect(
    evaluate(
      { results: ['a.json'], rows: ['/rows', '/rows'], where: [{ field: 'calls', gt: 3 }] },
      read,
    ),
  ).toBe(4);
  expect(rows({ measure: 'rate', part: [{ field: 'outcome', equals: 'validated' }] })).toBeCloseTo(
    33.33,
  );
  expect(rows({ measure: 'fraction', part: [{ field: 'calls', gte: 4 }] })).toEqual([2, 3]);
  expect(evaluate({ results: ['a.json'], value: '/summary/exposed' }, read)).toBe(3);
  expect(
    evaluate(
      {
        ...both,
        rows: undefined,
        results: ['b.json'],
        where: [{ field: 'outcome', in: ['validated'] }],
      },
      read,
    ),
  ).toBe(1);
  // A join: rows whose outcome another file's rows have, and one bound of an interval.
  expect(
    evaluate(
      {
        results: ['a.json'],
        rows: '/rows',
        where: [{ field: 'outcome', inQuery: { results: ['b.json'], field: 'outcome' } }],
      },
      read,
    ),
  ).toBe(1);
  expect(
    evaluate(
      {
        results: ['a.json'],
        rows: '/rows',
        measure: 'interval',
        part: [{ field: 'calls', gt: 3 }],
        pick: 0,
      },
      read,
    ),
  ).toBeCloseTo(20.77);
  // The deadline benchmark's own figure: 28 of 32 is 88%, 95% CI 72–95.
  expect(wilson(28, 32).map(Math.round)).toEqual([72, 95]);
  expect(reproduces('72–95', wilson(28, 32))).toBe(true);
});

it('compares at the precision the document writes', () => {
  expect(parseSays('6,512')).toBe(6512);
  expect(parseSays('$0.07')).toBe(0.07);
  expect(parseSays('28/32')).toEqual([28, 32]);
  expect(parseSays('86–99.5')).toEqual([86, 99.5]);
  expect(reproduces('45%', 44.88)).toBe(true);
  expect(reproduces('45%', 44.4)).toBe(false);
  expect(reproduces('99.5', 99.46)).toBe(true);
  expect(reproduces('28/31', [28, 31])).toBe(true);
  expect(reproduces('28/31', [28, 30])).toBe(false);
  expect(reproduces('86–99.5', [86.2, 99.48])).toBe(true);
});

async function fixture(claims: unknown, document: string) {
  const root = await mkdtemp(join(tmpdir(), 'refit-claims-test-'));
  roots.push(root);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'BENCH.md'), document);
  await writeFile(
    join(root, 'results.json'),
    JSON.stringify({
      rows: [{ outcome: 'validated' }, { outcome: 'validated' }, { outcome: 'x' }],
    }),
  );
  await writeFile(join(root, 'claims.json'), JSON.stringify(claims));
  return root;
}

const validated = {
  results: ['results.json'],
  rows: '/rows',
  where: [{ field: 'outcome', equals: 'validated' }],
};

it('reports values that reproduce, differ or cannot be checked, and every uncovered number', async () => {
  const document = [
    '# Bench',
    '| Outcome | Repositories |',
    '|---|---|',
    '| Validated | **2** |',
    '',
    'We validated 3 of 3 on October 16, at a cost of $0.10. Item 7 is a name.',
    'A stray 9 nobody claims.',
  ].join('\n');
  const root = await fixture(
    {
      scope: [{ doc: 'docs/BENCH.md' }],
      claims: [
        {
          doc: 'docs/BENCH.md',
          quote: '| Validated | **2** |',
          values: [{ says: '2', query: validated }],
        },
        {
          doc: 'docs/BENCH.md',
          quote: 'We validated 3 of 3 on October 16, at a cost of $0.10.',
          values: [
            { says: '3', query: validated },
            { says: '3', query: { results: ['results.json'], rows: '/rows' } },
            { says: '$0.10', notCheckable: 'Spend is not in any committed results file.' },
          ],
        },
        {
          doc: 'docs/BENCH.md',
          quote: 'Item 7 is a name.',
          values: [],
          ignore: [{ token: '7', reason: 'An item number, not a measurement.' }],
        },
        { doc: 'docs/BENCH.md', quote: 'This sentence was removed.', values: [] },
        {
          doc: 'docs/BENCH.md',
          quote: '| Outcome | Repositories |',
          values: [{ says: '4', query: validated }],
        },
      ],
    },
    document,
  );
  const { values, problems } = checkClaims(join(root, 'claims.json'), { root });
  expect(
    values.map((value) => [value.says, value.status, value.recomputed ?? value.reason]),
  ).toEqual([
    ['2', 'reproduces', '2'],
    ['3', 'differs', '2'],
    ['3', 'reproduces', '3'],
    ['$0.10', 'not-checkable', 'Spend is not in any committed results file.'],
    ['4', 'differs', '2'],
  ]);
  expect(problems).toEqual([
    'docs/BENCH.md: "This sentence was removed." is not in the document any more.',
    'docs/BENCH.md: "| Outcome | Repositories |" has numbers [] but lists [4].',
    'docs/BENCH.md:7 has numbers in no claim: 9 in "A stray 9 nobody claims."',
  ]);
});

it('exits 1 from the command line and prints both values of a claim that differs', async () => {
  const root = await fixture(
    {
      scope: [{ doc: 'docs/BENCH.md' }],
      claims: [
        { doc: 'docs/BENCH.md', quote: 'Validated: 3.', values: [{ says: '3', query: validated }] },
      ],
    },
    'Validated: 3.\n',
  );
  const result = await execute(process.execPath, [
    resolve('scripts/benchmark-claims.mjs'),
    '--root',
    root,
    '--claims',
    join(root, 'claims.json'),
  ]).catch((error: { code: number; stdout: string }) => error);
  expect(result).toMatchObject({ code: 1 });
  expect((result as { stdout: string }).stdout).toBe(
    'differs  docs/BENCH.md: says 3, recomputed 2\n         "Validated: 3."\n0 reproduce, 1 differ, 0 not checkable; 0 problem(s).\n',
  );
});
