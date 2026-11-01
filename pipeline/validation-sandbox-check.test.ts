import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { CheckResult } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
const ran: { directory: string; command: string; dependencies?: string }[] = [];
let outcomes: (directory: string, command: string) => CheckResult;
const installs: string[] = [];

vi.mock('./validation.ts', async (original) => ({
  ...(await original<typeof import('./validation.ts')>()),
  containerCheck: vi.fn(
    async (options: { directory: string; command: string[]; dependencies?: string }) => {
      const command = options.command.join(' ');
      ran.push({ directory: options.directory, command, dependencies: options.dependencies });
      return outcomes(options.directory, command);
    },
  ),
}));
vi.mock('./repository-environment.ts', () => ({
  installInSandbox: vi.fn(async (options: { repository: string; copyArchiveTo: string }) => {
    installs.push(options.copyArchiveTo);
    await writeFile(options.copyArchiveTo, '');
    return { environment: { installation: { command: ['npm', 'install'] } } };
  }),
}));
vi.mock('./docker-sandbox.ts', async (original) => ({
  ...(await original<typeof import('./docker-sandbox.ts')>()),
  resolveDockerImage: vi.fn(async () => 'sha256:test'),
}));
const { newFailures, sandboxBaseline, sandboxCheck, sandboxCheckParts, disposeSandboxBaseline } =
  await import('./validation-sandbox-check.ts');

afterEach(async () => {
  ran.length = 0;
  installs.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const result = (status: CheckResult['status'], stdout = '', exitCode = 1): CheckResult => ({
  status,
  exitCode: status === 'passed' ? 0 : exitCode,
  stdout,
  stderr: '',
});

it('picks the type check script, the build and the tests, never npm’s placeholder test', () => {
  expect(
    sandboxCheckParts(
      JSON.stringify({ scripts: { typecheck: 'react-router typegen && tsc', build: 'x' } }),
      true,
    ),
  ).toEqual([
    { kind: 'typecheck', command: ['npm', 'run', 'typecheck'] },
    { kind: 'build', command: ['npm', 'run', 'build'] },
  ]);
  const [tsc, ...rest] = sandboxCheckParts(
    JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    true,
  );
  expect(tsc.kind).toBe('typecheck');
  expect(tsc.command.join(' ')).toContain('--noEmit');
  expect(rest).toEqual([]);
  expect(sandboxCheckParts(JSON.stringify({ scripts: { test: 'vitest' } }), false)).toEqual([
    { kind: 'tests', command: ['npm', 'test'] },
  ]);
  expect(sandboxCheckParts('not json', false)).toEqual([]);
});

it('counts only type errors the original code did not have, whatever line they moved to', () => {
  const before = result(
    'failed',
    'app/a.ts(3,1): error TS2307: Cannot find module "./+types/route".\n',
  );
  const after = result(
    'failed',
    [
      'app/a.ts(9,1): error TS2307: Cannot find module "./+types/route".',
      'app/b.ts(2,5): error TS2339: Property "legacy" does not exist on type "Shop".',
    ].join('\n'),
  );
  const counted = newFailures('typecheck', ['npm', 'run', 'typecheck'], before, after);
  expect(counted.errors).toEqual([
    'app/b.ts(2,5): error TS2339: Property "legacy" does not exist on type "Shop".',
  ]);
  expect(counted.unproven).toMatch(/already fails on the original code/);
  expect(
    newFailures('typecheck', ['tsc'], result('passed'), result('failed', 'oops\n')).errors,
  ).toEqual(['the type check (tsc) exited with 1:', 'oops']);
});

it('counts only tests that newly fail where the original already fails', () => {
  const before = result('failed', '✓ keeps a\n× flaky clock\nTests  1 failed | 1 passed (2)\n');
  expect(
    newFailures(
      'tests',
      ['npm', 'test'],
      before,
      result('failed', '✓ keeps a\n× flaky clock\nTests  1 failed | 1 passed (2)\n'),
    ),
  ).toEqual({ errors: [] });
  expect(
    newFailures(
      'tests',
      ['npm', 'test'],
      before,
      result('failed', '× keeps a\n× flaky clock\nTests  2 failed | 0 passed (2)\n'),
    ).errors,
  ).toEqual([
    '0 passing and 2 failing on the patch, against 1 and 1 on the original code',
    '× keeps a',
  ]);
});

it('returns a regression as errors, a build that already failed as unproven, and timeouts', () => {
  expect(
    newFailures(
      'build',
      ['npm', 'run', 'build'],
      result('passed'),
      result('failed', 'vite v5\nError: Could not resolve "./gone" from app/root.tsx\n'),
    ),
  ).toEqual({ errors: ['Error: Could not resolve "./gone" from app/root.tsx'] });
  const failing = result('failed', 'Error: fetch failed (fonts.googleapis.com)\n');
  expect(newFailures('build', ['npm', 'run', 'build'], failing, failing)).toEqual({
    errors: [],
    unproven: expect.stringMatching(/^The build .* already fails on the original code/),
  });
  expect(
    newFailures('tests', ['npm', 'test'], result('passed'), {
      ...result('error'),
      error: 'Check exceeded 600 seconds; the container was stopped.',
    }).errors,
  ).toEqual([
    'the test (npm test) did not finish: Check exceeded 600 seconds; the container was stopped.',
  ]);
});

async function repository(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'refit-sandbox-check-test-'));
  roots.push(directory);
  for (const [path, content] of Object.entries(files))
    await writeFile(join(directory, path), content);
  await execute('git', ['init', '-q', directory]);
  await execute('git', ['-C', directory, 'add', '.']);
  await execute('git', [
    '-C',
    directory,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=refit@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture',
  ]);
  return directory;
}

