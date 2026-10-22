import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  dockerSandboxArguments,
  removeExpiredSandboxContainers,
  SANDBOX_EXPIRY_LABEL,
} from './docker-sandbox.ts';
import { validateSourcePatch } from './validation.ts';

const execute = promisify(execFile);
const NOW = Date.parse('2026-10-22T00:00:00.000Z');
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const HARDENING = [
  '--pull',
  'never',
  '--network',
  'none',
  '--log-driver',
  'none',
  '--read-only',
  '--user',
  '65534:65534',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '128',
  '--memory',
  '3g',
  '--memory-swap',
  '3g',
  '--cpus',
  '1',
  '--ulimit',
  'core=0',
  '--tmpfs',
  '/workspace:rw,exec,size=2g,uid=65534,gid=65534,mode=0700',
  '--tmpfs',
  '/tmp:rw,noexec,size=64m,mode=1777',
];

it('builds the exact docker run arguments for an offline validation check', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('REFIT_VALIDATION_WORKSPACE', '');
  expect(
    dockerSandboxArguments({
      name: 'refit-check',
      directory: '/tmp/refit-validation/baseline',
      image: 'sha256:image',
      command: ['npm', 'test'],
      network: 'none',
      timeoutMs: 120_000,
    }),
  ).toEqual([
    'run',
    '--name',
    'refit-check',
    '--label',
    `${SANDBOX_EXPIRY_LABEL}=${NOW + 180_000}`,
    ...HARDENING,
    '--mount',
    'type=bind,src=/tmp/refit-validation/baseline,dst=/input,readonly',
    '--workdir',
    '/workspace',
    '--env',
    'CI=true',
    '--entrypoint',
    '/bin/sh',
    'sha256:image',
    '-c',
    'cp -R /input/. /workspace/ && exec "$@"',
    'refit-check',
    'npm',
    'test',
  ]);
});

it('mounts prepared dependencies and tools read-only and keeps every other flag', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('REFIT_VALIDATION_WORKSPACE', '');
  expect(
    dockerSandboxArguments({
      name: 'refit-check',
      directory: '/tmp/candidate',
      image: 'sha256:image',
      command: ['node', 'check.js'],
      network: 'none',
      timeoutMs: 120_000,
      dependencies: '/tmp/dependencies.tar',
      readOnlyMounts: [{ source: '/tmp/tools', target: '/refit/generated' }],
    }),
  ).toEqual([
    'run',
    '--name',
    'refit-check',
    '--label',
    `${SANDBOX_EXPIRY_LABEL}=${NOW + 180_000}`,
    ...HARDENING,
    '--mount',
    'type=bind,src=/tmp/candidate,dst=/input,readonly',
    '--mount',
    'type=bind,src=/tmp/dependencies.tar,dst=/dependencies.tar,readonly',
    '--mount',
    'type=bind,src=/tmp/tools,dst=/refit/generated,readonly',
    '--workdir',
    '/workspace',
    '--env',
    'CI=true',
    '--entrypoint',
    '/bin/sh',
    'sha256:image',
    '-c',
    'cp -R /input/. /workspace/ && tar -xf /dependencies.tar -C /workspace/ && export PATH="/workspace/node_modules/.refit-tools/node_modules/.bin:/workspace/node_modules/.bin:$PATH" && exec "$@"',
    'refit-check',
    'node',
    'check.js',
  ]);
});

it('gives dependency preparation the registry network and its own deadline, nothing more', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const args = dockerSandboxArguments({
    name: 'refit-dependencies',
    directory: '/tmp/inputs',
    image: 'sha256:image',
    command: ['sh', '-c', 'npm ci'],
    network: 'bridge',
    timeoutMs: 300_000,
    preparation: { workspace: '2g', memory: '3g' },
  });
  expect(args.slice(0, 5)).toEqual([
    'run',
    '--name',
    'refit-dependencies',
    '--label',
    `${SANDBOX_EXPIRY_LABEL}=${NOW + 360_000}`,
  ]);
  expect(args.slice(5, 5 + HARDENING.length)).toEqual(
    HARDENING.map((value, index) => (HARDENING[index - 1] === '--network' ? 'bridge' : value)),
  );
  expect(args).not.toContain('--privileged');
  expect(args.join(' ')).not.toMatch(/unconfined|--cap-add|--device|docker\.sock|--volume|-v /);
});

