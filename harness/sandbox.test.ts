import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSandbox, sandboxEnvNote } from './sandbox.ts';
import type { Sandbox } from './types.ts';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

let repoDir: string;
let sandbox: Sandbox;

beforeEach(async () => {
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aptitude-fixture-'));
  await fs.writeFile(path.join(repoDir, 'index.js'), 'console.log("v1");\n');
  await fs.mkdir(path.join(repoDir, 'src'));
  await fs.writeFile(path.join(repoDir, 'src', 'lib.js'), 'export const x = 1;\n');
  // A planted .git and node_modules that must stay behind.
  await fs.mkdir(path.join(repoDir, '.git', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(repoDir, '.git', 'config'), '[core]\n\tfsmonitor = touch PWNED\n');
  await fs.mkdir(path.join(repoDir, 'node_modules', 'left-pad'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'node_modules', 'left-pad', 'index.js'), '');
});

afterEach(async () => {
  await sandbox?.dispose();
  await fs.rm(repoDir, { recursive: true, force: true });
});

describe('local sandbox', () => {
  beforeEach(async () => {
    sandbox = await createSandbox(repoDir, { mode: 'local' });
  });

  it('copies the repo without .git or node_modules', async () => {
    expect(sandbox.mode).toBe('local');
    expect(path.basename(path.dirname(sandbox.dir))).toMatch(/^aptitude-sandbox-/);
    const entries = await fs.readdir(sandbox.dir);
    expect(entries.sort()).toEqual(['index.js', 'src']);
    await expect(fs.readFile(path.join(sandbox.dir, 'src', 'lib.js'), 'utf8')).resolves.toContain(
      'x = 1',
    );
    await expect(fs.access(path.join(repoDir, 'PWNED'))).rejects.toThrow();
    expect(sandboxEnvNote(sandbox)).toBe('Local temp copy; install scripts disabled; no Docker');
  });

  it('runs commands in the copy and reports exit codes', async () => {
    const ok = await sandbox.exec('pwd && ls');
    expect(ok.code).toBe(0);
    expect(ok.timedOut).toBe(false);
    expect(await fs.realpath(ok.stdout.split('\n')[0])).toBe(await fs.realpath(sandbox.dir));
    expect(ok.stdout).toContain('index.js');
    const failed = await sandbox.exec('echo oops >&2; exit 3');
    expect(failed).toMatchObject({ code: 3, stderr: 'oops\n', timedOut: false });
  });

  it('disables install scripts and hides secrets from the env', async () => {
    process.env.FOO_TOKEN = 'fake-token-value-123456';
    try {
      const { stdout } = await sandbox.exec('env');
      expect(stdout).toContain('npm_config_ignore_scripts=true');
      expect(stdout).toContain('PIP_ONLY_BINARY=:all:');
      expect(stdout).not.toContain('FOO_TOKEN');
      expect(stdout).not.toContain('fake-token-value-123456');
      const echoed = await sandbox.exec('echo fake-token-value-123456');
      expect(echoed.stdout).toBe('[redacted]\n');
    } finally {
      delete process.env.FOO_TOKEN;
    }
  });

  it('diffs edits, new files and deletions against the baseline', async () => {
    expect(await sandbox.diff()).toBe('');
    await fs.writeFile(path.join(sandbox.dir, 'index.js'), 'console.log("v2");\n');
    await sandbox.exec('echo new > added.txt && rm src/lib.js && mkdir node_modules');
    const diff = await sandbox.diff();
    expect(diff).toContain('-console.log("v1");');
    expect(diff).toContain('+console.log("v2");');
    expect(diff).toContain('+++ b/added.txt');
    expect(diff).toContain('--- a/src/lib.js');
    expect(diff).not.toContain('node_modules');
  });

  it('has no git remotes and no .git in the working copy', async () => {
    const { code, stdout } = await sandbox.exec('git remote -v');
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    await expect(fs.access(path.join(sandbox.dir, '.git'))).rejects.toThrow();
  });

  it('kills commands that run past the timeout', async () => {
    const started = Date.now();
    const result = await sandbox.exec('sleep 30', { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('removes the copy on dispose', async () => {
    const root = path.dirname(sandbox.dir);
    await sandbox.dispose();
    await expect(fs.access(root)).rejects.toThrow();
  });
});

describe('env files', () => {
  it('copies env templates but never real env files', async () => {
    const names = [
      '.env',
      '.envrc',
      '.env.local',
      '.env.production',
      '.env.example',
      '.env.sample',
    ];
    for (const name of [...names, '.env.template', '.env.dist']) {
      await fs.writeFile(path.join(repoDir, name), 'API_KEY=x\n');
    }
    await fs.writeFile(path.join(repoDir, 'src', '.env'), 'API_KEY=x\n');
    sandbox = await createSandbox(repoDir, { mode: 'local' });
    const copied = (await fs.readdir(sandbox.dir)).filter((name) => name.startsWith('.env'));
    expect(copied.sort()).toEqual(['.env.dist', '.env.example', '.env.sample', '.env.template']);
    await expect(fs.access(path.join(sandbox.dir, 'src', '.env'))).rejects.toThrow();
  });
});

describe('docker sandbox', () => {
  it.skipIf(!dockerAvailable())(
    'runs commands in a container over the bind-mounted copy',
    async () => {
      sandbox = await createSandbox(repoDir, { mode: 'docker' });
      expect(sandbox.mode).toBe('docker');
      expect(sandboxEnvNote(sandbox)).toBe(
        'Docker container node:22-bookworm; install scripts disabled; no host env or mounts besides the repo copy',
      );
      const node = await sandbox.exec('node -v');
      expect(node.code).toBe(0);
      expect(node.stdout).toMatch(/^v22\./);
      await fs.writeFile(path.join(sandbox.dir, 'from-host.txt'), 'hello from host\n');
      const read = await sandbox.exec('cat from-host.txt && echo made > from-container.txt');
      expect(read.stdout).toBe('hello from host\n');
      await expect(fs.readFile(path.join(sandbox.dir, 'from-container.txt'), 'utf8')).resolves.toBe(
        'made\n',
      );
      const root = path.dirname(sandbox.dir);
      await sandbox.dispose();
      await expect(fs.access(root)).rejects.toThrow();
    },
    10 * 60 * 1000,
  );

  it.skipIf(!dockerAvailable())(
    'gives the container no host env, credentials or home mount, and keeps install scripts off',
    async () => {
      process.env.FOO_TOKEN = 'host-secret-value-123';
      try {
        await fs.writeFile(
          path.join(repoDir, 'package.json'),
          JSON.stringify({
            name: 'fixture',
            version: '1.0.0',
            scripts: { preinstall: 'touch RAN' },
          }),
        );
        sandbox = await createSandbox(repoDir, { mode: 'docker' });
        const env = await sandbox.exec('env');
        expect(env.stdout).not.toContain('host-secret-value-123');
        expect(env.stdout).not.toContain(os.homedir());
        expect(env.stdout).toContain('npm_config_ignore_scripts=true');
        expect(env.stdout).toContain('HOME=/tmp');
        // The only bind mount is the repo copy at /work.
        const mounts = await sandbox.exec(`awk '{print $5}' /proc/self/mountinfo`);
        expect(mounts.stdout).toContain('/work');
        expect(mounts.stdout).not.toContain(os.homedir());
        expect((await sandbox.exec(`test -e ${os.homedir()}`)).code).not.toBe(0);
        // Even a plain install the agent runs itself skips lifecycle scripts.
        const install = await sandbox.exec('npm install --no-audit --no-fund');
        expect(install.code).toBe(0);
        await expect(fs.access(path.join(sandbox.dir, 'RAN'))).rejects.toThrow();
      } finally {
        delete process.env.FOO_TOKEN;
      }
    },
    10 * 60 * 1000,
  );
});
