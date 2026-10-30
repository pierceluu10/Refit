import { readdir, readFile } from 'node:fs/promises';
import { readCommittedRepository } from './committed-repository.ts';
import { chosenLockfile, legacyPeerDeps, readPreparationInputs } from './dependency-inputs.ts';
import { lockChangesOutside, lockedReleases, type LockedProject } from './lockfile-graph.ts';
import {
  RESOLUTION_LOCKFILES,
  resolveNpmLockfile,
  type ResolutionManager,
} from './lockfile-resolution.ts';
import { parsePnpmLock } from './pnpm-lock.ts';
import { CLASSIC_HEADER } from './yarn-lock.ts';
import { join } from 'node:path';
import { minimumMajors, SHOPIFY_PACK } from './rule-pack.ts';
import { readBoundedResponse, SpecificationUnavailableError } from './network.ts';
import { SHOPIFY_API, SHOPIFY_API_ENUM_SINCE } from './shopify-versions.ts';
import { isObject, parseJson } from './specifications.ts';
import {
  INTEGRITY,
  manifestDeclaration,
  NPM_FORMATS,
  npmRegistryResponse,
  stringRecord,
  type PackageUpgrade,
} from './stripe-package-upgrade.ts';
import { PipelineInputError } from './types.ts';

// The oldest major of each package a project declares that serves a supported Admin API version
// (data/packs/shopify.json): each depends on @shopify/shopify-api 12, whose 12.1.0 first ships
// ApiVersion.January26.
export const SHOPIFY_SDK_MAJORS = minimumMajors(SHOPIFY_PACK);
const APP_PACKAGES = Object.keys(SHOPIFY_SDK_MAJORS).filter((name) => name !== SHOPIFY_API);
// Packages released together from Shopify/shopify-app-js. The upgrade moves them as one; any other
// package may only be added or moved when it has no dependencies of its own.
const SDK_FAMILY =
  /^@shopify\/(?:shopify-api|shopify-app-(?:remix|react-router|express)|shopify-app-session-storage(?:-[a-z0-9-]+)?|admin-api-client|storefront-api-client|graphql-client)$/;
const SESSION_STORAGE = '@shopify/shopify-app-session-storage';
// The app frameworks Shopify's app packages build on. Decision (2026-10-29, AGENTS.md): when an SDK
// major needs a newer release of them than the lockfile has, npm may re-resolve them.
const PRISMA = ['prisma', '@prisma/client'];
const FRAMEWORK = /^(?:@remix-run\/[a-z0-9.-]+|@react-router\/[a-z0-9.-]+|react-router(?:-dom)?)$/;
const SESSION_ADAPTER = /^@shopify\/shopify-app-session-storage-[a-z0-9-]+$/;
const REGISTRY = 'https://registry.npmjs.org/';
const ABBREVIATED_METADATA = 'application/vnd.npm.install-v1+json';
// Abbreviated metadata of prisma (23 MB) and @prisma/client (38 MB), measured 2026-10-29, which
// the session-storage upgrade reads.
const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024;
const MAX_RELEASE_BYTES = 1024 * 1024;
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;
const WILDCARD = /^[xX*]$/;
const ROOT_PACKAGE = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
// Manifest fields whose lock entries this upgrade does not write; a release with any is skipped.
const UNSUPPORTED_FIELDS = [
  'bin',
  'os',
  'cpu',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'acceptDependencies',
  'hasInstallScript',
  'gypfile',
];
// Arborist's preferred keys for json-stringify-nice, which writes every npm lockfile.
const NPM_KEY_ORDER = [
  'name',
  'version',
  'lockfileVersion',
  'resolved',
  'integrity',
  'requires',
  'packages',
  'dependencies',
];
const FLAGS = ['dev', 'optional', 'devOptional', 'peer'] as const;
const OTHER_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
// Bun for a project that does not pin it in packageManager: the newest release at least two weeks
// old. Source: npm registry, bun versions (1.4.3 published 2026-10-10), 2026-10-29.
const DEFAULT_BUN_VERSION = '1.4.3';
const BUN_PIN = /^bun@(\d+\.\d+\.\d+)(?:\+|$)/;
// The newest @shopify/shopify-api major whose documented breaking changes Refit applies or stops on
// (pipeline/shopify-sdk-source.ts): migrating-to-v12.md and the 13.0.0 and 14.0.0 changelogs.
const NEWEST_RULED_MAJOR = 14;
// Majors whose own breaking change Refit does not migrate, from each package's CHANGELOG.md in
// Shopify/shopify-app-js (read 2026-10-29): crossing one stops the upgrade with the reason.
const UNRULED_MAJORS: Record<string, [number, string][]> = {
  '@shopify/shopify-app-express': [
    [7, 'moves the app from Express 4 to Express 5 (0d4a3f7), a framework migration'],
  ],
  '@shopify/shopify-app-session-storage-sqlite': [
    [6, 'replaces the onlineAccessInfo column with user columns through a data migration'],
  ],
  '@shopify/shopify-app-session-storage-postgresql': [
    [6, 'replaces the onlineAccessInfo column with user columns through a data migration'],
  ],
  '@shopify/shopify-app-session-storage-mysql': [
    [6, 'replaces the onlineAccessInfo column with user columns through a data migration'],
  ],
  '@shopify/shopify-app-session-storage-drizzle': [
    [4, "needs refresh-token columns in the app's own session table"],
  ],
  '@shopify/shopify-app-session-storage-mongodb': [[6, 'moves the mongodb driver from v6 to v7']],
};
const ROOT_SECTIONS = ['dependencies', 'devDependencies'] as const;
// The Node.js each @shopify/shopify-api major needs (npm `engines`, read 2026-10-29).
const NODE_FOR_MAJOR: Record<number, string> = { 12: '20.10.0', 13: '20.10.0', 14: '22.0.0' };

type Triple = [number, number, number];
type Refusal = { reason: string };
type Packages = Record<string, unknown>;
type FlagSet = Record<(typeof FLAGS)[number], boolean>;
interface Release {
  version: string;
  dependencies: Record<string, string>;
  peers: Record<string, string>;
  optionalPeers: Set<string>;
  leaf: boolean;
}
type Plan = Map<string, Release>;