it('refuses bind-mount paths that would split the mount specification', () => {
  expect(() =>
    dockerSandboxArguments({
      name: 'refit-check',
      directory: '/tmp/a,dst=/etc',
      image: 'sha256:image',
      command: ['true'],
      network: 'none',
      timeoutMs: 1000,
    }),
  ).toThrow('Docker bind-mount paths must not contain commas.');
});

it('removes only labelled sandbox containers whose deadline has passed', async () => {
  const root = await temporaryDirectory('refit-sandbox-reaper-');
  const log = join(root, 'calls.jsonl');
  const [expired, live, malformed, racing] = ['a', 'b', 'c', 'd'].map((letter) =>
    letter.repeat(64),
  );
  await mkdir(join(root, 'bin'));
  await writeFile(
    join(root, 'bin', 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'rm' && args[2] === ${JSON.stringify(racing)}) {
  process.stderr.write('Error response from daemon: removal of container ' + args[2] + ' is already in progress\\n');
  process.exit(1);
}
if (args[0] === 'ps')
  process.stdout.write(${JSON.stringify(`${expired} ${NOW - 1}\n${live} ${NOW + 60_000}\n${malformed} soon\n${racing} ${NOW - 5}\n\n`)});
`,
  );
  await chmod(join(root, 'bin', 'docker'), 0o755);
  vi.stubEnv('PATH', join(root, 'bin') + delimiter + process.env.PATH);
  // A container another Refit process is already removing counts as removed.
  expect(await removeExpiredSandboxContainers(NOW)).toEqual([expired, racing]);
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  expect(calls).toEqual([
    [
      'ps',
      '--all',
      '--no-trunc',
      '--filter',
      `label=${SANDBOX_EXPIRY_LABEL}`,
      '--format',
      `{{.ID}} {{.Label "${SANDBOX_EXPIRY_LABEL}"}}`,
    ],
    ['rm', '--force', expired],
    ['rm', '--force', racing],
  ]);
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
  ).stdout.trim();
}

async function hostileRepository(files: Record<string, string>, links: Record<string, string>) {
  const repository = await temporaryDirectory('refit-hostile-');
  await git(repository, 'init', '-q');
  for (const [path, content] of Object.entries(files))
    await writeFile(join(repository, path), content);
  for (const [path, target] of Object.entries(links)) await symlink(target, join(repository, path));
  await git(repository, 'add', '-A');
  await git(repository, 'commit', '-q', '-m', 'test: hostile fixture');
  return repository;
}

// Each refusal happens before Refit resolves an image, so no Docker daemon is needed.
const validate = (repository: string) =>
  validateSourcePatch({
    repository,
    propose: async () => null,
    image: 'refit-test-image-never-resolved',
    command: ['npm', 'test'],
  });

it('refuses committed symbolic links to host paths before anything is extracted or run', async () => {
  const absolute = await hostileRepository({ 'index.js': '' }, { leak: '/etc/passwd' });
  await expect(validate(absolute)).rejects.toThrow(
    'Validation accepts tracked symbolic links only when they resolve inside the repository; leak does not.',
  );
  const relative = await hostileRepository({ 'index.js': '' }, { up: '../../../../../../etc' });
  await expect(validate(relative)).rejects.toThrow('resolve inside the repository; up does not.');
  const chained = await hostileRepository({ 'index.js': '' }, { first: 'second/..', second: '..' });
  await expect(validate(chained)).rejects.toThrow('resolve inside the repository');
});

it('refuses a commit whose tree holds ".." or ".git" entries, which Git will not archive', async () => {
  for (const name of ['..', '.git', '.GIT']) {
    const repository = await hostileRepository({ 'index.js': '' }, {});
    const blob = await git(repository, 'rev-parse', 'HEAD:index.js');
    const write = (input: string) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile('git', ['-C', repository, 'mktree'], (error, stdout) =>
          error ? reject(error) : resolve(stdout.trim()),
        );
        child.stdin!.end(input);
      });
    const inner = await write(`100644 blob ${blob}\tconfig\n`);
    const nested = await write(`040000 tree ${inner}\t${name}\n`);
    const top = await write(`040000 tree ${nested}\tsub\n100644 blob ${blob}\tindex.js\n`);
    const commit = await git(repository, 'commit-tree', '-p', 'HEAD', '-m', 'test: unsafe', top);
    await git(repository, 'update-ref', 'HEAD', commit);
    await expect(validate(repository), name).rejects.toThrow(
      'Validation requires a clean committed repository',
    );
  }
});
