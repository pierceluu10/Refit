import { posix } from 'node:path';
import { digest, isObject, parseObject, parseDocumentObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { parsePnpmLock } from './pnpm-lock.ts';
import {
  assertRegistryTarball,
  DEPENDENCY_SECTIONS,
  EXACT_PACKAGE_VERSION,
  hasStrongIntegrity,
  isRegistrySource,
  MAX_LOCK_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGES,
  NPM_PACKAGE_NAME,
  REGISTRY_PACKAGE_NAME,
  npmWorkspaceDirectories,
} from './npm-lock.ts';

export const PNPM_WORKSPACE = 'pnpm-workspace.yaml';
// Used when package.json does not pin pnpm; it is the final pnpm 9 release, which installs
// lockfile version 9 without the pnpm 10 behavior changes.
// Source: npm registry, pnpm versions, 2026-10-16.
export const DEFAULT_PNPM_VERSION = '9.15.9';
// Lockfile v6 is pnpm 8's format; newer pnpm migrates it instead of installing it frozen. Unpinned
// v6 roots therefore install with the final pnpm 8 release, which no longer receives fixes.
// Source: npm registry, pnpm versions (8.15.9 published 2024-07-17), 2026-10-16.
export const DEFAULT_PNPM_8_VERSION = '8.15.9';
// pnpm 9 rejects a pnpm-workspace.yaml without `packages`, which pnpm 10 accepts as a settings-only
// file. Unpinned roots with such a file install with the final pnpm 10 release.
// Source: npm registry, pnpm latest-10 dist-tag (10.34.7 published 2026-10-12), 2026-10-16.
export const DEFAULT_PNPM_10_VERSION = '10.34.7';
// Only a sha512 Corepack checksum can be compared with registry integrity; a weaker one is ignored,
// so that pin installs like an unhashed one, still verified by npm against the registry.
const MANAGER_PIN =
  /^pnpm@((?:8|9|10|11|12)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+(?:sha512\.([a-f0-9]{128})|sha1\.[a-f0-9]{40}|sha224\.[a-f0-9]{56}|sha256\.[a-f0-9]{64}|sha384\.[a-f0-9]{96}))?$/;
const CONFIGURATION_KEYS = new Set([
  'packages',
  'catalog',
  'catalogs',
  'overrides',
  'allowBuilds',
  'onlyBuiltDependencies',
  'ignoredBuiltDependencies',
  'pmOnFail',
  'autoInstallPeers',
  'excludeLinksFromLockfile',
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
]);
const IMPORTER_SECTIONS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);
const LOCK_KEYS = new Set([
  'lockfileVersion',
  'settings',
  'catalogs',
  'overrides',
  'importers',
  'packages',
  'snapshots',
]);

