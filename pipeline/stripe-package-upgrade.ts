import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, isScalar, parseDocument, type Document } from 'yaml';
import {
  fetchSpecificationResponse,
  readBoundedResponse,
  SpecificationUnavailableError,
} from './network.ts';
import { EXACT_PACKAGE_VERSION } from './npm-lock.ts';
import { legacyPeerDeps } from './dependency-inputs.ts';
import { changesOutside, resolveNpmLockfile } from './lockfile-resolution.ts';
import { isObject, parseJson } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Latest stripe-node release pinned to each API version.
// Source: stripe-node release tags (VERSION with API_VERSION / OPENAPI_VERSION), as mapped for the
// Stripe benchmark on 2026-10-14.
export const STRIPE_SDK_RELEASES: Record<string, string> = {
  '2022-08-01': '10.17.0',
  '2022-11-15': '12.18.0',
  '2023-08-16': '13.11.0',
  '2023-10-16': '14.25.0',
  '2024-04-10': '15.12.0',
  '2024-06-20': '16.12.0',
  '2024-09-30.acacia': '17.2.1',
  '2024-10-28.acacia': '17.3.1',
  '2024-11-20.acacia': '17.4.0',
  '2024-12-18.acacia': '17.5.0',
  '2025-01-27.acacia': '17.6.0',
  '2025-02-24.acacia': '17.7.0',
  '2025-03-31.basil': '18.0.0',
  '2025-04-30.basil': '18.1.1',
  '2025-05-28.basil': '18.2.1',
  '2025-06-30.basil': '18.3.0',
  '2025-07-30.basil': '18.4.0',
  '2025-08-27.basil': '18.5.0',
  '2025-09-30.clover': '19.1.0',
  '2025-10-29.clover': '19.3.1',
  '2025-11-17.clover': '20.0.0',
  '2025-12-15.clover': '20.2.0',
  '2026-01-28.clover': '20.3.1',
  '2026-02-25.clover': '20.4.1',
  '2026-03-25.dahlia': '22.0.2',
  '2026-04-22.dahlia': '22.1.1',
  '2026-05-27.dahlia': '22.2.3',
  '2026-06-24.dahlia': '22.3.2',
  '2026-07-29.dahlia': '22.5.0',
  '2026-08-26.dahlia': '22.6.2',
  '2026-09-30.endive': '23.0.0',
};

const REGISTRY = 'https://registry.npmjs.org/stripe/';
const MAX_METADATA_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const REGISTRY_ATTEMPTS = 3;
const REGISTRY_RETRY_MS = 2_000;
export const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const VERSION_SPEC = /^([~^]?)(\d+\.\d+\.\d+)$/;
// pnpm writes flow maps without inner padding and never folds long lines.
const PNPM_FORMAT = { lineWidth: 0, flowCollectionPadding: false, singleQuote: true };
export const NPM_FORMATS = [2, 4, '\t'].flatMap((indent) =>
  ['\n', '\r\n'].flatMap((newline) =>
    ['', '\n'].map(
      (end) => (lock: unknown) =>
        `${JSON.stringify(lock, null, indent)}${end}`.replace(/\n/g, newline),
    ),
  ),
);
const PNPM_IMPORTER_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

export const PACKAGE_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

function diffSections(diff: string) {
  return diff.split(/(?=^diff --git )/m).filter(Boolean);
}
// Refit renders quoted paths; `git diff` leaves plain ones unquoted.
const touchesPackage = (section: string, directory?: string) =>
  PACKAGE_FILES.map((file) => (directory ? `${directory}/${file}` : file)).some(
    (path) =>
      section.startsWith(`diff --git "a/${path}" "b/${path}"`) ||
      section.startsWith(`diff --git a/${path} b/${path}\n`),
  );

// The dependency part of a rendered patch (package.json and its lockfile, at the root or in the
// nested package Refit prepares).
export function packageDiff(diff: string, directory?: string) {
  return diffSections(diff)
    .filter((section) => touchesPackage(section, directory))
    .join('');
}

export function codeDiff(diff: string) {
  return diffSections(diff)
    .filter((section) => !touchesPackage(section))
    .join('');
}

export interface PackageUpgrade {
  from: string;
  to: string;
  files: { path: string; before: string; after: string }[];
  // Replaces the default patch warning when the upgrade is not a verified lockfile edit.
  warning?: string;
  // Types-only peers raised with stripe, which the draft names.
  raised?: Raised;
}

type Refusal = { reason: string };
type Lock = [string, () => Promise<{ upgrade: PackageUpgrade } | Refusal>];
interface Declaration {
  section: 'dependencies' | 'devDependencies';
  spec: string;
  newSpec: (target: string) => string;
  unique: boolean;
  rewrite: (target: string, text?: string, prefix?: string) => string;
}
interface Release {
  tarball: string;
  integrity: string;
  shasum?: string;
  license?: string;
  engines?: Record<string, unknown>;
  dependencies: Record<string, string>;
  peers: Record<string, string>;
  peerMeta: Record<string, unknown>;
  requiredPeers: string[];
}

// Only the `>=X[.Y[.Z]]` form stripe-node uses; any other range counts as unsatisfied.
// The same major.minor as `target`, at or above its patch (23.0.1 for 23.0.0, never 23.1.0).
export function samePatchLine(version: unknown, target: string) {
  const actual = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  const wanted = /^(\d+)\.(\d+)\.(\d+)$/.exec(target);
  return Boolean(
    actual &&
    wanted &&
    actual[1] === wanted[1] &&
    actual[2] === wanted[2] &&
    Number(actual[3]) >= Number(wanted[3]),
  );
}

