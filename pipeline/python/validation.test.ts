import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { checkGate } from '../check-gate.ts';
import { testOutcomes } from '../test-outcomes.ts';
import { typeErrors } from '../type-errors.ts';
import {
  changesPythonDependencies,
  pythonPath,
  pythonPlan,
  validatePythonPatch,
} from './validation.ts';

// Synthetic repositories only (pipeline/fixtures/python-validation): no benchmark repository is
// opened here. The Docker cases need docker/sandbox.Dockerfile's python target
// (`docker build --target python -t refit-sandbox:python-glibc -f docker/sandbox.Dockerfile docker`)
// and the network for preparation; the checks themselves run offline.
const IMAGE = process.env.REFIT_PYTHON_DOCKER_IMAGE;
const NODE_ONLY_IMAGE = process.env.REFIT_DOCKER_IMAGE;
const gated = it.skipIf(!IMAGE);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/python-validation');
const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'refit-python-test-'));
  roots.push(root);
  return root;
}

// A committed copy of a fixture, and a patch made by editing one file in it.
async function repository(fixture: string) {
  const directory = join(await scratch(), 'repository');
  await cp(join(FIXTURES, fixture), directory, { recursive: true });
  const git = (...args: string[]) =>
    execute('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: directory });
  await git('init', '-q');
  await git('add', '-A');
  await git('commit', '-qm', 'fixture');
  const patch = async (path: string, edit: (text: string) => string) => {
    const original = await readFile(join(directory, path), 'utf8');
    await writeFile(join(directory, path), edit(original));
    const { stdout } = await git('diff');
    await writeFile(join(directory, path), original);
    return stdout;
  };
  return { directory, patch };
}

describe('Python plan', () => {
  it('reads requirements files, pytest tests and a mypy configuration', async () => {
    const plan = await pythonPlan(join(FIXTURES, 'requirements'));
    expect(plan).toMatchObject({
      source: 'requirements',
      requirements: ['requirements-base.txt', 'requirements.txt'],
      runners: ['pytest', 'mypy'],
    });
    expect(plan!.checks.map((check) => check.name)).toEqual(['tests', 'typecheck']);
    // Without configured files, mypy checks the repository's top-level packages.
    expect(plan!.checks[1].command.slice(-2)).toEqual(['src', 'tests']);
    expect(pythonPath(join(FIXTURES, 'requirements'))).toBe('/workspace:/workspace/src');
  });

  it('prefers a lockfile: uv.lock, then poetry.lock', async () => {
    expect((await pythonPlan(join(FIXTURES, 'uv')))?.source).toBe('uv');
    expect((await pythonPlan(join(FIXTURES, 'poetry')))?.source).toBe('poetry');
    expect(pythonPath(join(FIXTURES, 'uv'))).toBe('/workspace');
  });

  it('runs no check in a repository with no tests and no mypy configuration', async () => {
    const root = await scratch();
    await writeFile(join(root, 'app.py'), 'print(1)\n');
    await writeFile(
      join(root, 'pyproject.toml'),
      '[project]\nname = "app"\ndependencies = ["six"]\n',
    );
    expect(await pythonPlan(root)).toEqual({
      source: 'pyproject',
      requirements: [],
      checks: [],
      runners: [],
    });
    await rm(join(root, 'app.py'));
    expect(await pythonPlan(root)).toBeNull();
  });

  it('runs mypy on its configured files only', async () => {
    const root = await scratch();
    await mkdir(join(root, 'pkg'));
    await writeFile(join(root, 'pkg/__init__.py'), '');
    await writeFile(join(root, 'mypy.ini'), '[mypy]\nfiles = pkg\n');
    const plan = await pythonPlan(root);
    expect(plan!.checks).toHaveLength(1);
    expect(plan!.checks[0].command.at(-1)).toBe('--cache-dir=/dev/null');
  });

  it('prepares the patched side again only when a dependency file changes', () => {
    const diff = (path: string) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(changesPythonDependencies(diff('app.py'))).toBe(false);
    for (const path of [
      'requirements.txt',
      'requirements-dev.txt',
      'dev-requirements.txt',
      'requirements/test.txt',
      'pyproject.toml',
      'uv.lock',
      'poetry.lock',
      'Pipfile.lock',
    ])
      expect(changesPythonDependencies(diff(path)), path).toBe(true);
  });
});

describe('pytest and mypy output', () => {
  const pytest = (failed: string[], summary: string) => ({
    stdout: `..F.\n=== short test summary info ===\n${failed.join('\n')}\n${summary}\n`,
    stderr: '',
  });

  it('reads the tests pytest -rfE names, and compares them like the Node runners', () => {
    const before = pytest(
      ['FAILED tests/test_a.py::test_old - AssertionError: x', 'ERROR tests/test_b.py'],
      '1 failed, 3 passed, 1 error in 0.12s',
    );
    expect(testOutcomes(before)).toEqual({
      runner: 'pytest',
      failed: new Set(['tests/test_a.py::test_old', 'file tests/test_b.py']),
      passed: 3,
    });
    const kept = checkGate([
      {
        name: 'tests',
        baseline: { status: 'failed', exitCode: 1, ...before },
        patched: { status: 'failed', exitCode: 1, ...before },
      },
    ]);
    expect(kept.status).toBe('passed');
    expect(kept.checks[0].outcome).toBe('kept');
    const after = pytest(
      [
        'FAILED tests/test_a.py::test_old - x',
        'FAILED tests/test_a.py::test_new - y',
        'ERROR tests/test_b.py',
      ],
      '========== 2 failed, 2 passed, 1 error in 0.20s ==========',
    );
    const regressed = checkGate([
      {
        name: 'tests',
        baseline: { status: 'failed', exitCode: 1, ...before },
        patched: { status: 'failed', exitCode: 1, ...after },
      },
    ]);
    expect(regressed.status).toBe('regression');
    expect(regressed.reason).toContain('tests/test_a.py::test_new');
  });

  it('leaves a summary whose failures are not all named unreadable', () => {
    expect(testOutcomes(pytest([], '2 failed, 1 passed in 0.1s'))).toBeUndefined();
  });

  it('reads mypy errors as type errors keyed without positions', () => {
    const output = {
      stdout: [
        'tally/__init__.py:5: error: Incompatible return value type (got "str", expected "int")  [return-value]',
        'tally/__init__.py:9:4: error: Name "x" is not defined  [name-defined]',
        'tally/__init__.py:9: note: See https://mypy.readthedocs.io',
      ].join('\n'),
      stderr: '',
    };
    expect(typeErrors(output).map((error) => error.key)).toEqual([
      'tally/__init__.py mypy-return-value Incompatible return value type (got "str", expected "int")',
      'tally/__init__.py mypy-name-defined Name "x" is not defined',
    ]);
    const baseline = {
      status: 'failed' as const,
      exitCode: 1,
      stdout: output.stdout.split('\n')[0],
      stderr: '',
    };
    const gate = checkGate([
      { name: 'typecheck', baseline, patched: { status: 'failed', exitCode: 1, ...output } },
    ]);
    expect(gate.status).toBe('regression');
    expect(gate.checks[0].introducedTypeErrors).toEqual([
      'tally/__init__.py mypy-name-defined Name "x" is not defined',
    ]);
  });
});

describe('offline Python validation in Docker', () => {
  gated(
    'keeps a patch that keeps every passing test, and fails one that breaks a test',
    async () => {
      const { directory, patch } = await repository('requirements');
      const keeps = await patch('src/greet/__init__.py', (text) =>
        text.replace('import six', 'import six  # unchanged'),
      );
      const kept = await validatePythonPatch({
        repository: directory,
        image: IMAGE!,
        patch: keeps,
      });
      expect(kept.status).toBe('passed');
      expect(kept.gate!.checks.map((check) => `${check.name} ${check.outcome}`)).toEqual([
        'tests kept',
        'typecheck passed',
      ]);
      expect(kept.gate!.checks[0].tests).toMatchObject({
        alreadyFailing: ['tests/test_greet.py::test_already_failing'],
        passed: 2,
      });
      const breaks = await patch('src/greet/__init__.py', (text) =>
        text.replace('greeting(name).upper()', 'greeting(name).upper() + "!"'),
      );
      const broken = await validatePythonPatch({
        repository: directory,
        image: IMAGE!,
        patch: breaks,
      });
      expect(broken.status).toBe('regression');
      expect(broken.reason).toContain('tests/test_greet.py::test_shout');
    },
    600_000,
  );

  gated(
    'installs a uv lockfile and fails a patch that introduces a mypy error',
    async () => {
      const { directory, patch } = await repository('uv');
      const typed = await patch('tally/__init__.py', (text) =>
        text.replace('return sum(values)', 'return sum(list(values))'),
      );
      expect(
        (await validatePythonPatch({ repository: directory, image: IMAGE!, patch: typed })).status,
      ).toBe('passed');
      const untyped = await patch('tally/__init__.py', (text) =>
        text.replace(
          'def total(values: list[int]) -> int:',
          'def total(values: list[int]) -> str:',
        ),
      );
      const result = await validatePythonPatch({
        repository: directory,
        image: IMAGE!,
        patch: untyped,
      });
      expect(result.status).toBe('regression');
      expect(result.gate!.checks.find((check) => check.name === 'typecheck')).toMatchObject({
        outcome: 'regressed',
      });
    },
    600_000,
  );

  gated(
    'installs a Poetry lockfile and runs its tests offline',
    async () => {
      const { directory, patch } = await repository('poetry');
      const result = await validatePythonPatch({
        repository: directory,
        image: IMAGE!,
        patch: await patch('tally/__init__.py', (text) => `${text}\n# reviewed\n`),
      });
      expect(result.status).toBe('passed');
      expect(result.reason).toContain('dependencies from poetry');
    },
    600_000,
  );

  gated(
    "falls back to an older Python that the repository's requires-python allows",
    async () => {
      const { directory, patch } = await repository('older-python');
      const result = await validatePythonPatch({
        repository: directory,
        image: IMAGE!,
        patch: await patch('legacy.py', (text) => `${text}\n# reviewed\n`),
      });
      expect(result).toMatchObject({ status: 'passed' });
      expect(result.python).toMatch(/^3\.12\./);
    },
    600_000,
  );

  gated(
    'prepares the patched side again when the patch changes a requirement',
    async () => {
      const { directory, patch } = await repository('requirements');
      const missing = await patch('requirements-base.txt', () => 'six==0.0.0-refit-missing\n');
      const result = await validatePythonPatch({
        repository: directory,
        image: IMAGE!,
        patch: missing,
      });
      expect(result.status).toBe('preparation-failed');
      expect(result.reason).toMatch(/^Python preparation stopped: Python system: `.+pip install/);
    },
    600_000,
  );

  it.skipIf(!IMAGE || !NODE_ONLY_IMAGE)(
    'names an image without python3',
    async () => {
      const { directory, patch } = await repository('requirements');
      const result = await validatePythonPatch({
        repository: directory,
        image: NODE_ONLY_IMAGE!,
        patch: await patch('src/greet/__init__.py', (text) => `${text}\n`),
      });
      expect(result.status).toBe('preparation-failed');
      expect(result.reason).toContain('has no python3');
    },
    120_000,
  );
});