function configuration(value: Record<string, unknown>) {
  if (Object.keys(value).some((key) => !CONFIGURATION_KEYS.has(key)))
    throw new PipelineInputError(
      'Unsupported pnpm settings require a custom validation image; hooks, patches, alternate stores, runtimes and registries are not loaded automatically.',
    );
  if (
    value.overrides !== undefined &&
    (!isObject(value.overrides) ||
      Object.values(value.overrides).some((source) => !isRegistrySource(source)))
  )
    throw new PipelineInputError('pnpm overrides must use public registry requirements.');
  if (
    value.allowBuilds !== undefined &&
    (!isObject(value.allowBuilds) ||
      Object.values(value.allowBuilds).some((enabled) => typeof enabled !== 'boolean'))
  )
    throw new PipelineInputError(
      'pnpm allowBuilds must contain boolean settings. Install scripts remain disabled.',
    );
  for (const key of ['onlyBuiltDependencies', 'ignoredBuiltDependencies'])
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        !(value[key] as unknown[]).every(
          (name) => typeof name === 'string' && REGISTRY_PACKAGE_NAME.test(name),
        ))
    )
      throw new PipelineInputError(`pnpm ${key} must contain package names.`);
  // The release-age gate only applies when pnpm resolves new versions; a frozen install fetches the
  // locked, integrity-checked snapshots either way.
  if (
    (value.minimumReleaseAge !== undefined &&
      (!Number.isSafeInteger(value.minimumReleaseAge) ||
        (value.minimumReleaseAge as number) < 0)) ||
    (value.minimumReleaseAgeExclude !== undefined &&
      (!Array.isArray(value.minimumReleaseAgeExclude) ||
        !value.minimumReleaseAgeExclude.every((entry) => typeof entry === 'string' && entry)))
  )
    throw new PipelineInputError(
      'pnpm minimumReleaseAge must be a whole number of minutes and minimumReleaseAgeExclude a list of package patterns.',
    );
  if (value.pmOnFail !== undefined && value.pmOnFail !== 'ignore' && value.pmOnFail !== 'error')
    throw new PipelineInputError('Unsupported pnpm package-manager policy.');
  if (
    (value.autoInstallPeers !== undefined && typeof value.autoInstallPeers !== 'boolean') ||
    (value.excludeLinksFromLockfile !== undefined && value.excludeLinksFromLockfile !== false)
  )
    throw new PipelineInputError(
      'pnpm peer settings must be boolean and workspace links must remain recorded.',
    );
  const catalogs: Record<string, Record<string, string>> = {};
  const add = (name: string, entries: unknown) => {
    if (
      !isObject(entries) ||
      Object.entries(entries).some(
        ([name, source]) =>
          !REGISTRY_PACKAGE_NAME.test(name) ||
          !isRegistrySource(source) ||
          source.startsWith('catalog:'),
      )
    )
      throw new PipelineInputError(
        'pnpm catalogs must map package names to public registry requirements.',
      );
    catalogs[name] = entries as Record<string, string>;
  };
  if (value.catalog !== undefined) add('default', value.catalog);
  if (value.catalogs !== undefined) {
    if (!isObject(value.catalogs)) throw new PipelineInputError('pnpm catalogs must be an object.');
    for (const [name, entries] of Object.entries(value.catalogs)) {
      if (name === 'default' && value.catalog !== undefined)
        throw new PipelineInputError('Duplicate default pnpm catalog.');
      add(name, entries);
    }
  }
  return catalogs;
}

