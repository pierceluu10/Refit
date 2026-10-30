import { readCommittedFile, type readCommittedRepository } from './committed-repository.ts';
import {
  EXACT_PACKAGE_VERSION,
  hasStrongIntegrity,
  MAX_LOCK_BYTES,
  REGISTRY_PACKAGE_NAME,
} from './npm-lock.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { LOCAL_OR_ALIASED, parseClassic, YARN_LOCKFILE, type YarnEntry } from './yarn-lock.ts';

type Snapshot = Awaited<ReturnType<typeof readCommittedRepository>> & {
  replaced?: ReadonlyMap<string, string>;
};

// A Yarn 1 lockfile record that keeps an exact version but lacks its registry URL or a
// SHA-256-or-stronger integrity is completed, for installation only, from the registry's metadata
// for that exact version: the installed version stays the committed one, and Yarn checks the
// downloaded tarball against the registry's integrity. npm never lets a published version change,
// so that integrity identifies the bytes every install of the version receives. Where the lockfile
// records a SHA-1 (a `#sha1` URL fragment), the registry's must equal it. The completed yarn.lock
// never reaches the patch.
const REGISTRY = 'https://registry.npmjs.org';
// Completion fetches one metadata document per record; a lockfile that needs more stays refused.
export const MAX_COMPLETED_RECORDS = 200;
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 8;
const YARN_INTEGRITY_REFUSAL = /^Every yarn\.lock entry must resolve an exact version/;

export interface CompletedLockfile {
  lockfile: typeof YARN_LOCKFILE;
  registry: typeof REGISTRY;
  // name@version of every completed record.
  records: string[];
}

export class RegistryUnreachableError extends PipelineInputError {
  override name = 'RegistryUnreachableError';
}

// `name@range`, where a scoped name has its own leading `@`.
const packageName = (descriptor: string) =>
  descriptor.slice(0, descriptor.indexOf('@', descriptor.startsWith('@') ? 1 : 0));
