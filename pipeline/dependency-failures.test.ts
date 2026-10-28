import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  DependencyPreparationError,
  hostInstallFailure,
  PreparationHostError,
  preparationFailure,
} from './dependency-preparation.ts';
import { validateNpmLock } from './npm-lock.ts';
import { withStateLock } from './state-files.ts';
import { PipelineInputError } from './types.ts';

const manifest = { name: 'app', dependencies: { stripe: '10.17.0' } };
const record = {
  version: '10.17.0',
  resolved: 'https://registry.npmjs.org/stripe/-/stripe-10.17.0.tgz',
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
};

function failure(packageJson: object, packages: Record<string, unknown>) {
  try {
    validateNpmLock(JSON.stringify(packageJson), JSON.stringify({ lockfileVersion: 3, packages }));
  } catch (error) {
    return preparationFailure(error);
  }
  throw new Error('Expected the lockfile to be refused');
}

it('classifies the lockfile refusals the repository owner can fix', () => {
  expect(
    failure(
      { ...manifest, dependencies: { stripe: '11.0.0' } },
      {
        '': manifest,
        'node_modules/stripe': record,
      },
    ),
  ).toMatchObject({
    reason: 'lockfile-out-of-sync',
    action: expect.stringContaining('`package-lock.json` does not match `package.json`'),
  });
  expect(
    failure(manifest, {
      '': manifest,
      'node_modules/stripe': { ...record, integrity: undefined },
    }),
  ).toMatchObject({ reason: 'lockfile-integrity' });
  expect(
    preparationFailure(
      new PipelineInputError(
        'The repository commits package.json without a lockfile, so the dependency versions to verify are unknown. Run npm install, pnpm install or yarn install and commit the package-lock.json, pnpm-lock.yaml or yarn.lock it writes.',
      ),
    ),
  ).toMatchObject({
    reason: 'no-lockfile',
    action: expect.stringContaining('commits no lockfile'),
  });
  expect(
    preparationFailure(
      new DependencyPreparationError(
        'npm dependency preparation failed (1). npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
      ),
    ),
  ).toMatchObject({ reason: 'lockfile-out-of-sync' });
  expect(
    preparationFailure(
      new DependencyPreparationError(
        'pnpm dependency preparation failed (1). ERR_PNPM_OUTDATED_LOCKFILE',
      ),
    ),
  ).toMatchObject({ action: expect.stringContaining('`pnpm-lock.yaml`') });
  // Suhaib3100/online-compiler at f982961 declares prisma ^5.20.0; pnpm-lock.yaml records ^5.17.0,
  // which a frozen pnpm install refuses. The second message is the same check's other form.
  for (const message of [
    'pnpm importer specifiers differ from committed manifests: prisma is "^5.20.0" in package.json but "^5.17.0" in pnpm-lock.yaml. Run pnpm install and commit the updated pnpm-lock.yaml.',
    'pnpm importer declarations differ from committed manifests: zod is in package.json dependencies but not in pnpm-lock.yaml. Run pnpm install and commit the updated pnpm-lock.yaml.',
  ])
    expect(preparationFailure(new PipelineInputError(message))).toMatchObject({
      reason: 'lockfile-out-of-sync',
      action: expect.stringContaining('`pnpm-lock.yaml` does not match `package.json`'),
    });
  expect(
    preparationFailure(
      new DependencyPreparationError(
        'Dependency archive exceeds 1024 MiB. This exceeds the largest validation profile; the sandbox cannot hold it.',
      ),
    ),
  ).toMatchObject({ reason: 'dependency-archive-limit' });
  expect(
    preparationFailure(
      new DependencyPreparationError(
        'npm dependency preparation failed (1). npm error code ERESOLVE\nnpm error ERESOLVE could not resolve\nnpm error Conflicting peer dependency: next@15.5.28',
      ),
    ),
  ).toMatchObject({
    reason: 'peer-dependency-conflict',
    action: expect.stringContaining('peer dependencies `package-lock.json` records'),
  });
});

// Owner decision 1: a patch is published untested whatever in the repository refused preparation.
it('records install and unnamed input refusals as preparation-failed, keeping the message', () => {
  for (const error of [
    new DependencyPreparationError('Dependency preparation exceeded 300 seconds.'),
    new DependencyPreparationError('npm dependency preparation failed (1). npm error ENOSPC'),
    new DependencyPreparationError('Unsupported pnpm snapshot or patched dependency.'),
  ])
    expect(preparationFailure(error)).toEqual({
      reason: 'preparation-failed',
      summary: 'Refit could not install them in its sandbox',
      action: expect.stringContaining('none of its checks ran'),
      message: error.message,
    });
});