export function validatePnpmInputs(
  packageContent: string,
  lockContent: string,
  workspaceContent: string | undefined,
  workspaceContents: ReadonlyMap<string, string>,
) {
  if (
    Buffer.byteLength(packageContent) > MAX_PACKAGE_BYTES ||
    Buffer.byteLength(lockContent) > MAX_LOCK_BYTES ||
    (workspaceContent !== undefined && Buffer.byteLength(workspaceContent) > MAX_PACKAGE_BYTES)
  )
    throw new PipelineInputError('pnpm preparation inputs exceed manifest or lockfile limits.');
  const manifest = parseObject(packageContent, 'package.json');
  const { document: lock, environment } = parsePnpmLock(lockContent);
  const v6 = lock.lockfileVersion === '6.0';
  const workspace =
    workspaceContent === undefined ? {} : parseDocumentObject(workspaceContent, PNPM_WORKSPACE);
  const settingsOnly =
    workspaceContent !== undefined &&
    !(Array.isArray(workspace.packages) && workspace.packages.length);
  const fallback = v6
    ? DEFAULT_PNPM_8_VERSION
    : settingsOnly
      ? DEFAULT_PNPM_10_VERSION
      : DEFAULT_PNPM_VERSION;
  const pin =
    manifest.packageManager === undefined
      ? ([`pnpm@${fallback}`, fallback] as const)
      : typeof manifest.packageManager === 'string'
        ? MANAGER_PIN.exec(manifest.packageManager)
        : null;
  if (!pin)
    throw new PipelineInputError(
      'pnpm preparation requires no packageManager or an exact pin for pnpm 8–12, optionally with a Corepack checksum.',
    );
  if (v6 !== pin[1].startsWith('8.'))
    throw new PipelineInputError(
      v6
        ? `pnpm-lock.yaml is lockfile v6 (pnpm 8), but packageManager pins pnpm ${pin[1]}, which would migrate it. Run pnpm install with pnpm ${pin[1]} and commit the regenerated lockfile, or pin pnpm 8.`
        : `packageManager pins pnpm ${pin[1]}, which cannot install this lockfile. Pin pnpm 9–12, or remove the pin.`,
    );
  const catalogs = configuration(workspace);
  if (manifest.pnpm !== undefined) {
    if (!isObject(manifest.pnpm))
      throw new PipelineInputError('pnpm manifest settings must be an object.');
    configuration(manifest.pnpm);
  }
  if (manifest.workspaces !== undefined)
    throw new PipelineInputError('pnpm workspaces must be declared only in pnpm-workspace.yaml.');
  const directories = npmWorkspaceDirectories(
    { workspaces: workspace.packages ?? [] },
    [...workspaceContents.keys()].map((path) => `${path}/package.json`),
  );
  if (directories.length !== workspaceContents.size)
    throw new PipelineInputError('Selected pnpm workspaces differ from their committed patterns.');
  const manifests = new Map<string, Record<string, unknown>>([['.', manifest]]);
  const names = new Map<string, string>();
  for (const directory of directories) {
    const content = workspaceContents.get(directory)!;
    if (Buffer.byteLength(content) > MAX_PACKAGE_BYTES)
      throw new PipelineInputError('A pnpm workspace manifest exceeds 512 KiB.');
    const value = parseObject(content, `${directory}/package.json`);
    if (
      typeof value.name !== 'string' ||
      !NPM_PACKAGE_NAME.test(value.name) ||
      value.name.startsWith('.') ||
      names.has(value.name)
    )
      throw new PipelineInputError('pnpm workspace package names must be explicit and unique.');
    if (
      value.bin !== undefined ||
      value.workspaces !== undefined ||
      value.pnpm !== undefined ||
      (value.packageManager !== undefined && value.packageManager !== manifest.packageManager)
    )
      throw new PipelineInputError(
        'Workspace bins, nested workspace declarations and workspace pnpm settings require a custom validation image.',
      );
    names.set(value.name, directory);
    manifests.set(directory, value);
  }
  const { packages, reference } = registryGraph(lock);
  let managerIntegrity = pin[2]
    ? `sha512-${Buffer.from(pin[2], 'hex').toString('base64')}`
    : undefined;
  if (environment) {
    const graph = registryGraph(environment);
    const importer = (environment.importers as Record<string, unknown>)['.'];
    if (
      !isObject(importer) ||
      Object.keys(environment.importers as object).join(',') !== '.' ||
      Object.keys(importer).some(
        (key) => !['configDependencies', 'packageManagerDependencies'].includes(key),
      ) ||
      !isObject(importer.configDependencies ?? {}) ||
      Object.keys((importer.configDependencies ?? {}) as object).length
    )
      throw new PipelineInputError(
        'pnpm configuration dependencies require a custom validation image.',
      );
    const managers = importer.packageManagerDependencies;
    const manager = isObject(managers) ? managers.pnpm : undefined;
    if (
      !isObject(managers) ||
      Object.keys(managers).join(',') !== 'pnpm' ||
      !isObject(manager) ||
      manager.specifier !== pin[1] ||
      manager.version !== pin[1]
    )
      throw new PipelineInputError(
        'pnpm environment lockfile must record the exact declared package manager.',
      );
    graph.reference('pnpm', pin[1]);
    const record = graph.packages[`pnpm@${pin[1]}`] as Record<string, unknown>;
    const integrity = (record.resolution as Record<string, unknown>).integrity as string;
    if (managerIntegrity && managerIntegrity !== integrity)
      throw new PipelineInputError('pnpm manager checksum differs between manifest and lockfile.');
    managerIntegrity = integrity;
  }
  if (!isObject(lock.importers)) throw new PipelineInputError('Missing pnpm importers.');
  if (
    JSON.stringify(Object.keys(lock.importers).sort()) !==
    JSON.stringify([...manifests.keys()].sort())
  )
    throw new PipelineInputError(
      'pnpm lockfile importers must exactly match committed root and workspace manifests.',
    );
  const workspaceLinks: Record<string, string> = {};
  for (const [directory, value] of manifests) {
    if (
      ['dependenciesMeta', 'devEngines', 'bundledDependencies', 'bundleDependencies'].some(
        (key) => value[key] !== undefined,
      )
    )
      throw new PipelineInputError(
        'Injected, runtime-managed or bundled pnpm dependencies require a custom image.',
      );
    const importer: unknown = lock.importers[directory];
    if (!isObject(importer)) throw new PipelineInputError('Missing pnpm importer.');
    if (Object.keys(importer).some((key) => !IMPORTER_SECTIONS.has(key)))
      throw new PipelineInputError(
        'pnpm configuration dependencies, injected metadata and unknown importer fields require a custom image.',
      );
    for (const section of DEPENDENCY_SECTIONS) {
      const declarations = value[section] ?? {};
      if (!isObject(declarations))
        throw new PipelineInputError(`pnpm ${section} must be an object.`);
      for (const [name, source] of Object.entries(declarations))
        if (
          !REGISTRY_PACKAGE_NAME.test(name) ||
          typeof source !== 'string' ||
          (!source.startsWith('workspace:') &&
            !source.startsWith('catalog:') &&
            !isRegistrySource(source))
        )
          throw new PipelineInputError(
            'pnpm declarations must use public registry, configured catalogs or explicit local workspaces.',
          );
      if (section === 'peerDependencies') continue;
      const recorded: unknown = importer[section] ?? {};
      if (
        !isObject(recorded) ||
        JSON.stringify(Object.keys(recorded).sort()) !==
          JSON.stringify(Object.keys(declarations).sort())
      )
        throw new PipelineInputError('pnpm importer declarations differ from committed manifests.');
      for (const [name, source] of Object.entries(declarations)) {
        const specifier = source as string;
        const record: unknown = recorded[name];
        if (
          !isObject(record) ||
          record.specifier !== specifier ||
          typeof record.version !== 'string'
        )
          throw new PipelineInputError('pnpm importer specifiers differ from committed manifests.');
        if (specifier.startsWith('workspace:')) {
          const target = names.get(name);
          if (
            !target ||
            !/^workspace:(?:\*|\^|~)$/.test(specifier) ||
            !record.version.startsWith('link:') ||
            posix.normalize(posix.join(directory, record.version.slice('link:'.length))) !== target
          )
            throw new PipelineInputError(
              'pnpm workspace dependencies must link explicitly to a selected named workspace.',
            );
          workspaceLinks[posix.join(directory, 'node_modules', name)] = target;
        } else {
          if (specifier.startsWith('catalog:')) {
            const group = specifier.slice('catalog:'.length) || 'default';
            const versions = isObject(lock.catalogs) ? lock.catalogs[group] : undefined;
            const catalog = isObject(versions) ? versions[name] : undefined;
            if (
              !catalogs[group]?.[name] ||
              !isObject(catalog) ||
              catalog.specifier !== catalogs[group][name] ||
              catalog.version !== record.version.split('(')[0]
            )
              throw new PipelineInputError(
                'pnpm catalog requirements differ from recorded lockfile resolutions.',
              );
          }
          reference(name, record.version);
        }
      }
    }
  }
  return {
    manager: 'pnpm' as const,
    managerVersion: pin[1],
    ...(managerIntegrity ? { managerIntegrity } : {}),
    packageHash: digest(packageContent),
    lockHash: digest(lockContent),
    packages: Object.keys(packages).length,
    ...(workspaceContent !== undefined ? { workspaceConfigHash: digest(workspaceContent) } : {}),
    ...(directories.length
      ? {
          workspaceHashes: Object.fromEntries(
            directories.map((directory) => [directory, digest(workspaceContents.get(directory)!)]),
          ),
          workspaceLinks,
          workspaceOptionalLinks: Object.fromEntries(
            [...names].map(([name, directory]) => [
              `node_modules/.pnpm/node_modules/${name}`,
              directory,
            ]),
          ),
        }
      : {}),
  };
}

