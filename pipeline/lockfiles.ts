import { posix } from 'node:path';
import { isObject } from './specifications.ts';
import type { DependencyDeclaration, LockedDependency } from './types.ts';
import { PNPM_LOCKFILE, resolvePnpmDependency } from './pnpm-lock.ts';
import { EXACT_PACKAGE_VERSION } from './npm-lock.ts';
import { YARN_LOCKFILE, resolveYarnDependency } from './yarn-lock.ts';

export const NPM_LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'] as const;
export const DEPENDENCY_LOCKFILES = [...NPM_LOCKFILES, PNPM_LOCKFILE, YARN_LOCKFILE] as const;
const SUPPORTED_LOCK_VERSIONS = new Set([2, 3]);

export interface DependencyLockfile {
  file: string;
  content: Record<string, unknown>;
}

export function resolveLockedDependency(
  dependency: DependencyDeclaration,
  packageName: string,
  lockfiles: DependencyLockfile[],
): LockedDependency {
  const pnpm = lockfiles.find((lock) => lock.file === PNPM_LOCKFILE);
  const yarn = lockfiles.find((lock) => lock.file === YARN_LOCKFILE);
  if (pnpm && lockfiles.length === 1)
    return resolvePnpmDependency(dependency, packageName, pnpm.content);
  if (yarn && lockfiles.length === 1)
    return resolveYarnDependency(dependency, packageName, yarn.content);
  if (pnpm || yarn)
    return {
      status: 'unknown',
      file: null,
      packagePath: null,
      version: null,
      reason:
        'Multiple package-manager lockfiles require explicit review; no effective graph is assumed.',
    };
  const selected = NPM_LOCKFILES.map((name) => lockfiles.find((lock) => lock.file === name)).find(
    Boolean,
  );
  const unknown = (reason: string): LockedDependency => ({
    status: 'unknown',
    file: selected?.file ?? null,
    packagePath: null,
    version: null,
    reason,
  });
  if (selected?.file === 'npm-shrinkwrap.json')
    return unknown(
      'Shrinkwrap selection depends on the npm version; this reader does not infer the effective graph when shrinkwrap is present.',
    );
  if (!selected)
    return unknown(
      'No supported root npm lockfile was found. Installed versions and other lockfile formats are not inferred.',
    );
  const version = selected.content.lockfileVersion;
  if (typeof version !== 'number' || !SUPPORTED_LOCK_VERSIONS.has(version))
    return unknown('Only npm lockfile versions 2 and 3 are supported.');
  const packages = selected.content.packages;
  if (!isObject(packages)) return unknown('Lockfile has no packages map.');
  const directory = posix.dirname(dependency.file);
  const importerPath = directory === '.' ? '' : directory;
  const importer = packages[importerPath];
  const declarations = isObject(importer) ? importer[dependency.section] : undefined;
  if (!isObject(declarations) || declarations[packageName] !== dependency.version)
    return unknown(
      'Manifest declaration is absent or differs from its lockfile importer; regenerate the lockfile before relying on it.',
    );
  if (
    dependency.version.startsWith('npm:') ||
    dependency.version.startsWith('file:') ||
    dependency.version.startsWith('link:') ||
    dependency.version.startsWith('workspace:')
  )
    return unknown('Aliased or local dependency sources require manual review.');
  let search = importerPath;
  for (;;) {
    const packagePath = posix.join(search, 'node_modules', packageName);
    if (Object.hasOwn(packages, packagePath)) {
      const entry = packages[packagePath];
      if (
        !isObject(entry) ||
        entry.link ||
        (entry.name !== undefined && entry.name !== packageName) ||
        typeof entry.version !== 'string' ||
        !EXACT_PACKAGE_VERSION.test(entry.version)
      )
        return unknown(
          'Nearest package entry is linked, aliased or lacks an exact version; no hoisted fallback is assumed.',
        );
      return {
        status: 'locked',
        file: selected.file,
        packagePath,
        version: entry.version,
        reason:
          'Version recorded in the matching npm lockfile graph. Installation and API-version applicability are not verified.',
      };
    }
    if (!search) break;
    const parent = posix.dirname(search);
    search = parent === '.' ? '' : parent;
  }
  return unknown('No package entry resolves from the recorded importer within this repository.');
}
