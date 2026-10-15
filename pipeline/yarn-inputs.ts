import { digest, isObject, parseObject } from './specifications.ts';
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
