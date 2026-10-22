import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  SCHEMA_DIRECTORY,
  assertResults,
  loadSchemas,
  pointerPattern,
  validate,
  validateCommitted,
  validateRunDirectory,
} from '../scripts/benchmark-results.mjs';

const execute = promisify(execFile);
const script = resolve('scripts/benchmark-results.mjs');
const schemas = loadSchemas();
const roots: string[] = [];
const COMMIT = 'a'.repeat(40);

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'refit-results-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const harness = {
  formatVersion: 1,
  format: 'stripe-results',
  refit: { commit: COMMIT, source: 'git', dirty: null, allowDirty: false },
  list: { path: 'selected.json', sha256: 'b'.repeat(64) },
  options: { validate: false },
  node: 'v22.12.0',
  docker: null,
  startedAt: '2026-10-22T08:00:00.000Z',
};
const row = {
  repo: 'owner/app',
  commit: COMMIT,
  read: 'ok',
  mappedMethods: 0,
  seconds: 3,
  outcomeClass: 'repository',
};

it('validates every committed results file, failing older ones only on the fields they predate', () => {
  const reports = validateCommitted();
  expect(reports.length).toBeGreaterThanOrEqual(22);
  expect(reports.filter((report) => report.errors.length)).toEqual([]);
  const stripe = reports.find((report) => report.file === '2026-10-16-stripe-fresh-results.json')!;
  expect(stripe.format).toBe('stripe-rows');
  expect([...new Set(stripe.predates.map((item) => pointerPattern(item.pointer)))]).toEqual([
    '/harness',
    '/rows/*/outcomeClass',
  ]);
});

it('separates fields a row predates from real errors, with JSON pointers', () => {
  const legacy = { ...row } as Record<string, unknown>;
  delete legacy.outcomeClass;
  expect(validate(schemas, 'stripe-results', [legacy])).toEqual({
    errors: [],
    predates: [{ pointer: '/0/outcomeClass', message: 'is required' }],
  });
  const broken = validate(schemas, 'stripe-results', [
    { ...row, commit: 'abc', seconds: -1, workflow: {} },
  ]);
  expect(broken.errors).toEqual([
    { pointer: '/0/commit', message: 'must match ^[0-9a-f]{40}$' },
    { pointer: '/0/seconds', message: 'must be at least 0' },
    { pointer: '/0/workflow/status', message: 'is required' },
  ]);
  expect(broken.predates).toEqual([]);
});

it('checks results as they are written: a property set to undefined is absent', () => {
  // The benchmark builds workflow summaries with optional fields left undefined.
  const workflow = { status: 'validated', error: undefined, reason: 'Checks passed.' };
  expect(validate(schemas, 'stripe-results', [{ ...row, workflow }]).errors).toEqual([]);
  expect(
    validate(schemas, 'stripe-results', [{ ...row, outcomeClass: undefined }]).predates,
  ).toEqual([{ pointer: '/0/outcomeClass', message: 'is required' }]);
});

it('requires the infrastructure detail on infrastructure errors', () => {
  expect(
    validate(schemas, 'stripe-results', [{ ...row, outcomeClass: 'infrastructure' }]).errors,
  ).toEqual([{ pointer: '/0/infrastructure', message: 'is required' }]);
  expect(
    validate(schemas, 'stripe-results', [
      {
        ...row,
        outcomeClass: 'infrastructure',
        infrastructure: { kind: 'clone', message: 'checkout is not at the pinned commit' },
      },
    ]).errors,
  ).toEqual([]);
  expect(
    validate(schemas, 'stripe-results', [
      { ...row, outcomeClass: 'infrastructure', infrastructure: { kind: 'flaky', message: 'x' } },
    ]).errors.map((error) => error.pointer),
  ).toEqual(['/0/infrastructure/kind']);
});

