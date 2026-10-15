import { isObject, parseObject, digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { posix } from 'node:path';

export const MAX_PACKAGE_BYTES = 512 * 1024;
export const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACES = 64;
export const NPM_PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
export const EXACT_PACKAGE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const MAX_PACKAGES = 20_000;
export const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const NON_REGISTRY_SOURCE =
  /^(?:file:|link:|workspace:|git(?:\+|:)|https?:|ssh:|github:|gitlab:|bitbucket:|\/|\.\.?\/)|^[^@\s]+\/[^@\s]+$/;
const INTEGRITY =
  /^(?:sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})(?:\s+sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})*$/;
const INTEGRITY_LENGTHS = new Map([
  ['sha256', 32],
  ['sha384', 48],
  ['sha512', 64],
]);

export function hasStrongIntegrity(value: unknown): value is string {
  if (typeof value !== 'string' || !INTEGRITY.test(value)) return false;
  return value.split(/\s+/).every((entry) => {
    const [algorithm, encoded] = entry.split('-', 2);
    const bytes = Buffer.from(encoded, 'base64');
    return (
      bytes.byteLength === INTEGRITY_LENGTHS.get(algorithm) && bytes.toString('base64') === encoded
    );
  });
}

function dependencySources(value: Record<string, unknown>) {
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = value[section];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) throw new PipelineInputError(`npm ${section} must be an object.`);
    for (const source of Object.values(dependencies))
      if (typeof source !== 'string' || !source.trim() || NON_REGISTRY_SOURCE.test(source))
        throw new PipelineInputError(
          'Automatic preparation supports public npm registry dependencies only; local, Git and URL dependencies require a custom image.',
        );
  }
}

export function npmWorkspaceDirectories(manifest: Record<string, unknown>, paths: string[]) {
  if (manifest.workspaces === undefined) return [];
  const patterns = manifest.workspaces;
  if (
    !Array.isArray(patterns) ||
    patterns.length > MAX_WORKSPACES ||
    patterns.some(
      (pattern) =>
        typeof pattern !== 'string' ||
        !pattern ||
        pattern.startsWith('!') ||
        pattern.startsWith('/') ||
        /[\\\u0000-\u001f\u007f]/.test(pattern) ||
        pattern.split('/').includes('..'),
    )
  )
    throw new PipelineInputError(
      'npm workspaces require at most 64 positive relative path/glob patterns. Negations, escaping paths and object declarations require a custom image.',
    );
  const directories = paths
    .filter((path) => path.endsWith('/package.json'))
    .map(posix.dirname)
    .filter(
      (directory) =>
        !directory.split('/').includes('node_modules') &&
        patterns.some((pattern) =>
          posix.matchesGlob(directory, pattern.replace(/^(\.\/)+/, '').replace(/\/+$/, '')),
        ),
    )
    .sort();
  if (directories.length > MAX_WORKSPACES)
    throw new PipelineInputError(
      'Automatic preparation supports at most 64 committed npm workspace packages.',
    );
  for (const directory of directories)
    if (
      /[\\\u0000-\u001f\u007f]/.test(directory) ||
      directory
        .split('/')
        .some((part) => !part || part === '..' || part === '.' || part.startsWith('-'))
    )
      throw new PipelineInputError('Workspace directories must be safe relative repository paths.');
  return directories;
}

