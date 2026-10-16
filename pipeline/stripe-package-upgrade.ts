import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchSpecificationResponse, readBoundedResponse } from './network.ts';
import { isObject } from './specifications.ts';

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
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const VERSION_SPEC = /^([~^]?)(\d+\.\d+\.\d+)$/;

export const PACKAGE_FILES = ['package.json', 'package-lock.json'];

function diffSections(diff: string) {
  return diff.split(/(?=^diff --git )/m).filter(Boolean);
}
const touchesPackage = (section: string) =>
  PACKAGE_FILES.some((path) => section.startsWith(`diff --git "a/${path}" "b/${path}"`));

// The dependency part of a rendered patch (root package.json and package-lock.json).
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

// Moves a root npm project's stripe dependency to the release for `apiVersion`, editing only
// package.json and package-lock.json. Anything unusual is refused with a reason, never guessed.
export async function stripePackageUpgrade(
  root: string,
  apiVersion: string,
): Promise<{ upgrade: PackageUpgrade } | { reason: string }> {
  const target = STRIPE_SDK_RELEASES[apiVersion];
  if (!target)
    return { reason: `No stripe-node release is recorded for API version ${apiVersion}.` };
  let manifestText: string, lockText: string;
  try {
    manifestText = await readFile(join(root, 'package.json'), 'utf8');
    lockText = await readFile(join(root, 'package-lock.json'), 'utf8');
  } catch {
    return {
      reason: 'Only root npm projects with package.json and package-lock.json are upgraded.',
    };
  }
  let manifest: unknown, lock: unknown;
  try {
    manifest = JSON.parse(manifestText);
    lock = JSON.parse(lockText);
  } catch {
    return { reason: 'package.json or package-lock.json is not valid JSON.' };
  }
  if (!isObject(manifest) || !isObject(lock) || !isObject(lock.packages))
    return { reason: 'package-lock.json has no packages section.' };
  const section = (['dependencies', 'devDependencies'] as const).find(
    (name) => isObject(manifest[name]) && typeof manifest[name].stripe === 'string',
  );
  if (!section) return { reason: 'The root package.json does not declare stripe.' };
  const spec = (manifest[section] as Record<string, string>).stripe;
  const parsed = VERSION_SPEC.exec(spec);
  if (!parsed) return { reason: `The stripe version "${spec}" is not an exact, ^ or ~ version.` };
  if (![2, 3].includes(lock.lockfileVersion as number))
    return { reason: 'Only npm lockfile versions 2 and 3 are upgraded.' };
  // Rewriting with npm's own formatting keeps the diff to the changed entries.
  if (lockText !== `${JSON.stringify(lock, null, 2)}\n`)
    return { reason: 'package-lock.json is not in npm formatting.' };
  const packages = lock.packages as Record<string, unknown>;
  const entry = packages['node_modules/stripe'];
  if (!isObject(entry) || typeof entry.version !== 'string')
    return { reason: 'package-lock.json does not lock stripe at the project root.' };
  if (entry.version === target) return { reason: `stripe ${target} is already locked.` };
  let metadata: unknown;
  try {
    const response = await fetchSpecificationResponse(
      `${REGISTRY}${target}`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      },
      'npm registry',
    );
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
  const locked = stringRecord(entry.dependencies) ? entry.dependencies : {};
  const missing = Object.entries(dependencies).filter(
    ([name, range]) => locked[name] !== range || !isObject(packages[`node_modules/${name}`]),
  );
  const requiredPeers = Object.keys(peers).filter(
    (name) => !(isObject(peerMeta[name]) && peerMeta[name].optional === true),
  );
  if (missing.length || requiredPeers.length)
    return {
      reason: `stripe ${target} needs dependency changes (${[...missing.map(([name]) => name), ...requiredPeers].join(', ')}); regenerate the lockfile instead.`,
    };
  // npm ci still rejects an optional peer that is installed outside the range.
  const conflicts = Object.entries(peers).filter(([name, range]) => {
    const installed = packages[`node_modules/${name}`];
    return isObject(installed) && !satisfiesMinimum(installed.version, range);
  });
  if (conflicts.length)
    return {
      reason: `stripe ${target} needs ${conflicts.map(([name, range]) => `${name} ${range}`).join(', ')}, which the lockfile does not provide; upgrade it first.`,
    };
  const optional = (value: Record<string, string>, key: string) =>
    Object.keys(value).length ? { [key]: value } : {};
  packages['node_modules/stripe'] = {
    version: target,
    resolved: dist.tarball,
    integrity: dist.integrity,
    ...(entry.dev === true ? { dev: true } : {}),
    ...(typeof metadata.license === 'string' ? { license: metadata.license } : {}),
    ...optional(dependencies, 'dependencies'),
    ...(isObject(metadata.engines) ? { engines: metadata.engines } : {}),
    ...optional(peers, 'peerDependencies'),
    ...(Object.keys(peerMeta).length ? { peerDependenciesMeta: peerMeta } : {}),
  };
  const newSpec = `${parsed[1]}${target}`;
  const rootEntry = packages[''];
  if (
    isObject(rootEntry) &&
    isObject(rootEntry[section]) &&
    typeof rootEntry[section].stripe === 'string'
  )
    rootEntry[section].stripe = newSpec;
  if (isObject(lock.dependencies) && isObject(lock.dependencies.stripe))
    lock.dependencies.stripe = {
      version: target,
      resolved: dist.tarball,
      integrity: dist.integrity,
      ...(lock.dependencies.stripe.dev === true ? { dev: true } : {}),
      ...optional(dependencies, 'requires'),
    };
  const declaration = new RegExp(`("stripe"\\s*:\\s*")${spec.replace(/[.^~]/g, '\\$&')}"`, 'g');
  if ((manifestText.match(declaration) ?? []).length !== 1)
    return { reason: 'package.json declares stripe more than once.' };
  return {
    upgrade: {
      from: entry.version,
      to: target,
      files: [
        {
          path: 'package.json',
          before: manifestText,
          after: manifestText.replace(declaration, `$1${newSpec}"`),
        },
        {
          path: 'package-lock.json',
          before: lockText,
          after: `${JSON.stringify(lock, null, 2)}\n`,
        },
      ],
    },
  };
}
