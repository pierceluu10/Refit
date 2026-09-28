import { posix } from 'node:path';
import { isObject } from './specifications.ts';
import type { DependencyDeclaration, LockedDependency } from './types.ts';

export const NPM_LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'] as const;
const SUPPORTED_LOCK_VERSIONS = new Set([2, 3]);
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface NpmLockfile {
  file: string;
  content: Record<string, unknown>;
}

export function resolveLockedDependency(
  dependency: DependencyDeclaration,
  packageName: string,
  lockfiles: NpmLockfile[],
): LockedDependency {
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
        !EXACT_VERSION.test(entry.version)
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
