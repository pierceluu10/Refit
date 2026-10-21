import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, isScalar, parseDocument, type Document } from 'yaml';
import {
  fetchSpecificationResponse,
  readBoundedResponse,
  SpecificationUnavailableError,
} from './network.ts';
import { EXACT_PACKAGE_VERSION } from './npm-lock.ts';
import { isObject, parseJson } from './specifications.ts';

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
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const VERSION_SPEC = /^([~^]?)(\d+\.\d+\.\d+)$/;
// pnpm writes flow maps without inner padding and never folds long lines.
const PNPM_FORMAT = { lineWidth: 0, flowCollectionPadding: false, singleQuote: true };
const NPM_FORMATS = [2, 4, '\t'].flatMap((indent) =>
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
const touchesPackage = (section: string) =>
  PACKAGE_FILES.some(
    (path) =>
      section.startsWith(`diff --git "a/${path}" "b/${path}"`) ||
      section.startsWith(`diff --git a/${path} b/${path}\n`),
  );

// The dependency part of a rendered patch (root package.json and its lockfile).
export function packageDiff(diff: string) {
  return diffSections(diff).filter(touchesPackage).join('');
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
}

type Refusal = { reason: string };
interface Declaration {
  section: 'dependencies' | 'devDependencies';
  spec: string;
  newSpec: (target: string) => string;
  unique: boolean;
  rewrite: (target: string) => string;
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

function stringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function manifestDeclaration(
  manifest: Record<string, unknown>,
  manifestText: string,
): Declaration | Refusal {
  const section = (['dependencies', 'devDependencies'] as const).find(
    (name) => isObject(manifest[name]) && typeof manifest[name].stripe === 'string',
  );
  if (!section) return { reason: 'The root package.json does not declare stripe.' };
  const spec = (manifest[section] as Record<string, string>).stripe;
  const parsed = VERSION_SPEC.exec(spec);
  if (!parsed) return { reason: `The stripe version "${spec}" is not an exact, ^ or ~ version.` };
  const declaration = new RegExp(`("stripe"\\s*:\\s*")${spec.replace(/[.^~]/g, '\\$&')}"`, 'g');
  return {
    section,
    spec,
    newSpec: (target: string) => `${parsed[1]}${target}`,
    unique: (manifestText.match(declaration) ?? []).length === 1,
    rewrite: (target: string) => manifestText.replace(declaration, `$1${parsed[1]}${target}"`),
  };
}

// Benchmark runs under load saw single connection resets; a short retry keeps them from skipping
// the upgrade. Any other failure is reported at once.
async function registryResponse(target: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchSpecificationResponse(
        `${REGISTRY}${target}`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Accept: 'application/json' },
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
    const response = await registryResponse(target);
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
): Refusal | undefined {
  const conflicts = Object.entries(peers).filter(([name, range]) => {
    const version = installed(name);
    return version !== undefined && !satisfiesMinimum(version, range);
  });
  return conflicts.length
    ? {
        reason: `stripe ${target} needs ${conflicts.map(([name, range]) => `${name} ${range}`).join(', ')}, which the lockfile does not provide; upgrade it first.`,
      }
    : undefined;
}

// Moves a root npm, pnpm or Yarn 1 project's stripe dependency to the release for `apiVersion`,
// editing only package.json and its lockfile. Anything unusual is refused with a reason, never guessed.
export async function stripePackageUpgrade(
  root: string,
  apiVersion: string,
): Promise<{ upgrade: PackageUpgrade } | Refusal> {
  const target = STRIPE_SDK_RELEASES[apiVersion];
  if (!target)
    return { reason: `No stripe-node release is recorded for API version ${apiVersion}.` };
  const read = (path: string) => readFile(join(root, path), 'utf8').catch(() => undefined);
  const [manifestText, npmLock, pnpmLock, yarnLock] = await Promise.all([
    read('package.json'),
    read('package-lock.json'),
    read('pnpm-lock.yaml'),
    read('yarn.lock'),
  ]);
  if (manifestText === undefined || [npmLock, pnpmLock, yarnLock].filter(Boolean).length !== 1)
    return {
      reason:
        'Only root npm, pnpm or Yarn 1 projects with package.json and exactly one of package-lock.json, pnpm-lock.yaml or yarn.lock are upgraded.',
    };
  if (npmLock !== undefined) return npmUpgrade(target, manifestText, npmLock);
  if (pnpmLock !== undefined) return pnpmUpgrade(target, manifestText, pnpmLock);
  return yarnUpgrade(target, manifestText, yarnLock!);
}

async function npmUpgrade(
  target: string,
  manifestText: string,
  lockText: string,
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
  const conflict = peerConflicts(target, peers, (name) => {
    const installed = packages[`node_modules/${name}`];
    return isObject(installed) ? (installed.version ?? null) : undefined;
  });
  if (conflict) return conflict;
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
