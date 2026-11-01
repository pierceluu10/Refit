// Before/after checks. These are tooling defaults the agent can lean on, never gates.
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './secrets.ts';
import type { CheckCommand, CheckComparison, CheckRun, Sandbox } from './types.ts';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'poetry' | 'none';

const CHECK_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 6000;

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

export async function detectPackageManager(dir: string): Promise<PackageManager> {
  const has = (name: string) => exists(path.join(dir, name));
  if (await has('pnpm-lock.yaml')) return 'pnpm';
  if (await has('yarn.lock')) return 'yarn';
  if ((await has('bun.lockb')) || (await has('bun.lock'))) return 'bun';
  if ((await has('package-lock.json')) || (await has('package.json'))) return 'npm';
  if (await has('poetry.lock')) return 'poetry';
  if ((await has('requirements.txt')) || (await has('pyproject.toml'))) return 'pip';
  return 'none';
}

// Local mode runs untrusted code on the host, so install scripts are always off there (hard limit 1).
export function installCommand(pm: PackageManager, mode: 'docker' | 'local'): string {
  const local = mode === 'local';
  switch (pm) {
    case 'npm': {
      const flags = `${local ? '--ignore-scripts ' : ''}--no-audit --no-fund`;
      return `npm ci ${flags} || npm install ${flags}`;
    }
    case 'pnpm': {
      const flags = local ? ' --ignore-scripts' : '';
      return `pnpm install --frozen-lockfile${flags} || pnpm install${flags}`;
    }
    case 'yarn': {
      // Yarn 1 takes --ignore-scripts; Yarn 2+ rejects that flag and reads YARN_ENABLE_SCRIPTS.
      const classic = local
        ? 'yarn install --frozen-lockfile --ignore-scripts || yarn install --ignore-scripts'
        : 'yarn install --frozen-lockfile || yarn install';
      const env = local ? 'YARN_ENABLE_SCRIPTS=false ' : '';
      const berry = `${env}yarn install --immutable || ${env}yarn install`;
      return `if yarn --version | grep -q '^1\\.'; then ${classic}; else ${berry}; fi`;
    }
    case 'bun': {
      const flags = local ? ' --ignore-scripts' : '';
      return `bun install --frozen-lockfile${flags} || bun install${flags}`;
    }
    case 'pip':
      return local
        ? 'if [ -f requirements.txt ]; then python3 -m pip install --only-binary=:all: -r requirements.txt; ' +
            'else echo "local mode installs only prebuilt wheels from requirements.txt; install other dependencies with pip --only-binary=:all:"; fi'
        : 'if [ -f requirements.txt ]; then python3 -m pip install -r requirements.txt; else python3 -m pip install -e .; fi';
    case 'poetry':
      // shortcut: Poetry before 1.8 ignores installer.only-binary and may build sdists; use Docker mode there.
      return local
        ? 'POETRY_INSTALLER_ONLY_BINARY=:all: PIP_ONLY_BINARY=:all: poetry install --no-root'
        : 'poetry install';
    case 'none':
      return 'echo "no package manager detected"';
  }
}

export async function detectChecks(dir: string, pm: PackageManager): Promise<CheckCommand[]> {
  const checks: CheckCommand[] = [];
  const manifest = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => undefined);
  if (manifest !== undefined) {
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(manifest).scripts ?? {};
    } catch {
      // An unparseable package.json just means no script-based checks.
    }
    const runner = ['npm', 'pnpm', 'yarn', 'bun'].includes(pm) ? pm : 'npm';
    const typecheck = ['typecheck', 'type-check', 'tsc'].find((name) => scripts[name]);
    if (typecheck) checks.push({ name: 'typecheck', command: `${runner} run ${typecheck}` });
    else if (await exists(path.join(dir, 'tsconfig.json'))) {
      checks.push({ name: 'typecheck', command: 'npx --no-install tsc --noEmit' });
    }
    if (scripts.build) checks.push({ name: 'build', command: `${runner} run build` });
    if (scripts.test && !scripts.test.includes('no test specified')) {
      checks.push({ name: 'test', command: `${runner} run test` });
    }
  }

  const pyproject = await readFile(path.join(dir, 'pyproject.toml'), 'utf8').catch(() => '');
  const setupCfg = await readFile(path.join(dir, 'setup.cfg'), 'utf8').catch(() => '');
  const pytest =
    (await exists(path.join(dir, 'tests'))) ||
    (await exists(path.join(dir, 'pytest.ini'))) ||
    (await exists(path.join(dir, 'conftest.py'))) ||
    pyproject.includes('[tool.pytest') ||
    setupCfg.includes('[tool:pytest]');
  const python =
    ['pip', 'poetry'].includes(pm) ||
    pyproject !== '' ||
    setupCfg !== '' ||
    (await exists(path.join(dir, 'requirements.txt')));
  if (pytest && python) checks.push({ name: 'pytest', command: 'python3 -m pytest -q' });
  return checks;
}