function triple(version: string): Triple | undefined {
  const match = RELEASE.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(left: Triple, right: Triple) {
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function comparator(actual: Triple, text: string): boolean | undefined {
  const match = COMPARATOR.exec(text);
  if (!match) return undefined;
  const operator = match[1] ?? '';
  const [major, minor, patch] = match
    .slice(2)
    .map((part) => (part === undefined || WILDCARD.test(part) ? undefined : Number(part)));
  if (major === undefined) return operator === '' || operator === '=' ? true : undefined;
  const low: Triple = [major, minor ?? 0, patch ?? 0];
  // The exclusive upper bound a partial version (`1`, `1.2`) stands for.
  const partialEnd: Triple | undefined =
    minor === undefined
      ? [major + 1, 0, 0]
      : patch === undefined
        ? [major, minor + 1, 0]
        : undefined;
  const between = (end: Triple) => compare(actual, low) >= 0 && compare(actual, end) < 0;
  switch (operator) {
    case '^':
      return between(
        major > 0 || minor === undefined
          ? [major + 1, 0, 0]
          : minor > 0 || patch === undefined
            ? [0, minor + 1, 0]
            : [0, 0, patch + 1],
      );
    case '~':
      return between(minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0]);
    case '':
    case '=':
      return partialEnd ? between(partialEnd) : compare(actual, low) === 0;
    case '>=':
      return compare(actual, low) >= 0;
    case '>':
      return partialEnd ? compare(actual, partialEnd) >= 0 : compare(actual, low) > 0;
    case '<':
      return compare(actual, low) < 0;
    default:
      return partialEnd ? compare(actual, partialEnd) < 0 : compare(actual, low) <= 0;
  }
}

// The npm range forms these packages use: `^`, `~`, exact and partial versions, comparisons, `*`,
// spaces (and) and `||` (or). Prereleases never match; any other form answers undefined.
export function satisfies(version: string, range: string): boolean | undefined {
  const actual = triple(version);
  if (!actual) return /^\d+\.\d+\.\d+-/.test(version) ? false : undefined;
  let matched = false;
  for (const alternative of range.split('||')) {
    const parts = alternative.trim().split(/\s+/).filter(Boolean);
    let all = true;
    for (const part of parts.length ? parts : ['*']) {
      const result = comparator(actual, part);
      if (result === undefined) return undefined;
      all &&= result;
    }
    matched ||= all;
  }
  return matched;
}

// npm writes lockfiles with json-stringify-nice: in every object, scalars (arrays included) come
// before objects, each group in Arborist's key order and then alphabetically.
function npmSorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(npmSorted);
  if (!isObject(value)) return value;
  const rank = (key: string) => {
    const index = NPM_KEY_ORDER.indexOf(key);
    return index < 0 ? NPM_KEY_ORDER.length : index;
  };
  return Object.fromEntries(
    Object.entries(value)
      .sort(
        ([left, a], [right, b]) =>
          Number(isObject(a)) - Number(isObject(b)) ||
          rank(left) - rank(right) ||
          left.localeCompare(right, 'en'),
      )
      .map(([key, entry]) => [key, npmSorted(entry)]),
  );
}

const byKey = (left: string, right: string) => left.localeCompare(right, 'en');

async function registryJson(url: string, accept: string, limit: number) {
  const response = await npmRegistryResponse(url, accept);
  if (!response.ok) {
    await response.body?.cancel();
    throw new SpecificationUnavailableError(
      `The npm registry returned HTTP ${response.status} for ${url}.`,
    );
  }
  const text = await readBoundedResponse(response, limit, 'npm registry');
  try {
    return parseJson(text);
  } catch {
    throw new PipelineInputError(`The npm registry sent invalid JSON for ${url}.`);
  }
}

const present = (value: unknown) =>
  Boolean(value) && (typeof value !== 'object' || Object.keys(value as object).length > 0);

// A stable release this upgrade can lock, or undefined for prereleases, deprecated releases and
// manifests with fields it does not write.
function readRelease(version: string, value: unknown): Release | undefined {
  if (
    !triple(version) ||
    !isObject(value) ||
    value.version !== version ||
    typeof value.deprecated === 'string' ||
    UNSUPPORTED_FIELDS.some((field) => present(value[field]))
  )
    return undefined;
  const dependencies = value.dependencies ?? {};
  const peers = value.peerDependencies ?? {};
  if (!stringRecord(dependencies) || !stringRecord(peers)) return undefined;
  const meta = isObject(value.peerDependenciesMeta) ? value.peerDependenciesMeta : {};
  return {
    version,
    dependencies,
    peers,
    optionalPeers: new Set(
      Object.keys(peers).filter((name) => isObject(meta[name]) && meta[name].optional === true),
    ),
    leaf: !Object.keys(dependencies).length && !Object.keys(peers).length,
  };
}

// Releases of a package, newest first.
async function releases(name: string) {
  const document = await registryJson(
    `${REGISTRY}${name}`,
    ABBREVIATED_METADATA,
    MAX_PACKUMENT_BYTES,
  );
  if (!isObject(document) || document.name !== name || !isObject(document.versions))
    throw new PipelineInputError(`The npm registry metadata for ${name} is unreadable.`);
  return Object.entries(document.versions)
    .map(([version, value]) => readRelease(version, value))
    .filter((entry): entry is Release => entry !== undefined)
    .sort((left, right) => compare(triple(right.version)!, triple(left.version)!));
}

// Every published release of a package, newest first, prereleases left out.
async function publishedVersions(name: string) {
  const document = await registryJson(
    `${REGISTRY}${name}`,
    ABBREVIATED_METADATA,
    MAX_PACKUMENT_BYTES,
  );
  if (!isObject(document) || !isObject(document.versions))
    throw new PipelineInputError(`The npm registry metadata for ${name} is unreadable.`);
  return Object.keys(document.versions)
    .filter((version) => RELEASE.test(version))
    .sort((left, right) => compare(triple(right)!, triple(left)!));
}

