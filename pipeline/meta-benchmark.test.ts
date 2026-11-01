import { expect, it } from 'vitest';
import type { GraphCall } from './meta-graph-calls.ts';
import { metaResult, metaRow, stopKind, summaryTable } from './meta-benchmark.ts';

const call = (overrides: Partial<GraphCall>): GraphCall => ({
  kind: 'url',
  host: 'graph.facebook.com',
  file: 'src/a.ts',
  line: 1,
  use: 'live',
  client: 'fetch',
  method: 'GET',
  version: 'v19.0',
  versionSource: 'url',
  pin: { file: 'src/a.ts', line: 1 },
  path: '/me',
  edge: null,
  fields: [],
  metrics: [],
  parameters: [],
  unknown: [],
  text: '',
  ...overrides,
});

it('names the kind of each stop reason meta-graph-moves writes', () => {
  expect(stopKind('src/a.ts:3: v21.0 field-removed page-x: Removed.')).toBe('listed-change');
  expect(stopKind('src/a.ts:3: the URL names no version')).toBe('unversioned');
  expect(stopKind('src/a.ts:3: the version is built at runtime')).toBe('unversioned');
  expect(stopKind('src/a.ts:3: the requested fields are not known')).toBe('unknown-request');
  expect(stopKind('src/a.ts:3: the version is in `V`, which is not a const')).toBe(
    'version-holder',
  );
  expect(stopKind('v13.0: this changelog is not reviewed in the Meta Graph API change list')).toBe(
    'unreviewed-changelog',
  );
  expect(stopKind('something new')).toBe('other');
});

it('makes a row from the scan and proposal', () => {
  const scan = {
    calls: [call({}), call({ use: 'test', version: 'v10.0' })],
    sdk: null,
    warnings: [],
  };
  const move = {
    file: 'src/a.ts',
    line: 1,
    from: 'v19.0',
    to: 'v26.0',
    crossed: [],
    requests: [],
    rules: [],
  };
  const stop = {
    file: null,
    line: null,
    from: null,
    requests: [],
    reasons: ['x: the URL names no version'],
  };
  expect(
    metaRow(scan, {
      target: 'v26.0',
      moves: [move],
      stops: [],
      current: [],
      patch: 'diff',
      edits: [],
    }),
  ).toMatchObject({
    outcome: 'version-move',
    liveRequests: 1,
    testRequests: 1,
    versions: ['v19.0'],
  });
  const row = metaRow(scan, {
    target: 'v26.0',
    moves: [move],
    stops: [stop],
    current: [],
    patch: null,
    edits: [],
  });
  expect(row).toMatchObject({ outcome: 'needs-review', stopKinds: { unversioned: 1 } });
  expect(
    metaRow(
      { calls: [], sdk: null, warnings: [] },
      { target: 'v26.0', moves: [], stops: [], current: [], patch: null, edits: [] },
    ).outcome,
  ).toBe('no-graph-usage');
  const table = summaryTable([
    { ...row, outcomeClass: 'repository', workflow: { status: 'validated', grade: 'C' } },
    { outcomeClass: 'infrastructure' },
    { error: 'boom', outcomeClass: 'repository' },
  ]);
  for (const line of [
    '| error | 1 |',
    '| infrastructure | 1 |',
    '| needs-review | 1 |',
    '| unversioned | 1 |',
    '| validated | 1 |',
    '| C | 1 |',
  ])
    expect(table).toContain(line);
});

it('ends every row in one of the four outcomes', () => {
  expect(metaResult({ outcomeClass: 'infrastructure' })).toBe('infrastructure');
  expect(metaResult({ outcome: 'needs-review', workflow: { status: 'validated' } })).toBe(
    'validated',
  );
  expect(metaResult({ outcome: 'current' })).toBe('no-change');
  expect(metaResult({ outcome: 'no-graph-usage' })).toBe('no-change');
  expect(metaResult({ outcome: 'needs-review', workflow: { status: 'needs-review' } })).toBe(
    'needs-review',
  );
  expect(metaResult({ outcome: 'needs-review' })).toBe('needs-review');
});
