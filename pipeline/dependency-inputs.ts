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
import {
  validateBerryInputs,
  validateYarnInputs,
  YARN_RC,
  YARN_RELEASE,
  yarnWorkspacePatterns,
} from './yarn-inputs.ts';
import { CLASSIC_HEADER } from './yarn-lock.ts';

// An exact npm pin, as Corepack writes it. Only a sha512 checksum can be compared with registry
// integrity; a weaker one is ignored and npm still verifies the tarball against the registry.
const NPM_PIN =
  /^npm@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+(?:sha512\.([a-f0-9]{128})|sha1\.[a-f0-9]{40}|sha224\.[a-f0-9]{56}|sha256\.[a-f0-9]{64}|sha384\.[a-f0-9]{96}))?$/;

export interface PreparationIdentity {
  manager: 'npm' | 'pnpm' | 'yarn';
  managerVersion?: string;
  managerIntegrity?: string;
  managerBundleSha512?: string;
  packageHash: string;
  lockHash: string;
  packages: number;
  workspaceConfigHash?: string;
  workspaceHashes?: Record<string, string>;
  workspaceLinks?: Record<string, string>;
  workspaceOptionalLinks?: Record<string, string>;
  legacyPeerDeps?: true;
  platformPackages?: number;
}

export async function readPreparationInputs(
  snapshot: Awaited<ReturnType<typeof readCommittedRepository>>,
) {
  const paths = snapshot.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  const pnpm = paths.includes(PNPM_LOCKFILE);
  const yarn = paths.includes(YARN_LOCKFILE);
  const lockfile = pnpm ? PNPM_LOCKFILE : yarn ? YARN_LOCKFILE : 'package-lock.json';
  if (!paths.includes('package.json')) {
    const nested = paths.filter((path) =>
      /^[^/]+\/(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path),
    );
    throw new PipelineInputError(
      `Automatic preparation reads dependencies only from the repository root, which has no committed package.json${nested.length ? ` (lockfiles exist in ${nested.slice(0, 3).join(', ')})` : ''}. Validate with a custom image, or commit a root package.json and lockfile.`,
    );
  }
  if (!paths.includes(lockfile) && paths.includes(YARN_RC))
    throw new PipelineInputError(
      `The repository commits ${YARN_RC} but no ${YARN_LOCKFILE}, so the dependency versions to verify are unknown. Run yarn install and commit the ${YARN_LOCKFILE} it writes.`,
    );
  if (!paths.includes(lockfile))
    throw new PipelineInputError(
      'The repository commits package.json without a lockfile, so the dependency versions to verify are unknown. Run npm install, pnpm install or yarn install and commit the package-lock.json, pnpm-lock.yaml or yarn.lock it writes.',
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
    const rcContent = paths.includes(YARN_RC)
      ? await readCommittedFile(snapshot, YARN_RC, MAX_PACKAGE_BYTES)
      : undefined;
    const workspaceContents = new Map<string, string>();
    for (const directory of npmWorkspaceDirectories(
      { workspaces: yarnWorkspacePatterns(manifest) },
      paths,
    ))
      workspaceContents.set(
        directory,
        await readCommittedFile(snapshot, `${directory}/package.json`, MAX_PACKAGE_BYTES),
      );
    const files = new Map([
      ['package.json', packageContent],
      [YARN_LOCKFILE, lockContent],
      ...[...workspaceContents].map(
        ([directory, content]) => [`${directory}/package.json`, content] as const,
      ),
    ]);
    if (!CLASSIC_HEADER.test(lockContent))
      return {
        files,
        workspaceContents,
        inputs: validateBerryInputs(
          packageContent,
          lockContent,
          rcContent,
          await committedRelease(snapshot, paths, rcContent),
          workspaceContents,
        ) as PreparationIdentity,
      };
    return {
      files,
      workspaceContents,
      inputs: validateYarnInputs(
        packageContent,
        lockContent,
        workspaceContents,
      ) as PreparationIdentity,
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
    : {
        ...validateNpmLock(packageContent, lockContent, workspaceContents),
        manager: 'npm',
        ...npmPin(manifest.packageManager),
        ...(paths.includes('.npmrc') &&
        legacyPeerDeps(await readCommittedFile(snapshot, '.npmrc', MAX_PACKAGE_BYTES))
          ? { legacyPeerDeps: true as const }
          : {}),
      };
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

// The committed .npmrc stays out of the install, so it cannot change the registry or credentials.
// Only legacy-peer-deps is honoured: it relaxes peer checks for a lockfile the owner generated
// with it, and every package is still installed from that lockfile with its integrity.
export function legacyPeerDeps(npmrc: string) {
  return npmrc.split(/\r?\n/).some((line) => /^\s*legacy-peer-deps\s*=\s*true\s*$/.test(line));
}

// A pinned npm installs and runs that exact release; an unpinned `npm@` range keeps the image's npm.
function npmPin(packageManager: unknown) {
  const pin = typeof packageManager === 'string' ? NPM_PIN.exec(packageManager) : null;
  if (!pin) return {};
  return {
    managerVersion: pin[1],
    ...(pin[2]
      ? { managerIntegrity: `sha512-${Buffer.from(pin[2], 'hex').toString('base64')}` }
      : {}),
  };
}

// Yarn bundles are about 3 MiB; the cap leaves room for a few releases' growth.
const MAX_RELEASE_BYTES = 8 * 1024 * 1024;

// The committed Yarn release a .yarnrc.yml `yarnPath` names, read as bytes to digest, never run.
async function committedRelease(
  snapshot: Awaited<ReturnType<typeof readCommittedRepository>>,
  paths: string[],
  rcContent: string | undefined,
) {
  const path =
    rcContent === undefined ? undefined : parseDocumentObject(rcContent, YARN_RC).yarnPath;
  if (typeof path !== 'string' || !YARN_RELEASE.test(path) || !paths.includes(path))
    return undefined;
  return {
    path,
    content: Buffer.from(await readCommittedFile(snapshot, path, MAX_RELEASE_BYTES), 'utf8'),
  };
}
