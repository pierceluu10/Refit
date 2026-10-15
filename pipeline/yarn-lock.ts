import { isObject, parseDocumentObject } from './specifications.ts';
import type { DependencyDeclaration, LockedDependency } from './types.ts';
import { PipelineInputError } from './types.ts';
import { EXACT_PACKAGE_VERSION } from './npm-lock.ts';

export const YARN_LOCKFILE = 'yarn.lock';
const CLASSIC_HEADER = /^# yarn lockfile v1$/m;
const REGISTRY_TARBALL = /^https:\/\/registry\.(?:yarnpkg\.com|npmjs\.org)\//;
// Registry ranges never contain '/', so `owner/repo` shorthands are caught with the hosted-git forms.
const LOCAL_OR_ALIASED =
  /^(?:npm:|workspace:|file:|link:|portal:|patch:|exec:|git[+:]|github:|gitlab:|bitbucket:|https?:)|\//;

interface YarnEntry {
  version?: string;
  resolved?: string;
  resolution?: string;
}

function descriptors(key: string) {
  return key.split(/,\s*/).map((descriptor) => descriptor.replace(/^"|"$/g, ''));
}

// Classic v1 is a custom format: unindented descriptor lines, then two-space indented fields.
function parseClassic(content: string) {
  const entries: Record<string, YarnEntry> = {};
  let current: YarnEntry | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      if (!line.endsWith(':'))
        throw new PipelineInputError(`${YARN_LOCKFILE} contains an unsupported entry line.`);
      current = {};
      for (const descriptor of descriptors(line.slice(0, -1))) entries[descriptor] = current;
      continue;
    }
    const field = line.match(/^ {2}(version|resolved) "?([^"]*)"?$/);
    if (field && current) current[field[1] as 'version' | 'resolved'] = field[2];
  }
  return { format: 'yarn-classic', lockfileVersion: 1, entries };
}

function parseBerry(content: string) {
  const document = parseDocumentObject(content, YARN_LOCKFILE);
  const metadata = document.__metadata;
  if (!isObject(metadata) || typeof metadata.version !== 'number')
    throw new PipelineInputError(`${YARN_LOCKFILE} lacks Yarn Berry __metadata.version.`);
  const entries: Record<string, YarnEntry> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === '__metadata' || !isObject(value)) continue;
    const entry: YarnEntry = {
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
      ...(typeof value.resolution === 'string' ? { resolution: value.resolution } : {}),
    };
    for (const descriptor of descriptors(key)) entries[descriptor] = entry;
  }
  return { format: 'yarn-berry', lockfileVersion: metadata.version, entries };
}

// Scans read yarn.lock only for version evidence, so an unreadable lockfile leaves SDK versions
// unknown instead of failing the scan.
export function parseYarnLock(content: string): Record<string, unknown> {
  try {
    return CLASSIC_HEADER.test(content) ? parseClassic(content) : parseBerry(content);
  } catch (cause) {
    if (!(cause instanceof PipelineInputError)) throw cause;
    return { format: 'unsupported', lockfileVersion: null, reason: cause.message };
  }
}

export function resolveYarnDependency(
  dependency: DependencyDeclaration,
  packageName: string,
  lock: Record<string, unknown>,
): LockedDependency {
  const unknown = (reason: string): LockedDependency => ({
    status: 'unknown',
    file: YARN_LOCKFILE,
    packagePath: null,
    version: null,
    reason,
  });
  if (lock.format === 'unsupported')
    return unknown(`${String(lock.reason)} No SDK version is inferred.`);
  if (LOCAL_OR_ALIASED.test(dependency.version))
    return unknown('Aliased, local, patched or URL SDK sources require manual review.');
  const berry = lock.format === 'yarn-berry';
  const descriptor = `${packageName}@${berry ? 'npm:' : ''}${dependency.version}`;
  const entries = isObject(lock.entries) ? lock.entries : {};
  const entry = Object.hasOwn(entries, descriptor) ? (entries[descriptor] as YarnEntry) : undefined;
  if (!entry)
    return unknown(
      'No yarn.lock entry matches this manifest declaration; regenerate the lockfile.',
    );
  const version = entry.version;
  const registry = berry
    ? entry.resolution === `${packageName}@npm:${version}`
    : typeof entry.resolved === 'string' && REGISTRY_TARBALL.test(entry.resolved);
  if (!version || !EXACT_PACKAGE_VERSION.test(version) || !registry)
    return unknown('The yarn.lock entry does not record an exact public registry version.');
  return {
    status: 'locked',
    file: YARN_LOCKFILE,
    packagePath: `${packageName}@${version}`,
    version,
    reason:
      'Version recorded in the matching yarn.lock entry. Installation and API-version applicability are not verified.',
  };
}
