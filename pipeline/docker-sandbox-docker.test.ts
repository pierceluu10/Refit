import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  dockerSandboxArguments,
  removeDockerContainer,
  removeExpiredSandboxContainers,
  SANDBOX_EXPIRY_LABEL,
} from './docker-sandbox.ts';
import { validateSourcePatch } from './validation.ts';

// Hostile repositories run through Refit's real validation path in local Docker. Each one must end
// with a named failure and leave nothing behind on the host or in Docker.
const IMAGE = process.env.REFIT_DOCKER_IMAGE;
const gated = it.skipIf(!IMAGE);
const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(repository: string, ...args: string[]) {
  return (
    await execute(
      'git',
      [
        '-C',
        repository,
        '-c',
        'user.name=Refit Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    )
  ).stdout;
}

// A committed repository whose `command` is the hostile step, plus a one-line source patch so
// Refit runs the baseline check.
async function hostile(files: Record<string, string | Buffer>) {
  const repository = await mkdtemp(join(tmpdir(), 'refit-hostile-docker-'));
  roots.push(repository);
  await git(repository, 'init', '-q');
  await writeFile(join(repository, 'index.js'), 'module.exports = 1;\n');
  for (const [path, content] of Object.entries(files))
    await writeFile(join(repository, path), content);
  await git(repository, 'add', '-A');
  await git(repository, 'commit', '-q', '-m', 'test: hostile fixture');
  await writeFile(join(repository, 'index.js'), 'module.exports = 2;\n');
  const diff = await git(repository, 'diff');
  await git(repository, 'checkout', '--', '.');
  return { repository, propose: async () => diff };
}

async function check(
  files: Record<string, string | Buffer>,
  command: string[],
  options: { prepareDependencies?: boolean; signal?: AbortSignal } = {},
) {
  const fixture = await hostile(files);
  const started = Date.now();
  const result = await validateSourcePatch({ ...fixture, image: IMAGE!, command, ...options });
  if (!('baseline' in result)) throw new Error(`Checks did not run: ${result.status}`);
  return { ...result.baseline, seconds: (Date.now() - started) / 1000 };
}

// Other gated files run sandboxes at the same time, so only containers running this check count.
async function sandboxContainers(command: string) {
  return (
    await execute('docker', [
      'ps',
      '--all',
      '--no-trunc',
      '--filter',
      `label=${SANDBOX_EXPIRY_LABEL}`,
      '--format',
      '{{.ID}} {{.Command}}',
    ])
  ).stdout
    .split('\n')
    .filter((line) => line.includes(command))
    .map((line) => line.split(' ')[0]);
}

const INSPECT = `
const { readFileSync, readdirSync } = require('node:fs');
const { execSync } = require('node:child_process');
const read = (path) => { try { return readFileSync(path, 'utf8').trim(); } catch (error) { return error.code; } };
const status = Object.fromEntries(read('/proc/self/status').split('\\n').map((line) => line.split(/:\\s+/)));
const mounts = read('/proc/mounts').split('\\n').map((line) => line.split(' '));
const mount = (target) => mounts.find((entry) => entry[1] === target)?.[3] ?? null;
console.log(JSON.stringify({
  uid: process.getuid(), gid: process.getgid(),
  capEff: status.CapEff, capBnd: status.CapBnd, noNewPrivs: status.NoNewPrivs, seccomp: status.Seccomp,
  memoryMax: read('/sys/fs/cgroup/memory.max'),
  pidsMax: read('/sys/fs/cgroup/pids.max'), cpuMax: read('/sys/fs/cgroup/cpu.max'),
  core: execSync('ulimit -c', { shell: '/bin/sh', encoding: 'utf8' }).trim(),
  root: mount('/'), workspace: mount('/workspace'), tmp: mount('/tmp'), input: mount('/input'),
  // Kernel fallback tunnels exist in every namespace but stay down; only loopback may be up.
  up: readdirSync('/sys/class/net').filter((name) => Number(read('/sys/class/net/' + name + '/flags')) & 1).sort(),
  routes: read('/proc/net/route').split('\\n').length - 1,
  environment: Object.keys(process.env).sort(),
  pwd: process.env.PWD,
}));
`;

gated(
  'applies every sandbox control inside the container',
  async () => {
    const result = await check({ 'inspect.cjs': INSPECT }, ['node', 'inspect.cjs']);
    expect(result.status, result.stderr).toBe('passed');
    const seen = JSON.parse(result.stdout);
    expect(seen).toMatchObject({
      uid: 65534,
      gid: 65534,
      capEff: '0000000000000000',
      capBnd: '0000000000000000',
      noNewPrivs: '1',
      seccomp: '2',
      memoryMax: String(5 * 1024 ** 3),
      pidsMax: '128',
      cpuMax: '100000 100000',
      core: '0',
      up: ['lo'],
      routes: 0,
    });
    expect(seen.root).toMatch(/^ro,/);
    expect(seen.input).toMatch(/^ro,/);
    expect(seen.workspace).toMatch(/^rw,.*size=4194304k/);
    expect(seen.tmp).toMatch(/^rw,.*noexec.*size=65536k/);
    // Only Docker's and the Node image's own variables, the entrypoint shell's PWD and SHLVL, and
    // CI=true; nothing from the host.
    const expected = [
      'CI',
      'HOME',
      'HOSTNAME',
      'NODE_VERSION',
      'PATH',
      'PWD',
      'SHLVL',
      'YARN_VERSION',
    ];
    expect(seen.environment.filter((key: string) => !expected.includes(key))).toEqual([]);
    expect(seen.environment).toContain('CI');
    expect(seen.pwd).toBe('/workspace');
  },
  120_000,
);

gated(
  'stops a fork bomb at the process limit',
  async () => {
    const result = await check(
      {
        'bomb.cjs': `
const { spawn } = require('node:child_process');
let count = 0;
(function next() {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  child.once('spawn', () => { count += 1; next(); });
  child.once('error', (error) => { console.log('fork bomb stopped after ' + count + ': ' + error.code); process.exit(1); });
})();
`,
      },
      ['node', 'bomb.cjs'],
    );
    expect(result.status).toBe('failed');
    const [, count, code] = /fork bomb stopped after (\d+): (\w+)/.exec(result.stdout) ?? [];
    expect(code).toBe('EAGAIN');
    expect(Number(count)).toBeLessThan(128);
  },
  180_000,
);

gated(
  'contains a disk filler in its own tmpfs and a read-only root',
  async () => {
    const result = await check(
      {
        'fill.cjs': `
const { writeSync, openSync } = require('node:fs');
const chunk = Buffer.alloc(16 * 1024 * 1024, 1);
for (const path of ['/workspace/fill', '/tmp/fill', '/fill', '/input/fill']) {
  try { const fd = openSync(path, 'w'); for (;;) writeSync(fd, chunk); }
  catch (error) { console.log(path + ' ' + error.code); }
}
process.exit(1);
`,
      },
      ['node', 'fill.cjs'],
    );
    expect(result.status).toBe('failed');
    expect(result.stdout).toContain('/workspace/fill ENOSPC');
    expect(result.stdout).toContain('/tmp/fill ENOSPC');
    expect(result.stdout).toMatch(/\/fill (EROFS|EACCES)/);
    expect(result.stdout).toMatch(/\/input\/fill (EROFS|EACCES)/);
  },
  300_000,
);

gated(
  'gives a network probe no route, name resolution or host gateway',
  async () => {
    const result = await check(
      {
        'probe.cjs': `
const { lookup } = require('node:dns/promises');
const { connect } = require('node:net');
const attempt = (host, port) => new Promise((resolve) => {
  const socket = connect({ host, port, timeout: 3000 });
  socket.once('connect', () => { socket.destroy(); resolve('connected'); });
  socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
  socket.once('error', (error) => resolve(error.code));
});
(async () => {
  const results = {
    dns: await lookup('registry.npmjs.org').then(() => 'resolved', (error) => error.code),
    internet: await attempt('1.1.1.1', 443),
    gateway: await attempt('172.17.0.1', 2375),
    metadata: await attempt('169.254.169.254', 80),
  };
  console.log(JSON.stringify(results));
  process.exit(Object.values(results).includes('connected') || results.dns === 'resolved' ? 0 : 1);
})();
`,
      },
      ['node', 'probe.cjs'],
    );
    expect(result.status).toBe('failed');
    const results = JSON.parse(result.stdout);
    expect(results.dns).toMatch(/^(EAI_AGAIN|ENOTFOUND)$/);
    for (const target of ['internet', 'gateway', 'metadata'])
      expect(results[target], target).toMatch(/^(ENETUNREACH|EHOSTUNREACH)$/);
  },
  120_000,
);

gated(
  'stops a check whose output passes the cap and names the reason',
  async () => {
    const result = await check({}, ['yes', 'flood']);
    expect(result).toMatchObject({
      status: 'error',
      error: 'Check output exceeded 1 MiB; the container was stopped.',
    });
    expect(result.seconds).toBeLessThan(60);
    expect(await sandboxContainers('flood')).toEqual([]);
  },
  120_000,
);

gated(
  'ends a check that ignores SIGTERM at the timeout and removes its container',
  async () => {
    const result = await check({}, ['sh', '-c', 'trap "" TERM INT; while :; do :; done']);
    expect(result).toMatchObject({
      status: 'error',
      error: 'Check exceeded 120 seconds; the container was stopped.',
    });
    expect(result.seconds).toBeLessThan(170);
    expect(await sandboxContainers('while :; do :; done')).toEqual([]);
  },
  240_000,
);

gated(
  'stops a running check when the caller aborts and removes its container',
  async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 5_000);
    await expect(
      check({}, ['sh', '-c', 'trap "" TERM INT; while :; do :; done'], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await sandboxContainers('while :; do :; done')).toEqual([]);
  },
  120_000,
);

gated(
  'removes expired sandbox containers and leaves live and unlabelled ones',
  async () => {
    const names = ['expired', 'live', 'unlabelled'].map(
      (kind) => `refit-test-${kind}-${randomUUID()}`,
    );
    // It expires only after the setup check: every sandbox start in another gated file sweeps too,
    // and a label already in the past let one remove the container before that check.
    const expiry = Date.now() + 30_000;
    const labels = [`${expiry}`, `${Date.now() + 600_000}`, undefined];
    try {
      for (const [index, name] of names.entries())
        await execute('docker', [
          'run',
          '--detach',
          '--name',
          name,
          ...(labels[index] ? ['--label', `${SANDBOX_EXPIRY_LABEL}=${labels[index]}`] : []),
          '--network',
          'none',
          '--entrypoint',
          'sleep',
          IMAGE!,
          '300',
        ]);
      const id = async (name: string) =>
        (await execute('docker', ['inspect', '--format', '{{.Id}}', name])).stdout.trim();
      expect(await id(names[0])).toMatch(/^[a-f0-9]{64}$/);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiry + 1000 - Date.now())));
      // A sandbox start in another gated file may remove it first, so only its absence counts.
      await removeExpiredSandboxContainers();
      await expect(id(names[0])).rejects.toThrow(/no such object/i);
      expect(await id(names[1])).toMatch(/^[a-f0-9]{64}$/);
      expect(await id(names[2])).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      for (const name of names) await removeDockerContainer(name);
    }
  },
  120_000,
);

