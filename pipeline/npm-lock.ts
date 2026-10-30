import { isObject, parseObject, digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { satisfiesNpmRange } from './validation-runtime.ts';
import { posix } from 'node:path';

export const MAX_PACKAGE_BYTES = 512 * 1024;
export const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACES = 64;
export const NPM_PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
// Quotes a declared source for a refusal; a URL's credentials never reach a message or a draft.
export const quotedSource = (source: unknown) =>
  JSON.stringify(source)?.replace(/(\/\/)[^/@\s"]*@/g, '$1***@');

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
  /^(?:sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})(?:\s+sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})*$/;
const INTEGRITY_LENGTHS = new Map([
  ['sha1', 20],
  ['sha256', 32],
  ['sha384', 48],
  ['sha512', 64],
]);

// npm, pnpm and Yarn 1 check a tarball against only the strongest algorithm its integrity lists
// (ssri's pickAlgorithm), so a sha1 hash beside a SHA-256-or-stronger one is never what is checked.
export function hasStrongIntegrity(value: unknown): value is string {
  if (typeof value !== 'string' || !INTEGRITY.test(value)) return false;
  const entries = value.split(/\s+/).map((entry) => entry.split('-', 2));
  return (
    entries.some(([algorithm]) => algorithm !== 'sha1') &&
    entries.every(([algorithm, encoded]) => {
      const bytes = Buffer.from(encoded, 'base64');
      return (
        bytes.byteLength === INTEGRITY_LENGTHS.get(algorithm) &&
        bytes.toString('base64') === encoded
      );
    })
  );
}

// Release archives of public code hosts, which npm records with the integrity of the bytes it
// downloaded. With a SHA-256-or-stronger integrity they are as verifiable as a registry tarball:
// npm ci refuses any other bytes. Only these hosts are fetched, never an arbitrary or private one.
const CODE_HOST_ARCHIVES: Record<string, RegExp> = {
  'github.com': /^\/[\w.-]+\/[\w.-]+\/archive\/[\w./-]+\.(?:tar\.gz|tgz)$/,
  'codeload.github.com': /^\/[\w.-]+\/[\w.-]+\/tar\.gz\/[\w./-]+$/,
  'gitlab.com': /^\/[\w.-]+(?:\/[\w.-]+)+\/-\/archive\/[\w./-]+\.(?:tar\.gz|tgz)$/,
};

export function codeHostTarball(source: unknown): source is string {
  if (typeof source !== 'string') return false;
  let url;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  return (
    // Only a URL written as npm will request it: no dot segments or other normalisation.
    url.href === source &&
    url.protocol === 'https:' &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    Boolean(CODE_HOST_ARCHIVES[url.hostname]?.test(url.pathname))
  );
}

// Names the repository and commit a Git source installs, for a refusal: Refit's install sandbox
// has no git, and a Git checkout carries no SHA-256-or-stronger integrity of its own.
export function gitSource(source: unknown) {
  if (typeof source !== 'string') return undefined;
  const at = (ref: string | undefined) =>
    !ref ? '' : /^[a-f0-9]{40}$/.test(ref) ? ` at commit ${ref.slice(0, 7)}` : ` at ${ref}`;
  const url =
    /^git(?:\+(?:ssh|https?))?:\/\/(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?(?:#(.*))?$/.exec(source);
  if (url) return `${url[1]}/${url[2]}${at(url[3])}`;
  const shortcut = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#(.*))?$/.exec(
    source,
  );
  if (shortcut && (shortcut[1] || !source.includes(':')) && !/^[@./]/.test(source))
    return `${shortcut[1] === 'gitlab' ? 'gitlab.com' : shortcut[1] === 'bitbucket' ? 'bitbucket.org' : 'github.com'}/${shortcut[2]}${at(shortcut[3])}`;
  // pnpm keys and tarballs for a commit: github.com/o/r/<sha>, codeload.github.com/o/r/tar.gz/<sha>.
  const commit =
    /^(?:https:\/\/codeload\.)?github\.com\/([\w.-]+\/[\w.-]+)\/(?:tar\.gz\/)?([a-f0-9]{40})$/.exec(
      source,
    );
  if (commit) return `github.com/${commit[1]}${at(commit[2])}`;
  return undefined;
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
export function dependencySources(value: Record<string, unknown>, file: string, published = false) {
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = value[section];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) throw new PipelineInputError(`npm ${section} must be an object.`);
    for (const [name, source] of Object.entries(dependencies)) {
      if ((published && source === '') || isRegistrySource(source) || codeHostTarball(source))
        continue;
      const git = gitSource(source);
      throw new PipelineInputError(
        git
          ? `Automatic preparation supports public npm registry dependencies only; ${file} declares ${name} from Git (${git}), which Refit's own preparation does not fetch: its install sandbox has no git, and a Git checkout has no SHA-256-or-stronger integrity to verify. Local, Git and URL dependencies need the repository install.`
          : `Automatic preparation supports public npm registry dependencies only; ${file} declares ${name} as ${quotedSource(source)}. Local, Git and URL dependencies need the repository install.`,
      );
    }
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
  // npm (@npmcli/map-workspaces) and pnpm (pnpm-workspace.yaml) exclude what a `!pattern` matches.
  // npm lets a later positive pattern re-include it and pnpm does not, so negations are read only
  // after every positive pattern, where both select the same directories.
  const first = Array.isArray(patterns)
    ? patterns.findIndex((pattern) => String(pattern).startsWith('!'))
    : -1;
  const negations = first < 0 ? [] : (patterns as string[]).slice(first);
  if (
    !Array.isArray(patterns) ||
    patterns.length > MAX_WORKSPACES ||
    negations.some((pattern) => !/^![^!]/.test(String(pattern))) ||
    patterns.some(
      (pattern) =>
        typeof pattern !== 'string' ||
        !pattern ||
        pattern.replace(/^!/, '').startsWith('/') ||
        /[\\\u0000-\u001f\u007f]/.test(pattern) ||
        pattern.replace(/^!/, '').split('/').includes('..'),
    )
  )
    throw new PipelineInputError(
      'npm workspaces require at most 64 relative path/glob patterns, with any negations after every positive one. Escaping paths and object declarations other than { packages } need the repository install.',
    );
  const glob = (directory: string, pattern: string) =>
    posix.matchesGlob(directory, pattern.replace(/^(\.\/)+/, '').replace(/\/+$/, ''));
  const positive = patterns.slice(0, patterns.length - negations.length);
  const directories = paths
    .filter((path) => path.endsWith('/package.json'))
    .map(posix.dirname)
    .filter(
      (directory) =>
        !directory.split('/').includes('node_modules') &&
        positive.some((pattern) => glob(directory, pattern)) &&
        !negations.some((pattern) => glob(directory, pattern.slice(1))),
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
    throw new PipelineInputError('Root bundled dependencies need the repository install.');
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
          'Each workspace requires an explicit npm name; workspace bins, nested workspace declarations and bundled dependencies need the repository install.',
        );
      dependencySources(value, `${directory}/package.json`);
      return [directory, value] as const;
    }),
  );
  if (new Set([...workspaces.values()].map((value) => value.name)).size !== workspaces.size)
    throw new PipelineInputError('npm workspace names must be unique.');
  // The version npm resolves for an importer's dependency: the nearest node_modules entry upward.
  function lockedVersion(importer: string, name: string) {
    let search = importer;
    for (;;) {
      const path = posix.join(search, 'node_modules', name);
      const entry = (lock.packages as Record<string, unknown>)[path];
      if (entry !== undefined)
        return isObject(entry) && !entry.link && (entry.name ?? name) === name
          ? entry.version
          : undefined;
      if (!search) return undefined;
      const parent = posix.dirname(search);
      search = parent === '.' ? '' : parent;
    }
  }
  // npm ci keeps every locked version that satisfies its declared range and prunes what no manifest
  // declares any more (npm 10.9: lib/utils/validate-lockfile.js, arborist dep-valid.js), so only a
  // declaration the lockfile cannot satisfy is drift; the committed lockfile installs unchanged.
  function matchingDeclarations(
    value: Record<string, unknown>,
    record: unknown,
    file: string,
    importer: string,
  ) {
    if (!isObject(record))
      throw new PipelineInputError(
        'Each npm workspace must have a committed lockfile package record.',
      );
    for (const section of DEPENDENCY_SECTIONS) {
      const declared = isObject(value[section]) ? value[section] : {};
      const recorded = isObject(record[section]) ? record[section] : {};
      // A declaration equal to its record is in sync, as before.
      const drifted = (name: string) => {
        if (declared[name] === recorded[name]) return false;
        const version = lockedVersion(importer, name);
        return !(typeof version === 'string' && satisfiesNpmRange(version, String(declared[name])));
      };
      const name = Object.keys(declared).find(drifted);
      if (name !== undefined)
        throw new PipelineInputError(
          `${file} ${section} differ from the committed package-lock.json: ${name} is ${quotedSource(declared[name])} in ${file} but ${quotedSource(recorded[name]) ?? 'missing'} in the lockfile. Run npm install and commit the updated package-lock.json.`,
        );
    }
  }
  matchingDeclarations(manifest, lock.packages[''], 'package.json', '');
  for (const [directory, value] of workspaces) {
    const record = lock.packages[directory];
    matchingDeclarations(value, record, `${directory}/package.json`, directory);
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
  const remoteTarballs: string[] = [];
  let mirrored = false;
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
    // A record outside every node_modules directory describes a project directory, which npm never
    // fetches (Arborist's diff.js does not diff fsChildren); an extraneous one with no source is a
    // leftover npm ci leaves alone.
    if (
      !path.split('/').includes('node_modules') &&
      record.extraneous === true &&
      !['link', 'resolved', 'integrity'].some((key) => key in record)
    )
      continue;
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
        'Every npm package requires a registry URL, version and SHA-256-or-stronger integrity; links and bundled records need the repository install.',
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
    if (codeHostTarball(record.resolved)) {
      remoteTarballs.push(path);
      continue;
    }
    assertRegistryTarball(record.resolved as string, path, true);
    mirrored ||= new URL(record.resolved as string).hostname !== 'registry.npmjs.org';
  }
  // npm fetches a mirror-resolved record from registry.npmjs.org only by replacing every host,
  // which would also send a code host's archive to the registry.
  if (remoteTarballs.length && mirrored)
    throw new PipelineInputError(
      `package-lock.json resolves ${remoteTarballs[0]} from a code host and other packages from a registry mirror; Refit fetches registry packages only from registry.npmjs.org, which npm cannot do while it also downloads a code host's archive. Reinstall against registry.npmjs.org and commit the lockfile.`,
    );
  return {
    packageHash: digest(packageContent),
    lockHash: digest(lockContent),
    packages: Object.keys(lock.packages).length - 1,
    ...(remoteTarballs.length ? { remoteTarballs: remoteTarballs.length } : {}),
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
  const git = gitSource(source);
  if (git)
    throw new PipelineInputError(
      `Package tarballs must use public registry.npmjs.org HTTPS URLs without credentials or parameters${path ? `; package-lock.json installs ${path} from Git (${git})` : `; a dependency comes from Git (${git})`}, which Refit's own preparation does not fetch: its install sandbox has no git, and a Git checkout has no SHA-256-or-stronger integrity to verify.`,
    );
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