it('judges an edited tree against the original, reinstalling only when package files change', async () => {
  const manifest = JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest' } });
  const original = await repository({ 'package.json': manifest, 'index.ts': 'export {};\n' });
  outcomes = (_directory, command) =>
    command === 'npm run typecheck'
      ? result('failed', 'gen.ts(1,1): error TS2307: Cannot find module "./generated".\n')
      : result('passed');
  const baseline = await sandboxBaseline({ repository: original });
  try {
    expect(baseline.install.status).toBe('installed');
    expect(baseline.parts.map((part) => [part.kind, part.result.status])).toEqual([
      ['typecheck', 'failed'],
      ['tests', 'passed'],
    ]);
    // The edit keeps the baseline type error and adds none: it passes, with the baseline noted.
    const clean = await sandboxCheck(original, baseline);
    expect(clean.passed).toBe(true);
    expect(clean.errors).toEqual([]);
    expect(clean.unproven).toEqual([expect.stringMatching(/type check .* already fails/)]);
    expect(installs).toHaveLength(1);

    // A failing test is fed back with its line; editing package.json installs once more.
    const edited = await repository({
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest', x: 'y' } }),
      'index.ts': 'export {};\n',
    });
    outcomes = (_directory, command) =>
      command === 'npm test'
        ? result('failed', '× creates a product\nTests  1 failed | 0 passed (1)\n')
        : result('failed', 'gen.ts(1,1): error TS2307: Cannot find module "./generated".\n');
    await chmod(edited, 0o700);
    const broken = await sandboxCheck(edited, baseline);
    expect((await stat(edited)).mode & 0o777).toBe(0o755);
    expect(broken.passed).toBe(false);
    expect(broken.errors).toEqual([
      '[tests] × creates a product',
      '[tests] Tests  1 failed | 0 passed (1)',
    ]);
    expect(installs).toHaveLength(2);
    expect(ran.at(-1)?.dependencies).toBe(installs[1]);
    await sandboxCheck(edited, baseline);
    expect(installs).toHaveLength(2);
  } finally {
    await disposeSandboxBaseline(baseline);
  }
});

it('marks a repository with no runnable check unproven instead of stopping', async () => {
  const original = await repository({ 'package.json': '{}', 'index.js': '' });
  outcomes = () => result('passed');
  const baseline = await sandboxBaseline({ repository: original });
  try {
    expect(await sandboxCheck(original, baseline)).toEqual({
      passed: true,
      errors: [],
      unproven: [expect.stringMatching(/no type check, build or test script/)],
      parts: [],
    });
  } finally {
    await disposeSandboxBaseline(baseline);
  }
});