function satisfiesMinimum(version: unknown, range: string) {
  const minimum = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  const actual = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!minimum || !actual) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(actual[index]) - Number(minimum[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

export function stringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

export function manifestDeclaration(
  manifest: Record<string, unknown>,
  manifestText: string,
  name = 'stripe',
): Declaration | Refusal {
  const section = (['dependencies', 'devDependencies'] as const).find(
    (key) => isObject(manifest[key]) && typeof manifest[key][name] === 'string',
  );
  if (!section) return { reason: `The root package.json does not declare ${name}.` };
  const spec = (manifest[section] as Record<string, string>)[name];
  const parsed = VERSION_SPEC.exec(spec);
  if (!parsed) return { reason: `The ${name} version "${spec}" is not an exact, ^ or ~ version.` };
  const declaration = new RegExp(
    `(${JSON.stringify(name).replace(/[.\\/-]/g, '\\$&')}\\s*:\\s*")${spec.replace(/[.^~]/g, '\\$&')}"`,
    'g',
  );
  return {
    section,
    spec,
    newSpec: (target: string) => `${parsed[1]}${target}`,
    unique: (manifestText.match(declaration) ?? []).length === 1,
    rewrite: (target: string, text = manifestText, prefix = parsed[1]) =>
      text.replace(declaration, `$1${prefix}${target}"`),
  };
}

// Benchmark runs under load saw single connection resets; a short retry keeps them from skipping
// the upgrade. Any other failure is reported at once.
export async function npmRegistryResponse(url: string, accept = 'application/json') {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchSpecificationResponse(
        url,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Accept: accept },
        },
        'npm registry',
      );
    } catch (error) {
      if (!(error instanceof SpecificationUnavailableError) || attempt === REGISTRY_ATTEMPTS)
        throw error;
      await new Promise((done) => setTimeout(done, REGISTRY_RETRY_MS * attempt));
    }
  }
}

