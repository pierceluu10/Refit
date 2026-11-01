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

// The repo's own release of its package manager, so a lockfile it rewrites keeps its format and the
// PR's lockfile diff holds only real dependency changes: package.json's packageManager field first,
// else the release the lockfile's format implies. Undefined means whatever the sandbox has.
export async function packageManagerVersion(
  dir: string,
  pm: PackageManager,
): Promise<string | undefined> {
  const read = (name: string) => readFile(path.join(dir, name), 'utf8').catch(() => '');
  const declared = /"packageManager"\s*:\s*"(\w+)@(\d[\w.-]*)/.exec(await read('package.json'));
  if (declared?.[1] === pm) return declared[2];
  if (pm === 'npm') {
    let lock: { lockfileVersion?: number; packages?: Record<string, object> };
    try {
      lock = JSON.parse(await read('package-lock.json'));
    } catch {
      return undefined;
    }
    // npm 7+ rewrites a whole v1 lockfile as v3. Later releases keep v2 and v3, but 10.8+ adds a
    // license line to each entry it writes, so a v2 lockfile without them gets npm 8. A v3 one keeps
    // the sandbox's npm: that license line per new entry is all it adds.
    if (lock.lockfileVersion === 1) return '6';
    const licensed = Object.entries(lock.packages ?? {}).some(
      ([key, entry]) => key !== '' && 'license' in entry,
    );
    return lock.lockfileVersion === 2 && !licensed ? '8' : undefined;
  }
  if (pm === 'pnpm') {
    // Lockfile formats: 5.3 pnpm 6, 5.4 pnpm 7, 6.x pnpm 8, 9.0 pnpm 9 and 10.
    const format = /^lockfileVersion:\s*'?(\d+)\.(\d+)/m.exec(await read('pnpm-lock.yaml'));
    if (!format) return undefined;
    const [major, minor] = [Number(format[1]), Number(format[2])];
    return major >= 9 ? '9' : major >= 6 ? '8' : minor >= 4 ? '7' : '6';
  }
  if (pm === 'yarn') {
    // Lockfile formats: v1 yarn 1; berry's __metadata version 4 yarn 2, 5-6 yarn 3, 7+ yarn 4.
    const lock = await read('yarn.lock');
    if (lock.includes('# yarn lockfile v1')) return '1';
    const format = Number(/__metadata:\s+version:\s*(\d+)/.exec(lock)?.[1]);
    return format >= 7 ? '4' : format >= 5 ? '3' : format === 4 ? '2' : undefined;
  }
  return undefined;
}

// The command that runs that release: npx for npm, corepack for pnpm and yarn. The Docker image
// has no pnpm binary, so pnpm always goes through corepack.
export function packageManagerBinary(pm: PackageManager, version?: string): string {
  if (pm === 'npm') return version ? `npx -y npm@${version}` : 'npm';
  if (pm === 'pnpm' || (pm === 'yarn' && version)) {
    return `corepack ${pm}${version ? `@${version}` : ''}`;
  }
  return pm;
}

// Install scripts are always off, in Docker too: untrusted repo code runs only in a sandbox with
// install scripts off (Otabek's rule, stricter than the plan; allowing them in Docker is for the founders).
export function installCommand(pm: PackageManager, version?: string): string {
  const bin = packageManagerBinary(pm, version);
  switch (pm) {
    case 'npm':
      return `${bin} ci --ignore-scripts --no-audit --no-fund || ${bin} install --ignore-scripts --no-audit --no-fund`;
    case 'pnpm':
      return `${bin} install --frozen-lockfile --ignore-scripts || ${bin} install --ignore-scripts`;
    case 'yarn': {
      // Yarn 1 takes --ignore-scripts; Yarn 2+ rejects that flag and reads YARN_ENABLE_SCRIPTS.
      const classic = `${bin} install --frozen-lockfile --ignore-scripts || ${bin} install --ignore-scripts`;
      const berry = `YARN_ENABLE_SCRIPTS=false ${bin} install --immutable || YARN_ENABLE_SCRIPTS=false ${bin} install`;
      if (version) return /^1(\.|$)/.test(version) ? classic : berry;
      return `if yarn --version | grep -q '^1\\.'; then ${classic}; else ${berry}; fi`;
    }
    case 'bun':
      return 'bun install --frozen-lockfile --ignore-scripts || bun install --ignore-scripts';
    case 'pip':
      return (
        'if [ -f requirements.txt ]; then python3 -m pip install --only-binary=:all: -r requirements.txt; ' +
        'else echo "installs only prebuilt wheels from requirements.txt; install other dependencies with pip --only-binary=:all:"; fi'
      );
    case 'poetry':
      // shortcut: Poetry before 1.8 ignores installer.only-binary and may build sdists; pin Poetry 1.8+ in the image.
      return 'POETRY_INSTALLER_ONLY_BINARY=:all: PIP_ONLY_BINARY=:all: poetry install --no-root';
    case 'none':
      return 'echo "no package manager detected"';
  }
}

export async function detectChecks(
  dir: string,
  pm: PackageManager,
  version?: string,
): Promise<CheckCommand[]> {
  const checks: CheckCommand[] = [];
  const manifest = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => undefined);
  if (manifest !== undefined) {
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(manifest).scripts ?? {};
    } catch {
      // An unparseable package.json just means no script-based checks.
    }
    // Scripts never write the lockfile, so npm runs them with the sandbox's own release.
    const runner = ['pnpm', 'yarn', 'bun'].includes(pm) ? packageManagerBinary(pm, version) : 'npm';
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
