import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { legacyPeerDeps } from './dependency-inputs.ts';
import { changesOutside, resolveNpmLockfile } from './lockfile-resolution.ts';
import { readBoundedResponse } from './network.ts';
import { isObject, parseJson } from './specifications.ts';
import {
  manifestDeclaration,
  npmRegistryResponse,
  type PackageUpgrade,
} from './stripe-package-upgrade.ts';
import { PipelineInputError } from './types.ts';

// Moves an AI SDK (openai, @anthropic-ai/sdk) to the newest release of its target major in a root
// npm project: package.json's declaration is rewritten and npm re-resolves package-lock.json from
// the committed one in its own networked container, as of the repository's last commit, so only
// the SDK resolves later (lockfile-resolution.ts). The upgrade is kept only when nothing in the
// lockfile changes outside the SDK and the packages only it reaches.

type Refusal = { reason: string };
export type Resolve = typeof resolveNpmLockfile;
export interface SdkUpgradeOptions {
  packageName: string;
  targetMajor: number;
  // Packages that must move with the SDK (Anthropic's platform clients); declared ones refuse.
  companions?: string[];
  resolution: { image: string; before: string; resolve?: Resolve };
  // The newest release of the target major; read from the npm registry when absent.
  release?: string;
  // A swap: this declared package is replaced by `packageName` in the same section.
  replaces?: string;
}

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const OTHER_LOCKFILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
];
const MAX_PACKUMENT_BYTES = 16 * 1024 * 1024;

// The newest published, non-deprecated release of `major`, from npm's abbreviated metadata.
export async function newestRelease(packageName: string, major: number) {
  const response = await npmRegistryResponse(
    `https://registry.npmjs.org/${packageName.replace('/', '%2f')}`,
    'application/vnd.npm.install-v1+json',
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new PipelineInputError(
      `The npm registry returned HTTP ${response.status} for ${packageName}.`,
    );
  }
  const metadata = parseJson(
    await readBoundedResponse(response, MAX_PACKUMENT_BYTES, 'npm registry'),
  );
  if (!isObject(metadata) || !isObject(metadata.versions))
    throw new PipelineInputError(`The npm registry metadata for ${packageName} is unreadable.`);
  const releases = Object.entries(metadata.versions)
    .filter(([version, entry]) => {
      const match = RELEASE.exec(version);
      return (
        match && Number(match[1]) === major && isObject(entry) && entry.deprecated === undefined
      );
    })
    .map(([version]) => version.split('.').map(Number))
    .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  if (!releases.length) throw new PipelineInputError(`${packageName} has no ${major}.x release.`);
  return releases[0].join('.');
}