async function registryRelease(target: string): Promise<Release | Refusal> {
  let metadata: unknown;
  try {
    const response = await npmRegistryResponse(`${REGISTRY}${target}`);
    if (!response.ok) {
      await response.body?.cancel();
      return { reason: `The npm registry returned HTTP ${response.status} for stripe ${target}.` };
    }
    metadata = JSON.parse(await readBoundedResponse(response, MAX_METADATA_BYTES, 'npm registry'));
  } catch (error) {
    return {
      reason: `stripe ${target} metadata could not be read from the npm registry: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const dist = isObject(metadata) ? metadata.dist : undefined;
  if (
    !isObject(metadata) ||
    metadata.name !== 'stripe' ||
    metadata.version !== target ||
    !isObject(dist) ||
    dist.tarball !== `${REGISTRY}-/stripe-${target}.tgz` ||
    typeof dist.integrity !== 'string' ||
    !INTEGRITY.test(dist.integrity)
  )
    return {
      reason: `The npm registry metadata for stripe ${target} is not a verifiable release.`,
    };
  const dependencies = metadata.dependencies ?? {};
  const peers = metadata.peerDependencies ?? {};
  const peerMeta = isObject(metadata.peerDependenciesMeta) ? metadata.peerDependenciesMeta : {};
  if (!stringRecord(dependencies) || !stringRecord(peers))
    return { reason: `stripe ${target} declares unreadable dependencies.` };
  const requiredPeers = Object.keys(peers).filter(
    (name) => !(isObject(peerMeta[name]) && peerMeta[name].optional === true),
  );
  return {
    tarball: dist.tarball as string,
    integrity: dist.integrity,
    ...(typeof dist.shasum === 'string' && /^[a-f0-9]{40}$/.test(dist.shasum)
      ? { shasum: dist.shasum }
      : {}),
    license: typeof metadata.license === 'string' ? metadata.license : undefined,
    engines: isObject(metadata.engines) ? metadata.engines : undefined,
    dependencies,
    peers,
    peerMeta,
    requiredPeers,
  };
}

function dependencyChanges(target: string, names: string[]): Refusal {
  return {
    reason: `stripe ${target} needs dependency changes (${names.join(', ')}); regenerate the lockfile instead.`,
  };
}

// npm ci and pnpm both reject an optional peer that is installed outside the range.
function peerConflicts(
  target: string,
  peers: Record<string, string>,
  installed: (name: string) => unknown,
  source = 'the lockfile',
): Refusal | undefined {
  const conflicts = Object.entries(peers).filter(([name, range]) => {
    const version = installed(name);
    return version !== undefined && !satisfiesMinimum(version, range);
  });
  return conflicts.length
    ? {
        reason: `stripe ${target} needs ${conflicts.map(([name, range]) => `${name} ${range}`).join(', ')}, which ${source} does not provide; upgrade it first.`,
      }
    : undefined;
}

// Moves a root npm, pnpm or Yarn 1 project's stripe dependency to the release for `apiVersion`,
// editing only package.json and its lockfile. Anything unusual is refused with a reason, never guessed.
export async function stripePackageUpgrade(
  root: string,
  apiVersion: string,
  // The networked resolver (lockfile-resolution.ts) a types-only peer bump re-resolves with.
  resolution?: Resolution,
  // Of several committed lockfiles, the one preparation installs (dependency-inputs.ts).
  lockfile?: string,
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  const target = STRIPE_SDK_RELEASES[apiVersion];
  if (!target)
    return { reason: `No stripe-node release is recorded for API version ${apiVersion}.` };
  const read = (path: string) => readFile(join(root, path), 'utf8').catch(() => undefined);
  const [manifestText, npmLock, pnpmLock, yarnLock, ...otherLocks] = await Promise.all([
    read('package.json'),
    read('package-lock.json'),
    read('pnpm-lock.yaml'),
    read('yarn.lock'),
    read('npm-shrinkwrap.json'),
    read('bun.lock'),
    read('bun.lockb'),
  ]);
  if (
    manifestText !== undefined &&
    [npmLock, pnpmLock, yarnLock, ...otherLocks].every((text) => text === undefined)
  )
    return manifestUpgrade(target, manifestText, Boolean(resolution));
  const locks = [
    npmLock && [
      'package-lock.json',
      () =>
        npmUpgrade(
          target,
          manifestText!,
          npmLock,
          resolution && { ...resolution, npmrc: () => read('.npmrc') },
        ),
    ],
    pnpmLock && ['pnpm-lock.yaml', () => pnpmUpgrade(target, manifestText!, pnpmLock)],
    yarnLock && ['yarn.lock', () => yarnUpgrade(target, manifestText!, yarnLock)],
  ].filter((entry): entry is Lock => Array.isArray(entry));
  if (manifestText === undefined || !locks.length)
    return {
      reason:
        'Only root npm, pnpm or Yarn 1 projects with package.json and at least one of package-lock.json, pnpm-lock.yaml or yarn.lock are upgraded.',
    };
  if (locks.length === 1) return locks[0][1]();
  const every = await everyLockfileUpgrade(locks.map(([, upgrade]) => upgrade));
  const chosen = locks.find(([path]) => path === lockfile);
  if ('upgrade' in every || !chosen) return every;
  return chosenLockfileUpgrade(
    chosen[1],
    locks.flatMap(([path]) => (path === lockfile ? [] : [path])),
  );
}

// Founder decision (Otabek, 2026-10-28): when the lockfiles cannot all be upgraded together, the
// one preparation chose is upgraded alone, and the others stay as committed; the warning names them.
async function chosenLockfileUpgrade(
  chosen: Lock[1],
  others: string[],
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  const result = await chosen();
  if ('reason' in result) return result;
  const { upgrade } = result;
  return {
    upgrade: {
      ...upgrade,
      warning: `${upgrade.warning ?? `Upgrades stripe from ${upgrade.from} to ${upgrade.to} in ${upgrade.files.map((file) => file.path).join(' and ')}, using the npm registry's SHA-512 integrity. A major SDK upgrade can change other types and behavior; review the stripe-node changelog.`} Refit installed and upgraded ${upgrade.files[1].path} only and left ${others.join(' and ')} as committed, so ${others.length === 1 ? 'it' : 'they'} can still lock the older stripe. Delete the lockfile your package manager does not use.`,
    },
  };
}

// A project that commits several lockfiles installs from whichever its package manager reads, so
// each one is upgraded by its own rules and the upgrade is kept only when every one succeeds from
// the same locked release.
async function everyLockfileUpgrade(
  locks: (() => Promise<{ upgrade: PackageUpgrade } | Refusal>)[],
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  const upgrades: PackageUpgrade[] = [];
  for (const lock of locks) {
    const result = await lock();
    if ('reason' in result) return result;
    upgrades.push(result.upgrade);
  }
  const [first, ...rest] = upgrades;
  const lockPath = (upgrade: PackageUpgrade) => upgrade.files[1].path;
  const other = rest.find((upgrade) => upgrade.from !== first.from);
  if (other)
    return {
      reason: `${lockPath(first)} locks stripe ${first.from} and ${lockPath(other)} locks ${other.from}; the lockfiles disagree, so the installed release is not known.`,
    };
  // Every manager rewrites package.json the same way, so the first rewrite stands for all.
  return {
    upgrade: { ...first, files: [first.files[0], ...upgrades.map((upgrade) => upgrade.files[1])] },
  };
}

// The lower bound of a declared exact, ^ or ~ version (`^20` is 20.0.0); null for any other range.
function declaredMinimum(spec: string) {
  const parsed = /^[~^]?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(spec);
  return parsed ? `${parsed[1]}.${parsed[2] ?? 0}.${parsed[3] ?? 0}` : null;
}

// Without a lockfile `npm install` resolves package.json afresh, so the upgrade is that file alone.
// The release is pinned exactly: a ^ or ~ range could install a later stripe-node whose types
// accept only a newer API version than the patch moves to.
async function manifestUpgrade(
  target: string,
  manifestText: string,
  resolved = false,
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  let manifest: unknown;
  try {
    manifest = parseJson(manifestText);
  } catch {
    return { reason: 'package.json is not valid JSON.' };
  }
  if (!isObject(manifest)) return { reason: 'package.json is not an object.' };
  const root = manifest;
  if (root.workspaces !== undefined)
    return { reason: 'Workspaces without a lockfile are not upgraded.' };
  const declared = manifestDeclaration(root, manifestText);
  if ('reason' in declared) return declared;
  if (declared.spec === target) return { reason: `stripe ${target} is already declared.` };
  if (!declared.unique) return { reason: 'package.json declares stripe more than once.' };
  const release = await registryRelease(target);
  if ('reason' in release) return release;
  if (release.requiredPeers.length) return dependencyChanges(target, release.requiredPeers);
  const installed = (name: string) => {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const declarations = root[section];
      const spec = isObject(declarations) ? declarations[name] : undefined;
      if (spec !== undefined) return typeof spec === 'string' ? declaredMinimum(spec) : null;
    }
    return undefined;
  };
  const conflict = peerConflicts(target, release.peers, installed, 'package.json');
  const after = declared.rewrite(target, undefined, '');
  // With resolution on, validation resolves the raised peer with the rest (lockfile-resolution.ts).
  const bump =
    conflict && resolved ? typesPeerBump(root, after, release.peers, installed) : undefined;
  if (conflict && !bump) return conflict;
  return {
    upgrade: {
      from: declaredMinimum(declared.spec)!,
      to: target,
      files: [{ path: 'package.json', before: manifestText, after: bump?.text ?? after }],
      ...(bump ? { raised: bump.raised } : {}),
      warning: `Upgrades stripe from ${declared.spec} to exactly ${target}${bump ? ` and ${raisedText(bump.raised, target)}` : ''} in package.json only: the project commits no lockfile, so npm install resolves stripe ${target} and the rest of the dependency tree at install time${resolved ? '. Refit checked the patch against a package-lock.json it resolved for validation only, which this patch does not add, so your own install can resolve other versions' : ', which Refit did not check'}. A major SDK upgrade can change other types and behavior; review the stripe-node changelog.`,
    },
  };
}

type Resolution = { image: string; before: string };
type Raised = { name: string; from: string; to: string; range: string }[];

// Founders' decision (2026-10-27): an @types/* devDependency outside stripe's optional peer range
// is raised with stripe to the lowest version in range, keeping its ^ or ~. Any other conflicting
// peer, or one declared elsewhere or in another form, keeps the refusal.
function typesPeerBump(
  manifest: Record<string, unknown>,
  manifestText: string,
  peers: Record<string, string>,
  installed: (name: string) => unknown,
) {
  let text = manifestText;
  const raised: Raised = [];
  for (const [name, range] of Object.entries(peers)) {
    const version = installed(name);
    if (version === undefined || satisfiesMinimum(version, range)) continue;
    const minimum = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
    const declaration = manifestDeclaration(manifest, text, name);
    if (
      !name.startsWith('@types/') ||
      !minimum ||
      'reason' in declaration ||
      declaration.section !== 'devDependencies' ||
      !declaration.unique
    )
      return undefined;
    const to = `${minimum[1]}.${minimum[2] ?? 0}.${minimum[3] ?? 0}`;
    text = declaration.rewrite(to, text);
    raised.push({ name, from: declaration.spec, to: declaration.newSpec(to), range });
  }
  return raised.length ? { text, raised } : undefined;
}

const raisedText = (raised: Raised, target: string) =>
  raised
    .map(
      ({ name, from, to, range }) =>
        `raises ${name} from ${from} to ${to}, the lowest version in stripe ${target}'s optional peer range ${range}`,
    )
    .join(' and ');

// Re-resolves the committed package-lock.json with stripe and the raised peers changed, and keeps
// it only when nothing changes outside them and the packages only they reach.
async function resolvedPeerUpgrade(
  target: string,
  from: string,
  manifestText: string,
  lockText: string,
  bump: { text: string; raised: Raised },
  resolution: Resolution & { npmrc: () => Promise<string | undefined> },
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  const raised = bump.raised.map(({ name }) => name);
  const npmrc = (await resolution.npmrc()) ?? '';
  if (/^\s*(?:@[^:\s]+:)?registry\s*=|_auth/m.test(npmrc))
    return {
      reason: `stripe ${target} needs ${raised.join(', ')} raised, and .npmrc configures another registry.`,
    };
  let resolved;
  try {
    resolved = await resolveNpmLockfile({
      manifest: bump.text,
      seed: lockText,
      before: resolution.before,
      legacyPeerDeps: legacyPeerDeps(npmrc),
      image: resolution.image,
    });
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return {
      reason: `stripe ${target} needs ${raised.join(', ')} raised, and npm could not re-resolve package-lock.json: ${error.message}`,
    };
  }
  const outside = changesOutside(lockText, resolved.lockfile, ['stripe', ...raised]);
  if (outside.length)
    return {
      reason: `Raising ${raised.join(', ')} with stripe ${target} changes ${outside
        .slice(0, 5)
        .map((key) => key || 'the root record')
        .join(
          ', ',
        )}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''} in package-lock.json, outside stripe, the raised peer and the packages only they reach.`,
    };
  const lock = parseJson(resolved.lockfile);
  const packages = isObject(lock) && isObject(lock.packages) ? lock.packages : {};
  const version = (name: string) => {
    const entry = packages[`node_modules/${name}`];
    return isObject(entry) ? entry.version : undefined;
  };
  // npm picks the newest patch of the caret range; a patch keeps the API version, a minor may not.
  const locked = version('stripe');
  if (
    !samePatchLine(locked, target) ||
    bump.raised.some(({ name, range }) => !satisfiesMinimum(version(name), range))
  )
    return { reason: `npm did not lock stripe ${target} and ${raised.join(', ')} in range.` };
  return {
    upgrade: {
      from,
      to: locked as string,
      files: [
        { path: 'package.json', before: manifestText, after: bump.text },
        { path: 'package-lock.json', before: lockText, after: resolved.lockfile },
      ],
      raised: bump.raised,
      warning: `Upgrades stripe from ${from} to ${locked} and ${raisedText(bump.raised, target)} (now ${bump.raised.map(({ name }) => `${name} ${version(name)}`).join(', ')}). npm re-resolved package-lock.json from the committed one in networked Docker with lifecycle scripts off, as of ${resolution.before}${Object.entries(
        resolved.late,
      )
        .map(([name, pin]) => `, ${name} ${pin.spec} as of ${pin.published}`)
        .join(
          '',
        )}; nothing outside stripe, the raised peer and the packages only they reach changed. A major SDK upgrade and a newer ${raised.join(', ')} can change other types and behavior; review the stripe-node changelog.`,
    },
  };
}

async function npmUpgrade(
  target: string,
  manifestText: string,
  lockText: string,
  resolution?: Resolution & { npmrc: () => Promise<string | undefined> },
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  let manifest: unknown, lock: unknown;
  try {
    manifest = parseJson(manifestText);
    lock = parseJson(lockText);
  } catch {
    return { reason: 'package.json or package-lock.json is not valid JSON.' };
  }
  if (!isObject(manifest) || !isObject(lock) || !isObject(lock.packages))
    return { reason: 'package-lock.json has no packages section.' };
  const declared = manifestDeclaration(manifest, manifestText);
  if ('reason' in declared) return declared;
  if (![2, 3].includes(lock.lockfileVersion as number))
    return { reason: 'Only npm lockfile versions 2 and 3 are upgraded.' };
  // npm keeps a lockfile's indentation and line endings; rewriting the same way keeps the diff to
  // the changed entries.
  const render = NPM_FORMATS.find((format) => format(lock) === lockText);
  if (!render) return { reason: 'package-lock.json is not in npm formatting.' };
  const packages = lock.packages as Record<string, unknown>;
  const entry = packages['node_modules/stripe'];
  if (!isObject(entry) || typeof entry.version !== 'string')
    return { reason: 'package-lock.json does not lock stripe at the project root.' };
  if (entry.version === target) return { reason: `stripe ${target} is already locked.` };
  const release = await registryRelease(target);
  if ('reason' in release) return release;
  const { dependencies, peers, peerMeta } = release;
  const locked = stringRecord(entry.dependencies) ? entry.dependencies : {};
  const missing = Object.entries(dependencies).filter(
    ([name, range]) => locked[name] !== range || !isObject(packages[`node_modules/${name}`]),
  );
  if (missing.length || release.requiredPeers.length)
    return dependencyChanges(target, [...missing.map(([name]) => name), ...release.requiredPeers]);
  const installed = (name: string) => {
    const installed = packages[`node_modules/${name}`];
    return isObject(installed) ? (installed.version ?? null) : undefined;
  };
  const conflict = peerConflicts(target, peers, installed);
  if (conflict) {
    const bump =
      resolution && declared.unique
        ? typesPeerBump(manifest, declared.rewrite(target), peers, installed)
        : undefined;
    return bump && resolution
      ? resolvedPeerUpgrade(target, entry.version, manifestText, lockText, bump, resolution)
      : conflict;
  }
  const optional = (value: Record<string, string>, key: string) =>
    Object.keys(value).length ? { [key]: value } : {};
  packages['node_modules/stripe'] = {
    version: target,
    resolved: release.tarball,
    integrity: release.integrity,
    ...(entry.dev === true ? { dev: true } : {}),
    ...(release.license ? { license: release.license } : {}),
    ...optional(dependencies, 'dependencies'),
    ...(release.engines ? { engines: release.engines } : {}),
    ...optional(peers, 'peerDependencies'),
    ...(Object.keys(peerMeta).length ? { peerDependenciesMeta: peerMeta } : {}),
  };
  const newSpec = declared.newSpec(target);
  const rootEntry = packages[''];
  const rootSection = isObject(rootEntry) ? rootEntry[declared.section] : undefined;
  if (isObject(rootSection) && typeof rootSection.stripe === 'string') rootSection.stripe = newSpec;
  if (isObject(lock.dependencies) && isObject(lock.dependencies.stripe))
    lock.dependencies.stripe = {
      version: target,
      resolved: release.tarball,
      integrity: release.integrity,
      ...(lock.dependencies.stripe.dev === true ? { dev: true } : {}),
      ...optional(dependencies, 'requires'),
    };
  if (!declared.unique) return { reason: 'package.json declares stripe more than once.' };
  return {
    upgrade: {
      from: entry.version,
      to: target,
      files: [
        { path: 'package.json', before: manifestText, after: declared.rewrite(target) },
        {
          path: 'package-lock.json',
          before: lockText,
          after: render(lock),
        },
      ],
    },
  };
}

// Snapshot keys reachable from the importers, following snapshot dependencies.
function reachableSnapshots(lock: Record<string, unknown>) {
  const snapshots = isObject(lock.snapshots) ? lock.snapshots : {};
  const seen = new Set<string>();
  const visit = (name: string, version: unknown) => {
    if (typeof version !== 'string') return;
    const base = version.split('(')[0];
    const key = EXACT_PACKAGE_VERSION.test(base) ? `${name}@${version}` : version;
    const snapshot = snapshots[key];
    if (seen.has(key) || !isObject(snapshot)) return;
    seen.add(key);
    for (const section of ['dependencies', 'optionalDependencies'])
      if (isObject(snapshot[section]))
        for (const [child, value] of Object.entries(snapshot[section])) visit(child, value);
  };
  for (const importer of Object.values(isObject(lock.importers) ? lock.importers : {}))
    for (const section of PNPM_IMPORTER_SECTIONS)
      if (isObject(importer) && isObject(importer[section]))
        for (const [name, entry] of Object.entries(importer[section]))
          if (isObject(entry)) visit(name, entry.version);
  return seen;
}

// Replaces one top-level map entry in place, keeping the blank line pnpm puts before it.
function replaceEntry(document: Document, map: string, key: string, newKey: string, value: object) {
  const node = document.get(map, true);
  if (!isMap(node)) return false;
  const index = node.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === key);
  if (index < 0) return false;
  const pair = document.createPair(newKey, value);
  if (isScalar(pair.key))
    pair.key.spaceBefore = (node.items[index].key as { spaceBefore?: boolean }).spaceBefore;
  node.items.splice(index, 1, pair);
  return true;
}

function setFlow(document: Document, path: string[]) {
  const node = document.getIn(path, true);
  if (isMap(node)) node.flow = true;
}

async function pnpmUpgrade(
  target: string,
  manifestText: string,
  lockText: string,
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  let manifest: unknown;
  try {
    manifest = parseJson(manifestText);
  } catch {
    return { reason: 'package.json is not valid JSON.' };
  }
  if (!isObject(manifest)) return { reason: 'package.json is not an object.' };
  const declared = manifestDeclaration(manifest, manifestText);
  if ('reason' in declared) return declared;
  const document = parseDocument(lockText);
  // Rewriting with pnpm's own formatting keeps the diff to the changed entries.
  if (document.errors.length || document.toString(PNPM_FORMAT) !== lockText)
    return { reason: 'pnpm-lock.yaml is not a single document in pnpm formatting.' };
  const lock = document.toJS() as unknown;
  if (isObject(lock) && lock.lockfileVersion === '6.0')
    return pnpmV6Upgrade(target, manifestText, lockText, declared, document, lock);
  if (!isObject(lock) || lock.lockfileVersion !== '9.0')
    return { reason: 'Only pnpm lockfile versions 6 and 9 are upgraded.' };
  const importers = isObject(lock.importers) ? lock.importers : {};
  const importer = isObject(importers['.']) ? importers['.'] : {};
  const declaredSection = importer[declared.section];
  const entry = isObject(declaredSection) ? declaredSection.stripe : undefined;
  if (!isObject(entry) || entry.specifier !== declared.spec || typeof entry.version !== 'string')
    return { reason: 'pnpm-lock.yaml does not lock the declared stripe at the project root.' };
  const from = entry.version.split('(')[0];
  if (!EXACT_PACKAGE_VERSION.test(from))
    return { reason: 'pnpm-lock.yaml does not lock stripe to a registry version.' };
  if (from === target) return { reason: `stripe ${target} is already locked.` };
  const snapshots = isObject(lock.snapshots) ? lock.snapshots : {};
  const lockedElsewhere =
    Object.entries(importers).some(
      ([path, value]) =>
        path !== '.' &&
        isObject(value) &&
        PNPM_IMPORTER_SECTIONS.some((section) => isObject(value[section]) && value[section].stripe),
    ) ||
    Object.values(snapshots).some(
      (snapshot) =>
        isObject(snapshot) &&
        ['dependencies', 'optionalDependencies'].some(
          (section) => isObject(snapshot[section]) && snapshot[section].stripe !== undefined,
        ),
    );
  if (lockedElsewhere)
    return { reason: 'stripe is locked by more than the root importer in pnpm-lock.yaml.' };
  if (!declared.unique) return { reason: 'package.json declares stripe more than once.' };
  const release = await registryRelease(target);
  if ('reason' in release) return release;
  // pnpm records dependencies only in snapshots; a release that adds any needs a fresh resolution.
  const added = Object.keys(release.dependencies);
  if (added.length || release.requiredPeers.length)
    return dependencyChanges(target, [...added, ...release.requiredPeers]);
  const rootVersion = (name: string) => {
    for (const section of PNPM_IMPORTER_SECTIONS) {
      const locked = isObject(importer[section])
        ? (importer[section] as Record<string, unknown>)[name]
        : undefined;
      if (isObject(locked)) return locked.version ?? null;
    }
    return undefined;
  };
  const conflict = peerConflicts(target, release.peers, rootVersion);
  if (conflict) return conflict;
  // Optional peers the root installs qualify the snapshot, as pnpm names them: (name@version).
  const peers = Object.keys(release.peers)
    .sort()
    .flatMap((name) => {
      const version = rootVersion(name);
      return typeof version === 'string' ? [[name, version] as const] : [];
    });
  if (peers.some(([, version]) => !EXACT_PACKAGE_VERSION.test(version)))
    return { reason: 'An optional stripe peer is locked with its own peer qualifiers.' };
  const qualified = `${target}${peers.map(([name, version]) => `(${name}@${version})`).join('')}`;
  const before = reachableSnapshots(lock);
  const packageKey = `stripe@${from}`;
  const snapshotKey = `stripe@${entry.version}`;
  const record = {
    resolution: { integrity: release.integrity },
    ...(release.engines ? { engines: release.engines } : {}),
    ...(Object.keys(release.peers).length ? { peerDependencies: release.peers } : {}),
    ...(Object.keys(release.peerMeta).length ? { peerDependenciesMeta: release.peerMeta } : {}),
  };
  const snapshot = peers.length ? { optionalDependencies: Object.fromEntries(peers) } : {};
  if (
    !replaceEntry(document, 'packages', packageKey, `stripe@${target}`, record) ||
    !replaceEntry(document, 'snapshots', snapshotKey, `stripe@${qualified}`, snapshot)
  )
    return { reason: 'pnpm-lock.yaml does not record the locked stripe package and snapshot.' };
  setFlow(document, ['packages', `stripe@${target}`, 'resolution']);
  setFlow(document, ['packages', `stripe@${target}`, 'engines']);
  const path = ['importers', '.', declared.section, 'stripe'];
  document.setIn([...path, 'specifier'], declared.newSpec(target));
  document.setIn([...path, 'version'], qualified);
  // Drop only what the old stripe made reachable: its own records and dependencies nothing else uses.
  const after = reachableSnapshots(document.toJS() as Record<string, unknown>);
  const kept = new Set([...after].map((key) => key.split('(')[0]));
  for (const key of before) {
    if (after.has(key)) continue;
    document.deleteIn(['snapshots', key]);
    const base = key.split('(')[0];
    if (!kept.has(base)) document.deleteIn(['packages', base]);
  }
  return {
    upgrade: {
      from,
      to: target,
      files: [
        { path: 'package.json', before: manifestText, after: declared.rewrite(target) },
        { path: 'pnpm-lock.yaml', before: lockText, after: document.toString(PNPM_FORMAT) },
      ],
    },
  };
}

// pnpm 8's lockfile v6 for one project: root sections at the top level and `/name@version(peers)`
// package records that carry their own dependencies and pnpm's `dev` and `optional` flags.
const V6_ROOT_SECTIONS = ['dependencies', 'optionalDependencies', 'devDependencies'] as const;

function v6Key(name: string, version: unknown) {
  if (typeof version !== 'string') return null;
  if (version.startsWith('link:')) return undefined;
  return version.startsWith('/') ? version : `/${name}@${version}`;
}

// `dev: false` when only production dependencies reach a package, `dev: true` when only development
// ones do, neither when both; `optional: true` when every path goes through an optional dependency.
// Undefined when a dependency names no record.
function v6Flags(lock: Record<string, unknown>) {
  const packages = isObject(lock.packages) ? lock.packages : {};
  const states = new Map<string, Set<string>>();
  const pending: [string, string, boolean][] = [];
  let missing = false;
  const reach = (name: string, version: unknown, kind: string, optional: boolean) => {
    const key = v6Key(name, version);
    if (key === undefined) return;
    if (key === null || !isObject(packages[key])) {
      missing = true;
      return;
    }
    const state = `${kind}:${optional}`;
    const seen = states.get(key) ?? new Set<string>();
    if (seen.has(state)) return;
    seen.add(state);
    states.set(key, seen);
    pending.push([key, kind, optional]);
  };
  for (const section of V6_ROOT_SECTIONS) {
    const entries = isObject(lock[section]) ? lock[section] : {};
    for (const [name, entry] of Object.entries(entries))
      if (isObject(entry))
        reach(
          name,
          entry.version,
          section === 'devDependencies' ? 'dev' : 'prod',
          section === 'optionalDependencies',
        );
  }
  while (pending.length) {
    const [key, kind, optional] = pending.pop()!;
    const record = packages[key] as Record<string, unknown>;
    for (const [section, isOptional] of [
      ['dependencies', optional],
      ['optionalDependencies', true],
    ] as const)
      if (isObject(record[section]))
        for (const [name, version] of Object.entries(record[section]))
          reach(name, version, kind, isOptional);
  }
  if (missing) return undefined;
  return new Map(
    [...states].map(([key, seen]) => {
      const kinds = new Set([...seen].map((state) => state.split(':')[0]));
      return [
        key,
        {
          dev: kinds.size === 2 ? undefined : kinds.has('dev'),
          optional: [...seen].every((state) => state.endsWith(':true')) || undefined,
        },
      ] as const;
    }),
  );
}

async function pnpmV6Upgrade(
  target: string,
  manifestText: string,
  lockText: string,
  declared: Declaration,
  document: Document,
  lock: Record<string, unknown>,
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  if (lock.importers !== undefined)
    return { reason: 'Only single-project pnpm lockfile version 6 files are upgraded.' };
  const packages = isObject(lock.packages) ? lock.packages : {};
  // Refit's model of pnpm's flags must reproduce the recorded ones before it rewrites them.
  const original = v6Flags(lock);
  if (
    !original ||
    Object.entries(packages).some(([key, record]) => {
      const flags = original.get(key);
      return (
        !isObject(record) ||
        !flags ||
        record.dev !== flags.dev ||
        (record.optional === true) !== Boolean(flags.optional)
      );
    })
  )
    return {
      reason: 'pnpm-lock.yaml (v6) dev and optional flags do not match its dependency graph.',
    };
  const section = lock[declared.section];
  const entry = isObject(section) ? section.stripe : undefined;
  if (!isObject(entry) || entry.specifier !== declared.spec || typeof entry.version !== 'string')
    return { reason: 'pnpm-lock.yaml does not lock the declared stripe at the project root.' };
  const from = entry.version.split('(')[0];
  if (!EXACT_PACKAGE_VERSION.test(from))
    return { reason: 'pnpm-lock.yaml does not lock stripe to a registry version.' };
  if (from === target) return { reason: `stripe ${target} is already locked.` };
  const oldKey = `/stripe@${entry.version}`;
  const lockedElsewhere =
    V6_ROOT_SECTIONS.some(
      (name) => name !== declared.section && isObject(lock[name]) && lock[name].stripe,
    ) ||
    Object.entries(packages).some(
      ([key, record]) =>
        key !== oldKey &&
        isObject(record) &&
        ['dependencies', 'optionalDependencies'].some(
          (name) => isObject(record[name]) && record[name].stripe !== undefined,
        ),
    );
  if (lockedElsewhere)
    return { reason: 'stripe is locked by more than the root declaration in pnpm-lock.yaml.' };
  if (!declared.unique) return { reason: 'package.json declares stripe more than once.' };
  const release = await registryRelease(target);
  if ('reason' in release) return release;
  const added = Object.keys(release.dependencies);
  if (added.length || release.requiredPeers.length)
    return dependencyChanges(target, [...added, ...release.requiredPeers]);
  const rootVersion = (name: string) => {
    for (const root of V6_ROOT_SECTIONS) {
      const locked = isObject(lock[root])
        ? (lock[root] as Record<string, unknown>)[name]
        : undefined;
      if (isObject(locked)) return locked.version ?? null;
    }
    return undefined;
  };
  const conflict = peerConflicts(target, release.peers, rootVersion);
  if (conflict) return conflict;
  const peers = Object.keys(release.peers)
    .sort()
    .flatMap((name) => {
      const version = rootVersion(name);
      return typeof version === 'string' ? [[name, version] as const] : [];
    });
  if (peers.some(([, version]) => !EXACT_PACKAGE_VERSION.test(version)))
    return { reason: 'An optional stripe peer is locked with its own peer qualifiers.' };
  const qualified = `${target}${peers.map(([name, version]) => `(${name}@${version})`).join('')}`;
  const newKey = `/stripe@${qualified}`;
  const record = {
    resolution: { integrity: release.integrity },
    ...(release.engines ? { engines: release.engines } : {}),
    ...(Object.keys(release.peers).length ? { peerDependencies: release.peers } : {}),
    ...(Object.keys(release.peerMeta).length ? { peerDependenciesMeta: release.peerMeta } : {}),
    ...(peers.length ? { dependencies: Object.fromEntries(peers) } : {}),
  };
  if (!replaceEntry(document, 'packages', oldKey, newKey, record))
    return { reason: 'pnpm-lock.yaml does not record the locked stripe package.' };
  setFlow(document, ['packages', newKey, 'resolution']);
  setFlow(document, ['packages', newKey, 'engines']);
  document.setIn([declared.section, 'stripe', 'specifier'], declared.newSpec(target));
  document.setIn([declared.section, 'stripe', 'version'], qualified);
  // Drop what only the old stripe reached, then rewrite every flag the new graph changes.
  const flags = v6Flags(document.toJS() as Record<string, unknown>);
  if (!flags) return { reason: 'pnpm-lock.yaml (v6) names a package it does not record.' };
  for (const key of Object.keys(packages))
    if (key !== oldKey && !flags.has(key)) document.deleteIn(['packages', key]);
  for (const [key, { dev, optional }] of flags) {
    const node = document.getIn(['packages', key], true);
    if (!isMap(node)) continue;
    const index = (name: string) =>
      node.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === name);
    if (index('dev') >= 0) node.items.splice(index('dev'), 1);
    if (dev !== undefined) {
      const at = index('optional');
      node.items.splice(at >= 0 ? at : node.items.length, 0, document.createPair('dev', dev));
    }
    if (!optional && index('optional') >= 0) node.items.splice(index('optional'), 1);
  }
  return {
    upgrade: {
      from,
      to: target,
      files: [
        { path: 'package.json', before: manifestText, after: declared.rewrite(target) },
        { path: 'pnpm-lock.yaml', before: lockText, after: document.toString(PNPM_FORMAT) },
      ],
    },
  };
}

