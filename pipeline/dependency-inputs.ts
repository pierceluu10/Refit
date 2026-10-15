import type { readCommittedRepository } from './committed-repository.ts';
import {
  MAX_LOCK_BYTES,
  MAX_PACKAGE_BYTES,
  npmWorkspaceDirectories,
  validateNpmLock,
} from './npm-lock.ts';
import { readCommittedFile } from './committed-repository.ts';
import { parseDocumentObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { PNPM_LOCKFILE } from './pnpm-lock.ts';
import { PNPM_WORKSPACE, validatePnpmInputs } from './pnpm-inputs.ts';
import { YARN_LOCKFILE } from './yarn-lock.ts';
import { validateYarnInputs } from './yarn-inputs.ts';

export interface PreparationIdentity {
  manager: 'npm' | 'pnpm' | 'yarn';
  managerVersion?: string;
  managerIntegrity?: string;
  packageHash: string;
  lockHash: string;
  packages: number;
  workspaceConfigHash?: string;
  workspaceHashes?: Record<string, string>;
  workspaceLinks?: Record<string, string>;
  workspaceOptionalLinks?: Record<string, string>;
}

export async function readPreparationInputs(
  snapshot: Awaited<ReturnType<typeof readCommittedRepository>>,
) {
  const paths = snapshot.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  const pnpm = paths.includes(PNPM_LOCKFILE);
  const yarn = paths.includes(YARN_LOCKFILE);
  const lockfile = pnpm ? PNPM_LOCKFILE : yarn ? YARN_LOCKFILE : 'package-lock.json';
  if (!paths.includes('package.json') || !paths.includes(lockfile))
    throw new PipelineInputError(
      'Automatic preparation requires committed root package.json and package-lock.json, pnpm-lock.yaml or yarn.lock.',
    );
  if (
    paths.includes('npm-shrinkwrap.json') ||
    (pnpm && yarn) ||
    ((pnpm || yarn) && paths.includes('package-lock.json')) ||
    (pnpm && paths.some((path) => /^\.pnpmfile\.[cm]?js$/.test(path.split('/').at(-1)!))) ||
    paths.some((path) => path.split('/').includes('node_modules'))
  )
    throw new PipelineInputError(
      'Tracked node_modules, conflicting lockfiles, shrinkwrap or pnpm hooks require a custom validation image.',
    );
  const packageContent = await readCommittedFile(snapshot, 'package.json', MAX_PACKAGE_BYTES);
  const manifest = parseObject(packageContent, 'package.json');
  if (yarn) {
    const lockContent = await readCommittedFile(snapshot, YARN_LOCKFILE, MAX_LOCK_BYTES);
    return {
      files: new Map([
        ['package.json', packageContent],
        [YARN_LOCKFILE, lockContent],
      ]),
      workspaceContents: new Map<string, string>(),
      inputs: validateYarnInputs(packageContent, lockContent) as PreparationIdentity,
    };
  }
  if (
    !pnpm &&
    manifest.packageManager !== undefined &&
    (typeof manifest.packageManager !== 'string' || !manifest.packageManager.startsWith('npm@'))
  )
    throw new PipelineInputError(
      'The declared package manager differs from the committed npm lockfile.',
    );
  const lockContent = await readCommittedFile(snapshot, lockfile, MAX_LOCK_BYTES);
  const workspaceContent =
    pnpm && paths.includes(PNPM_WORKSPACE)
      ? await readCommittedFile(snapshot, PNPM_WORKSPACE, MAX_PACKAGE_BYTES)
      : undefined;
  const workspace =
    workspaceContent === undefined
      ? undefined
      : parseDocumentObject(workspaceContent, PNPM_WORKSPACE);
  const directories = npmWorkspaceDirectories(
    pnpm ? { workspaces: workspace?.packages ?? [] } : manifest,
    paths,
  );
  const workspaceContents = new Map<string, string>();
  for (const directory of directories)
    workspaceContents.set(
      directory,
      await readCommittedFile(snapshot, `${directory}/package.json`, MAX_PACKAGE_BYTES),
    );
  const inputs: PreparationIdentity = pnpm
    ? validatePnpmInputs(packageContent, lockContent, workspaceContent, workspaceContents)
    : { ...validateNpmLock(packageContent, lockContent, workspaceContents), manager: 'npm' };
  const files = new Map([
    ['package.json', packageContent],
    [lockfile, lockContent],
    ...[...workspaceContents].map(
      ([directory, content]) => [`${directory}/package.json`, content] as const,
    ),
  ]);
  if (workspaceContent !== undefined) files.set(PNPM_WORKSPACE, workspaceContent);
  return {
    files,
    workspaceContents,
    inputs,
  };
}
