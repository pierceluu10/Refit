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
const ENV_TEMPLATE = /^\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist)$/;
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
  // The sandbox has one Node release; a repo pinned to an old one still gets its checks run.
  YARN_IGNORE_ENGINES: 'true',
  npm_config_engine_strict: 'false',
  // pnpm puts its store at the mount's root when home is on another disk: the copy, and so the diff.
  npm_config_store_dir: '/tmp/aptitude-pnpm-store',
};

export type SandboxOptions = { mode?: 'docker' | 'local'; image?: string };

export async function createSandbox(
  repoDir: string,
  options: SandboxOptions = {},
): Promise<Sandbox & { image?: string }> {
  const mode = options.mode ?? (await pickMode());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aptitude-sandbox-'));
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
    await git('config', 'user.name', 'Aptitude');
    await git('config', 'user.email', 'aptitude@localhost');
    await git('add', '-A');
    await git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'baseline');
    let baseline = (await git('rev-parse', 'HEAD')).trim();
    const leftOut = new Set<string>();
    const snapshot = async () => {
      await git('add', '-A');
      await git('commit', '-q', '--allow-empty', '--no-verify', '-m', 'prepared');
      baseline = (await git('rev-parse', 'HEAD')).trim();
    };
    // Back to the last snapshot: tracked files restored, new files gone (node_modules is kept, as
    // git excludes it). What running the checks built doesn't then collide with a diff applied after.
    const reset = async () => {
      await git('checkout', '-q', '-f', baseline, '--', '.');
      await git('clean', '-fdq');
    };
    // tsc rewrites a committed *.tsbuildinfo whenever the checks build, so it is no change of the
    // agent's: left in, a task that changed nothing read as a diff (round 3, liamstamper/lamp-bot).
    const diff = async () => {
      await git('add', '-A', '-N');
      return git(
        'diff',
        '--no-color',
        '--no-ext-diff',
        baseline,
        '--',
        '.',
        ':(exclude,glob)**/*.tsbuildinfo',
        // Python bytecode the checks compile (round 3, bcrant/Tableau2Slack), and nothing to review.
        ':(exclude,glob)**/__pycache__/**',
        ':(exclude,glob)**/*.pyc',
        // A proof test for a repo with no test setup: run by the harness, kept out of the PR.
        ':(exclude).refit-proof',
        ...[...leftOut].map((file) => `:(exclude,literal)${file}`),
      );
    };
    const leaveOut = (files: string[]) => files.forEach((file) => leftOut.add(file));
    const keep = (file: string) => void leftOut.delete(file);
    const remove = () => fs.rm(root, { recursive: true, force: true });

    if (mode === 'local') {
      const env = { ...scrubbedEnv(), ...SANDBOX_ENV };
      return {
        dir,
        mode,
        exec: (command, opts) => run('sh', ['-c', command], { cwd: dir, env, ...opts }),
        diff,
        snapshot,
        reset,
        leaveOut,
        keep,
        dispose: remove,
      };
    }

    const image = options.image ?? process.env.APTITUDE_SANDBOX_IMAGE ?? (await pickImage(repoDir));
    const name = `aptitude-${randomBytes(6).toString('hex')}`;
    // Run as the host user so files the container writes stay editable and removable on the host.
    const user =
      process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
    // prettier-ignore
    const started = await run('docker', [
      'run', '-d', '--rm', '--name', name, ...user,
      '--memory', '4g', '--cpus', process.env.APTITUDE_SANDBOX_CPUS ?? '2', '--security-opt', 'no-new-privileges',
      ...Object.entries(SANDBOX_ENV).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '-e', 'HOME=/tmp',
      '-v', `${dir}:/work`, '-w', '/work', image, 'sleep', 'infinity',
    ]);
    if (started.code !== 0) throw new Error(`docker run ${image} failed: ${started.stderr.trim()}`);
    // Repo scripts call pnpm and yarn by name, and the image has only corepack. Its shims go on a
    // PATH every command sets, since sh -l resets PATH. Best effort: the Python image has no corepack.
    await run(
      'docker',
      [
        'exec',
        name,
        'sh',
        '-c',
        'mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin',
      ],
      { timeoutMs: 60_000 },
    );
    return {
      dir,
      mode,
      image,
      exec: (command, opts) => {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // Killing the docker client leaves the command running, so the container enforces the
        // timeout too, a little after the host gives up.
        const seconds = String(Math.ceil(timeoutMs / 1000) + 2);
        const args = ['exec', '-w', '/work', name, 'timeout', '-s', 'KILL', seconds];
        return run(
          'docker',
          [...args, 'sh', '-lc', `export PATH=/tmp/bin:/tmp/bun/bin:$PATH; ${command}`],
          {
            timeoutMs,
          },
        );
      },
      diff,
      snapshot,
      reset,
      leaveOut,
      keep,
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

export function sandboxEnvNote(sandbox: Sandbox & { image?: string }): string {
  return sandbox.mode === 'docker'
    ? `Docker container ${sandbox.image ?? DEFAULT_IMAGE}; install scripts disabled; no host env or mounts besides the repo copy; no credentials, so no live API calls`
    : 'Local temp copy; install scripts disabled; no Docker; no credentials, so no live API calls';
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
  const fromEnv = process.env.APTITUDE_SANDBOX;
  if (fromEnv === 'docker' || fromEnv === 'local') return fromEnv;
  // On Linux CI never fall back to running repo code on the host; a missing Docker should fail loudly.
  if (process.env.CI && process.platform === 'linux') return 'docker';
  const info = await run('docker', ['info'], { timeoutMs: 20_000 });
  return info.code === 0 ? 'docker' : 'local';
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
