import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCommittedRepository } from './committed-repository.ts';
import { legacyPeerDeps, readPreparationInputs } from './dependency-inputs.ts';
import { lockChangesOutside, lockedReleases, type LockedProject } from './lockfile-graph.ts';
import {
  changesOutside,
  RESOLUTION_LOCKFILES,
  resolveNpmLockfile,
  type ResolutionManager,
} from './lockfile-resolution.ts';
import { readBoundedResponse } from './network.ts';
import { scopedNpmLock } from './scoped-lockfile.ts';
import { parsePnpmLock } from './pnpm-lock.ts';
import { isObject, parseJson } from './specifications.ts';
import {
  manifestDeclaration,
  npmRegistryResponse,
  type PackageUpgrade,
} from './stripe-package-upgrade.ts';
import { PipelineInputError } from './types.ts';
import { CLASSIC_HEADER } from './yarn-lock.ts';

// Moves an AI SDK (openai, @anthropic-ai/sdk) to the newest release of its target major in a root
// project: package.json's declaration is rewritten and the project's own package manager
// re-resolves its committed lockfile in its own networked container (lockfile-resolution.ts). npm
// resolves as of the repository's last commit, so only the SDK resolves later; pnpm, Yarn and Bun
// run the release preparation installs with (its packageManager pin) and start from the committed
// lockfile. The upgrade is kept only when nothing in the lockfile changes outside the SDK and the
// packages only it reaches (lockfile-graph.ts).