interface YarnBlock {
  descriptors: string[];
  text: string;
  dependencies: [string, string][];
}

const unquote = (value: string) => value.replace(/^"|"$/g, '');

// Yarn 1 blocks: an unindented descriptor line, then two-space fields and four-space dependencies,
// separated by one blank line. `body` is the file without its final newline.
function yarnBlocks(body: string) {
  const [header, ...chunks] = body.split(/\n\n(?=\S)/);
  const blocks: YarnBlock[] = [];
  for (const text of chunks) {
    const [key, ...lines] = text.split('\n');
    if (!key.endsWith(':') || key.startsWith('#')) return undefined;
    const dependencies: [string, string][] = [];
    let section = '';
    for (const line of lines) {
      if (/^ {2}\S/.test(line)) section = line.trim();
      else if (['dependencies:', 'optionalDependencies:'].includes(section)) {
        const match = /^ {4}("[^"]+"|\S+) ("[^"]+"|\S+)$/.exec(line);
        if (!match) return undefined;
        dependencies.push([unquote(match[1]), unquote(match[2])]);
      }
    }
    blocks.push({ descriptors: key.slice(0, -1).split(/,\s*/).map(unquote), text, dependencies });
  }
  return { header, blocks };
}

// Blocks reachable from the root manifest's dependency declarations.
function reachableBlocks(manifest: Record<string, unknown>, blocks: YarnBlock[]) {
  const byDescriptor = new Map(
    blocks.flatMap((block) => block.descriptors.map((descriptor) => [descriptor, block] as const)),
  );
  const seen = new Set<YarnBlock>();
  const visit = (name: string, range: string) => {
    const block = byDescriptor.get(`${name}@${range}`);
    if (!block || seen.has(block)) return;
    seen.add(block);
    for (const [child, childRange] of block.dependencies) visit(child, childRange);
  };
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const declared = manifest[section];
    if (isObject(declared))
      for (const [name, range] of Object.entries(declared))
        if (typeof range === 'string') visit(name, range);
  }
  return seen;
}

