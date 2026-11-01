import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkGate, type CheckGate, type NamedCheck } from '../check-gate.ts';
import {
  dockerSandboxArguments,
  emptyInstallerCache,
  preparationProfile,
  removeDockerContainer,
  removeExpiredSandboxContainers,
  validationProfile,
} from '../docker-sandbox.ts';
import { gitEnvironment } from '../git-environment.ts';
import { parseToml, type TomlTable } from '../package-manifests-toml.ts';
import type { CheckResult } from '../validation.ts';
import { DEFAULT_CHECK_TIMEOUT_SECONDS } from '../validation-options.ts';

const execute = promisify(execFile);

// Python repositories validate like the Node checks (check-gate.ts): their own tests (pytest) and,
// when the repository configures it, mypy run offline on the original code and on the patch, and the
// shared gate decides. Preparation is the only step with network: prepare.py reads the dependency
// source the repository commits (uv.lock, poetry.lock, Pipfile.lock, requirements files, or
// pyproject.toml's own lists), installs it from wheels into a venv and archives it; each check
// unpacks that venv and runs with no network. The repository itself is never installed: its source
// is imported from PYTHONPATH, so the patched side runs the patched files. Nothing here branches on
// a repository; a repository Refit cannot prepare gets a named stop.

// Refit's runners when the repository declares none, and the tools that export uv and Poetry
// lockfiles. Each was released at least two weeks before it was pinned (2026-10-31).
export const PYTHON_TOOL_VERSIONS = {
  pytest: '9.1.1',
  mypy: '2.4.0',
  uv: '0.13.1',
  poetry: '2.5.1',
  poetryExport: '1.10.1',
};

// The venv prepare.py builds; checks unpack it at the same path, so its scripts' paths still hold.
const VENV = '/workspace/.refit-python';
const PYTHON = `${VENV}/bin/python`;
const PREPARE_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// `REFIT_PYTHON_SOURCE_BUILDS=1` lets pip build a dependency without a wheel, which runs that
// package's build code in the preparation sandbox (network on, no secrets). Off by default, as npm
// lifecycle scripts are.
const SOURCE_BUILDS = 'REFIT_PYTHON_SOURCE_BUILDS';

export type PythonSource = 'uv' | 'poetry' | 'pipenv' | 'requirements' | 'pyproject' | 'none';

export interface PythonPlan {
  source: PythonSource;
  // Requirements files, for the `requirements` source.
  requirements: string[];
  checks: NamedCheck[];
  // The runners the checks need, which preparation adds when the repository does not install them.
  runners: Array<'pytest' | 'mypy'>;
}

// Folders that are never the repository's own Python: environments, caches and vendored trees.
const SKIPPED = new Set([
  'node_modules',
  'venv',
  'env',
  'site-packages',
  '__pycache__',
  'build',
  'dist',
]);
const MAX_FILES = 20_000;

async function pythonFiles(root: string) {
  const found: string[] = [];
  async function walk(relative: string, depth: number) {
    if (depth > 8 || found.length >= MAX_FILES) return;
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.py')) found.push(path);
    }
  }
  await walk('', 0);
  return found;
}

const REQUIREMENTS_FILE = /^(?:requirements(?:[-_.][\w.-]+)?|[\w-]+[-_]requirements)\.txt$/i;
const TEST_FILE = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$|(?:^|\/)tests?\/[^/]+\.py$/;

function iniHasSection(text: string, section: RegExp) {
  return text.split('\n').some((line) => section.test(line.trim()));
}

