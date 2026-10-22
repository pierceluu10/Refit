import { isObject, parseObject, digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { posix } from 'node:path';

export const MAX_PACKAGE_BYTES = 512 * 1024;
export const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACES = 64;
export const NPM_PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
// npm refuses capital letters in new names, but packages published before that rule keep theirs
// (JSONStream is in 7 of 126 benchmark pnpm lockfiles), so registry dependencies may use them.
export const REGISTRY_PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
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

export function isRegistrySource(source: unknown): source is string {
  return (
    typeof source === 'string' &&
    Boolean(source.trim()) &&
    !NON_REGISTRY_SOURCE.test(source) &&
    (!source.includes(':') ||
      (source.startsWith('npm:') && !source.slice('npm:'.length).includes(':')))
  );
}

// A published package's own declarations reach the lockfile as its record's dependencies. npm reads
// an empty range there as "*" (@tabler/icons-react 3.36.1 declares "@tabler/icons": ""), and the
// lockfile still pins what it installs.
function dependencySources(value: Record<string, unknown>, file: string, published = false) {
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = value[section];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) throw new PipelineInputError(`npm ${section} must be an object.`);
    for (const [name, source] of Object.entries(dependencies))
      if (!(published && source === '') && !isRegistrySource(source))
        throw new PipelineInputError(
          `Automatic preparation supports public npm registry dependencies only; ${file} declares ${name} as ${JSON.stringify(source)}. Local, Git and URL dependencies require a custom image.`,
        );
  }
}

export function npmWorkspaceDirectories(manifest: Record<string, unknown>, paths: string[]) {
  if (manifest.workspaces === undefined) return [];
  // npm reads Yarn's `{ "packages": [...] }` form the same way (@npmcli/map-workspaces).
  const declared = manifest.workspaces;
  const patterns =
    isObject(declared) && Object.keys(declared).join() === 'packages'
      ? declared.packages
      : declared;
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
      'npm workspaces require at most 64 positive relative path/glob patterns. Negations, escaping paths and object declarations other than { packages } require a custom image.',
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
  dependencySources(manifest, 'package.json');
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
      `Automatic preparation requires a root npm lockfile version 2 or 3 with at most 20,000 package records. ${
        !(lock.lockfileVersion === 2 || lock.lockfileVersion === 3)
          ? `It is lockfile version ${JSON.stringify(lock.lockfileVersion)}; npm 7 or later writes version 2 or 3.`
          : !isObject(lock.packages) || !isObject(lock.packages[''])
            ? 'It has no package record for the root project; regenerate it with npm install.'
            : `It records ${Object.keys(lock.packages).length} packages.`
      }`,
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
      dependencySources(value, `${directory}/package.json`);
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
      if (normalize(value[section]) !== normalize(record[section])) {
        const declared = isObject(value[section]) ? value[section] : {};
        const recorded = isObject(record[section]) ? record[section] : {};
        const name = [...new Set([...Object.keys(declared), ...Object.keys(recorded)])].find(
          (name) => declared[name] !== recorded[name],
        );
        throw new PipelineInputError(
          `${file} ${section} differ from the committed package-lock.json${name ? `: ${name} is ${JSON.stringify(declared[name]) ?? 'missing'} in ${file} but ${JSON.stringify(recorded[name]) ?? 'missing'} in the lockfile` : ''}. Run npm install and commit the updated package-lock.json.`,
        );
      }
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
    dependencySources(
      record,
      path ? `package-lock.json record ${path}` : 'package-lock.json',
      path.startsWith('node_modules/') || path.includes('/node_modules/'),
    );
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
    if (!dependencyPath || record.link)
      throw new PipelineInputError(
        'Every npm package requires a registry URL, version and SHA-256-or-stronger integrity; links and bundled records require a custom image.',
      );
    const verified = (value: Record<string, unknown>) =>
      typeof value.version === 'string' &&
      Boolean(value.version.trim()) &&
      typeof value.resolved === 'string' &&
      hasStrongIntegrity(value.integrity);
    // A bundled package ships inside its nearest non-bundled ancestor's tarball, which npm checks
    // against that ancestor's integrity; it has no source of its own. It is accepted only with a
    // version, no source fields, and a verified registry ancestor.
    const bundled = (path: string, value: Record<string, unknown>) => {
      if (
        value.inBundle !== true ||
        typeof value.version !== 'string' ||
        !value.version.trim() ||
        'resolved' in value ||
        'integrity' in value
      )
        return false;
      let parent = path;
      while (parent.lastIndexOf('/node_modules/') > 0) {
        parent = parent.slice(0, parent.lastIndexOf('/node_modules/'));
        const ancestor = (lock.packages as Record<string, unknown>)[parent];
        if (!isObject(ancestor) || ancestor.link) return false;
        if (ancestor.inBundle === true) continue;
        if (!verified(ancestor)) return false;
        try {
          assertRegistryTarball(ancestor.resolved as string, undefined, true);
        } catch {
          return false;
        }
        return true;
      }
      return false;
    };
    if (bundled(path, record)) continue;
    const unverified = (other: string, value: unknown) =>
      isObject(value) && !value.link && !verified(value) && !bundled(other, value);
    if (unverified(path, record)) {
      const others =
        Object.entries(lock.packages).filter(
          ([other, value]) => other && !workspaces.has(other) && unverified(other, value),
        ).length - 1;
      throw new PipelineInputError(
        `package-lock.json records ${path}${others ? ` and ${others} more packages` : ''} without a version, registry "resolved" URL and SHA-256-or-stronger "integrity", so Refit cannot verify what it would install. Reinstall against registry.npmjs.org so npm records them (delete node_modules and run npm install; if entries stay incomplete, regenerate package-lock.json) and commit the lockfile.`,
      );
    }
    assertRegistryTarball(record.resolved as string, path, true);
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

// Public mirrors of the npm registry that serve its tarballs at the same paths. npm installs with
// --replace-registry-host=always, so it fetches every one from registry.npmjs.org and checks the
// lockfile's integrity; the mirror recorded in the lockfile is never contacted.
const NPM_REGISTRY_MIRRORS = new Set(['registry.npmmirror.com', 'registry.yarnpkg.com']);

export function assertRegistryTarball(source: string, path?: string, mirrors = false) {
  let url;
  try {
    url = new URL(source);
  } catch (cause) {
    throw new PipelineInputError('Package registry URL is invalid.', { cause });
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'registry.npmjs.org' &&
      !(mirrors && NPM_REGISTRY_MIRRORS.has(url.hostname))) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('.tgz')
  )
    throw new PipelineInputError(
      `Package tarballs must use public registry.npmjs.org HTTPS URLs without credentials or parameters${path ? `; package-lock.json resolves ${path} from ${url.host}` : ''}.`,
    );
}