function registryGraph(document: Record<string, unknown>) {
  if (Object.keys(document).some((key) => !LOCK_KEYS.has(key)))
    throw new PipelineInputError(
      'Unsupported pnpm lockfile settings, patches or graph metadata require a custom image.',
    );
  if (document.settings !== undefined) {
    if (!isObject(document.settings))
      throw new PipelineInputError('pnpm lockfile settings must be an object.');
    configuration(document.settings);
  }
  if (
    ![9, '9.0', '6.0'].includes(document.lockfileVersion as string | number) ||
    !isObject(document.importers) ||
    !isObject(document.packages ?? {}) ||
    !isObject(document.snapshots ?? {}) ||
    Object.keys((document.packages ?? {}) as object).length > MAX_PACKAGES
  )
    throw new PipelineInputError(
      'Automatic pnpm preparation requires lockfile v6 or v9 with at most 20,000 registry package records.',
    );
  const packages = (document.packages ?? {}) as Record<string, unknown>;
  const snapshots = (document.snapshots ?? {}) as Record<string, unknown>;
  const reference = (name: string, version: unknown) => {
    if (typeof version !== 'string')
      throw new PipelineInputError('pnpm package resolutions must be exact strings.');
    const base = version.split('(')[0];
    const key = EXACT_PACKAGE_VERSION.test(base) ? `${name}@${base}` : base;
    const split = key.lastIndexOf('@');
    if (
      !REGISTRY_PACKAGE_NAME.test(key.slice(0, split)) ||
      !EXACT_PACKAGE_VERSION.test(key.slice(split + 1)) ||
      !Object.hasOwn(packages, key) ||
      !Object.hasOwn(snapshots, `${key}${version.slice(base.length)}`)
    )
      throw new PipelineInputError(
        'pnpm dependencies must resolve to recorded registry packages and peer-qualified snapshots.',
      );
  };
  for (const [key, value] of Object.entries(packages)) {
    const split = key.lastIndexOf('@');
    if (
      !REGISTRY_PACKAGE_NAME.test(key.slice(0, split)) ||
      !EXACT_PACKAGE_VERSION.test(key.slice(split + 1)) ||
      !isObject(value) ||
      !isObject(value.resolution) ||
      !hasStrongIntegrity(value.resolution.integrity) ||
      Object.keys(value.resolution).some((key) => !['integrity', 'tarball'].includes(key))
    )
      throw new PipelineInputError(
        'Every pnpm package needs a registry name/version and SHA-256-or-stronger integrity; local, Git, patched and URL sources require a custom image.',
      );
    if (value.resolution.tarball !== undefined) {
      if (typeof value.resolution.tarball !== 'string')
        throw new PipelineInputError('pnpm tarball must be a public registry URL.');
      assertRegistryTarball(value.resolution.tarball);
    }
  }
  for (const [key, value] of Object.entries(snapshots)) {
    const base = key.split('(')[0];
    if (!Object.hasOwn(packages, base) || !isObject(value) || value.patched === true)
      throw new PipelineInputError('Unsupported pnpm snapshot or patched dependency.');
    for (const section of ['dependencies', 'optionalDependencies']) {
      const dependencies = value[section];
      if (dependencies === undefined) continue;
      if (!isObject(dependencies))
        throw new PipelineInputError('pnpm snapshot dependencies must be objects.');
      for (const [name, version] of Object.entries(dependencies)) reference(name, version);
    }
  }

  return { packages, reference };
}
