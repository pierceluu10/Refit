// Hard limit 1: untrusted repo code runs only here. Hard limit 3: the copy has a fresh git dir
// with no remotes, so nothing in the sandbox can push.
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { redactSecrets, scrubbedEnv } from './secrets.ts';
import type { ExecResult, Sandbox } from './types.ts';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_CAP = 2 * 1024 * 1024;
const DEFAULT_IMAGE = 'node:22-bookworm';
// The Node image has python3 but no pip, so a Python repo with no package.json gets the Python image.
const PYTHON_IMAGE = 'python:3.12-bookworm';
const PYTHON_MANIFESTS = ['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile'];
const EXCLUDED = new Set(['.git', 'node_modules']);
// Hard limit 4: real env files (and direnv's .envrc) never enter the sandbox; templates (.env.example etc.) do.
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist)$/;
export const isRealEnvFile = (name: string) =>
  (name === '.env' || name === '.envrc' || name.startsWith('.env.')) && !ENV_TEMPLATE.test(name);

// The only env repo code gets beyond the scrubbed host env (local) or nothing (Docker). Install scripts stay off.
const SANDBOX_ENV = {
  CI: '1',
  npm_config_ignore_scripts: 'true',
  YARN_ENABLE_SCRIPTS: 'false',
  PIP_ONLY_BINARY: ':all:', // no sdist builds, so no setup.py runs
  // corepack fetches the repo's pnpm or yarn release without asking, and never pins it into package.json.
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  COREPACK_ENABLE_AUTO_PIN: '0',
  // CI makes Yarn 2+ refuse any lockfile change, which would block the agent's `yarn add`.
  YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
  // pnpm puts its store at the mount's root when home is on another disk: the copy, and so the diff.
  npm_config_store_dir: '/tmp/refit-pnpm-store',
};

// The env that turns install scripts off. With the agent's request, a Docker sandbox drops it.
const SCRIPTS_OFF = ['npm_config_ignore_scripts', 'YARN_ENABLE_SCRIPTS', 'PIP_ONLY_BINARY'];

export type RuntimeName = 'node' | 'python';
export type Runtime = { name: RuntimeName; version: string };

// The official images the sandbox is tested on. Another version still gets its official tag: the
// agent may try it, and the run notes say it is outside this list.
export const OFFICIAL_RUNTIMES: Readonly<Record<RuntimeName, readonly string[]>> = {
  node: ['18', '20', '22', '24'],
  python: ['3.9', '3.10', '3.11', '3.12', '3.13'],
};

// 'node@20', 'node 20', 'python3.11', 'python 3.12.4' or 'nodejs 22' → a Runtime, else undefined.
export function parseRuntime(text: string): Runtime | undefined {
  const match = /^\s*(node(?:js)?|python)\s*@?\s*v?(\d+(?:\.\d+){0,2})\s*$/i.exec(text);
  if (!match) return undefined;
  const name: RuntimeName = match[1].toLowerCase().startsWith('node') ? 'node' : 'python';
  return { name, version: match[2] };
}

// The Docker Hub official image for a runtime: node:20-bookworm, python:3.12-bookworm.
export function runtimeImage(runtime: Runtime): string {
  return `${runtime.name}:${runtime.version}-bookworm`;
}

export function isOfficialRuntime(runtime: Runtime): boolean {
  const family =
    runtime.name === 'node'
      ? runtime.version.split('.')[0]
      : runtime.version.split('.').slice(0, 2).join('.');
  return OFFICIAL_RUNTIMES[runtime.name].includes(family);
}

export type SandboxOptions = {
  mode?: 'docker' | 'local';
  image?: string;
  // Run on this runtime and version, in its official image. Docker only; locally it is noted.
  runtime?: Runtime;
  // Install scripts stay off unless the agent asks, and even then only inside a Docker container.
  installScripts?: boolean;
};

export type RuntimeSandbox = Sandbox & {
  image?: string;
  runtime?: Runtime;
  installScripts: boolean;
  // What the sandbox could not do as asked, in plain words, for the run notes and the PR.
  notes: string[];
};