export function validateNpmLock(
  packageContent: string,
  lockContent: string,
  workspaceContents: ReadonlyMap<string, string> = new Map(),
) {
  if (
    Buffer.byteLength(packageContent) > MAX_PACKAGE_BYTES ||
    Buffer.byteLength(lockContent) > MAX_LOCK_BYTES
  )
    throw new PipelineInputError(
      'npm preparation inputs exceed the 512 KiB manifest or 8 MiB lockfile limit.',
    );
  const manifest = parseObject(packageContent, 'package.json');
  const lock = parseObject(lockContent, 'package-lock.json');
  if (manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined)
    throw new PipelineInputError('Root bundled dependencies require a custom validation image.');
  dependencySources(manifest);
  if (manifest.overrides !== undefined) {
    if (!isObject(manifest.overrides))
      throw new PipelineInputError('npm overrides must be an object.');
    const values: unknown[] = Object.values(manifest.overrides);
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      if (isObject(value)) values.push(...Object.values(value));
      else if (typeof value !== 'string' || NON_REGISTRY_SOURCE.test(value))
        throw new PipelineInputError('npm overrides must resolve through the public registry.');
    }
  }
  if (
    !(lock.lockfileVersion === 2 || lock.lockfileVersion === 3) ||
    !isObject(lock.packages) ||
    !isObject(lock.packages['']) ||
    Object.keys(lock.packages).length > MAX_PACKAGES
  )
    throw new PipelineInputError(
      'Automatic preparation requires a root npm lockfile version 2 or 3 with at most 20,000 package records.',
    );
  const directories = npmWorkspaceDirectories(
    manifest,
    [...workspaceContents.keys()].map((directory) => `${directory}/package.json`),
  );
  if (
    directories.length !== workspaceContents.size ||
    JSON.stringify(manifest.workspaces) !== JSON.stringify(lock.packages[''].workspaces)
  )
    throw new PipelineInputError(
      'Workspaces must match the committed root lockfile and selected workspace manifests.',
    );
  const workspaces = new Map(
    directories.map((directory) => {
      const content = workspaceContents.get(directory)!;
      if (Buffer.byteLength(content) > MAX_PACKAGE_BYTES)
        throw new PipelineInputError(`Workspace manifest ${directory} exceeds 512 KiB.`);
      const value = parseObject(content, `${directory}/package.json`);
      if (
        typeof value.name !== 'string' ||
        !NPM_PACKAGE_NAME.test(value.name) ||
        value.name.startsWith('.') ||
        value.bin !== undefined ||
        value.workspaces !== undefined ||
        value.bundledDependencies !== undefined ||
        value.bundleDependencies !== undefined
      )
        throw new PipelineInputError(
          'Each workspace requires an explicit npm name; workspace bins, nested workspace declarations and bundled dependencies require a custom image.',
        );
      dependencySources(value);
      return [directory, value] as const;
    }),
  );
  if (new Set([...workspaces.values()].map((value) => value.name)).size !== workspaces.size)
    throw new PipelineInputError('npm workspace names must be unique.');
  function matchingDeclarations(value: Record<string, unknown>, record: unknown, file: string) {
    if (!isObject(record))
      throw new PipelineInputError(
        'Each npm workspace must have a committed lockfile package record.',
      );
    for (const section of DEPENDENCY_SECTIONS) {
      const normalize = (value: unknown) =>
        JSON.stringify(
          Object.entries(isObject(value) ? value : {}).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        );
      if (normalize(value[section]) !== normalize(record[section]))
        throw new PipelineInputError(
          `${file} dependency requirements differ from the committed root lockfile. Update and commit the lockfile before preparation.`,
        );
    }
  }
  matchingDeclarations(manifest, lock.packages[''], 'package.json');
  for (const [directory, value] of workspaces) {
    const record = lock.packages[directory];
    matchingDeclarations(value, record, `${directory}/package.json`);
    if (
      !isObject(record) ||
      record.link ||
      record.version !== value.version ||
      (record.name !== undefined && record.name !== value.name)
    )
      throw new PipelineInputError(
        'Workspace names and versions must match their committed lockfile records.',
      );
  }
  const workspaceLinks: Record<string, string> = {};
  for (const [path, record] of Object.entries(lock.packages)) {
    if (!isObject(record))
      throw new PipelineInputError('npm lockfile package records must be objects.');
    dependencySources(record);
    if (!path) continue;
    if (workspaces.has(path)) continue;
    const dependencyPath =
      (path.startsWith('node_modules/') ||
        directories.some((directory) => path.startsWith(`${directory}/node_modules/`))) &&
      !path.split('/').some((part) => !part || part === '..' || part === '.') &&
      !/[\\\u0000-\u001f\u007f]/.test(path);
    if (record.link === true) {
      const target = typeof record.resolved === 'string' && workspaces.get(record.resolved);
      if (
        !dependencyPath ||
        !target ||
        !(path === `node_modules/${target.name}` || path.endsWith(`/node_modules/${target.name}`))
      )
        throw new PipelineInputError(
          'npm links may only target a declared committed workspace under its exact package name.',
        );
      workspaceLinks[path] = record.resolved as string;
      continue;
    }
    if (
      !dependencyPath ||
      record.link ||
      typeof record.version !== 'string' ||
      !record.version.trim() ||
      typeof record.resolved !== 'string' ||
      !hasStrongIntegrity(record.integrity)
    )
      throw new PipelineInputError(
        'Every npm package requires a registry URL, version and SHA-256-or-stronger integrity; links and bundled records require a custom image.',
      );
    let url;
    try {
      url = new URL(record.resolved);
    } catch (cause) {
      throw new PipelineInputError('npm package registry URL is invalid.', { cause });
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'registry.npmjs.org' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('.tgz')
    )
      throw new PipelineInputError(
        'npm package tarballs must use public registry.npmjs.org HTTPS URLs without credentials or parameters.',
      );
  }
  return {
    packageHash: digest(packageContent),
    lockHash: digest(lockContent),
    packages: Object.keys(lock.packages).length - 1,
    ...(workspaces.size
      ? {
          workspaceHashes: Object.fromEntries(
            directories.map((directory) => [directory, digest(workspaceContents.get(directory)!)]),
          ),
          workspaceLinks,
        }
      : {}),
  };
}