// A minimal ustar writer, so the archive holds exactly the hostile entries under test.
function tarArchive(entries: { name: string; content?: string; link?: string }[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    const field = (value: string, offset: number, length: number) =>
      header.write(value, offset, length, 'utf8');
    const octal = (value: number, offset: number, length: number) =>
      field(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
    field(entry.name, 0, 100);
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(entry.link ? 0 : content.length, 124, 12);
    octal(0, 136, 12);
    field('        ', 148, 8);
    field(entry.link ? '2' : '0', 156, 1);
    field(entry.link ?? '', 157, 100);
    field('ustar\u000000', 257, 8);
    let sum = 0;
    for (const byte of header) sum += byte;
    field(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header);
    if (!entry.link) blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

gated(
  'keeps a dependency archive with ../, absolute and through-link entries inside the workspace',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-hostile-archive-'));
    roots.push(root);
    const marker = `refit-escape-${randomUUID()}`;
    const archive = join(root, 'dependencies.tar');
    await writeFile(
      archive,
      tarArchive([
        { name: 'node_modules/ok.js', content: 'ok' },
        { name: `../../../../tmp/${marker}-dotdot`, content: 'escape' },
        { name: `/tmp/${marker}-absolute`, content: 'escape' },
        { name: 'node_modules/link', link: '/tmp' },
        { name: `node_modules/link/${marker}-through`, content: 'escape' },
      ]),
    );
    const input = join(root, 'input');
    await mkdir(input);
    const name = `refit-test-${randomUUID()}`;
    try {
      const run = await execute(
        'docker',
        dockerSandboxArguments({
          name,
          directory: input,
          image: IMAGE!,
          command: ['sh', '-c', 'echo unreachable'],
          network: 'none',
          timeoutMs: 60_000,
          dependencies: archive,
        }),
        { encoding: 'utf8' },
      ).then(
        () => ({ code: 0, stderr: '' }),
        (error: { code: number; stderr: string }) => error,
      );
      // The extraction refuses the link before the check runs, so the check fails, not passes.
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(/can't create symlink|Cannot create symlink/);
    } finally {
      await removeDockerContainer(name);
    }
    for (const suffix of ['dotdot', 'absolute', 'through'])
      await expect(access(join('/tmp', `${marker}-${suffix}`))).rejects.toThrow(/ENOENT/);
  },
  120_000,
);

it.skipIf(!IMAGE || !process.env.REFIT_NPM_PREPARE)(
  'never runs a postinstall script and gives it no network during validation',
  async () => {
    const manifest = {
      name: 'hostile-postinstall',
      version: '1.0.0',
      private: true,
      scripts: { postinstall: 'node postinstall.cjs', test: 'node check.cjs' },
    };
    const result = await check(
      {
        'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
        'package-lock.json': `${JSON.stringify(
          {
            name: manifest.name,
            version: manifest.version,
            lockfileVersion: 3,
            requires: true,
            packages: { '': { name: manifest.name, version: manifest.version } },
          },
          null,
          2,
        )}\n`,
        'postinstall.cjs': `
require('node:fs').mkdirSync('node_modules', { recursive: true });
require('node:fs').writeFileSync('node_modules/.postinstall-ran', '');
fetch('https://registry.npmjs.org/').then(() => { console.log('postinstall reached the network'); }, (error) => {
  console.log('postinstall network ' + (error.cause?.code ?? error.message)); process.exit(1);
});
`,
        'check.cjs': `
const { existsSync } = require('node:fs');
console.log(existsSync('node_modules/.postinstall-ran') ? 'postinstall ran during preparation' : 'postinstall did not run during preparation');
require('node:child_process').execFileSync('npm', ['run', 'postinstall'], { stdio: 'inherit' });
`,
      },
      ['npm', 'test'],
      { prepareDependencies: true },
    );
    expect(result.status).toBe('failed');
    expect(result.stdout).toContain('postinstall did not run during preparation');
    expect(result.stdout).toMatch(/postinstall network (EAI_AGAIN|ENOTFOUND)/);
    expect(result.stdout).not.toContain('postinstall reached the network');
  },
  600_000,
);
