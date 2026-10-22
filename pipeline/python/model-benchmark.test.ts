import { expect, it } from 'vitest';
import type { SdkCallRecord } from '../sdk-call-record.ts';
import { reported, scorePythonModels, type PythonModelResult } from './model-benchmark.ts';

const site = (file: string, line: number, model: string) => ({ file, line, model });

function record(
  file: string,
  line: number,
  literals: [string, number, string][],
  stop: string | null = null,
): SdkCallRecord {
  return {
    language: 'python',
    provider: 'openai',
    package: 'openai',
    file,
    line,
    column: 1,
    resource: 'chat.completions',
    method: 'create',
    expression: 'client.chat.completions.create',
    client: { kind: 'constructor', file, line: 1, column: 1, custom: null },
    options: ['model'],
    spread: false,
    arguments: {
      model: {
        literals: literals.map(([where, at, value]) => ({
          file: where,
          line: at,
          column: 1,
          value,
          via: 'literal',
        })),
        stop,
      },
    },
  };
}

it('reports literal sites once each and leaves test paths out', () => {
  expect(
    reported([
      record('app.py', 10, [['config.py', 2, 'gpt-4']]),
      record(
        'app.py',
        20,
        [
          ['config.py', 2, 'gpt-4'],
          ['tests/data.py', 1, 'gpt-4o'],
        ],
        'The model comes from `x`.',
      ),
      record('tests/test_app.py', 5, [['app.py', 3, 'o1']]),
    ]),
  ).toEqual({
    calls: [
      {
        file: 'app.py',
        line: 10,
        provider: 'openai',
        call: 'chat.completions.create',
        client: 'constructor',
      },
      {
        file: 'app.py',
        line: 20,
        provider: 'openai',
        call: 'chat.completions.create',
        client: 'constructor',
      },
    ],
    sites: [site('config.py', 2, 'gpt-4')],
    stops: [{ file: 'app.py', line: 20, reason: 'The model comes from `x`.' }],
  });
});

it('scores line precision and recall, ignoring ambiguous labels', () => {
  const labels = {
    repos: [
      {
        repo: 'a/one',
        commit: 'c1',
        calls: [
          { file: 'app.py', line: 10, provider: 'openai' },
          { file: 'app.py', line: 30, provider: 'openai' },
        ],
        sent: [site('config.py', 2, 'gpt-4'), site('app.py', 31, 'gpt-4o')],
        notSent: [site('app.py', 40, 'o1')],
        ambiguous: [site('app.py', 50, 'o3')],
      },
      {
        repo: 'b/two',
        commit: 'c2',
        calls: [],
        sent: [],
        notSent: [],
        ambiguous: [],
      },
    ],
  };
  const results: PythonModelResult[] = [
    {
      repo: 'a/one',
      commit: 'c1',
      status: 'scanned',
      calls: [
        {
          file: 'app.py',
          line: 10,
          provider: 'openai',
          call: 'chat.completions.create',
          client: 'module',
        },
      ],
      sites: [site('config.py', 2, 'gpt-4'), site('app.py', 40, 'o1'), site('app.py', 50, 'o3')],
      stops: [],
    },
    {
      repo: 'b/two',
      commit: 'c2',
      status: 'scanned',
      calls: [],
      sites: [site('x.py', 1, 'gpt-4')],
      stops: [],
    },
    {
      repo: 'c/unlabelled',
      commit: 'c3',
      status: 'scanned',
      calls: [],
      sites: [site('y.py', 1, 'gpt-4')],
      stops: [],
    },
  ];
  const score = scorePythonModels(labels, results);
  expect(score.counts).toEqual({
    truePositives: 1,
    falsePositives: 2,
    sent: 2,
    labelledCalls: 2,
    tracedCalls: 1,
  });
  expect(score.linePrecision).toBeCloseTo(1 / 3);
  expect(score.lineRecall).toBe(0.5);
  expect(score.callRecall).toBe(0.5);
  expect(score.wrong).toEqual(['a/one app.py:40 o1', 'b/two x.py:1 gpt-4']);
  expect(score.missed).toEqual(['a/one app.py:31 gpt-4o']);
});

it('refuses results that are missing or at another commit', () => {
  const labels = {
    repos: [{ repo: 'a/one', commit: 'c1', calls: [], sent: [], notSent: [], ambiguous: [] }],
  };
  const result: PythonModelResult = {
    repo: 'a/one',
    commit: 'c1',
    status: 'scanned',
    calls: [],
    sites: [],
    stops: [],
  };
  expect(() => scorePythonModels(labels, [])).toThrow('a/one was not scanned.');
  expect(() => scorePythonModels(labels, [{ ...result, commit: 'other' }])).toThrow(
    'a/one was scanned at other, not the labelled c1.',
  );
  expect(scorePythonModels(labels, [result]).linePrecision).toBeNull();
});