export async function sdkMajorUpgrade(
  root: string,
  options: SdkUpgradeOptions,
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  const { packageName, targetMajor } = options;
  const read = (path: string) => readFile(join(root, path), 'utf8').catch(() => undefined);
  const [manifestText, lockText, npmrc, ...others] = await Promise.all([
    read('package.json'),
    read('package-lock.json'),
    read('.npmrc'),
    ...OTHER_LOCKFILES.map(read),
  ]);
  if (manifestText === undefined) return { reason: 'The project has no root package.json.' };
  const present = OTHER_LOCKFILES.filter((_, index) => others[index] !== undefined);
  if (present.length)
    return {
      reason: `The ${packageName} upgrade re-resolves only npm's package-lock.json; this project commits ${present.join(', ')}, whose manager cannot resolve as of a date.`,
    };
  let manifest: unknown;
  try {
    manifest = parseJson(manifestText);
  } catch {
    return { reason: 'package.json is not valid JSON.' };
  }
  if (!isObject(manifest)) return { reason: 'package.json is not an object.' };
  if (manifest.workspaces !== undefined)
    return { reason: `The ${packageName} upgrade does not cover npm workspaces.` };
  const declared = (name: string) =>
    ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
      (section) => isObject(manifest[section]) && name in manifest[section],
    );
  const companions = (options.companions ?? []).filter(declared);
  if (companions.length)
    return {
      reason: `package.json also declares ${companions.join(', ')}, which must move to a matching major with ${packageName}; Refit does not upgrade them together yet.`,
    };
  const current = options.replaces ?? packageName;
  if (options.replaces && declared(packageName))
    return { reason: `package.json already declares ${packageName} beside ${options.replaces}.` };
  const declaration = manifestDeclaration(manifest, manifestText, current);
  if ('reason' in declaration) return declaration;
  if (!declaration.unique) return { reason: `package.json declares ${current} more than once.` };
  if (npmrc && /^\s*(?:@[^:\s]+:)?registry\s*=|_auth/m.test(npmrc))
    return { reason: '.npmrc configures another registry or credentials.' };
  let release: string;
  try {
    release = options.release ?? (await newestRelease(packageName, targetMajor));
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return { reason: error.message };
  }
  const rewritten = declaration.rewrite(release, manifestText, '^');
  // A swap renames the key in place, so the section keeps its order.
  const after = options.replaces
    ? rewritten.replace(JSON.stringify(options.replaces), JSON.stringify(packageName))
    : rewritten;
  if (lockText === undefined)
    return {
      upgrade: {
        from: declaration.spec,
        to: release,
        files: [{ path: 'package.json', before: manifestText, after }],
        warning: `Moves ${packageName} from ${declaration.spec} to ^${release} in package.json. The project commits no lockfile, so the release installed depends on when it is installed.`,
      },
    };
  const resolve = options.resolution.resolve ?? resolveNpmLockfile;
  let resolved;
  try {
    resolved = await resolve({
      manifest: after,
      seed: lockText,
      before: options.resolution.before,
      legacyPeerDeps: legacyPeerDeps(npmrc ?? ''),
      image: options.resolution.image,
    });
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return {
      reason: `npm could not re-resolve package-lock.json with ${packageName} ^${release}: ${error.message}`,
    };
  }
  const outside = changesOutside(
    lockText,
    resolved.lockfile,
    options.replaces ? [packageName, options.replaces] : [packageName],
  );
  if (outside.length)
    return {
      reason: `Upgrading ${packageName} changes ${outside
        .slice(0, 5)
        .map((key) => key || 'the root record')
        .join(
          ', ',
        )}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''} in package-lock.json, outside ${packageName} and the packages only it reaches.`,
    };
  const lock = parseJson(resolved.lockfile);
  const entry =
    isObject(lock) && isObject(lock.packages)
      ? lock.packages[`node_modules/${packageName}`]
      : undefined;
  const locked = isObject(entry) && typeof entry.version === 'string' ? entry.version : undefined;
  if (!locked || Number(RELEASE.exec(locked)?.[1]) !== targetMajor)
    return { reason: `npm did not lock ${packageName} ${targetMajor}.x at the project root.` };
  const previous = parseJson(lockText);
  const previousEntry =
    isObject(previous) && isObject(previous.packages)
      ? previous.packages[`node_modules/${current}`]
      : undefined;
  const from =
    isObject(previousEntry) && typeof previousEntry.version === 'string'
      ? previousEntry.version
      : declaration.spec;
  return {
    upgrade: {
      from,
      to: locked,
      files: [
        { path: 'package.json', before: manifestText, after },
        { path: 'package-lock.json', before: lockText, after: resolved.lockfile },
      ],
      warning: `${options.replaces ? `Replaces ${options.replaces} ${from} with ${packageName} ${locked}` : `Upgrades ${packageName} from ${from} to ${locked}`}. npm re-resolved package-lock.json from the committed one in networked Docker with lifecycle scripts off, as of ${resolved.before}${Object.entries(
        resolved.late,
      )
        .map(([name, pin]) => `, ${name} ${pin.spec} as of ${pin.published}`)
        .join('')}; nothing outside ${packageName} and the packages only it reaches changed.`,
    },
  };
}
