import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PipelineInputError } from './types.ts';

export async function createArtifactDirectory(repository: string, output: string) {
  const source = await realpath(repository);
  const destination = resolve(output);
  const parent = await realpath(dirname(destination));
  const relativeParent = relative(source, parent);
  if (
    !relativeParent ||
    (!relativeParent.startsWith(`..${sep}`) &&
      relativeParent !== '..' &&
      !isAbsolute(relativeParent))
  )
    throw new PipelineInputError('Artifact output must be outside the scanned repository.');
  await mkdir(destination, { mode: 0o700 });
  return destination;
}