// What a Python repository's checks are and where its dependencies come from, read from its
// committed files only. Null when the root holds no Python project.
export async function pythonPlan(root: string): Promise<PythonPlan | null> {
  const read = (path: string) => readFile(join(root, path), 'utf8').catch(() => undefined);
  const files = await pythonFiles(root);
  if (!files.length) return null;
  const top = await readdir(root).catch(() => [] as string[]);
  let pyproject: TomlTable = {};
  const pyprojectText = await read('pyproject.toml');
  if (pyprojectText !== undefined)
    try {
      pyproject = parseToml(pyprojectText);
    } catch {
      // An unreadable pyproject.toml declares nothing Refit can use; prepare.py names the error.
    }
  const table = (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as TomlTable)
      : undefined;
  const tool = table(pyproject.tool) ?? {};
  const project = table(pyproject.project);
  let requirements = top.filter((name) => REQUIREMENTS_FILE.test(name)).sort();
  if (!requirements.length && top.includes('requirements'))
    requirements = (await readdir(join(root, 'requirements')).catch(() => [] as string[]))
      .filter((name) => name.endsWith('.txt'))
      .sort()
      .map((name) => `requirements/${name}`);
  const source: PythonSource = top.includes('uv.lock')
    ? 'uv'
    : top.includes('poetry.lock')
      ? 'poetry'
      : top.includes('Pipfile.lock')
        ? 'pipenv'
        : requirements.length
          ? 'requirements'
          : project?.dependencies ||
              project?.['optional-dependencies'] ||
              pyproject['dependency-groups']
            ? 'pyproject'
            : 'none';

  const checks: NamedCheck[] = [];
  const runners: PythonPlan['runners'] = [];
  const setupCfg = (await read('setup.cfg')) ?? '';
  const toxIni = (await read('tox.ini')) ?? '';
  const pytestConfigured =
    top.includes('pytest.ini') ||
    top.includes('conftest.py') ||
    Boolean(table(tool.pytest)) ||
    iniHasSection(setupCfg, /^\[tool:pytest\]$/) ||
    iniHasSection(toxIni, /^\[pytest\]$/);
  if (pytestConfigured || files.some((file) => TEST_FILE.test(file))) {
    // -rfE names every failed and erroring test in the summary, which test-outcomes.ts reads.
    checks.push({
      name: 'tests',
      command: [PYTHON, '-m', 'pytest', '-q', '-rfE', '-p', 'no:cacheprovider', '--color=no'],
    });
    runners.push('pytest');
  }
  const mypyIni = (await read('mypy.ini')) ?? (await read('.mypy.ini'));
  const mypyTool = table(tool.mypy);
  if (mypyIni !== undefined || mypyTool || iniHasSection(setupCfg, /^\[mypy\]$/)) {
    const configuredFiles =
      mypyTool?.files !== undefined ||
      /^\s*files\s*=/m.test(mypyIni ?? '') ||
      /^\[mypy\][^[]*^\s*files\s*=/m.test(setupCfg);
    // Without configured files, mypy checks the repository's own top-level packages and modules.
    const targets = configuredFiles
      ? []
      : [...new Set(files.map((file) => file.split('/')[0]))].filter(
          (name) => name.endsWith('.py') || !name.includes('.'),
        );
    if (configuredFiles || targets.length) {
      checks.push({
        name: 'typecheck',
        command: [
          PYTHON,
          '-m',
          'mypy',
          '--no-color-output',
          '--no-error-summary',
          '--show-error-codes',
          '--hide-error-context',
          '--cache-dir=/dev/null',
          ...targets.sort(),
        ],
      });
      runners.push('mypy');
    }
  }
  return { source, requirements, checks, runners };
}

// The files whose change means the patched side needs its own preparation.
const DEPENDENCY_FILE =
  /^(?:pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|setup\.cfg|requirements\/[^/]+\.txt)$/;

export function changesPythonDependencies(patch: string) {
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].some(
    (match) => DEPENDENCY_FILE.test(match[1]) || REQUIREMENTS_FILE.test(match[1]),
  );
}

// PYTHONPATH for a checkout: its root, and src/ in a src layout.
export function pythonPath(root: string) {
  return existsSync(join(root, 'src')) ? '/workspace:/workspace/src' : '/workspace';
}

const ENVIRONMENT = (root: string) => [
  'env',
  'HOME=/tmp',
  'PYTHONDONTWRITEBYTECODE=1',
  'PYTHONUNBUFFERED=1',
  `PYTHONPATH=${pythonPath(root)}`,
];