it('never keeps an absolute path in the recorded message', () => {
  const failure = preparationFailure(
    new DependencyPreparationError(
      'npm dependency preparation failed (1). npm error A complete log is in /root/.npm/_logs/debug-0.log (cache "/Users/someone/.refit/dependencies/abc"); see https://registry.npmjs.org/stripe/-/stripe-10.17.0.tgz and node_modules/stripe/package.json',
    ),
  );
  expect(failure?.message).toBe(
    'npm dependency preparation failed (1). npm error A complete log is in [path] (cache "[path]"); see https://registry.npmjs.org/stripe/-/stripe-10.17.0.tgz and node_modules/stripe/package.json',
  );
});

// Refit's own refusals are not the repository's: the job fails and is retried instead.
it("leaves Refit's state locks, cache and other errors to propagate", async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-lock-'));
  try {
    const locked = await withStateLock(directory, 'prepare', () =>
      withStateLock(directory, 'prepare', async () => undefined).catch((error: unknown) => error),
    );
    expect(locked).toBeInstanceOf(PipelineInputError);
    expect(String(locked)).toContain('State is locked by active process');
    for (const error of [
      locked,
      new PipelineInputError(
        `State ownership cannot be verified: ${directory}/prepare.lock. Inspect the lock before retrying.`,
      ),
      new PipelineInputError(`State recovery is already in progress: ${directory}/prepare.lock.`),
      new PipelineInputError('Prepared dependency cache does not match its committed inputs.'),
      new PipelineInputError(
        'REFIT_DEPENDENCY_TIMEOUT_SECONDS must be a whole number from 60 to 1800.',
      ),
      new PipelineInputError('An existing local Docker image is required.'),
      new Error('package.json dependencies differ from the committed package-lock.json.'),
      new DOMException('The operation was aborted.', 'AbortError'),
      'not an error',
    ])
      expect(preparationFailure(error)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('redacts every absolute path, and keeps URLs, base64 and import aliases intact', () => {
  const redacted = (text: string) =>
    preparationFailure(new DependencyPreparationError(text))?.message;
  expect(redacted('docker: unix:///Users/someone/.docker/run/docker.sock failed')).toBe(
    'docker: unix://[path] failed',
  );
  expect(redacted('read file:///home/someone/app/package.json')).toBe('read file://[path]');
  expect(redacted('PATH=/usr/bin:/home/someone/bin:/opt/someone')).toBe(
    'PATH=[path]:[path]:[path]',
  );
  expect(redacted('in /Users/John Smith/repo/package.json (cache')).toBe('in [path] (cache');
  const integrity = `sha512-ab+/cd/ef==`;
  expect(
    redacted(`integrity ${integrity} for '@/lib/stripe' at https://registry.npmjs.org/a/-/a.tgz`),
  ).toBe(`integrity ${integrity} for '@/lib/stripe' at https://registry.npmjs.org/a/-/a.tgz`);
});

// Docker, the host and the network are Refit's to fix: the job fails and is retried.
it("treats Docker, host and registry failures of an install as Refit's", () => {
  const exit = (code: number | null, signal: NodeJS.Signals | null = null) => ({ code, signal });
  for (const [result, stderr] of [
    [
      exit(125),
      'docker: Error response from daemon: Conflict. The container name is already in use.',
    ],
    [
      exit(125),
      'docker: Error response from daemon: failed to mount overlay: no space left on device.',
    ],
    [exit(1), 'write /var/lib/docker/overlay2/abc/diff: ENOSPC: overlay upper directory full'],
    [exit(125), 'docker: Error response from daemon: Mounts denied: path is not shared.'],
    [exit(1), 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'],
    [exit(137), ''],
    [exit(null, 'SIGTERM'), ''],
    [
      exit(1),
      'npm error code EAI_AGAIN\nnpm error request to https://registry.npmjs.org/stripe failed',
    ],
    [exit(1), 'npm error network socket hang up'],
  ] as const) {
    const error = hostInstallFailure('npm', result, stderr);
    expect(error, stderr).toBeInstanceOf(PreparationHostError);
    expect(preparationFailure(error)).toBeUndefined();
  }
  // The repository's own install failures stay the repository's.
  for (const stderr of [
    'npm error code ERESOLVE\nnpm error ERESOLVE could not resolve',
    'npm error ENOSPC: no space left on device, write',
    'npm error code ELIFECYCLE',
  ])
    expect(hostInstallFailure('npm', exit(1), stderr)).toBeUndefined();
});
