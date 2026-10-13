import type { readCommittedRepository } from './committed-repository.ts';
import { validateNpmLock } from './npm-lock.ts';
import { PipelineInputError } from './types.ts';

export async function readNpmPreparationInputs(
  snapshot: Awaited<ReturnType<typeof readCommittedRepository>>,
) {
  const paths = snapshot.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  if (!paths.includes('package.json') || !paths.includes('package-lock.json'))
    throw new PipelineInputError(
      'Automatic preparation requires committed root package.json and package-lock.json.',
    );
  if (
    paths.includes('npm-shrinkwrap.json') ||
    paths.some((path) => path.startsWith('node_modules/'))
  )
    throw new PipelineInputError(
      'Tracked node_modules or npm-shrinkwrap.json require a custom validation image.',
    );
  const packageContent = (await snapshot.git(['show', `${snapshot.revision}:package.json`])).stdout;
  const lockContent = (await snapshot.git(['show', `${snapshot.revision}:package-lock.json`]))
    .stdout;
  return {
    packageContent,
    lockContent,
    inputs: validateNpmLock(packageContent, lockContent),
  };
}
