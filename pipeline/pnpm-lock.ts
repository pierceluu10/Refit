import { posix } from 'node:path';
import { isObject, parseDocumentObjects } from './specifications.ts';
import type { DependencyDeclaration, LockedDependency } from './types.ts';
import { PipelineInputError } from './types.ts';
import { EXACT_PACKAGE_VERSION } from './npm-lock.ts';

export const PNPM_LOCKFILE = 'pnpm-lock.yaml';
const MAX_DOCUMENTS = 2;

export function parsePnpmLock(content: string) {
  const documents = parseDocumentObjects(content, PNPM_LOCKFILE, MAX_DOCUMENTS);
  const environment = documents.length === MAX_DOCUMENTS ? documents[0] : undefined;
  if (environment) {
    const importer = isObject(environment.importers) ? environment.importers['.'] : undefined;
    if (
      !isObject(importer) ||
      (!Object.hasOwn(importer, 'configDependencies') &&
        !Object.hasOwn(importer, 'packageManagerDependencies'))
    )
      throw new PipelineInputError(
        'The leading pnpm document must describe its package-manager environment, not a second application graph.',
      );
  }
  return { document: documents.at(-1)!, environment };
}

export function resolvePnpmDependency(
  dependency: DependencyDeclaration,
  packageName: string,
  lock: Record<string, unknown>,
): LockedDependency {
  const unknown = (reason: string): LockedDependency => ({
    status: 'unknown',
    file: PNPM_LOCKFILE,
    packagePath: null,
    version: null,
    reason,
  });
  if (![9, '9.0'].includes(lock.lockfileVersion as string | number))
    return unknown('Only pnpm lockfile version 9 is supported.');
  const directory = posix.dirname(dependency.file);
  const importer = isObject(lock.importers) ? lock.importers[directory] : undefined;
  const declarations = isObject(importer) ? importer[dependency.section] : undefined;
  const record = isObject(declarations) ? declarations[packageName] : undefined;
  if (
    !isObject(record) ||
    record.specifier !== dependency.version ||
    typeof record.version !== 'string'
  )
    return unknown(
      'Manifest declaration differs from its pnpm importer or lacks a recorded resolution.',
    );
  if (/^(?:npm:|workspace:|file:|link:)/.test(dependency.version))
    return unknown('Aliased or local SDK sources require manual review.');
  const version = record.version.split('(')[0];
  const packagePath = `${packageName}@${version}`;
  if (
    !EXACT_PACKAGE_VERSION.test(version) ||
    !isObject(lock.packages) ||
    !isObject(lock.packages[packagePath]) ||
    !isObject(lock.snapshots) ||
    !isObject(lock.snapshots[`${packageName}@${record.version}`])
  )
    return unknown('The exact registry SDK package and peer-qualified snapshot are not recorded.');
  return {
    status: 'locked',
    file: PNPM_LOCKFILE,
    packagePath: `packages/${packagePath}`,
    version,
    reason:
      'Version recorded in the matching pnpm importer and package snapshot. Installation and API-version applicability are not verified.',
  };
}