type Refusal = { reason: string };
export type Resolve = typeof resolveNpmLockfile;
export interface SdkUpgradeOptions {
  packageName: string;
  targetMajor: number;
  // Packages that must move with the SDK (Anthropic's platform clients); declared ones refuse
  // unless they are in `together`.
  companions?: string[];
  // Declared packages moved to their newest `targetMajor` release in the same upgrade, as the
  // provider's guide says (Anthropic's platform SDKs to v1 with @anthropic-ai/sdk 1).
  together?: string[];
  // The newest release of each `together` package; read from the npm registry when absent.
  togetherReleases?: Record<string, string>;
  resolution: { image: string; before: string; resolve?: Resolve };
  // The newest release of the target major; read from the npm registry when absent.
  release?: string;
  // A swap: this declared package is replaced by `packageName` in the same section.
  replaces?: string;
  // The Git checkout `root` was extracted from (validation proposes in an extracted copy); a pnpm,
  // Yarn or Bun project's committed lockfiles are read from it. Defaults to `root`.
  repository?: string;
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
// Bun for a project that does not pin it in packageManager, as the Shopify SDK upgrade in #417
// chooses it: the newest release at least two weeks old. Source: npm registry, bun versions
// (1.4.3 published 2026-10-10), 2026-10-29.
const DEFAULT_BUN_VERSION = '1.4.3';
const BUN_PIN = /^bun@(\d+\.\d+\.\d+)(?:\+|$)/;

// A pnpm, Yarn or Bun project's lockfile and the release of the manager that re-resolves it.
interface Managed {
  manager: ResolutionManager;
  version: string;
  lockfile: string;
  lockText: string;
  // Lockfile settings pnpm records, passed back so the re-resolved lockfile keeps them.
  arguments: string[];
}

// A project that commits a lockfile other than package-lock.json, read as preparation reads it
// (readPreparationInputs): the same lockfile choice and package-manager release, refused where
// preparation refuses. `managed` is absent when the rule picks package-lock.json; `others` lists
// the lockfiles left as committed, with why.
async function managedProject(
  root: string,
  manifestText: string,
): Promise<{ managed?: Managed; others: Record<string, string> } | Refusal> {
  let snapshot;
  try {
    snapshot = await readCommittedRepository(root);
  } catch {
    return {
      reason:
        'Refit reads a pnpm, Yarn or Bun lockfile as committed, and this project is not the top of a Git checkout.',
    };
  }
  let prepared;
  try {
    prepared = await readPreparationInputs(snapshot);
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return {
      reason: `Preparation cannot read the committed lockfiles, so the SDK upgrade cannot either: ${error.message.slice(0, 300)}`,
    };
  }
  const { inputs, files, workspaceContents } = prepared;
  const others = inputs.lockfileChoice?.others ?? {};
  if (workspaceContents.size || files.has('pnpm-workspace.yaml'))
    return {
      reason: 'The SDK upgrade re-resolves lockfiles only for projects without workspaces.',
    };
  if (inputs.patchHashes && Object.keys(inputs.patchHashes).length)
    return {
      reason: 'pnpm-lock.yaml records patched dependencies, which re-resolution does not apply.',
    };
  let manager: ResolutionManager, version: string;
  if (inputs.manager === 'pnpm' || inputs.manager === 'yarn') {
    manager = inputs.manager;
    version = inputs.managerVersion!;
  } else if (inputs.bunLockHash) {
    const manifest = parseJson(manifestText);
    const pin =
      isObject(manifest) && typeof manifest.packageManager === 'string'
        ? BUN_PIN.exec(manifest.packageManager)
        : null;
    manager = 'bun';
    version = pin?.[1] ?? DEFAULT_BUN_VERSION;
  } else return { others };
  const lockfile = RESOLUTION_LOCKFILES[manager];
  const lockText = await readFile(join(root, lockfile), 'utf8');
  if (manager === 'yarn' && !CLASSIC_HEADER.test(lockText)) manager = 'yarn-berry';
  // pnpm writes these settings into the lockfile; the resolution keeps the committed ones.
  const settings = manager === 'pnpm' ? parsePnpmLock(lockText).document.settings : undefined;
  const managerArguments = isObject(settings)
    ? [
        ['autoInstallPeers', 'auto-install-peers'],
        ['excludeLinksFromLockfile', 'exclude-links-from-lockfile'],
      ].flatMap(([key, flag]) =>
        typeof settings[key] === 'boolean' ? [`--config.${flag}=${String(settings[key])}`] : [],
      )
    : [];
  return { managed: { manager, version, lockfile, lockText, arguments: managerArguments }, others };
}

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
  const project = present.length
    ? await managedProject(options.repository ?? root, manifestText)
    : { others: {} };
  if ('reason' in project) return project;
  const { managed } = project;
  // Lockfiles the rule did not pick keep their committed SDK; the draft says so.
  const leftAlone = Object.keys(project.others);
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
  const together = (options.together ?? []).filter(declared);
  const companions = (options.companions ?? []).filter(
    (name) => declared(name) && !together.includes(name),
  );
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
  let rewritten = declaration.rewrite(release, manifestText, '^');
  const moved: { name: string; release: string }[] = [];
  for (const name of together) {
    const companion = manifestDeclaration(manifest, rewritten, name);
    if ('reason' in companion) return companion;
    if (!companion.unique) return { reason: `package.json declares ${name} more than once.` };
    let next: string;
    try {
      next = options.togetherReleases?.[name] ?? (await newestRelease(name, targetMajor));
    } catch (error) {
      if (!(error instanceof PipelineInputError)) throw error;
      return { reason: error.message };
    }
    rewritten = companion.rewrite(next, rewritten, '^');
    moved.push({ name, release: next });
  }
  // A swap renames the key in place, so the section keeps its order.
  const after = options.replaces
    ? rewritten.replace(JSON.stringify(options.replaces), JSON.stringify(packageName))
    : rewritten;
  if (managed)
    return managedUpgrade(options, managed, {
      manifestText,
      after,
      from: declaration.spec,
      release,
      moved,
      together,
      leftAlone,
    });
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
  const moving = [packageName, ...(options.replaces ? [options.replaces] : []), ...together];
  // npm re-resolves the whole tree; when that moves anything outside the upgrade, only the moved
  // packages' own trees are taken from it (scoped-lockfile.ts).
  const outside = changesOutside(lockText, resolved.lockfile, moving);
  let lockfile = resolved.lockfile;
  if (outside.length) {
    const scoped = scopedNpmLock({
      committed: lockText,
      resolved: resolved.lockfile,
      names: moving,
    });
    if ('reason' in scoped)
      return {
        reason: `Upgrading ${packageName} changes ${outside
          .slice(0, 5)
          .map((key) => key || 'the root record')
          .join(
            ', ',
          )}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''} in npm's re-resolved package-lock.json, outside ${[packageName, ...together].join(', ')} and the packages only they reach, and Refit cannot keep the rest as committed: ${scoped.reason}`,
      };
    lockfile = scoped.lockfile;
  }
  const lock = parseJson(lockfile);
  const entry =
    isObject(lock) && isObject(lock.packages)
      ? lock.packages[`node_modules/${packageName}`]
      : undefined;
  const locked = isObject(entry) && typeof entry.version === 'string' ? entry.version : undefined;
  if (!locked || Number(RELEASE.exec(locked)?.[1]) !== targetMajor)
    return { reason: `npm did not lock ${packageName} ${targetMajor}.x at the project root.` };
  for (const name of together) {
    const companion =
      isObject(lock) && isObject(lock.packages) ? lock.packages[`node_modules/${name}`] : undefined;
    const version =
      isObject(companion) && typeof companion.version === 'string' ? companion.version : '';
    if (Number(RELEASE.exec(version)?.[1]) !== targetMajor)
      return { reason: `npm did not lock ${name} ${targetMajor}.x at the project root.` };
    // Nothing may keep a second, older copy of the SDK for it.
    const nested = Object.keys(
      isObject(lock) && isObject(lock.packages) ? lock.packages : {},
    ).filter((key) => key.endsWith(`/node_modules/${packageName}`));
    if (nested.length)
      return { reason: `package-lock.json keeps another ${packageName} under ${nested[0]}.` };
  }
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
        { path: 'package-lock.json', before: lockText, after: lockfile },
      ],
      warning: `${options.replaces ? `Replaces ${options.replaces} ${from} with ${packageName} ${locked}` : `Upgrades ${packageName} from ${from} to ${locked}`}${moved.length ? `, and ${moved.map((item) => `${item.name} to ${item.release}`).join(', ')} with it` : ''}. npm re-resolved package-lock.json from the committed one in networked Docker with lifecycle scripts off, as of ${resolved.before}${Object.entries(
        resolved.late,
      )
        .map(([name, pin]) => `, ${name} ${pin.spec} as of ${pin.published}`)
        .join('')}${
        outside.length
          ? `. npm's lockfile also moved ${outside.length} entr${outside.length === 1 ? 'y' : 'ies'} outside ${[packageName, ...together].join(', ')}; Refit kept ${outside.length === 1 ? 'it' : 'them'} as committed and took only the moved packages' own dependencies from it, each checked against the range that requires it`
          : `; nothing outside ${[packageName, ...together].join(', ')} and the packages only they reach changed`
      }.${leftAloneNote(leftAlone, packageName)}`,
    },
  };
}

