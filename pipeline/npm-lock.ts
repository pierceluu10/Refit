import { isObject, parseObject, digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const MAX_PACKAGE_BYTES = 512 * 1024;
const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGES = 20_000;
const DEPENDENCY_SECTIONS = [
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

function hasStrongIntegrity(value: unknown): value is string {
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

export function validateNpmLock(packageContent: string, lockContent: string) {
  if (
    Buffer.byteLength(packageContent) > MAX_PACKAGE_BYTES ||
    Buffer.byteLength(lockContent) > MAX_LOCK_BYTES
  )
    throw new PipelineInputError(
      'npm preparation inputs exceed the 512 KiB manifest or 8 MiB lockfile limit.',
    );
  const manifest = parseObject(packageContent, 'package.json');
  const lock = parseObject(lockContent, 'package-lock.json');
  if (
    manifest.workspaces !== undefined ||
    manifest.bundledDependencies !== undefined ||
    manifest.bundleDependencies !== undefined
  )
    throw new PipelineInputError(
      'Workspaces and root bundled dependencies require a custom validation image.',
    );
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
  for (const section of DEPENDENCY_SECTIONS) {
    const normalize = (value: unknown) =>
      JSON.stringify(
        Object.entries(isObject(value) ? value : {}).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    if (normalize(manifest[section]) !== normalize(lock.packages[''][section]))
      throw new PipelineInputError(
        'package.json dependency requirements differ from the committed root lockfile. Update and commit the lockfile before preparation.',
      );
  }
  for (const [path, record] of Object.entries(lock.packages)) {
    if (!isObject(record))
      throw new PipelineInputError('npm lockfile package records must be objects.');
    dependencySources(record);
    if (!path) continue;
    if (
      !path.startsWith('node_modules/') ||
      path.split('/').some((part) => part === '..' || part === '.') ||
      path.includes('\\') ||
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
  };
}