interface DockerRun {
  status: 'passed' | 'failed' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

async function docker(args: string[], name: string, timeoutMs: number, signal?: AbortSignal) {
  await removeExpiredSandboxContainers();
  try {
    const result = await execute('docker', args, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      signal,
    });
    return { status: 'passed', exitCode: 0, ...result } satisfies DockerRun;
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error)) throw error;
    const failure = error as Error & {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    return {
      status: exitCode !== null && !failure.killed && exitCode < 125 ? 'failed' : 'error',
      exitCode,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      error: failure.killed
        ? `Exceeded ${timeoutMs / 1000} seconds; the container was stopped.`
        : failure.message,
    } satisfies DockerRun;
  } finally {
    await removeDockerContainer(name);
  }
}

export class PythonPreparationStop extends Error {}

// Prepares one checkout's venv archive in the networked preparation sandbox.
export async function preparePython(options: {
  directory: string;
  image: string;
  plan: PythonPlan;
  archive: string;
  signal?: AbortSignal;
}) {
  const output = await mkdtemp(join(dirname(options.archive), 'python-prepare-'));
  await chmod(output, 0o777);
  const name = `refit-${randomUUID()}`;
  const plan = {
    source: options.plan.source,
    requirements: options.plan.requirements,
    runners: options.plan.runners,
    versions: PYTHON_TOOL_VERSIONS,
    sourceBuilds: process.env[SOURCE_BUILDS] === '1',
  };
  try {
    const run = await docker(
      dockerSandboxArguments({
        name,
        directory: options.directory,
        image: options.image,
        command: [
          'env',
          'HOME=/workspace/.refit-home',
          'TMPDIR=/workspace/.refit-tmp',
          'PIP_NO_CACHE_DIR=1',
          'PIP_DISABLE_PIP_VERSION_CHECK=1',
          'PYTHONDONTWRITEBYTECODE=1',
          'python3',
          '/refit/python/prepare.py',
          JSON.stringify(plan),
        ],
        network: 'bridge',
        timeoutMs: PREPARE_TIMEOUT_MS,
        preparation: preparationProfile(),
        readOnlyMounts: [
          { source: dirname(fileURLToPath(import.meta.url)), target: '/refit/python' },
        ],
        installerCache: output,
      }),
      name,
      PREPARE_TIMEOUT_MS,
      options.signal,
    );
    if (run.status !== 'passed') {
      const named = /refit-python-stop: (.*)/.exec(run.stderr)?.[1];
      if (named) throw new PythonPreparationStop(`Python preparation stopped: ${named}`);
      if (/python3: not found|can't execute 'python3'|'python3': No such file/.test(run.stderr))
        throw new PythonPreparationStop(
          `The validation image ${options.image} has no python3 (docker/sandbox.Dockerfile's python target has).`,
        );
      throw new PythonPreparationStop(
        `Python preparation did not finish (${run.exitCode === null ? 'stopped' : `exit ${run.exitCode}`}): ${run.stderr.trim().split('\n').slice(-3).join(' | ')}`,
      );
    }
    const built = join(output, 'python.tar');
    const { size } = await stat(built);
    const limit = validationProfile().archiveBytes;
    if (size > limit)
      throw new PythonPreparationStop(
        `The prepared Python environment is ${Math.round(size / 2 ** 20)} MiB, over the ${limit / 2 ** 20} MiB validation archive limit.`,
      );
    await copyFile(built, options.archive);
    await chmod(options.archive, 0o644);
    const summary = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as {
      python?: string;
      runners?: string[];
    };
    return { python: summary.python ?? 'unknown', addedRunners: summary.runners ?? [] };
  } finally {
    // The sandbox user wrote the archive; it removes it before the host removes the folder.
    await emptyInstallerCache(options.image, output).catch(() => {});
    await rm(output, { recursive: true, force: true }).catch(() => {});
  }
}

// One check on one prepared checkout, offline.
export async function runPythonCheck(options: {
  directory: string;
  image: string;
  archive: string;
  check: NamedCheck;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CheckResult> {
  const name = `refit-${randomUUID()}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_SECONDS * 1000;
  return docker(
    dockerSandboxArguments({
      name,
      directory: options.directory,
      image: options.image,
      command: [...ENVIRONMENT(options.directory), ...options.check.command],
      network: 'none',
      timeoutMs,
      dependencies: options.archive,
      readOnlyMounts: [],
    }),
    name,
    timeoutMs,
    options.signal,
  );
}

async function checkout(repository: string, root: string, side: string) {
  const directory = join(root, side);
  await mkdir(directory);
  await chmod(directory, 0o755);
  const archive = join(root, `${side}.tar`);
  await execute('git', ['-C', repository, 'archive', '--format=tar', '-o', archive, 'HEAD'], {
    env: gitEnvironment(),
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  await execute('tar', ['-xf', archive, '-C', directory]);
  await rm(archive, { force: true });
  return directory;
}

export interface PythonValidation {
  status:
    'passed' | 'regression' | 'baseline-failed' | 'error' | 'no-checks' | 'preparation-failed';
  command: string[];
  reason: string;
  gate?: CheckGate;
  python?: string;
}

// The Python counterpart of validateSourcePatch for a patch on a committed checkout: prepare,
// run each check on the original code and on the patch, and gate them as the Node checks are.
export async function validatePythonPatch(options: {
  repository: string;
  image: string;
  patch: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<PythonValidation> {
  const root = await mkdtemp(join(tmpdir(), 'refit-python-'));
  await chmod(root, 0o755);
  try {
    const original = await checkout(options.repository, root, 'baseline');
    const plan = await pythonPlan(original);
    if (!plan || !plan.checks.length)
      return {
        status: 'no-checks',
        command: ['none'],
        reason: 'The repository has no pytest tests and no mypy configuration.',
      };
    const command = [
      plan.checks.map((check) => ['python', ...check.command.slice(1)].join(' ')).join('; '),
    ];
    const patched = await checkout(options.repository, root, 'patched');
    const patchFile = join(root, 'patch.diff');
    await writeFile(patchFile, options.patch);
    try {
      await execute('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: patched });
    } catch (error) {
      return {
        status: 'error',
        command,
        reason: `The patch does not apply: ${error instanceof Error ? error.message.slice(0, 300) : 'failed'}`,
      };
    }
    let python: string;
    const archives = {
      baseline: join(root, 'baseline-python.tar'),
      patched: join(root, 'baseline-python.tar'),
    };
    try {
      options.onProgress?.(`Preparing Python dependencies (${plan.source})...`);
      ({ python } = await preparePython({
        directory: original,
        image: options.image,
        plan,
        archive: archives.baseline,
        signal: options.signal,
      }));
      if (changesPythonDependencies(options.patch)) {
        options.onProgress?.('Preparing the patched Python dependencies...');
        archives.patched = join(root, 'patched-python.tar');
        await preparePython({
          directory: patched,
          image: options.image,
          plan: (await pythonPlan(patched)) ?? plan,
          archive: archives.patched,
          signal: options.signal,
        });
      }
    } catch (error) {
      if (!(error instanceof PythonPreparationStop)) throw error;
      return { status: 'preparation-failed', command, reason: error.message };
    }
    const runs = [];
    for (const check of plan.checks) {
      options.onProgress?.(`Running the Python ${check.name} check offline...`);
      const run = (directory: string, archive: string) =>
        runPythonCheck({
          directory,
          image: options.image,
          archive,
          check,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
      runs.push({
        name: check.name,
        baseline: await run(original, archives.baseline),
        patched: await run(patched, archives.patched),
      });
    }
    const gate = checkGate(runs);
    return {
      status: gate.status,
      command,
      reason: `Python ${python}, dependencies from ${plan.source}. ${gate.reason}`,
      gate,
      python,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