// A pnpm, Yarn or Bun project: its own manager re-resolves the committed lockfile with the
// rewritten package.json, and the result is kept only when nothing outside the moved packages and
// what only they reach changes, and every locked copy of each moved package is the target major.
async function managedUpgrade(
  options: SdkUpgradeOptions,
  managed: Managed,
  change: {
    manifestText: string;
    after: string;
    from: string;
    release: string;
    moved: { name: string; release: string }[];
    together: string[];
    leftAlone: string[];
  },
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  const { packageName, targetMajor } = options;
  const label = `${managed.manager.replace('-berry', '')} ${managed.version}`;
  const resolve = options.resolution.resolve ?? resolveNpmLockfile;
  let resolved;
  try {
    resolved = await resolve({
      manifest: change.after,
      seed: managed.lockText,
      before: options.resolution.before,
      manager: managed.manager,
      managerVersion: managed.version,
      managerArguments: managed.arguments,
      image: options.resolution.image,
    });
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return {
      reason: `${label} could not re-resolve ${managed.lockfile} with ${packageName} ^${change.release}: ${error.message.slice(0, 120)} … ${error.message.slice(-300)}`,
    };
  }
  const names = [packageName, ...(options.replaces ? [options.replaces] : []), ...change.together];
  const manifest = (text: string) => parseJson(text) as Record<string, unknown>;
  const before: LockedProject = {
    lockfile: managed.lockText,
    manifests: { '.': manifest(change.manifestText) },
  };
  const after: LockedProject = {
    lockfile: resolved.lockfile,
    manifests: { '.': manifest(change.after) },
  };
  let outside: string[], was: ReturnType<typeof lockedReleases>, now: typeof was;
  try {
    outside = lockChangesOutside(managed.manager, before, after, names).map(
      (key) => key || 'the root record',
    );
    [was, now] = [lockedReleases(managed.manager, before), lockedReleases(managed.manager, after)];
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return {
      reason: `Refit could not compare the re-resolved ${managed.lockfile}: ${error.message}`,
    };
  }
  if (outside.length)
    return {
      reason: `Upgrading ${packageName} with ${label} changes ${outside.slice(0, 5).join(', ')}${
        outside.length > 5 ? ` and ${outside.length - 5} more` : ''
      } in ${managed.lockfile}, outside ${[packageName, ...change.together].join(', ')} and the packages only they reach.`,
    };
  // Every copy of each moved package, nested ones included, must be the target major.
  for (const name of [packageName, ...change.together]) {
    const copies = [...(now.all.get(name) ?? [])];
    if (
      !copies.length ||
      copies.some((version) => Number(RELEASE.exec(version)?.[1]) !== targetMajor)
    )
      return {
        reason: `${label} did not lock ${name} ${targetMajor}.x everywhere (it locks ${copies.join(', ') || 'none'}).`,
      };
  }
  const locked = now.root[packageName] ?? [...now.all.get(packageName)!][0];
  const from = was.root[options.replaces ?? packageName] ?? change.from;
  return {
    upgrade: {
      from,
      to: locked,
      files: [
        { path: 'package.json', before: change.manifestText, after: change.after },
        { path: managed.lockfile, before: managed.lockText, after: resolved.lockfile },
      ],
      warning: `${options.replaces ? `Replaces ${options.replaces} ${from} with ${packageName} ${locked}` : `Upgrades ${packageName} from ${from} to ${locked}`}${change.moved.length ? `, and ${change.moved.map((item) => `${item.name} to ${item.release}`).join(', ')} with it` : ''}. ${label}, the release this project installs with, re-resolved ${managed.lockfile} from the committed one in networked Docker with lifecycle scripts off; nothing outside ${[packageName, ...change.together].join(', ')} and the packages only they reach changed.${leftAloneNote(change.leftAlone, packageName)}`,
    },
  };
}

function leftAloneNote(lockfiles: string[], packageName: string) {
  return lockfiles.length
    ? ` ${lockfiles.join(' and ')} ${lockfiles.length === 1 ? 'is' : 'are'} left as committed, on the older ${packageName}.`
    : '';
}
