import { createHash } from 'node:crypto';
import { digest, isObject, parseDocumentObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import {
  EXACT_PACKAGE_VERSION,
  hasStrongIntegrity,
  MAX_LOCK_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGES,
  NPM_PACKAGE_NAME,
  REGISTRY_PACKAGE_NAME,
} from './npm-lock.ts';
import {
  CLASSIC_HEADER,
  LOCAL_OR_ALIASED,
  parseClassic,
  REGISTRY_TARBALL,
  YARN_LOCKFILE,
  type YarnEntry,
} from './yarn-lock.ts';

// Used when package.json does not pin Yarn 1; it is the final Yarn 1 release.
export const DEFAULT_YARN_VERSION = '1.22.22';
// Only a sha512 Corepack checksum can be compared with registry integrity; a weaker one is ignored,
// so that pin installs like an unhashed one, still verified by npm against the registry.
const MANAGER_PIN =
  /^yarn@(1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+(?:sha512\.([a-f0-9]{128})|sha1\.[a-f0-9]{40}|sha224\.[a-f0-9]{56}|sha256\.[a-f0-9]{64}|sha384\.[a-f0-9]{96}))?$/;
const INSTALLED_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function registryTarball(source: string | undefined) {
  if (!source || !REGISTRY_TARBALL.test(source)) return false;
  const url = new URL(source);
  return (
    !url.port && !url.username && !url.password && !url.search && url.pathname.endsWith('.tgz')
  );
}

// Yarn 1 declares workspaces as an array or `{ packages }`; nohoist changes the layout.
export function yarnWorkspacePatterns(manifest: Record<string, unknown>) {
  const workspaces = manifest.workspaces;
  if (workspaces === undefined || Array.isArray(workspaces)) return workspaces;
  if (isObject(workspaces) && Object.keys(workspaces).join(',') === 'packages')
    return workspaces.packages;
  throw new PipelineInputError(
    'Yarn workspaces must be a pattern list or { packages }; nohoist requires a custom image.',
  );
}

export function validateYarnInputs(
  packageContent: string,
  lockContent: string,
  workspaceContents: ReadonlyMap<string, string> = new Map(),
) {
  if (
    Buffer.byteLength(packageContent) > MAX_PACKAGE_BYTES ||
    Buffer.byteLength(lockContent) > MAX_LOCK_BYTES ||
    [...workspaceContents.values()].some(
      (content) => Buffer.byteLength(content) > MAX_PACKAGE_BYTES,
    )
  )
    throw new PipelineInputError('Yarn preparation inputs exceed manifest or lockfile limits.');
  const manifest = parseObject(packageContent, 'package.json');
  yarnWorkspacePatterns(manifest);
  const workspaces = new Map<string, { directory: string; version: unknown }>();
  for (const [directory, content] of workspaceContents) {
    const value = parseObject(content, `${directory}/package.json`);
    if (
      typeof value.name !== 'string' ||
      !NPM_PACKAGE_NAME.test(value.name) ||
      workspaces.has(value.name) ||
      value.workspaces !== undefined
    )
      throw new PipelineInputError(
        'Yarn workspace packages need unique package names and no nested workspaces.',
      );
    workspaces.set(value.name, { directory, version: value.version });
  }
  const pin =
    manifest.packageManager === undefined
      ? undefined
      : typeof manifest.packageManager === 'string'
        ? MANAGER_PIN.exec(manifest.packageManager)
        : null;
  if (pin === null)
    throw new PipelineInputError(
      typeof manifest.packageManager === 'string' && BERRY_PIN.test(manifest.packageManager)
        ? `packageManager pins ${manifest.packageManager}, but ${YARN_LOCKFILE} is a Yarn 1 lockfile. Run yarn install with that release and commit the lockfile it writes.`
        : 'Yarn preparation supports an exact Yarn 1 packageManager pin, optionally with a Corepack checksum. Yarn 2+ requires a custom image.',
    );
  if (!CLASSIC_HEADER.test(lockContent))
    throw new PipelineInputError(
      'Automatic Yarn preparation supports Yarn 1 lockfiles only; Yarn 2+ requires a custom image.',
    );
  const { entries } = parseClassic(lockContent);
  const records = new Set(Object.values(entries));
  if (records.size > MAX_PACKAGES)
    throw new PipelineInputError(`Lockfile exceeds ${MAX_PACKAGES} package records.`);
  for (const record of records as Set<YarnEntry>)
    if (
      !record.version ||
      !EXACT_PACKAGE_VERSION.test(record.version) ||
      !registryTarball(record.resolved) ||
      !hasStrongIntegrity(record.integrity)
    )
      throw new PipelineInputError(
        'Every yarn.lock entry must resolve an exact version to a public registry tarball with SHA-256-or-stronger integrity.',
      );
  const manifests: [string, Record<string, unknown>][] = [
    ['package.json', manifest],
    ...[...workspaceContents].map(
      ([directory, content]) =>
        [`${directory}/package.json`, parseObject(content, directory)] as [
          string,
          Record<string, unknown>,
        ],
    ),
  ];
  for (const [file, value] of manifests)
    for (const section of INSTALLED_SECTIONS) {
      const dependencies = value[section];
      if (dependencies === undefined) continue;
      if (!isObject(dependencies))
        throw new PipelineInputError(`${file} ${section} must be an object.`);
      for (const [name, range] of Object.entries(dependencies)) {
        // Yarn 1 links a sibling workspace without a lock entry when its version satisfies the range.
        const sibling = workspaces.get(name);
        if (sibling && (range === '*' || range === sibling.version)) continue;
        if (
          typeof range !== 'string' ||
          LOCAL_OR_ALIASED.test(range) ||
          !Object.hasOwn(entries, `${name}@${range}`)
        )
          throw new PipelineInputError(
            `${name}@${String(range)} in ${file} is not a public registry dependency recorded in yarn.lock or an exact sibling workspace; regenerate the lockfile or use a custom image.`,
          );
      }
    }
  return {
    manager: 'yarn' as const,
    managerVersion: pin?.[1] ?? DEFAULT_YARN_VERSION,
    ...(pin?.[2]
      ? { managerIntegrity: `sha512-${Buffer.from(pin[2], 'hex').toString('base64')}` }
      : {}),
    packageHash: digest(packageContent),
    lockHash: digest(lockContent),
    packages: records.size,
    ...(workspaces.size
      ? {
          workspaceHashes: Object.fromEntries(
            [...workspaceContents].map(([directory, content]) => [directory, digest(content)]),
          ),
          workspaceLinks: Object.fromEntries(
            [...workspaces].map(([name, { directory }]) => [`node_modules/${name}`, directory]),
          ),
        }
      : {}),
  };
}

export const YARN_RC = '.yarnrc.yml';
const BERRY_PIN =
  /^yarn@([234]\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+(?:sha512\.([a-f0-9]{128})|sha1\.[a-f0-9]{40}|sha224\.[a-f0-9]{56}|sha256\.[a-f0-9]{64}|sha384\.[a-f0-9]{96}))?$/;
const BERRY_RC_KEYS = new Set(['nodeLinker', 'enableTelemetry', 'yarnPath']);
// `yarn set version` writes the release here; its name carries the version.
export const YARN_RELEASE = /^\.yarn\/releases\/[A-Za-z0-9._-]+\.c?js$/;
const RELEASE_VERSION = /^\.yarn\/releases\/yarn-([234]\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.c?js$/;
const YARN_1_PIN = /^yarn@(1\.\d+\.\d+)(?:\+|$)/;
const BERRY_CHECKSUM = /^(?:\d+[a-z]\d*\/)?[a-f0-9]{128}$/;
// Yarn's own compatibility patches ship in the verified Yarn bundle and wrap an npm package. Yarn 4
// writes them as `optional!builtin<…>`, Yarn 2 and 3 as `~builtin<…>`.
const BUILTIN_PATCH =
  /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@patch:\1@npm%3A([^#]+)#(?:optional!|~)builtin<compat\/[a-z0-9-]+>::version=\2&hash=[a-f0-9]+$/;

// Yarn 2+ installs only with the node-modules linker, the root workspace and npm-resolved
// packages with checksums. Configuration reaches the installer through environment variables.
export function validateBerryInputs(
  packageContent: string,
  lockContent: string,
  rcContent: string | undefined,
  // The committed release a `yarnPath` setting names, read by the caller.
  release?: { path: string; content: Buffer },
  workspaceContents: ReadonlyMap<string, string> = new Map(),
) {
  if (
    Buffer.byteLength(packageContent) > MAX_PACKAGE_BYTES ||
    Buffer.byteLength(lockContent) > MAX_LOCK_BYTES ||
    (rcContent !== undefined && Buffer.byteLength(rcContent) > MAX_PACKAGE_BYTES) ||
    [...workspaceContents.values()].some(
      (content) => Buffer.byteLength(content) > MAX_PACKAGE_BYTES,
    )
  )
    throw new PipelineInputError('Yarn preparation inputs exceed manifest or lockfile limits.');
  const manifest = parseObject(packageContent, 'package.json');
  if (typeof manifest.packageManager === 'string' && YARN_1_PIN.test(manifest.packageManager))
    throw new PipelineInputError(
      `packageManager pins ${manifest.packageManager}, but ${YARN_LOCKFILE} is a Yarn 2+ lockfile. Pin the Yarn release that wrote the lockfile, or regenerate it with Yarn 1.`,
    );
  const rc = rcContent === undefined ? {} : parseDocumentObject(rcContent, YARN_RC);
  if (rc.plugins !== undefined)
    throw new PipelineInputError(
      `Yarn plugins (plugins in ${YARN_RC}) run their own code during installs, so they require a custom validation image.`,
    );
  if (rc.nodeLinker === undefined || rc.nodeLinker === 'pnp')
    throw new PipelineInputError(
      `Yarn Plug'n'Play requires a custom validation image: Refit prepares Yarn 2+ only with nodeLinker: node-modules in ${YARN_RC}${rc.nodeLinker === undefined ? ", and without nodeLinker Yarn uses Plug'n'Play" : ''}.`,
    );
  if (rc.nodeLinker !== 'node-modules')
    throw new PipelineInputError(
      `Yarn's ${JSON.stringify(rc.nodeLinker)} linker requires a custom validation image; Refit prepares Yarn 2+ only with nodeLinker: node-modules.`,
    );
  const unsupported = Object.keys(rc).filter((key) => !BERRY_RC_KEYS.has(key));
  if (unsupported.length)
    throw new PipelineInputError(
      `${YARN_RC} sets ${unsupported.join(', ')}, which Refit does not apply; validating with them requires a custom image.`,
    );
  const pin =
    typeof manifest.packageManager === 'string' ? BERRY_PIN.exec(manifest.packageManager) : null;
  if (
    rc.yarnPath !== undefined &&
    (typeof rc.yarnPath !== 'string' || release?.path !== rc.yarnPath)
  )
    throw new PipelineInputError(
      `yarnPath in ${YARN_RC} must name a committed Yarn release under .yarn/releases.`,
    );
  const named = release ? RELEASE_VERSION.exec(release.path)?.[1] : undefined;
  const version = pin?.[1] ?? named;
  if (!version)
    throw new PipelineInputError(
      'Yarn 2+ preparation requires an exact packageManager pin such as yarn@4.9.2 (optionally with a Corepack checksum), or a committed yarnPath release named yarn-<version>.cjs.',
    );
  if (pin && named && pin[1] !== named)
    throw new PipelineInputError(
      `packageManager pins Yarn ${pin[1]}, but yarnPath names Yarn ${named}.`,
    );
  // The committed release is never run: its digest must equal the published bundle Refit installs.
  const releaseSha512 = release && createHash('sha512').update(release.content).digest('hex');
  if (releaseSha512 && pin?.[2] && pin[2] !== releaseSha512)
    throw new PipelineInputError(
      'The packageManager checksum differs from the committed yarnPath release.',
    );
  const bundleSha512 = releaseSha512 ?? pin?.[2];
  yarnWorkspacePatterns(manifest);
  // Workspace directory → its manifest; the root is ".".
  const workspaces = new Map<string, Record<string, unknown>>([['.', manifest]]);
  const names = new Set<string>();
  for (const [directory, content] of workspaceContents) {
    const value = parseObject(content, `${directory}/package.json`);
    if (
      typeof value.name !== 'string' ||
      !NPM_PACKAGE_NAME.test(value.name) ||
      names.has(value.name) ||
      value.workspaces !== undefined
    )
      throw new PipelineInputError(
        'Yarn workspace packages need unique package names and no nested workspaces.',
      );
    names.add(value.name);
    workspaces.set(directory, value);
  }
  const lock = parseDocumentObject(lockContent, YARN_LOCKFILE);
  if (!isObject(lock.__metadata) || typeof lock.__metadata.version !== 'number')
    throw new PipelineInputError(`${YARN_LOCKFILE} lacks Yarn Berry __metadata.version.`);
  const descriptors = new Set<string>();
  const locked = new Set<string>();
  let packages = 0;
  // Yarn 3.2+ records platform-specific packages with `conditions` and, since Yarn 4, never with a
  // checksum. By default Refit installs none of them (see YARN_SKIP_PLATFORM_PACKAGES).
  let platformPackages = 0;
  for (const [key, record] of Object.entries(lock)) {
    if (key === '__metadata') continue;
    if (!isObject(record)) throw new PipelineInputError('yarn.lock entries must be objects.');
    const resolution = typeof record.resolution === 'string' ? record.resolution : '';
    const workspace = /^(.+)@workspace:(.+)$/.exec(resolution);
    if (workspace) {
      const value = workspaces.get(workspace[2]);
      if (
        !value ||
        (workspace[2] !== '.' && value.name !== workspace[1]) ||
        record.linkType !== 'soft'
      )
        throw new PipelineInputError(
          `${YARN_LOCKFILE} records workspace ${resolution}, which the committed workspace manifests do not declare; run yarn install and commit the lockfile it writes.`,
        );
      locked.add(workspace[2]);
    } else {
      const builtin = BUILTIN_PATCH.exec(resolution);
      const name = builtin ? builtin[1] : resolution.split('@npm:')[0];
      const platform = typeof record.conditions === 'string';
      if (platform) platformPackages++;
      if (
        ++packages > MAX_PACKAGES ||
        !REGISTRY_PACKAGE_NAME.test(name) ||
        typeof record.version !== 'string' ||
        !EXACT_PACKAGE_VERSION.test(record.version) ||
        (builtin
          ? builtin[2] !== record.version ||
            (record.checksum !== undefined && !BERRY_CHECKSUM.test(String(record.checksum)))
          : resolution !== `${name}@npm:${record.version}` ||
            (record.checksum === undefined
              ? !platform
              : typeof record.checksum !== 'string' || !BERRY_CHECKSUM.test(record.checksum))) ||
        record.linkType !== 'hard'
      )
        throw new PipelineInputError(
          'Every Yarn 2+ lock entry must resolve an exact npm version with a checksum (platform-specific packages excepted, which Refit does not install); patches, git and local sources require a custom image.',
        );
    }
    for (const descriptor of key.split(/,\s*/)) descriptors.add(descriptor);
  }
  // Yarn 2+ records every workspace, the root included.
  const missing = [...workspaces.keys()].find((directory) => !locked.has(directory));
  if (missing !== undefined)
    throw new PipelineInputError(
      `${YARN_LOCKFILE} has no entry for workspace ${missing}; run yarn install and commit the lockfile it writes.`,
    );
  for (const [directory, value] of workspaces)
    for (const section of INSTALLED_SECTIONS) {
      const file = directory === '.' ? 'package.json' : `${directory}/package.json`;
      const dependencies = value[section];
      if (dependencies === undefined) continue;
      if (!isObject(dependencies))
        throw new PipelineInputError(`${file} ${section} must be an object.`);
      for (const [name, range] of Object.entries(dependencies))
        if (
          typeof range !== 'string' ||
          // A sibling workspace is recorded as `name@range` for a workspace: range or for a plain
          // range Yarn resolved to the workspace; registry packages as `name@npm:range`.
          !(
            (names.has(name) && descriptors.has(`${name}@${range}`)) ||
            (!LOCAL_OR_ALIASED.test(range) && descriptors.has(`${name}@npm:${range}`))
          )
        )
          throw new PipelineInputError(
            `${name}@${String(range)} in ${file} is not a public registry dependency or a sibling workspace recorded in yarn.lock; regenerate the lockfile or use a custom image.`,
          );
    }
  return {
    manager: 'yarn' as const,
    managerVersion: version,
    ...(bundleSha512 ? { managerBundleSha512: bundleSha512 } : {}),
    packageHash: digest(packageContent),
    lockHash: digest(lockContent),
    ...(rcContent === undefined ? {} : { workspaceConfigHash: digest(rcContent) }),
    packages,
    ...(platformPackages ? { platformPackages } : {}),
    ...(workspaceContents.size
      ? {
          workspaceHashes: Object.fromEntries(
            [...workspaceContents].map(([directory, content]) => [directory, digest(content)]),
          ),
          // The node-modules linker links a workspace into the root only when it can be hoisted there.
          workspaceOptionalLinks: Object.fromEntries(
            [...workspaces]
              .filter(([directory]) => directory !== '.')
              .map(([directory, value]) => [`node_modules/${String(value.name)}`, directory]),
          ),
        }
      : {}),
  };
}
