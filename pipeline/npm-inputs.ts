import type { readCommittedRepository } from './committed-repository.ts';
import {
  MAX_LOCK_BYTES,
  MAX_PACKAGE_BYTES,
  npmWorkspaceDirectories,
  validateNpmLock,
} from './npm-lock.ts';
import { readCommittedFile } from './committed-repository.ts';
import { parseObject } from './specifications.ts';
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
    paths.some((path) => path.split('/').includes('node_modules'))
  )
    throw new PipelineInputError(
      'Tracked node_modules or npm-shrinkwrap.json require a custom validation image.',
    );
  const packageContent = await readCommittedFile(snapshot, 'package.json', MAX_PACKAGE_BYTES);
  const lockContent = await readCommittedFile(snapshot, 'package-lock.json', MAX_LOCK_BYTES);
  const directories = npmWorkspaceDirectories(parseObject(packageContent, 'package.json'), paths);
  const workspaceContents = new Map<string, string>();
  for (const directory of directories)
    workspaceContents.set(
      directory,
      await readCommittedFile(snapshot, `${directory}/package.json`, MAX_PACKAGE_BYTES),
    );
  return {
    packageContent,
    lockContent,
    workspaceContents,
    inputs: validateNpmLock(packageContent, lockContent, workspaceContents),
  };
}