// The lock entry npm writes for a release, from its full registry manifest, before dependency
// flags are added.
async function lockEntry(name: string, version: string) {
  const document = await registryJson(
    `${REGISTRY}${name}/${version}`,
    'application/json',
    MAX_RELEASE_BYTES,
  );
  const tarball = `${REGISTRY}${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
  const dist = isObject(document) ? document.dist : undefined;
  const scripts = isObject(document) && isObject(document.scripts) ? document.scripts : {};
  if (
    !isObject(document) ||
    document.name !== name ||
    !readRelease(version, document) ||
    INSTALL_SCRIPTS.some((script) => script in scripts) ||
    !isObject(dist) ||
    dist.tarball !== tarball ||
    typeof dist.integrity !== 'string' ||
    !INTEGRITY.test(dist.integrity)
  )
    throw new PipelineInputError(
      `The npm registry metadata for ${name} ${version} is not a verifiable release this upgrade can lock.`,
    );
  // Arborist keeps only a license object's type.
  const license = isObject(document.license) ? document.license.type : document.license;
  const field = (key: string, value: unknown = document[key]) =>
    present(value) ? { [key]: value } : {};
  return npmSorted({
    version,
    resolved: tarball,
    integrity: dist.integrity,
    ...field('license', license),
    ...field('dependencies'),
    ...field('engines'),
    ...field('funding'),
    ...field('peerDependencies'),
    ...field('peerDependenciesMeta'),
  }) as Record<string, unknown>;
}

// npm's lookup: the nearest `node_modules/<name>` from the requiring package up to the root.
function resolveKey(packages: Packages, from: string, name: string) {
  let base = from;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (key in packages) return key;
    if (!base) return undefined;
    const index = base.lastIndexOf('/node_modules/');
    base = index >= 0 ? base.slice(0, index) : '';
  }
}

const rootName = (key: string) => ROOT_PACKAGE.exec(key)?.[1];

function rootVersion(packages: Packages, name: string) {
  const entry = packages[`node_modules/${name}`];
  return isObject(entry) && typeof entry.version === 'string' ? entry.version : undefined;
}

// The edges Arborist builds from a lock entry, by dependency name. A later kind replaces an
// earlier one, and the root's workspace links win over everything.
function edges(packages: Packages, key: string, entry: Record<string, unknown>) {
  const kinds = new Map<string, { dev: boolean; optional: boolean; peer: boolean }>();
  const add = (section: string, kind: { dev: boolean; optional: boolean; peer: boolean }) => {
    for (const name of Object.keys(isObject(entry[section]) ? entry[section] : {}))
      kinds.set(name, kind);
  };
  add('devDependencies', { dev: true, optional: false, peer: false });
  add('dependencies', { dev: false, optional: false, peer: false });
  add('optionalDependencies', { dev: false, optional: true, peer: false });
  const meta = isObject(entry.peerDependenciesMeta) ? entry.peerDependenciesMeta : {};
  for (const name of Object.keys(isObject(entry.peerDependencies) ? entry.peerDependencies : {}))
    kinds.set(name, {
      dev: false,
      optional: isObject(meta[name]) && meta[name].optional === true,
      peer: true,
    });
  if (key === '' && entry.workspaces !== undefined)
    for (const [link, value] of Object.entries(packages)) {
      const name = rootName(link);
      if (name && isObject(value) && value.link === true)
        kinds.set(name, { dev: false, optional: false, peer: false });
    }
  return kinds;
}

// npm's calc-dep-flags over a lockfile: every package starts with each flag, and an edge from a
// package without a flag, of a kind without it, clears it on the target. Returns the flags of each
// package the root reaches.
function dependencyFlags(packages: Packages) {
  const flags = new Map<string, FlagSet>([
    ['', { dev: false, optional: false, devOptional: false, peer: false }],
  ]);
  const queue = [''];
  while (queue.length) {
    const key = queue.pop()!;
    const node = flags.get(key)!;
    const entry = packages[key];
    if (!isObject(entry)) continue;
    if (entry.link === true) {
      if (typeof entry.resolved === 'string' && isObject(packages[entry.resolved])) {
        flags.set(entry.resolved, { ...node });
        queue.push(entry.resolved);
      }
      continue;
    }
    for (const [name, edge] of edges(packages, key, entry)) {
      const target = resolveKey(packages, key, name);
      if (!target) continue;
      const to = flags.get(target) ?? { dev: true, optional: true, devOptional: true, peer: true };
      let changed = !flags.has(target);
      flags.set(target, to);
      const unset = (flag: keyof FlagSet, condition: boolean) => {
        if (to[flag] && condition) {
          to[flag] = false;
          changed = true;
        }
      };
      unset('dev', !node.dev && !edge.dev);
      unset('optional', !node.optional && !edge.optional);
      unset(
        'devOptional',
        !node.devOptional && !node.dev && !node.optional && !edge.dev && !edge.optional,
      );
      unset('peer', !node.peer && !edge.peer);
      if (changed) queue.push(target);
    }
  }
  for (const [key, value] of flags)
    if (key && (value.dev || value.optional)) value.devOptional = false;
  return flags;
}

function writtenFlags(entry: unknown, flags: FlagSet) {
  return isObject(entry) && FLAGS.every((flag) => (entry[flag] === true) === flags[flag]);
}

// Ranges in lock entries that resolve `name` to its root copy.
function requirers(packages: Packages, name: string) {
  const ranges: { key: string; range: string }[] = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!isObject(entry) || entry.link === true) continue;
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const range = isObject(entry[section]) ? entry[section][name] : undefined;
      if (typeof range === 'string' && resolveKey(packages, key, name) === `node_modules/${name}`)
        ranges.push({ key, range });
    }
  }
  return ranges;
}

function describe(packages: Packages, key: string) {
  const entry = packages[key];
  const version = isObject(entry) && typeof entry.version === 'string' ? ` ${entry.version}` : '';
  return `${key.replace(/^.*node_modules\//, '') || 'package.json'}${version}`;
}

// Chooses releases for one candidate of the declared Shopify package: the Shopify SDK packages it
// needs at the newest release that fits, with @shopify/shopify-api at `since` or later, session
// storage adapters whose peers then fit, and dependency-free releases for other ranges the lock
// misses. Returns the blockers when the lockfile cannot take it as is.
async function resolvePlan(
  packages: Packages,
  primary: string,
  candidate: Release,
  since: Triple,
  lookup: (name: string) => Promise<Release[]>,
): Promise<{ plan: Plan } | { blockers: string[] }> {
  const plan: Plan = new Map([[primary, candidate]]);
  // Each blocker once, keyed by the package and what it needs (`*` for all of it).
  const blockers = new Map<string, string>();
  const block = (owner: string, needed: string, text: string) => {
    if (!blockers.has(`${owner}>${needed}`) && !blockers.has(`${owner}>*`))
      blockers.set(`${owner}>${needed}`, text);
  };
  const current = (name: string) => plan.get(name)?.version ?? rootVersion(packages, name);
  const has = (name: string) =>
    plan.has(name)
      ? `the upgrade chooses ${plan.get(name)!.version}`
      : `the lockfile has ${rootVersion(packages, name) ?? 'none'}`;
  const atTarget = (version: string) => {
    const parsed = triple(version);
    return parsed !== undefined && parsed[0] === since[0] && compare(parsed, since) >= 0;
  };
  const settled = (name: string, range: string) => {
    const version = current(name);
    return (
      version !== undefined &&
      satisfies(version, range) === true &&
      (name !== SHOPIFY_API || atTarget(version))
    );
  };
  // package.json's own ranges on the Shopify SDK are rewritten; every other lock range must hold.
  const lockRanges = (name: string) =>
    requirers(packages, name)
      .filter(({ key }) => !(key === '' && SDK_FAMILY.test(name)) && !plan.has(rootName(key) ?? ''))
      .map(({ key, range }) => ({ key, owner: describe(packages, key), range }));
  const needs = (release: Release) => [
    ...Object.entries(release.dependencies),
    ...Object.entries(release.peers).filter(
      ([name]) => !release.optionalPeers.has(name) || current(name),
    ),
  ];
  const planRanges = (name: string) =>
    [...plan.values()].flatMap((release) => {
      const range = release.dependencies[name] ?? release.peers[name];
      return range ? [range] : [];
    });
  const queue = [primary];
  for (let index = 0; index < queue.length; index++) {
    const owner = queue[index];
    const release = plan.get(owner)!;
    for (const [name, range] of needs(release)) {
      if (settled(name, range) || plan.has(name)) continue;
      const family = SDK_FAMILY.test(name);
      const choice = (await lookup(name)).find(
        (option) =>
          satisfies(option.version, range) === true &&
          (family
            ? name !== SHOPIFY_API || atTarget(option.version)
            : option.leaf &&
              [...lockRanges(name).map((entry) => entry.range), ...planRanges(name)].every(
                (other) => satisfies(option.version, other) === true,
              )),
      );
      if (!choice) {
        block(
          owner,
          name,
          `${owner} ${release.version} needs ${name} ${range}; ${has(name)}${family ? '' : ', and no dependency-free release fits every range'}.`,
        );
        continue;
      }
      plan.set(name, choice);
      if (family) queue.push(name);
    }
  }
  const sdk = `${SHOPIFY_API} ${current(SHOPIFY_API) ?? since.join('.')}`;
  // Session storage adapters peer the SDK. One that something outside the upgrade still requires
  // moves to its oldest newer release whose peers fit, when the lock satisfies the rest.
  for (const key of Object.keys(packages)) {
    const name = rootName(key);
    if (!name || !SESSION_ADAPTER.test(name) || plan.has(name)) continue;
    if (!requirers(packages, name).some(({ key: owner }) => !plan.has(rootName(owner) ?? '')))
      continue;
    const entry = packages[key] as Record<string, unknown>;
    const fitsPlan = (ranges: Record<string, string>) =>
      [...plan].every(
        ([planned, release]) =>
          !ranges[planned] || satisfies(release.version, ranges[planned]) === true,
      );
    if (fitsPlan(stringRecord(entry.peerDependencies) ? entry.peerDependencies : {})) continue;
    const locked = triple(String(entry.version));
    const newer = (await lookup(name))
      .filter(
        (option) =>
          fitsPlan(option.peers) && (!locked || compare(triple(option.version)!, locked) > 0),
      )
      .reverse();
    const unmet = (option: Release) =>
      needs(option).filter(([dependency, range]) => !settled(dependency, range));
    const usable = newer.find((option) => !unmet(option).length);
    if (usable) plan.set(name, usable);
    else
      block(
        name,
        '*',
        newer.length
          ? `${name} ${newer[0].version}, the first release for ${sdk}, needs ${unmet(newer[0])
              .map(([dependency, range]) => `${dependency} ${range} (${has(dependency)})`)
              .join(', ')}.`
          : `No ${name} release supports ${sdk}.`,
      );
  }
  if (!atTarget(current(SHOPIFY_API) ?? ''))
    block(
      primary,
      SHOPIFY_API,
      `${primary} ${candidate.version} does not bring ${SHOPIFY_API} ${since.join('.')} or later.`,
    );
  for (const [name, release] of plan) {
    for (const { key, owner, range } of lockRanges(name))
      if (satisfies(release.version, range) !== true)
        block(
          rootName(key) ?? key,
          name,
          `${owner} needs ${name} ${range}; the upgrade chooses ${release.version}.`,
        );
    for (const [dependency, range] of needs(release))
      if (!settled(dependency, range))
        block(
          name,
          dependency,
          `${name} ${release.version} needs ${dependency} ${range}; ${has(dependency)}.`,
        );
  }
  return blockers.size ? { blockers: [...blockers.values()] } : { plan };
}

// The package.json of every npm workspace a pattern names: exact paths and `dir/*`, as the Shopify
// app template declares (`extensions/*`). Other glob forms name none.
async function workspaceManifests(root: string, declared: unknown) {
  const patterns = Array.isArray(declared)
    ? declared
    : isObject(declared) && Array.isArray(declared.packages)
      ? declared.packages
      : [];
  const found: { path: string; content: string }[] = [];
  for (const pattern of patterns.filter((entry): entry is string => typeof entry === 'string')) {
    const directories = pattern.endsWith('/*')
      ? (await readdir(join(root, pattern.slice(0, -2)), { withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
      : /^[\w@.\/-]+$/.test(pattern)
        ? [pattern]
        : [];
    for (const directory of directories) {
      const path = `${directory.replace(/\/$/, '')}/package.json`;
      const content = await readFile(join(root, path), 'utf8').catch(() => undefined);
      if (content !== undefined) found.push({ path, content });
    }
  }
  return found;
}

// Without a lockfile, a declaration like `^6.2.1` installs the newest release of its range: it fits
// a peer range when it admits the peer range's lowest version.
function installable(entry: unknown, peer: string) {
  const range = isObject(entry) && typeof entry.range === 'string' ? entry.range : undefined;
  const lowest = /\d+\.\d+\.\d+/.exec(peer)?.[0];
  return Boolean(range && lowest && satisfies(lowest, range) === true);
}

// Prisma's documented 5 to 6 changes (prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/
// upgrading-to-prisma-6, read 2026-10-29) that need a person: Refit never writes migrations or
// edits the data model. Code that catches NotFoundError stops in pipeline/shopify-sdk-source.ts.
async function prismaUpgradeStops(files: LockFiles, chosen: Map<string, { version: string }>) {
  const to = chosen.get('prisma');
  const from = triple(rootVersion(files.packages, 'prisma') ?? '');
  if (!to || !from || from[0] >= 6) return undefined;
  const typescript = triple(rootVersion(files.packages, 'typescript') ?? '');
  if (typescript && compare(typescript, [5, 1, 0]) < 0)
    return `Prisma 6 needs TypeScript 5.1 or later, and the project has ${typescript.join('.')}.`;
  const configured =
    isObject(files.manifest.prisma) && typeof files.manifest.prisma.schema === 'string'
      ? files.manifest.prisma.schema
      : 'prisma/schema.prisma';
  const schema = files.root
    ? await readFile(join(files.root, configured), 'utf8').catch(() => undefined)
    : undefined;
  if (schema === undefined)
    return `Prisma 6 changes need checking against the schema, and Refit cannot read ${configured}.`;
  const postgres = /provider\s*=\s*"(?:postgresql|postgres)"/.test(schema);
  const models = new Map(
    [...schema.matchAll(/^model\s+(\w+)\s*\{([^}]*)\}/gm)].map((match) => [match[1], match[2]]),
  );
  if ([...models.keys()].some((name) => ['async', 'await', 'using'].includes(name)))
    return 'Prisma 6 reserves async, await and using as model names, and the schema uses one.';
  if (/\bBytes\b/.test([...models.values()].join('\n')))
    return 'Prisma 6 returns Bytes fields as Uint8Array instead of Buffer, and the schema has a Bytes field.';
  if (postgres && /previewFeatures[^\n]*"fullTextSearch"/.test(schema))
    return 'Prisma 6 renames the PostgreSQL fullTextSearch preview feature to fullTextSearchPostgres.';
  // An implicit many-to-many relation: each model has a list of the other and no @relation fields.
  const lists = (body: string) =>
    [...body.matchAll(/^\s*\w+\s+(\w+)\[\](?![^\n]*fields:)/gm)].map((match) => match[1]);
  if (
    postgres &&
    [...models].some(([name, body]) =>
      lists(body).some((other) => lists(models.get(other) ?? '').includes(name)),
    )
  )
    return 'Prisma 6 turns the unique index of PostgreSQL implicit many-to-many relation tables into a primary key, which needs a migration.';
  return undefined;
}

// True when an SDK range installs `since` or a later release of its major: it admits `since`, or its
// lowest version is in that major and not older.
function installsSince(range: string | undefined, since: Triple) {
  if (!range) return false;
  const lowest = triple(/\d+\.\d+\.\d+/.exec(range)?.[0] ?? '');
  return (
    satisfies(since.join('.'), range) === true ||
    Boolean(lowest && lowest[0] === since[0] && compare(lowest, since) >= 0)
  );
}

// The planned moves that cross a major whose breaking change Refit does not migrate.
function unruledMajors(plan: Map<string, { version: string }>, packages: Packages) {
  return [...plan].flatMap(([name, release]) => {
    const was = triple(rootVersion(packages, name) ?? '');
    const now = triple(release.version)!;
    return (UNRULED_MAJORS[name] ?? [])
      .filter(([major]) => was && was[0] < major && now[0] >= major)
      .map(
        ([major, change]) =>
          `${name} ${major}.0.0 ${change}; the upgrade to ${release.version} stops for review.`,
      );
  });
}

// The declared Shopify packages moved to the target: the newest release of the declared package in
// the target major that brings the member, then the newest release of every other declared Shopify
// package that fits it, with package.json rewritten where a declaration does not allow it.
async function declaredUpgrade(
  files: LockFiles,
  primary: string,
  major: number,
  since: Triple,
  lookup: (name: string) => Promise<Release[]>,
): Promise<{ manifestText: string; chosen: Map<string, { version: string }> } | Refusal> {
  const { manifest, packages } = files;
  const declared = [
    ...new Set(
      ROOT_SECTIONS.flatMap((section) =>
        isObject(manifest[section]) ? Object.keys(manifest[section]) : [],
      ),
    ),
  ].filter((name) => SDK_FAMILY.test(name));
  // The newest release of the declared package in the target major that brings the member, then
  // the newest release of every other declared Shopify package that fits it.
  // Never a release older than the one locked (or, without a lockfile, the lowest declared).
  const lowestOf = (name: string) => triple(rootVersion(packages, name) ?? '0.0.0')!;
  const brings = (release: Release) => {
    const parsed = triple(release.version)!;
    if (parsed[0] !== major || compare(parsed, lowestOf(primary)) < 0) return false;
    if (primary === SHOPIFY_API) return compare(parsed, since) >= 0;
    return installsSince(release.dependencies[SHOPIFY_API], since);
  };
  const target = (await lookup(primary)).find(brings);
  if (!target)
    return { reason: `No ${primary} ${major} release brings ${SHOPIFY_API} ${since.join('.')}.` };
  const chosen = new Map<string, { version: string }>([[primary, target]]);
  if (primary !== SHOPIFY_API) {
    const api = (await lookup(SHOPIFY_API)).find(
      (release) =>
        triple(release.version)![0] === since[0] &&
        satisfies(release.version, target.dependencies[SHOPIFY_API]) === true,
    );
    if (api) chosen.set(SHOPIFY_API, api);
  }
  for (const name of declared) {
    if (chosen.has(name)) continue;
    const fits = (await lookup(name)).find(
      (release) =>
        compare(triple(release.version)!, lowestOf(name)) >= 0 &&
        [...Object.entries(release.dependencies), ...Object.entries(release.peers)].every(
          ([dependency, range]) =>
            !chosen.has(dependency) || satisfies(chosen.get(dependency)!.version, range) === true,
        ) &&
        // Peers outside the Shopify and framework packages (prisma) must take what is locked.
        Object.entries(release.peers).every(
          ([dependency, range]) =>
            SDK_FAMILY.test(dependency) ||
            FRAMEWORK.test(dependency) ||
            release.optionalPeers.has(dependency) ||
            rootVersion(packages, dependency) === undefined ||
            satisfies(rootVersion(packages, dependency)!, range) === true ||
            installable(packages[`node_modules/${dependency}`], range),
        ),
    );
    // Decision (2026-10-29, AGENTS.md): a session-storage release may move prisma and
    // @prisma/client to the release its peer range needs, when the project declares both.
    const prismaDeclared = PRISMA.every((entry) =>
      ROOT_SECTIONS.some((section) => isObject(manifest[section]) && entry in manifest[section]),
    );
    const moved =
      !fits && prismaDeclared && SESSION_ADAPTER.test(name)
        ? (await lookup(name)).find(
            (release) =>
              compare(triple(release.version)!, lowestOf(name)) >= 0 &&
              [...Object.entries(release.dependencies), ...Object.entries(release.peers)].every(
                ([dependency, range]) =>
                  PRISMA.includes(dependency) ||
                  !chosen.has(dependency) ||
                  satisfies(chosen.get(dependency)!.version, range) === true,
              ) &&
              Object.entries(release.peers).every(
                ([dependency, range]) =>
                  PRISMA.includes(dependency) ||
                  SDK_FAMILY.test(dependency) ||
                  FRAMEWORK.test(dependency) ||
                  release.optionalPeers.has(dependency) ||
                  rootVersion(packages, dependency) === undefined ||
                  satisfies(rootVersion(packages, dependency)!, range) === true ||
                  installable(packages[`node_modules/${dependency}`], range),
              ),
          )
        : undefined;
    if (moved)
      for (const dependency of PRISMA) {
        const range = moved.peers[dependency];
        if (!range || satisfies(rootVersion(packages, dependency) ?? '0.0.0', range) === true)
          continue;
        // The newest release of the major the peer range names. npm installs it, so releases the
        // lockfile edit could not write (bin, install scripts) count too.
        const release = (await publishedVersions(dependency))
          .filter((version) => satisfies(version, range) === true)
          .map((version) => ({ version }))[0];
        if (!release)
          return { reason: `No ${dependency} release satisfies ${name}'s peer ${range}.` };
        chosen.set(dependency, release);
      }
    if (!fits && !moved)
      return {
        reason: `No ${name} release works with ${primary} ${target.version} and the packages the lockfile has (such as its peers' versions).`,
      };
    chosen.set(name, (fits ?? moved)!);
  }
  const prismaStop = await prismaUpgradeStops(files, chosen);
  if (prismaStop) return { reason: prismaStop };
  const crossed = unruledMajors(chosen, packages);
  if (crossed.length) return { reason: crossed.join(' ') };
  let manifestText = files.manifestText;
  for (const [name, release] of chosen) {
    const section = ROOT_SECTIONS.find(
      (candidate) => isObject(manifest[candidate]) && typeof manifest[candidate][name] === 'string',
    );
    if (!section || satisfies(release.version, (manifest[section] as Record<string, string>)[name]))
      continue;
    const declaration = manifestDeclaration(manifest, manifestText, name);
    if ('reason' in declaration) return declaration;
    if (!declaration.unique) return { reason: `package.json declares ${name} more than once.` };
    manifestText = declaration.rewrite(release.version, manifestText);
  }
  return { manifestText, chosen };
}

// No lockfile is committed: the upgrade rewrites package.json only. Validation resolves a lockfile
// for its checks (pipeline/lockfile-resolution.ts), and that lockfile never reaches the patch.
async function manifestUpgrade(
  files: LockFiles,
  primary: string,
  major: number,
  since: Triple,
  lookup: (name: string) => Promise<Release[]>,
): Promise<{ upgrade: ShopifySdkUpgrade } | Refusal> {
  const declaration = await declaredUpgrade(files, primary, major, since, lookup);
  if ('reason' in declaration) return declaration;
  const changes = [...declaration.chosen]
    .filter(([name]) => name === SHOPIFY_API || rootVersion(files.packages, name) !== undefined)
    .map(([name, release]) => ({
      name,
      from: rootVersion(files.packages, name) ?? null,
      to: release.version,
    }));
  return {
    upgrade: {
      primary,
      from: rootVersion(files.packages, primary) ?? '',
      to: declaration.chosen.get(primary)!.version,
      apiRelease: declaration.chosen.get(SHOPIFY_API)?.version ?? since.join('.'),
      packages: changes,
      removed: [],
      lockless: true,
      // Empty when package.json already allows the target releases.
      files: [
        { path: 'package.json', before: files.manifestText, after: declaration.manifestText },
      ].filter((file) => file.after !== file.before),
    },
  };
}

// Decision (2026-10-29, AGENTS.md): when the committed lockfile cannot take the upgrade as it is,
// the declared Shopify packages move to the target major's releases and npm re-resolves the
// committed package-lock.json from it in networked Docker (lifecycle scripts off, no repository
// .npmrc). The result ships in the patch only when nothing outside the Shopify packages, the
// Remix and React Router framework packages, and what only they reach changes.
async function resolvedUpgrade(
  root: string,
  files: LockFiles,
  primary: string,
  major: number,
  since: Triple,
  lookup: (name: string) => Promise<Release[]>,
  resolution: { image: string; before: string },
): Promise<{ upgrade: ShopifySdkUpgrade } | Refusal> {
  const { lockText, managed } = files;
  const manager: ResolutionManager = managed?.manager ?? 'npm';
  const lockfile = RESOLUTION_LOCKFILES[manager];
  const label = managed ? `${managed.manager.replace('-berry', '')} ${managed.version}` : 'npm';
  const npmrc = await readFile(join(root, '.npmrc'), 'utf8').catch(() => '');
  // Only the public registry (the Shopify app template names it for @shopify) and no credentials.
  const registries = [...npmrc.matchAll(/^\s*(?:@[^:\s]+:)?registry\s*=\s*(\S+)/gm)].map((match) =>
    match[1].replace(/\/$/, ''),
  );
  if (
    /_auth/.test(npmrc) ||
    registries.some(
      (url) => url !== 'https://registry.npmjs.org' && url !== 'https://registry.yarnpkg.com',
    )
  )
    return { reason: '.npmrc configures another registry or credentials.' };
  const declaration = await declaredUpgrade(files, primary, major, since, lookup);
  if ('reason' in declaration) return declaration;
  const { manifestText } = declaration;
  const asOf = new Date().toISOString();
  let resolved;
  try {
    const workspaces = managed
      ? managed.workspaces
      : files.manifest.workspaces !== undefined
        ? await workspaceManifests(root, files.manifest.workspaces)
        : undefined;
    resolved = await resolveNpmLockfile({
      manifest: manifestText,
      ...(workspaces && (workspaces.length || files.manifest.workspaces !== undefined)
        ? { workspaces }
        : {}),
      seed: lockText,
      // As of now: the target releases are newer than the commit, and the committed lockfile seeds
      // the resolution, so only packages the upgrade newly needs take today's versions.
      before: asOf,
      legacyPeerDeps: manager === 'npm' && legacyPeerDeps(npmrc),
      manager,
      ...(managed
        ? {
            managerVersion: managed.version,
            managerArguments: managed.arguments,
            ...(managed.pnpmWorkspace !== undefined
              ? { pnpmWorkspace: managed.pnpmWorkspace }
              : {}),
          }
        : {}),
      image: resolution.image,
    });
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return {
      reason: `${label} could not re-resolve ${lockfile}: ${error.message.slice(0, 120)} … ${error.message.slice(-300)}`,
    };
  }
  const manifests = managed?.manifests ?? { '.': files.manifest };
  const before: LockedProject = { lockfile: lockText, manifests };
  const after: LockedProject = {
    lockfile: resolved.lockfile,
    manifests: { ...manifests, '.': parseJson(manifestText) as Record<string, unknown> },
  };
  // Prisma's packages count too, when session storage moves prisma (decision of 2026-10-29).
  const upgraded = (name: string) =>
    SDK_FAMILY.test(name) ||
    FRAMEWORK.test(name) ||
    (declaration.chosen.has('prisma') && /^(?:prisma|@prisma\/[a-z0-9-]+)$/.test(name));
  let outside: string[], was: ReturnType<typeof lockedReleases>, now: typeof was;
  try {
    [was, now] = [lockedReleases(manager, before), lockedReleases(manager, after)];
    const names = [...new Set([...was.all.keys(), ...now.all.keys()])].filter(upgraded);
    outside = lockChangesOutside(manager, before, after, names).map(
      (key) => key || 'the root record',
    );
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return { reason: `Refit could not compare the re-resolved ${lockfile}: ${error.message}` };
  }
  if (outside.length)
    return {
      reason: `${label}'s re-resolved ${lockfile} changes ${outside.slice(0, 5).join(', ')}${
        outside.length > 5 ? ` and ${outside.length - 5} more` : ''
      }, outside the Shopify and framework packages and what only they reach.`,
    };
  // The release a project installs: the root declaration's, else the only one locked.
  const release = (releases: typeof was, name: string): string | undefined => {
    const all = [...(releases.all.get(name) ?? [])];
    return releases.root[name] ?? (all.length === 1 ? all[0] : undefined);
  };
  // Every copy of the SDK, nested ones included, must be the target's.
  const apiCopies = [...(now.all.get(SHOPIFY_API) ?? [])];
  const primaryRelease = release(now, primary);
  const apiRelease = release(now, SHOPIFY_API);
  if (
    !apiCopies.length ||
    !apiCopies.every((version) => {
      const parsed = triple(version);
      return parsed !== undefined && parsed[0] === since[0] && compare(parsed, since) >= 0;
    }) ||
    !apiRelease ||
    triple(primaryRelease ?? '')?.[0] !== major
  )
    return {
      reason: `${label} did not lock ${primary} ${major} with ${SHOPIFY_API} ${since.join('.')} or later everywhere (it locks ${SHOPIFY_API} ${apiCopies.join(', ') || 'nowhere'}).`,
    };
  const names = [...new Set([...was.all.keys(), ...now.all.keys()])].filter(upgraded);
  const changes = names
    .map((name) => ({ name, from: release(was, name) ?? null, to: release(now, name) }))
    .filter((change): change is { name: string; from: string | null; to: string } =>
      Boolean(change.to && change.to !== change.from),
    );
  return {
    upgrade: {
      primary,
      from: release(was, primary) ?? '',
      to: primaryRelease!,
      apiRelease,
      packages: changes,
      removed: [],
      resolved: {
        before: asOf,
        legacyPeerDeps: resolved.legacyPeerDeps === true,
        manager: label,
        lockfile,
        frameworks: changes
          .filter((change) => FRAMEWORK.test(change.name))
          .map((change) => `${change.name} ${change.from ?? '(new)'} → ${change.to}`),
      },
      ...(files.otherLockfiles ? { otherLockfiles: files.otherLockfiles } : {}),
      files: [
        { path: 'package.json', before: files.manifestText, after: manifestText },
        { path: lockfile, before: lockText, after: resolved.lockfile },
      ].filter((file) => file.after !== file.before),
    },
  };
}

export interface ShopifySdkUpgrade extends PackageUpgrade {
  // The declared Shopify package moved to its target major; `from` and `to` are its releases.
  primary: string;
  // The @shopify/shopify-api release the project resolves after the upgrade.
  apiRelease: string;
  packages: { name: string; from: string | null; to: string }[];
  removed: string[];
  // The project's package manager re-resolved its lockfile (see resolvedUpgrade): when, which
  // manager and release, the lockfile, and the framework packages it moved.
  resolved?: {
    before: string;
    legacyPeerDeps: boolean;
    manager: string;
    lockfile: string;
    frameworks: string[];
  };
  // No lockfile is committed, so only package.json changes.
  lockless?: true;
  // Other root lockfiles left on the old release, because the documented lockfile choice
  // (pipeline/dependency-inputs.ts) picked another: each with why it was not chosen.
  otherLockfiles?: Record<string, string>;
}

interface LockFiles {
  manifestText: string;
  manifest: Record<string, unknown>;
  lock: Record<string, unknown>;
  lockText: string;
  render: (lock: unknown) => string;
  packages: Packages;
  otherLockfiles?: Record<string, string>;
  // No lockfile is committed: `packages` holds the lowest release each declaration allows.
  lockless?: true;
  // A pnpm, Yarn or Bun project: the upgrade re-resolves its lockfile with the release of the
  // manager preparation installs with, and `packages` holds what each root declaration installs.
  managed?: {
    manager: ResolutionManager;
    version: string;
    manifests: Record<string, Record<string, unknown>>;
    workspaces: { path: string; content: string }[];
    pnpmWorkspace?: string;
    arguments: string[];
  };
  root?: string;
}

// A root pnpm, Yarn or Bun project, read as preparation reads it (readPreparationInputs): the same
// lockfile choice, package-manager release and workspaces, refused where preparation refuses.
async function managedLockFiles(
  root: string,
  manifestText: string,
  bunBinary: boolean,
): Promise<LockFiles | Refusal> {
  let prepared;
  try {
    prepared = await readPreparationInputs(await readCommittedRepository(root));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      reason: bunBinary
        ? 'The repository commits only the binary bun.lockb, which Refit cannot read or review.'
        : `Preparation cannot read the committed lockfile, so the Shopify SDK upgrade cannot either: ${message.slice(0, 300)}`,
    };
  }
  const { inputs, workspaceContents } = prepared;
  const pnpmWorkspace = prepared.files.get('pnpm-workspace.yaml');
  if (inputs.patchHashes && Object.keys(inputs.patchHashes).length)
    return {
      reason: 'pnpm-lock.yaml records patched dependencies, which re-resolution does not apply.',
    };
  const manifest = parseJson(manifestText) as Record<string, unknown>;
  let manager: ResolutionManager, version: string;
  if (inputs.manager === 'pnpm' || inputs.manager === 'yarn') {
    manager = inputs.manager;
    version = inputs.managerVersion!;
  } else if (inputs.bunLockHash) {
    manager = 'bun';
    const pin =
      typeof manifest.packageManager === 'string' ? BUN_PIN.exec(manifest.packageManager) : null;
    version = pin?.[1] ?? DEFAULT_BUN_VERSION;
  } else
    return { reason: 'The repository installs from package-lock.json, which Refit read as npm.' };
  const lockText = await readFile(join(root, RESOLUTION_LOCKFILES[manager]), 'utf8');
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
  const manifests: Record<string, Record<string, unknown>> = { '.': manifest };
  for (const [directory, content] of workspaceContents)
    manifests[directory] = parseJson(content) as Record<string, unknown>;
  const project = { lockfile: lockText, manifests };
  let releases;
  try {
    releases = lockedReleases(manager, project);
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return { reason: `Refit could not read ${RESOLUTION_LOCKFILES[manager]}: ${error.message}` };
  }
  return {
    manifestText,
    manifest,
    lock: {},
    lockText,
    render: () => '',
    packages: Object.fromEntries(
      Object.entries(releases.root).map(([name, release]) => [
        `node_modules/${name}`,
        { version: release },
      ]),
    ),
    root,
    ...(inputs.lockfileChoice ? { otherLockfiles: inputs.lockfileChoice.others } : {}),
    managed: {
      manager,
      version,
      manifests,
      workspaces: [...workspaceContents].map(([directory, content]) => ({
        path: `${directory}/package.json`,
        content,
      })),
      ...(pnpmWorkspace !== undefined ? { pnpmWorkspace } : {}),
      arguments: managerArguments,
    },
  };
}

async function applyPlan(
  plan: Plan,
  primary: string,
  files: LockFiles,
): Promise<{ upgrade: ShopifySdkUpgrade } | Refusal> {
  const { manifest, lock, render, packages } = files;
  const updated: Packages = { ...packages };
  const rootEntry = structuredClone(isObject(packages['']) ? packages[''] : {});
  const changes: ShopifySdkUpgrade['packages'] = [];
  let manifestText = files.manifestText;
  for (const [name, release] of plan) {
    const key = `node_modules/${name}`;
    if (Object.keys(packages).some((other) => other.startsWith(`${key}/node_modules/`)))
      return { reason: `package-lock.json nests packages under ${name}.` };
    updated[key] = await lockEntry(name, release.version);
    changes.push({ name, from: rootVersion(packages, name) ?? null, to: release.version });
    const section = ROOT_SECTIONS.find(
      (candidate) => isObject(manifest[candidate]) && typeof manifest[candidate][name] === 'string',
    );
    if (!section || satisfies(release.version, (manifest[section] as Record<string, string>)[name]))
      continue;
    const declaration = manifestDeclaration(manifest, manifestText, name);
    if ('reason' in declaration) return declaration;
    if (!declaration.unique) return { reason: `package.json declares ${name} more than once.` };
    manifestText = declaration.rewrite(release.version, manifestText);
    const declared = rootEntry[declaration.section];
    if (isObject(declared) && typeof declared[name] === 'string')
      declared[name] = declaration.newSpec(release.version);
  }
  updated[''] = rootEntry;
  const before = dependencyFlags(packages);
  const after = dependencyFlags(updated);
  const removed = [...before.keys()].filter((key) => !after.has(key));
  for (const key of removed) delete updated[key];
  // Older npm releases left stale flags in some lockfiles (a root devDependency marked `peer`), so
  // only the entries the upgrade writes or whose flags it changes take today's calculation. Where
  // the two disagree the calculation has fewer flags, which never omits a needed package.
  for (const [key, flags] of after) {
    const entry = updated[key];
    if (!key || !isObject(entry) || entry.link === true || writtenFlags(entry, flags)) continue;
    const previous = before.get(key);
    const written = plan.has(rootName(key) ?? '');
    if (!written && previous && FLAGS.every((flag) => previous[flag] === flags[flag])) continue;
    const fields = Object.entries(entry).filter(
      ([field]) => !(FLAGS as readonly string[]).includes(field),
    );
    updated[key] = npmSorted({
      ...Object.fromEntries(fields),
      ...Object.fromEntries(FLAGS.filter((flag) => flags[flag]).map((flag) => [flag, true])),
    });
  }
  const ordered = Object.fromEntries(
    Object.keys(updated)
      .sort(byKey)
      .map((key) => [key, updated[key]]),
  );
  const primaryChange = changes.find((change) => change.name === primary)!;
  return {
    upgrade: {
      primary,
      from: primaryChange.from ?? '',
      to: primaryChange.to,
      apiRelease: plan.get(SHOPIFY_API)?.version ?? rootVersion(packages, SHOPIFY_API)!,
      packages: changes,
      removed: removed.map((key) => key.replace(/^node_modules\//, '')),
      ...(files.otherLockfiles ? { otherLockfiles: files.otherLockfiles } : {}),
      // package.json is unchanged when every declaration already admits the new releases.
      files: [
        { path: 'package.json', before: files.manifestText, after: manifestText },
        {
          path: 'package-lock.json',
          before: files.lockText,
          after: render({ ...lock, packages: ordered }),
        },
      ].filter((file) => file.after !== file.before),
    },
  };
}

async function readLockFiles(root: string): Promise<LockFiles | Refusal> {
  const read = (path: string) => readFile(join(root, path), 'utf8').catch(() => undefined);
  const [manifestText, lockText, shrinkwrap, ...others] = await Promise.all(
    ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', ...OTHER_LOCKFILES].map(read),
  );
  if (
    manifestText !== undefined &&
    lockText === undefined &&
    shrinkwrap === undefined &&
    others.every((text) => text === undefined)
  ) {
    let manifest: unknown;
    try {
      manifest = parseJson(manifestText);
    } catch {
      return { reason: 'package.json is not valid JSON.' };
    }
    if (!isObject(manifest)) return { reason: 'package.json is not an object.' };
    const packages: Packages = {};
    for (const section of ROOT_SECTIONS)
      if (isObject(manifest[section]))
        for (const [name, spec] of Object.entries(manifest[section])) {
          const lowest = typeof spec === 'string' ? /\d+\.\d+\.\d+/.exec(spec)?.[0] : undefined;
          if (lowest) packages[`node_modules/${name}`] = { version: lowest, range: spec };
        }
    return {
      manifestText,
      manifest,
      lock: {},
      lockText: '',
      render: () => '',
      packages,
      lockless: true,
      root,
    };
  }
  if (manifestText === undefined || shrinkwrap !== undefined)
    return {
      reason:
        'The Shopify SDK upgrade covers root projects with a package.json and no npm-shrinkwrap.json.',
    };
  const bunBinary = others[OTHER_LOCKFILES.indexOf('bun.lockb')] !== undefined;
  if (lockText === undefined) return managedLockFiles(root, manifestText, bunBinary);
  // Several committed lockfiles: the one preparation installs decides, as for stripe-node.
  let otherLockfiles: Record<string, string> | undefined;
  if (others.some((text) => text !== undefined)) {
    const choice = await readCommittedRepository(root)
      .then((snapshot) => chosenLockfile(snapshot))
      .catch(() => undefined);
    if (!choice)
      return {
        reason: 'The repository commits several lockfiles and no documented rule picks one.',
      };
    if (choice.lockfile !== 'package-lock.json') return managedLockFiles(root, manifestText, false);
    otherLockfiles = choice.others;
  }
  let manifest: unknown, lock: unknown;
  try {
    manifest = parseJson(manifestText);
    lock = parseJson(lockText);
  } catch {
    return { reason: 'package.json or package-lock.json is not valid JSON.' };
  }
  if (!isObject(manifest) || !isObject(lock) || !isObject(lock.packages))
    return { reason: 'package-lock.json has no packages section.' };
  if (lock.lockfileVersion !== 3)
    return { reason: 'The Shopify SDK upgrade covers npm lockfile version 3 only.' };
  // npm keeps a lockfile's indentation and line endings; rewriting the same way keeps the diff to
  // the changed entries.
  const render = NPM_FORMATS.find((format) => format(lock) === lockText);
  if (!render) return { reason: 'package-lock.json is not in npm formatting.' };
  const packages = lock.packages;
  const keys = Object.keys(packages);
  if (keys.join('\n') !== [...keys].sort(byKey).join('\n'))
    return { reason: 'package-lock.json packages are not in npm order.' };
  return {
    manifestText,
    manifest,
    lock,
    lockText,
    render,
    packages,
    root,
    ...(otherLockfiles ? { otherLockfiles } : {}),
  };
}

// Moves a root npm project's Shopify SDK to the oldest major that serves a supported Admin API
// version, at a release that names ApiVersion.`member`, editing only package.json and
// package-lock.json from verified registry metadata. Anything the lockfile cannot take as is would
// need npm to resolve it again, so it is refused with each blocker named.
export async function shopifySdkUpgrade(
  root: string,
  member: string,
  // With lockfile resolution on (validation's networked step), npm may re-resolve the lockfile.
  resolution?: { image: string; before: string },
): Promise<{ upgrade: ShopifySdkUpgrade } | Refusal> {
  const since = triple(SHOPIFY_API_ENUM_SINCE[member] ?? '');
  if (!since) return { reason: `No ${SHOPIFY_API} release is recorded for ApiVersion.${member}.` };
  if (since[0] > NEWEST_RULED_MAJOR)
    return {
      reason: `ApiVersion.${member} first ships in ${SHOPIFY_API} ${since.join('.')}; Refit applies the documented breaking changes up to ${SHOPIFY_API} ${NEWEST_RULED_MAJOR} only.`,
    };
  const files = await readLockFiles(root);
  if ('reason' in files) return files;
  const { manifest, packages } = files;
  const declared = (name: string) =>
    ROOT_SECTIONS.some((section) => isObject(manifest[section]) && name in manifest[section]);
  const apps = APP_PACKAGES.filter(declared);
  if (apps.length > 1)
    return { reason: `package.json declares several Shopify app packages (${apps.join(', ')}).` };
  const primary = apps[0] ?? (declared(SHOPIFY_API) ? SHOPIFY_API : undefined);
  if (!primary)
    return { reason: `package.json declares neither ${SHOPIFY_API} nor a Shopify app package.` };
  // A nested copy of the SDK is moved only by npm's own re-resolution.
  let nested: string | undefined;
  for (const name of [primary, SHOPIFY_API, SESSION_STORAGE]) {
    const keys = Object.keys(packages).filter((key) => key.endsWith(`/node_modules/${name}`));
    if (keys.length && !nested)
      nested = `package-lock.json nests ${name} under ${keys
        .map((key) => describe(packages, key.slice(0, key.lastIndexOf('/node_modules/'))))
        .join(', ')}.`;
  }
  if (nested && !resolution) return { reason: nested };
  const from = triple(rootVersion(packages, primary) ?? '');
  if (!from) return { reason: `package-lock.json does not lock ${primary} at the project root.` };
  // Node.js the target needs, against the range the project declares.
  const engines = isObject(manifest.engines) ? manifest.engines.node : undefined;
  const node = NODE_FOR_MAJOR[since[0]];
  // Refused only when no Node.js release the range names or later majors satisfy reaches it.
  const reaches = (range: string, minimum: string) =>
    [
      minimum,
      ...[...range.matchAll(/\d+\.\d+\.\d+/g)].map((match) => match[0]),
      ...Array.from({ length: 10 }, (_, index) => `${22 + index * 2}.0.0`),
    ].some(
      (version) => compare(triple(version)!, triple(minimum)!) >= 0 && satisfies(version, range),
    );
  if (typeof engines === 'string' && node && !reaches(engines, node))
    return {
      reason: `${SHOPIFY_API} ${since[0]} needs Node.js ${node} or later, and package.json declares engines.node ${engines}.`,
    };
  const cache = new Map<string, Promise<Release[]>>();
  const lookup = (name: string) => {
    if (!cache.has(name)) cache.set(name, releases(name));
    return cache.get(name)!;
  };
  try {
    // The first major of the declared package whose releases depend on the SDK that ships the
    // member: shopify-api itself, or the app package release built on it.
    const major =
      primary === SHOPIFY_API
        ? since[0]
        : (await lookup(primary))
            .map((release) => ({ release, parsed: triple(release.version)! }))
            .filter(({ release }) => installsSince(release.dependencies[SHOPIFY_API], since))
            .map(({ parsed }) => parsed[0])
            .sort((a, b) => a - b)[0];
    if (major === undefined)
      return { reason: `No ${primary} release depends on ${SHOPIFY_API} ${since.join('.')}.` };
    // From the oldest major of each package that served a supported version, the documented
    // changes of every major in between are applied or stop the upgrade.
    if (from[0] < SHOPIFY_SDK_MAJORS[primary] - 1)
      return {
        reason: `${primary} ${from.join('.')} is older than ${SHOPIFY_SDK_MAJORS[primary] - 1}, the oldest major whose migration Refit applies.`,
      };
    if (from[0] > major)
      return {
        reason: `${primary} ${from.join('.')} is newer than major ${major}, which this upgrade targets.`,
      };
    if (files.lockless) return await manifestUpgrade(files, primary, major, since, lookup);
    // pnpm, Yarn and Bun lockfiles, and npm lockfiles with nested SDK copies, take the upgrade
    // only through their own manager's re-resolution.
    if (files.managed || nested) {
      const why =
        nested ?? `The repository installs from ${RESOLUTION_LOCKFILES[files.managed!.manager]}.`;
      if (!resolution)
        return { reason: `${why} Its upgrade needs lockfile resolution, which is off.` };
      const resolved = await resolvedUpgrade(
        root,
        files,
        primary,
        major,
        since,
        lookup,
        resolution,
      );
      return 'upgrade' in resolved ? resolved : { reason: `${why} ${resolved.reason}` };
    }
    // The release with the fewest blockers, newest first on a tie, says what is missing.
    let closest: { version: string; blockers: string[] } | undefined;
    for (const candidate of await lookup(primary)) {
      const parsed = triple(candidate.version)!;
      if (parsed[0] !== major || (primary === SHOPIFY_API && compare(parsed, since) < 0)) continue;
      const result = await resolvePlan(packages, primary, candidate, since, lookup);
      if ('plan' in result) {
        const crossed = unruledMajors(result.plan, packages);
        if (crossed.length) return { reason: crossed.join(' ') };
        return await applyPlan(result.plan, primary, files);
      }
      if (!closest || result.blockers.length < closest.blockers.length)
        closest = { version: candidate.version, blockers: result.blockers };
    }
    const reason = closest
      ? `The lockfile cannot take the ${primary} ${major} upgrade without npm resolving it again; the closest release, ${closest.version}: ${closest.blockers.join(' ')}`
      : `No ${primary} ${major} release brings ${SHOPIFY_API} ${since.join('.')} or later.`;
    if (!resolution || !closest) return { reason };
    const resolved = await resolvedUpgrade(root, files, primary, major, since, lookup, resolution);
    return 'upgrade' in resolved
      ? resolved
      : { reason: `${reason} npm re-resolution stopped too: ${resolved.reason}` };
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return { reason: `Shopify SDK metadata could not be read: ${error.message}` };
  }
}