it('lets summaries accept older results only when they ask to, and says what they predate', () => {
  const legacy = { ...row } as Record<string, unknown>;
  delete legacy.outcomeClass;
  expect(() => assertResults('stripe-results', [legacy])).toThrow(
    'Results do not match the stripe-results schema:\n  /0/outcomeClass is required',
  );
  expect(assertResults('stripe-results', [legacy, legacy], { allowPredating: true })).toEqual({
    predates: ['/*/outcomeClass'],
  });
  expect(() =>
    assertResults('stripe-results', [{ ...row, repo: 'no-owner' }], { allowPredating: true }),
  ).toThrow('/0/repo must match');
});

it('refuses schema keywords it does not implement instead of ignoring them', () => {
  const custom = new Map([['strict', { type: 'object', not: { required: ['x'] } }]]);
  expect(() => validate(custom, 'strict', {})).toThrow('Unsupported schema keyword "not".');
  expect(() => validate(schemas, 'no-such-format', {})).toThrow(
    'Unknown results format "no-such-format".',
  );
});

it('checks a run directory through its harness record', async () => {
  const root = await directory();
  await writeFile(join(root, 'harness.json'), JSON.stringify(harness));
  await writeFile(join(root, 'results.json'), JSON.stringify([row]));
  expect(validateRunDirectory(root)).toEqual({
    format: 'stripe-results',
    errors: [],
    predates: [],
  });
  await writeFile(
    join(root, 'harness.json'),
    JSON.stringify({ ...harness, refit: { ...harness.refit, commit: 'HEAD' } }),
  );
  expect(validateRunDirectory(root).errors.map((error) => error.pointer)).toEqual([
    '/refit/commit',
  ]);
  const cli = await execute(process.execPath, [script, root]).catch(
    (error: { code: number; stdout: string }) => error,
  );
  expect(cli).toMatchObject({ code: 1, stdout: expect.stringContaining(`invalid  ${root}`) });
});

it('keeps the committed index exact: unlisted files, stale predates and missing files fail', async () => {
  const benchmarks = await directory();
  await cp(SCHEMA_DIRECTORY, join(benchmarks, 'schemas'), { recursive: true });
  const index = (files: Record<string, { format: string; predates: string[] }>) =>
    writeFile(join(benchmarks, 'schemas', 'files.json'), JSON.stringify({ files }));
  const condensed = {
    run: '2026-10-22',
    refit: 'abc1234',
    target: '2026-09-30.endive',
    rows: [
      {
        repo: 'owner/app',
        commit: COMMIT,
        before: '2024-06-20',
        beforeSource: 'apiVersion pin',
        outcome: 'not-affected',
        sdkCalls: 1,
        tracedCalls: 1,
        confirmedReads: 0,
        confirmedFields: [],
        checks: null,
        reason: null,
        seconds: 2,
      },
    ],
  };
  await writeFile(join(benchmarks, '2026-10-22-stripe-results.json'), JSON.stringify(condensed));
  await index({
    '2026-10-22-stripe-results.json': {
      format: 'stripe-rows',
      predates: ['/harness', '/rows/*/outcomeClass'],
    },
  });
  expect(validateCommitted(benchmarks).map((report) => report.errors)).toEqual([[]]);

  await index({
    '2026-10-22-stripe-results.json': {
      format: 'stripe-rows',
      predates: ['/harness', '/rows/*/outcomeClass', '/rows/*/seconds'],
    },
    '2026-10-22-gone-results.json': { format: 'stripe-rows', predates: [] },
  });
  expect(validateCommitted(benchmarks).map((report) => report.errors)).toEqual([
    [
      {
        pointer: '/rows/*/seconds',
        message: 'is recorded as predated in files.json but present',
      },
    ],
    [{ pointer: '/', message: 'is listed in schemas/files.json but missing' }],
  ]);

  await index({});
  await mkdir(join(benchmarks, 'nested'));
  expect(validateCommitted(benchmarks)).toEqual([
    {
      file: '2026-10-22-stripe-results.json',
      errors: [{ pointer: '/', message: 'is not listed in schemas/files.json' }],
      predates: [],
    },
  ]);
});

it('exits 0 for the committed files from the command line', async () => {
  const { stdout } = await execute(process.execPath, [script, '--committed']);
  expect(stdout).toMatch(/^(\d+)\/\1 committed results files valid\.$/m);
});