export async function runChecks(sandbox: Sandbox, checks: CheckCommand[]): Promise<CheckRun[]> {
  const prefixes = [sandbox.dir, await realpath(sandbox.dir).catch(() => sandbox.dir)];
  const runs: CheckRun[] = [];
  for (const check of checks) {
    const result = await sandbox.exec(check.command, { timeoutMs: CHECK_TIMEOUT_MS });
    let output = redactSecrets(`${result.stdout}\n${result.stderr}`);
    for (const prefix of prefixes) output = output.split(`${prefix}/`).join('');
    if (result.timedOut) output += `\n[timed out after ${CHECK_TIMEOUT_MS / 60_000} minutes]`;
    const ok = result.code === 0 && !result.timedOut;
    runs.push({
      name: check.name,
      command: check.command,
      ok,
      output: output.slice(-OUTPUT_TAIL),
      failures: failureSignatures(output, ok),
    });
  }
  return runs;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TEMP_DIR = /(?:\/private)?\/(?:var\/folders\/[^\s/]+\/[^\s/]+\/T|tmp)\/[^\s/]+\//g;
const DURATION = /\s*\(?\d+(?:\.\d+)?\s?(?:ms|s|m)\)?\s*$/;

function normalise(line: string): string {
  return line
    .replace(TEMP_DIR, '')
    .replace(/:\d+(?::\d+)?\b/g, '')
    .replace(DURATION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// shortcut: a regex heuristic over common tool output; the agent reads the raw output for anything it misses.
export function failureSignatures(output: string, ok: boolean): string[] {
  if (ok) return [];
  const found = new Set<string>();
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/))) {
      found.add(normalise(`${match[1]}: error ${match[2]}: ${match[3]}`));
    } else if ((match = line.match(/^(.+?):\d+:\d+ - error (TS\d+): (.*)$/))) {
      found.add(normalise(`${match[1]}: error ${match[2]}: ${match[3]}`));
    } else if ((match = line.match(/^FAIL\s+(.+)$/))) {
      found.add(normalise(`FAIL ${match[1]}`));
    } else if ((match = line.match(/^[✗×✕]\s+(.+)$/))) {
      found.add(normalise(`failed: ${match[1]}`));
    } else if ((match = line.match(/^(FAILED|ERROR)\s+(\S+)/))) {
      found.add(normalise(`${match[1]} ${match[2]}`));
    } else if (/^(?:Uncaught )?[A-Z]?\w*Error(?: \[[^\]]*\])?: \S/.test(line)) {
      found.add(normalise(line));
    }
  }
  if (found.size === 0) {
    const last =
      lines
        .map((line) => line.trim())
        .filter(Boolean)
        .pop() ?? '';
    found.add(`exit-nonzero: ${normalise(last)}`);
  }
  return [...found];
}

function summary(run: CheckRun | undefined): string {
  if (!run) return 'not run';
  return run.ok ? 'pass' : `fail (${run.failures.length})`;
}

export function compareChecks(before: CheckRun[], after: CheckRun[]): CheckComparison[] {
  const names = [...new Set([...before, ...after].map((run) => run.name))];
  return names.map((name) => {
    const old = before.find((run) => run.name === name);
    const now = after.find((run) => run.name === name);
    const known = new Set(old?.failures ?? []);
    return {
      name,
      before: summary(old),
      after: summary(now),
      newFailures: (now?.failures ?? []).filter((failure) => !known.has(failure)),
    };
  });
}
