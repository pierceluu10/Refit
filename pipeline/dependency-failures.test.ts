import { expect, it } from 'vitest';
import {
  DependencyPreparationError,
  repositoryDependencyFailure,
} from './dependency-preparation.ts';
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
    return repositoryDependencyFailure(error);
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
    repositoryDependencyFailure(
      new PipelineInputError(
        'Automatic preparation requires committed root package.json and package-lock.json, pnpm-lock.yaml or yarn.lock.',
      ),
    ),
  ).toMatchObject({ reason: 'no-lockfile', action: expect.stringContaining('package-lock.json') });
  expect(
    repositoryDependencyFailure(
      new DependencyPreparationError(
        'npm dependency preparation failed (1). npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
      ),
    ),
  ).toMatchObject({ reason: 'lockfile-out-of-sync' });
  expect(
    repositoryDependencyFailure(
      new DependencyPreparationError(
        'pnpm dependency preparation failed (1). ERR_PNPM_OUTDATED_LOCKFILE',
      ),
    ),
  ).toMatchObject({ action: expect.stringContaining('`pnpm-lock.yaml`') });
  expect(
    repositoryDependencyFailure(
      new DependencyPreparationError(
        'Dependency archive exceeds 1024 MiB. This exceeds the largest validation profile; use a custom validation image.',
      ),
    ),
  ).toMatchObject({ reason: 'dependency-archive-limit' });
});

it('leaves sandbox, network and unknown failures unclassified', () => {
  for (const error of [
    new DependencyPreparationError('Dependency preparation exceeded 300 seconds.'),
    new DependencyPreparationError('npm dependency preparation failed (1). npm error ENOSPC'),
    new PipelineInputError('Prepared dependency cache does not match its committed inputs.'),
    new Error('package.json dependency requirements differ from the committed root lockfile.'),
  ])
    expect(repositoryDependencyFailure(error)).toBeUndefined();
});