export async function createSandbox(
  repoDir: string,
  options: SandboxOptions = {},
): Promise<RuntimeSandbox> {
  const mode = options.mode ?? (await pickMode());
  const notes: string[] = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'refit-sandbox-'));
  const dir = path.join(root, 'repo');
  // The git dir lives outside the working copy, so sandboxed code cannot plant hooks, fsmonitor or
  // filter drivers in a config that host-side git later reads. The repo's own .git is never copied.
  const gitDir = path.join(root, 'git');
  try {
    await fs.cp(repoDir, dir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !EXCLUDED.has(path.basename(src)) && !isRealEnvFile(path.basename(src)),
    });
    const git = (...args: string[]) => runGit(gitDir, dir, args);
    await git('init', '-q');
    await fs.appendFile(path.join(gitDir, 'info', 'exclude'), '\nnode_modules\n.pnpm-store\n');
    await git('config', 'user.name', 'Refit');
    await git('config', 'user.email', 'refit@localhost');
    await git('add', '-A');
    await git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'baseline');
    const baseline = (await git('rev-parse', 'HEAD')).trim();
    const diff = async () => {
      await git('add', '-A', '-N');
      return git('diff', '--no-color', '--no-ext-diff', baseline);
    };
    const remove = () => fs.rm(root, { recursive: true, force: true });

    if (mode === 'local') {
      const env = { ...scrubbedEnv(), ...SANDBOX_ENV };
      // Hard limit 1: on the host, install scripts never run, whatever the agent asks.
      if (options.installScripts) {
        notes.push(
          'Install scripts stayed off: they run only in a Docker sandbox, and Docker was not used.',
        );
      }
      if (options.runtime) {
        notes.push(
          `Asked for ${options.runtime.name} ${options.runtime.version}, but without Docker the local sandbox runs the host's ${options.runtime.name}${options.runtime.name === 'node' ? ` (${process.version})` : ''}; checks on that version are unproven.`,
        );
      }
      return {
        dir,
        mode,
        installScripts: false,
        notes,
        exec: (command, opts) => run('sh', ['-c', command], { cwd: dir, env, ...opts }),
        diff,
        dispose: remove,
      };
    }

    const image =
      options.image ??
      (options.runtime ? runtimeImage(options.runtime) : undefined) ??
      process.env.REFIT_SANDBOX_IMAGE ??
      (await pickImage(repoDir));
    if (options.runtime && !isOfficialRuntime(options.runtime)) {
      notes.push(
        `${options.runtime.name} ${options.runtime.version} is outside the tested images (${OFFICIAL_RUNTIMES[options.runtime.name].join(', ')}); tried ${image} anyway.`,
      );
    }
    const installScripts = options.installScripts === true;
    const sandboxEnv = Object.entries(SANDBOX_ENV).filter(
      ([key]) => !installScripts || !SCRIPTS_OFF.includes(key),
    );
    const name = `refit-${randomBytes(6).toString('hex')}`;
    // Run as the host user so files the container writes stay editable and removable on the host.
    const user =
      process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    // prettier-ignore
    const started = await run('docker', [
      'run', '-d', '--rm', '--name', name, ...user,
      '--memory', '4g', '--cpus', '2', '--security-opt', 'no-new-privileges',
      ...sandboxEnv.flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '-e', 'HOME=/tmp',
      '-v', `${dir}:/work`, '-w', '/work', image, 'sleep', 'infinity',
    ]);
    if (started.code !== 0) throw new Error(`docker run ${image} failed: ${started.stderr.trim()}`);
    return {
      dir,
      mode,
      image,
      runtime: options.runtime,
      installScripts,
      notes,
      exec: (command, opts) => {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // Killing the docker client leaves the command running, so the container enforces the
        // timeout too, a little after the host gives up.
        const seconds = String(Math.ceil(timeoutMs / 1000) + 2);
        const args = ['exec', '-w', '/work', name, 'timeout', '-s', 'KILL', seconds];
        return run('docker', [...args, 'sh', '-lc', command], { timeoutMs });
      },
      diff,
      dispose: async () => {
        await run('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
        await remove();
      },
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function sandboxEnvNote(
  sandbox: Sandbox & { image?: string; installScripts?: boolean },
): string {
  const scripts = sandbox.installScripts
    ? "install scripts enabled at the agent's request, inside the container only"
    : 'install scripts disabled';
  return sandbox.mode === 'docker'
    ? `Docker container ${sandbox.image ?? DEFAULT_IMAGE}; ${scripts}; no host env or mounts besides the repo copy; no credentials, so no live API calls`
    : 'Local temp copy; install scripts disabled; no Docker; no credentials, so no live API calls';
}

// Whether a Docker daemon answers. Checks and validators use it to say plainly what they could not run.
export async function dockerAvailable(): Promise<boolean> {
  const info = await run('docker', ['info'], { timeoutMs: 20_000 });
  return info.code === 0;
}

async function pickImage(repoDir: string): Promise<string> {
  const has = (name: string) =>
    fs.access(path.join(repoDir, name)).then(
      () => true,
      () => false,
    );
  if (await has('package.json')) return DEFAULT_IMAGE;
  for (const name of PYTHON_MANIFESTS) if (await has(name)) return PYTHON_IMAGE;
  return DEFAULT_IMAGE;
}

async function pickMode(): Promise<'docker' | 'local'> {
  const fromEnv = process.env.REFIT_SANDBOX;
  if (fromEnv === 'docker' || fromEnv === 'local') return fromEnv;
  // On Linux CI never fall back to running repo code on the host; a missing Docker should fail loudly.
  if (process.env.CI && process.platform === 'linux') return 'docker';
  return (await dockerAvailable()) ? 'docker' : 'local';
}

const execFileAsync = promisify(execFile);

async function runGit(gitDir: string, workTree: string, args: string[]): Promise<string> {
  const safe = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  const { stdout } = await execFileAsync(
    'git',
    [
      ...safe,
      '-c',
      'commit.gpgsign=false',
      `--git-dir=${gitDir}`,
      `--work-tree=${workTree}`,
      ...args,
    ],
    { cwd: workTree, maxBuffer: 256 * 1024 * 1024 },
  );
  return stdout;
}

// Runs a host tool (docker, never repo code). Exported for the validators.
export const runHost = (
  file: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
) => run(file, args, options);

// Never throws. Keeps the last OUTPUT_CAP characters of each stream and kills the whole process
// group on timeout.
function run(
  file: string,
  args: string[],
  options: SpawnOptions & { timeoutMs?: number } = {},
): Promise<ExecResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(file, args, {
      ...spawnOptions,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-OUTPUT_CAP);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-OUTPUT_CAP);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const finish = (code: number, extra = '') => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr + extra),
        timedOut,
      });
    };
    child.on('error', (error) => finish(127, error.message));
    child.on('close', (code) => finish(code ?? (timedOut ? 124 : 1)));
  });
}