const tarballPath = (name: string, version: string) =>
  `/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;

// The records completion would fill, or a reason it cannot: one that is not an exact registry
// version, or a registry URL Yarn could not have written for it.
export function incompleteYarnRecords(content: string) {
  const { entries } = parseClassic(content);
  const records = new Map<YarnEntry, string>();
  for (const [descriptor, record] of Object.entries(entries)) {
    if (record.resolved !== undefined && hasStrongIntegrity(record.integrity)) continue;
    const name = packageName(descriptor);
    const range = descriptor.slice(name.length + 1);
    const tarball = record.resolved && new URL(record.resolved);
    if (
      !REGISTRY_PACKAGE_NAME.test(name) ||
      LOCAL_OR_ALIASED.test(range) ||
      !record.version ||
      !EXACT_PACKAGE_VERSION.test(record.version) ||
      (records.has(record) && records.get(record) !== name) ||
      (tarball &&
        (!['registry.npmjs.org', 'registry.yarnpkg.com'].includes(tarball.hostname) ||
          tarball.search ||
          (tarball.hash && !/^#[a-f0-9]{40}$/.test(tarball.hash)) ||
          decodeURIComponent(tarball.pathname) !== tarballPath(name, record.version)))
    )
      return { refused: descriptor };
    records.set(record, name);
  }
  return { records, entries };
}

async function registryVersion(name: string, version: string, signal?: AbortSignal) {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}/${version}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
  } catch (cause) {
    signal?.throwIfAborted();
    throw new RegistryUnreachableError(
      `Refit could not reach ${REGISTRY} to read ${name}@${version} within ${FETCH_TIMEOUT_MS / 1000} seconds.`,
      { cause },
    );
  }
  if (response.status >= 500)
    throw new RegistryUnreachableError(
      `${REGISTRY} answered ${response.status} for ${name}@${version}.`,
    );
  if (!response.ok)
    throw new PipelineInputError(
      `${REGISTRY} does not publish ${name}@${version}, which yarn.lock locks (HTTP ${response.status}).`,
    );
  const body: unknown = await response.json();
  const dist = isObject(body) && isObject(body.dist) ? body.dist : {};
  if (
    !isObject(body) ||
    body.name !== name ||
    body.version !== version ||
    typeof dist.tarball !== 'string' ||
    typeof dist.shasum !== 'string' ||
    !hasStrongIntegrity(dist.integrity) ||
    new URL(dist.tarball).origin !== REGISTRY ||
    decodeURIComponent(new URL(dist.tarball).pathname) !== tarballPath(name, version)
  )
    throw new PipelineInputError(
      `${REGISTRY} does not record a registry tarball and SHA-256-or-stronger integrity for ${name}@${version}.`,
    );
  return { tarball: dist.tarball, shasum: dist.shasum, integrity: dist.integrity };
}

// Completes yarn.lock when its only refusal is records without a registry URL or integrity;
// returns undefined where completion does not apply, so the original refusal stands.
export async function completedYarnLockSnapshot(
  snapshot: Snapshot,
  refusal: Error,
  options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
) {
  const paths = snapshot.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  if (!YARN_INTEGRITY_REFUSAL.test(refusal.message) || !paths.includes(YARN_LOCKFILE))
    return undefined;
  const content = await readCommittedFile(snapshot, YARN_LOCKFILE, MAX_LOCK_BYTES);
  const incomplete = incompleteYarnRecords(content);
  if ('refused' in incomplete)
    throw new PipelineInputError(
      `yarn.lock records ${incomplete.refused} without an exact registry version and URL, so Refit cannot complete it from the registry.`,
    );
  const records = [...incomplete.records];
  if (!records.length) return undefined;
  if (records.length > MAX_COMPLETED_RECORDS)
    throw new PipelineInputError(
      `yarn.lock has ${records.length} records without a registry URL or SHA-256-or-stronger integrity; Refit completes at most ${MAX_COMPLETED_RECORDS} from the registry.`,
    );
  options.onProgress?.(
    `Completing ${records.length} yarn.lock records from ${REGISTRY} metadata for their exact versions, for validation only...`,
  );
  const completed = new Map<YarnEntry, Awaited<ReturnType<typeof registryVersion>>>();
  for (let start = 0; start < records.length; start += CONCURRENCY)
    await Promise.all(
      records.slice(start, start + CONCURRENCY).map(async ([record, name]) => {
        const published = await registryVersion(name, record.version!, options.signal);
        const sha1 =
          (record.resolved && new URL(record.resolved).hash.slice(1)) ||
          (record.integrity?.startsWith('sha1-')
            ? Buffer.from(record.integrity.slice(5), 'base64').toString('hex')
            : undefined);
        if (sha1 && sha1 !== published.shasum)
          throw new PipelineInputError(
            `yarn.lock records ${name}@${record.version} with SHA-1 ${sha1}, but ${REGISTRY} publishes ${published.shasum}.`,
          );
        completed.set(record, published);
      }),
    );
  // Rewrite each completed block in place: keep its lines, add what it lacks after `version`.
  const { entries } = incomplete;
  const lines: string[] = [];
  let block: ReturnType<typeof completed.get>;
  for (const line of content.split('\n')) {
    if (line && !line.startsWith(' ') && !line.startsWith('#') && line.endsWith(':')) {
      const descriptor = line.slice(0, -1).split(/,\s*/)[0].replace(/^"|"$/g, '');
      block = completed.get(entries[descriptor]);
    } else if (block && /^ {2}(?:resolved|integrity) /.test(line)) continue;
    lines.push(line);
    if (block && /^ {2}version /.test(line))
      lines.push(`  resolved "${block.tarball}#${block.shasum}"`, `  integrity ${block.integrity}`);
  }
  const lockfile = lines.join('\n');
  return {
    snapshot: {
      ...snapshot,
      entries: [
        ...snapshot.entries.filter((entry) => !entry.endsWith(`\t${YARN_LOCKFILE}`)),
        `100644 blob 0000000000000000000000000000000000000000\t${YARN_LOCKFILE}`,
      ],
      replaced: new Map([...(snapshot.replaced ?? []), [YARN_LOCKFILE, lockfile]]),
    },
    record: {
      lockfile: YARN_LOCKFILE,
      registry: REGISTRY,
      records: records.map(([record, name]) => `${name}@${record.version}`).sort(),
    } satisfies CompletedLockfile,
  };
}
