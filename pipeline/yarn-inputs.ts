import { digest, isObject, parseDocumentObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import {
  EXACT_PACKAGE_VERSION,
  hasStrongIntegrity,
  MAX_LOCK_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGES,
  NPM_PACKAGE_NAME,
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
const MANAGER_PIN = /^yarn@(1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+sha512\.([a-f0-9]{128}))?$/;
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
      'Yarn preparation supports an exact Yarn 1 packageManager pin, optionally with a SHA-512 Corepack checksum. Yarn 2+ requires a custom image.',
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
const BERRY_PIN = /^yarn@([234]\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+sha512\.([a-f0-9]{128}))?$/;
const BERRY_RC_KEYS = new Set(['nodeLinker', 'enableTelemetry']);
const BERRY_CHECKSUM = /^(?:\d+[a-z]\d*\/)?[a-f0-9]{128}$/;
// Yarn's own compatibility patches ship in the verified Yarn bundle and wrap an npm package.
const BUILTIN_PATCH =
  /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@patch:\1@npm%3A([^#]+)#optional!builtin<compat\/[a-z0-9-]+>::version=\2&hash=[a-f0-9]+$/;

// Yarn 2+ installs only with the node-modules linker, the root workspace and npm-resolved
// packages with checksums. Configuration reaches the installer through environment variables.
export function validateBerryInputs(
  packageContent: string,
  lockContent: string,
  rcContent: string | undefined,
) {
  if (
    Buffer.byteLength(packageContent) > MAX_PACKAGE_BYTES ||
    Buffer.byteLength(lockContent) > MAX_LOCK_BYTES ||
    (rcContent !== undefined && Buffer.byteLength(rcContent) > MAX_PACKAGE_BYTES)
  )
    throw new PipelineInputError('Yarn preparation inputs exceed manifest or lockfile limits.');
  const manifest = parseObject(packageContent, 'package.json');
  const pin =
    typeof manifest.packageManager === 'string' ? BERRY_PIN.exec(manifest.packageManager) : null;
  if (!pin)
    throw new PipelineInputError(
      'Yarn 2+ preparation requires an exact packageManager pin such as yarn@4.9.2, optionally with a Corepack SHA-512 checksum.',
    );
  if (manifest.workspaces !== undefined)
    throw new PipelineInputError('Yarn 2+ workspaces require a custom validation image.');
  const rc = rcContent === undefined ? {} : parseDocumentObject(rcContent, YARN_RC);
  if (rc.nodeLinker !== 'node-modules' || Object.keys(rc).some((key) => !BERRY_RC_KEYS.has(key)))
    throw new PipelineInputError(
      `Yarn 2+ preparation requires ${YARN_RC} with nodeLinker: node-modules and no other settings except enableTelemetry; Plug'n'Play and custom settings require a custom image.`,
    );
  const lock = parseDocumentObject(lockContent, YARN_LOCKFILE);
  if (!isObject(lock.__metadata) || typeof lock.__metadata.version !== 'number')
    throw new PipelineInputError(`${YARN_LOCKFILE} lacks Yarn Berry __metadata.version.`);
  const descriptors = new Set<string>();
  let packages = 0;
  for (const [key, record] of Object.entries(lock)) {
    if (key === '__metadata') continue;
    if (!isObject(record)) throw new PipelineInputError('yarn.lock entries must be objects.');
    const resolution = typeof record.resolution === 'string' ? record.resolution : '';
    if (/^[^@\s]+@workspace:\.$/.test(resolution)) continue;
    const builtin = BUILTIN_PATCH.exec(resolution);
    const name = builtin ? builtin[1] : resolution.split('@npm:')[0];
    if (
      ++packages > MAX_PACKAGES ||
      !NPM_PACKAGE_NAME.test(name) ||
      typeof record.version !== 'string' ||
      !EXACT_PACKAGE_VERSION.test(record.version) ||
      (builtin
        ? builtin[2] !== record.version ||
          (record.checksum !== undefined && !BERRY_CHECKSUM.test(String(record.checksum)))
        : resolution !== `${name}@npm:${record.version}` ||
          typeof record.checksum !== 'string' ||
          !BERRY_CHECKSUM.test(record.checksum)) ||
      record.linkType !== 'hard'
    )
      throw new PipelineInputError(
        'Every Yarn 2+ lock entry must resolve an exact npm version with a checksum; workspaces, patches, git and local sources require a custom image.',
      );
    for (const descriptor of key.split(/,\s*/)) descriptors.add(descriptor);
  }
  for (const section of INSTALLED_SECTIONS) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies))
      throw new PipelineInputError(`package.json ${section} must be an object.`);
    for (const [name, range] of Object.entries(dependencies))
      if (
        typeof range !== 'string' ||
        LOCAL_OR_ALIASED.test(range) ||
        !descriptors.has(`${name}@npm:${range}`)
      )
        throw new PipelineInputError(
          `${name}@${String(range)} is not a public registry dependency recorded in yarn.lock; regenerate the lockfile or use a custom image.`,
        );
  }
  return {
    manager: 'yarn' as const,
    managerVersion: pin[1],
    ...(pin[2] ? { managerBundleSha512: pin[2] } : {}),
    packageHash: digest(packageContent),
    lockHash: digest(lockContent),
    ...(rcContent === undefined ? {} : { workspaceConfigHash: digest(rcContent) }),
    packages,
  };
}