const YARN_RESOLVED =
  /^ {2}resolved "(https:\/\/registry\.(?:yarnpkg\.com|npmjs\.org))\/stripe\/-\/stripe-[^"#]+\.tgz(#[a-f0-9]{40})?"$/m;

async function yarnUpgrade(
  target: string,
  manifestText: string,
  lockText: string,
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  let manifest: unknown;
  try {
    manifest = parseJson(manifestText);
  } catch {
    return { reason: 'package.json is not valid JSON.' };
  }
  if (!isObject(manifest)) return { reason: 'package.json is not an object.' };
  if (manifest.workspaces !== undefined)
    return { reason: 'Yarn workspaces are not upgraded; regenerate the lockfile instead.' };
  const declared = manifestDeclaration(manifest, manifestText);
  if ('reason' in declared) return declared;
  if (!/^# yarn lockfile v1$/m.test(lockText) || lockText.includes('\r'))
    return { reason: 'Only Yarn 1 lockfiles with LF line endings are upgraded.' };
  const newline = lockText.endsWith('\n') ? '\n' : '';
  const parsed = yarnBlocks(lockText.slice(0, lockText.length - newline.length));
  const render = (blocks: YarnBlock[]) =>
    `${[parsed!.header, ...blocks.map((block) => block.text)].join('\n\n')}${newline}`;
  if (!parsed || render(parsed.blocks) !== lockText)
    return { reason: 'yarn.lock is not in Yarn 1 formatting.' };
  const stripeBlocks = parsed.blocks.filter((block) =>
    block.descriptors.some((descriptor) => descriptor.startsWith('stripe@')),
  );
  const block = stripeBlocks[0];
  if (stripeBlocks.length !== 1 || block.descriptors.join() !== `stripe@${declared.spec}`)
    return { reason: 'yarn.lock locks stripe for more than the root declaration.' };
  const from = /^ {2}version "([^"]+)"$/m.exec(block.text)?.[1];
  const resolved = YARN_RESOLVED.exec(block.text);
  if (!from || !EXACT_PACKAGE_VERSION.test(from) || !resolved)
    return { reason: 'yarn.lock does not lock stripe to a public registry version.' };
  if (from === target) return { reason: `stripe ${target} is already locked.` };
  if (!declared.unique) return { reason: 'package.json declares stripe more than once.' };
  const release = await registryRelease(target);
  if ('reason' in release) return release;
  // Yarn 1 does not install peers, so only regular dependencies would need a fresh resolution.
  const added = Object.keys(release.dependencies);
  if (added.length) return dependencyChanges(target, added);
  if (resolved[2] && !release.shasum)
    return { reason: `The npm registry metadata for stripe ${target} has no SHA-1 checksum.` };
  const newSpec = declared.newSpec(target);
  const replacement: YarnBlock = {
    descriptors: [`stripe@${newSpec}`],
    dependencies: [],
    text: [
      block.text.startsWith('"') ? `"stripe@${newSpec}":` : `stripe@${newSpec}:`,
      `  version "${target}"`,
      `  resolved "${resolved[1]}/stripe/-/stripe-${target}.tgz${resolved[2] ? `#${release.shasum}` : ''}"`,
      `  integrity ${release.integrity}`,
    ].join('\n'),
  };
  const manifestAfter = declared.rewrite(target);
  const before = reachableBlocks(manifest, parsed.blocks);
  const updated = parsed.blocks.map((entry) => (entry === block ? replacement : entry));
  const after = reachableBlocks(parseJson(manifestAfter) as Record<string, unknown>, updated);
  // Drop only what the old stripe made reachable: blocks nothing else in the root graph uses.
  const kept = updated.filter((entry) => after.has(entry) || !before.has(entry));
  return {
    upgrade: {
      from,
      to: target,
      files: [
        { path: 'package.json', before: manifestText, after: manifestAfter },
        { path: 'yarn.lock', before: lockText, after: render(kept) },
      ],
    },
  };
}
