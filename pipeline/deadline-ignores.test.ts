import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  applyDeadlineIgnores,
  deadlineCheck,
  parseDeadlineIgnores,
  parseFailWithin,
  readDeadlineIgnores,
  type DeadlineIgnore,
} from './deadline-ignores.ts';
import type { DeadlineExposure } from './deadline-exposure.ts';
import type { DeadlineEntry } from './deadline-registry.ts';

const execute = promisify(execFile);
const bin = resolve('bin/refit.mjs');
const NOW = new Date('2026-10-16T12:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-deadline-ignores-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

function deadline(id: string, date: string): DeadlineEntry {
  return {
    id,
    provider: 'openai',
    kind: 'model',
    versions: [id],
    date,
    summary: `${id} shuts down.`,
    replacement: null,
    source: 'https://provider.example/deprecations',
    checkedAt: '2026-10-15',
  };
}

function exposure(id: string, days: number, files: string[], more = 0): DeadlineExposure {
  return {
    deadline: deadline(id, '2026-10-23'),
    days,
    evidence: files.map((file, index) => ({
      file,
      line: index + 1,
      kind: 'source',
      use: 'live',
      version: id,
      text: `model: '${id}'`,
    })),
    more,
    nonLive: [],
    nonLiveMore: 0,
  };
}

const ignore = (overrides: Partial<DeadlineIgnore> & Pick<DeadlineIgnore, 'deadline'>) => ({
  reason: 'Migration scheduled for the next release.',
  until: '2026-11-30',
  ...overrides,
});

it('accepts a valid ignore file and normalizes its paths', () => {
  expect(
    parseDeadlineIgnores(
      {
        formatVersion: 1,
        ignore: [
          ignore({ deadline: 'meta-graph-v19-0', reason: '  Falls forward to v21.  ' }),
          ignore({ deadline: 'openai-x', paths: ['./src/legacy/', 'scripts'] }),
        ],
      },
      NOW,
    ),
  ).toEqual([
    {
      deadline: 'meta-graph-v19-0',
      reason: 'Falls forward to v21.',
      until: '2026-11-30',
      paths: null,
    },
    {
      deadline: 'openai-x',
      reason: 'Migration scheduled for the next release.',
      until: '2026-11-30',
      paths: ['src/legacy', 'scripts'],
    },
  ]);
});

it('rejects the whole file on any problem and reports every problem at once', () => {
  const invalid = (value: unknown) => () => parseDeadlineIgnores(value, NOW);
  expect(invalid([])).toThrow(/formatVersion: 1 and an ignore array/);
  expect(invalid({ formatVersion: 2, ignore: [] })).toThrow(/formatVersion: 1/);
  expect(invalid({ formatVersion: 1, ignore: [], extra: true })).toThrow(/and nothing else/);
  expect(
    invalid({
      formatVersion: 1,
      ignore: Array.from({ length: 101 }, () => ignore({ deadline: 'a' })),
    }),
  ).toThrow(/at most 100/);
  let message = '';
  try {
    parseDeadlineIgnores(
      {
        formatVersion: 1,
        ignore: [
          { deadline: 'Bad.Id', reason: ' ', until: '2026-02-30', note: 'x' },
          ignore({ deadline: 'ok-id', until: '2027-10-17' }),
          ignore({ deadline: 'ok-id', reason: 'x'.repeat(501) }),
          ignore({ deadline: 'ok-id', paths: [] }),
          ignore({ deadline: 'ok-id', paths: ['../outside', '/etc', 'C:/x', 'a//b', 'src/./x'] }),
          'not an object',
        ],
      },
      NOW,
    );
  } catch (error) {
    message = (error as Error).message;
  }
  for (const expected of [
    'ignore[0] has unknown fields: note.',
    'ignore[0].deadline must be a registry deadline id',
    'ignore[0].reason must say why this exposure is accepted.',
    'ignore[0].until must be a real YYYY-MM-DD date.',
    'ignore[1].until must be within 365 days',
    'ignore[2].reason must be at most 500 characters.',
    'ignore[3].paths must list 1–20 repository paths.',
    'ignore[4].paths must be relative repository paths without ".."',
    'ignore[5] must be an object.',
  ])
    expect(message).toContain(expected);
  // Exactly a year out is still allowed.
  expect(
    parseDeadlineIgnores(
      { formatVersion: 1, ignore: [ignore({ deadline: 'a', until: '2027-10-16' })] },
      NOW,
    ),
  ).toHaveLength(1);
});

it('reads only regular, bounded ignore files and fails on a missing explicit file', async () => {
  const empty = await directory();
  expect(await readDeadlineIgnores(empty, NOW)).toEqual({ file: null, entries: [] });
  await expect(readDeadlineIgnores(empty, NOW, join(empty, 'missing.json'))).rejects.toThrow(
    /ENOENT/,
  );
  const valid = JSON.stringify({ formatVersion: 1, ignore: [ignore({ deadline: 'a' })] });
  const root = await directory({ '.refit-deadlines-ignore.json': valid, 'other.json': valid });
  expect((await readDeadlineIgnores(root, NOW)).file).toBe('.refit-deadlines-ignore.json');
  expect((await readDeadlineIgnores(root, NOW, join(root, 'other.json'))).entries).toHaveLength(1);

  const linked = await directory({ 'real.json': valid });
  await symlink(join(linked, 'real.json'), join(linked, '.refit-deadlines-ignore.json'));
  await expect(readDeadlineIgnores(linked, NOW)).rejects.toThrow(/regular file, not a link/);
  const folder = await directory();
  await mkdir(join(folder, '.refit-deadlines-ignore.json'));
  await expect(readDeadlineIgnores(folder, NOW)).rejects.toThrow(/regular file/);
  const large = await directory({ '.refit-deadlines-ignore.json': ' '.repeat(64 * 1024 + 1) });
  await expect(readDeadlineIgnores(large, NOW)).rejects.toThrow(/exceeds 64 KiB/);
  const broken = await directory({ '.refit-deadlines-ignore.json': '{ not json' });
  await expect(readDeadlineIgnores(broken, NOW)).rejects.toThrow();
});

it('accepts an exposure only when an active ignore covers all of its live evidence', () => {
  const known = new Set(['wide', 'scoped', 'partial', 'lookalike', 'capped', 'expired', 'none']);
  const exposures = [
    exposure('wide', 3, ['src/a.ts', 'lib/b.ts']),
    exposure('scoped', 3, ['src/legacy/a.ts', 'src/legacy/deep/b.ts']),
    exposure('partial', 3, ['src/legacy/a.ts', 'src/new.ts']),
    // src/legacy must not cover the sibling folder src/legacy-old.
    exposure('lookalike', 3, ['src/legacy-old/a.ts']),
    exposure('capped', 3, ['src/legacy/a.ts'], 4),
    exposure('expired', 3, ['src/a.ts']),
    exposure('none', 3, ['src/a.ts']),
  ];
  const { decisions, expired, unknown } = applyDeadlineIgnores(
    exposures,
    [
      ignore({ deadline: 'wide', paths: null }),
      ignore({ deadline: 'scoped', paths: ['src/legacy'] }),
      ignore({ deadline: 'partial', paths: ['src/legacy'] }),
      // A prefix must match whole path segments: src/leg does not cover src/legacy.
      ignore({ deadline: 'partial', paths: ['src/leg'] }),
      ignore({ deadline: 'lookalike', paths: ['src/legacy'] }),
      ignore({ deadline: 'capped', paths: ['src/legacy'] }),
      ignore({ deadline: 'expired', until: '2026-10-15', paths: null }),
      ignore({ deadline: 'not-in-registry', paths: null }),
    ].map((entry) => ({ paths: null, ...entry })),
    known,
    NOW,
  );
  expect(decisions.get('wide')?.ignoredBy).toHaveLength(1);
  expect(decisions.get('scoped')?.ignoredBy).toHaveLength(1);
  expect(decisions.get('partial')).toEqual({
    ignoredBy: [],
    note: 'Not covered by the ignore paths: src/new.ts.',
  });
  expect(decisions.get('lookalike')).toEqual({
    ignoredBy: [],
    note: 'Not covered by the ignore paths: src/legacy-old/a.ts.',
  });
  expect(decisions.get('capped')?.ignoredBy).toEqual([]);
  expect(decisions.get('capped')?.note).toMatch(
    /cannot cover the 4 matches past the listing limit/,
  );
  expect(decisions.has('expired')).toBe(false);
  expect(decisions.has('none')).toBe(false);
  expect(expired.map((entry) => entry.deadline)).toEqual(['expired']);
  expect(unknown.map((entry) => entry.deadline)).toEqual(['not-in-registry']);
  // An ignore is active through its until date.
  expect(
    applyDeadlineIgnores(
      [exposure('wide', 3, ['a.ts'])],
      [{ ...ignore({ deadline: 'wide', until: '2026-10-16' }), paths: null }],
      known,
      NOW,
    ).decisions.get('wide')?.ignoredBy,
  ).toHaveLength(1);
});

it('fails on live exposures that are past due or inside the window, unless accepted', () => {
  const exposures = [
    exposure('past', -40, ['a.ts']),
    exposure('today', 0, ['a.ts']),
    exposure('edge', 30, ['a.ts']),
    exposure('outside', 31, ['a.ts']),
    exposure('accepted', 5, ['a.ts']),
  ];
  const decisions = new Map([
    ['accepted', { ignoredBy: [{ ...ignore({ deadline: 'accepted' }), paths: null }], note: null }],
  ]);
  expect(deadlineCheck(exposures, decisions, 30)).toEqual({
    failWithin: 30,
    status: 'fail',
    failing: ['past', 'today', 'edge'],
    ignored: ['accepted'],
  });
  expect(deadlineCheck(exposures, decisions, 0).failing).toEqual(['past', 'today']);
  expect(deadlineCheck([exposure('outside', 31, ['a.ts'])], new Map(), 30)).toEqual({
    failWithin: 30,
    status: 'pass',
    failing: [],
    ignored: [],
  });
  for (const value of ['30', '0', ' 7 ', '3650'])
    expect(parseFailWithin(value)).toBe(Number(value));
  for (const value of ['', '-1', '30d', '1.5', '3651', 'soon', '1e3'])
    expect(() => parseFailWithin(value)).toThrow(/whole days from 0 to 3650/);
});

// Dates relative to the real clock, because the CLI reads it.
function day(offset: number) {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function cli(args: string[]) {
  try {
    const { stdout } = await execute(process.execPath, [bin, 'deadlines', ...args]);
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

it('runs as a CI check end to end: exit 2 on due live exposures, 0 when accepted or clear, 1 on errors', async () => {
  const registry = {
    formatVersion: 1,
    deadlines: [
      deadline('zz-past-model', day(-10)),
      deadline('zz-soon-model', day(5)),
      deadline('zz-later-model', day(200)),
      deadline('zz-listed-model', day(2)),
    ],
  };
  const registryRoot = await directory({ 'registry.json': JSON.stringify(registry) });
  const registryPath = join(registryRoot, 'registry.json');
  const root = await directory({
    'package.json': '{"name":"app"}',
    'src/ai.ts': [
      "export const past = { model: 'zz-past-model' };",
      "export const soon = { model: 'zz-soon-model' };",
      "export const later = { model: 'zz-later-model' };",
    ].join('\n'),
    // Named only in a test: never fails the check.
    'src/ai.test.ts': "it('works', () => run({ model: 'zz-listed-model' }));",
  });
  const run = (...extra: string[]) =>
    cli(['--repository', root, '--registry', registryPath, ...extra]);
  // Each CLI start costs about 0.3 s, so runs that see the same files start together.
  const [report, failing, json, tight, wide] = await Promise.all([
    run(),
    run('--fail-within', '30'),
    run('--fail-within', '30', '--json'),
    run('--fail-within', '1'),
    run('--fail-within', '300'),
  ]);

  // Without --fail-within the command only reports.
  expect(report.code).toBe(0);

  expect(failing.code).toBe(2);
  expect(failing.stdout).toContain(
    'Deadline check failed: 2 live exposures are past due or within 30 days.',
  );
  expect(failing.stdout).toContain('zz-past-model');
  expect(failing.stdout).toContain('zz-soon-model');
  expect(failing.stdout).not.toMatch(/^ {2}zz-later-model/m);

  expect(json.code).toBe(2);
  expect(JSON.parse(json.stdout).check).toEqual({
    failWithin: 30,
    status: 'fail',
    failing: ['zz-past-model', 'zz-soon-model'],
    ignored: [],
  });
  expect(tight.code).toBe(2);
  expect(wide.code).toBe(2);

  await writeFile(
    join(root, '.refit-deadlines-ignore.json'),
    JSON.stringify({
      formatVersion: 1,
      ignore: [
        { deadline: 'zz-past-model', reason: 'Legacy job, removed next sprint.', until: day(20) },
        { deadline: 'zz-soon-model', reason: 'Swap is in review.', until: day(3), paths: ['src'] },
        { deadline: 'zz-gone', reason: 'Old entry.', until: day(-1) },
      ],
    }),
  );
  const strict = await directory({ 'none.json': JSON.stringify({ formatVersion: 1, ignore: [] }) });
  const [accepted, acceptedOutput, explicit] = await Promise.all([
    run('--fail-within', '30'),
    run('--fail-within', '30', '--json'),
    run('--fail-within', '30', '--ignore-file', join(strict, 'none.json')),
  ]);
  expect(accepted.code).toBe(0);
  expect(accepted.stdout).toContain(
    'Deadline check passed: no live exposure is past due or within 30 days (2 accepted by .refit-deadlines-ignore.json).',
  );
  expect(accepted.stdout).toContain('Ignored      until');
  expect(accepted.stdout).toContain('expired      zz-gone');
  expect(accepted.stdout).toContain('unknown      zz-gone is not a registry deadline');
  // The accepted exposures are still reported, not hidden.
  expect(accepted.stdout).toContain('src/ai.ts:1');
  const acceptedJson = JSON.parse(acceptedOutput.stdout);
  expect(acceptedJson.check.ignored).toEqual(['zz-past-model', 'zz-soon-model']);
  expect(acceptedJson.ignores.expired.map((entry: DeadlineIgnore) => entry.deadline)).toEqual([
    'zz-gone',
  ]);

  // A different file can be named explicitly; the default one is then not read.
  expect(explicit.code).toBe(2);

  // Errors fail closed with exit 1: an invalid ignore file, a bad window, a missing explicit file.
  await writeFile(
    join(root, '.refit-deadlines-ignore.json'),
    JSON.stringify({
      formatVersion: 1,
      ignore: [{ deadline: 'zz-soon-model', reason: '', until: day(400) }],
    }),
  );
  const [invalid, badWindow, missing] = await Promise.all([
    run('--fail-within', '30'),
    run('--fail-within', '30d'),
    run('--fail-within', '30', '--ignore-file', join(strict, 'missing.json')),
  ]);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('.refit-deadlines-ignore.json is invalid');
  expect(badWindow.code).toBe(1);
  expect(missing.code).toBe(1);
}, 60_000);
