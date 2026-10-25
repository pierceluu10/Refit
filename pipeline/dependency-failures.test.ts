import { expect, it } from 'vitest';
import { DependencyPreparationError, preparationFailure } from './dependency-preparation.ts';
import { validateNpmLock } from './npm-lock.ts';
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
    action: expect.stringContaining('Update `package-lock.json` so it matches `package.json`'),
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
  ).toMatchObject({ reason: 'no-lockfile', action: expect.stringContaining('package-lock.json') });
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
  expect(
    preparationFailure(
      new DependencyPreparationError(
        'Dependency archive exceeds 1024 MiB. This exceeds the largest validation profile; use a custom validation image.',
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
    action: expect.stringContaining('commit the updated `package-lock.json`'),
  });
});

// Owner decision 1: a patch is published untested whatever refused preparation.
it('records sandbox, network and unknown refusals as preparation-failed, keeping the message', () => {
  for (const error of [
    new DependencyPreparationError('Dependency preparation exceeded 300 seconds.'),
    new DependencyPreparationError('npm dependency preparation failed (1). npm error ENOSPC'),
    new PipelineInputError('Prepared dependency cache does not match its committed inputs.'),
  ])
    expect(preparationFailure(error)).toEqual({
      reason: 'preparation-failed',
      summary: 'Refit could not install them in its sandbox',
      action: expect.stringContaining('Refit ran none'),
      message: error.message,
    });
});

it('leaves errors that are not preparation refusals to propagate', () => {
  for (const error of [
    new Error('package.json dependencies differ from the committed package-lock.json.'),
    new DOMException('The operation was aborted.', 'AbortError'),
    'not an error',
  ])
    expect(preparationFailure(error)).toBeUndefined();
});
