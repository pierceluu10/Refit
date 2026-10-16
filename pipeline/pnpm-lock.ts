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
  return { document: fromLockfileV6(documents.at(-1)!), environment };
}

const IMPORTER_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

// pnpm 8 writes lockfile v6: root importer sections at the top level and one record per
// `/name@version(peers)` key, where v9 splits resolutions into `packages` and graphs into
// `snapshots`. Mapping v6 onto that shape lets the same checks cover both. Anything that does not
// map cleanly is returned unchanged, so the normal checks refuse it.
function fromLockfileV6(lock: Record<string, unknown>) {
  if (lock.lockfileVersion !== '6.0') return lock;
  const { importers, packages, ...rest } = lock;
  const version = (value: unknown) =>
    typeof value === 'string' && value.startsWith('/') ? value.slice(1) : value;
  const importer = (record: unknown) =>
    isObject(record)
      ? Object.fromEntries(
          Object.entries(record).map(([section, entries]) => [
            section,
            IMPORTER_SECTIONS.includes(section) && isObject(entries)
              ? Object.fromEntries(
                  Object.entries(entries).map(([name, entry]) => [
                    name,
                    isObject(entry) ? { ...entry, version: version(entry.version) } : entry,
                  ]),
                )
              : entries,
          ]),
        )
      : record;
  const root = Object.fromEntries(
    IMPORTER_SECTIONS.flatMap((key) => (key in rest ? [[key, rest[key]]] : [])),
  );
  if (Object.keys(root).length && importers !== undefined) return lock;
  for (const key of IMPORTER_SECTIONS) delete rest[key];
  const converted: Record<string, unknown> = {
    ...rest,
    importers: isObject(importers)
      ? Object.fromEntries(
          Object.entries(importers).map(([path, value]) => [path, importer(value)]),
        )
      : { '.': importer(root) },
  };
  if (packages === undefined) return converted;
  if (!isObject(packages)) return lock;
  const resolutions: Record<string, unknown> = {};
  const snapshots: Record<string, unknown> = {};
  for (const [key, record] of Object.entries(packages)) {
    if (!isObject(record)) return lock;
    // Remote-tarball and local records have no `/` registry key. Kept as they are, they fail the
    // registry name/version check with its own reason.
    if (!key.startsWith('/')) {
      resolutions[key] = record;
      continue;
    }
    const snapshot = key.slice(1);
    const base = snapshot.split('(')[0];
    const recorded = resolutions[base] as { resolution: unknown } | undefined;
    if (recorded && JSON.stringify(recorded.resolution) !== JSON.stringify(record.resolution))
      return lock;
    resolutions[base] = { resolution: record.resolution };
    snapshots[snapshot] = Object.fromEntries(
      Object.entries(record).flatMap(([section, entries]) =>
        section === 'patched'
          ? [[section, entries]]
          : ['dependencies', 'optionalDependencies'].includes(section) && isObject(entries)
            ? [
                [
                  section,
                  Object.fromEntries(
                    Object.entries(entries).map(([name, value]) => [name, version(value)]),
                  ),
                ],
              ]
            : [],
      ),
    );
  }
  return { ...converted, packages: resolutions, snapshots };
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
  if (![9, '9.0', '6.0'].includes(lock.lockfileVersion as string | number))
    return unknown('Only pnpm lockfile versions 6 and 9 are supported.');
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
