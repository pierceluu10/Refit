import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeSnapshot, fetchStripeSnapshot } from './snapshots.ts';
import { COMMIT_REVISION, digest, isObject, parseObject } from './specifications.ts';
import { hasErrorCode } from './state-files.ts';
import { PipelineInputError } from './types.ts';

// Built by scripts/stripe-openapi-versions.mjs from the stripe/openapi tags the frozen benchmark
// lists pin; every entry's spec3.json was downloaded and its info.version checked.
export const STRIPE_OPENAPI_VERSIONS = new URL(
  '../data/stripe-openapi-versions.json',
  import.meta.url,
);
// Where a generated configuration's contracts are saved on this machine. The hosted worker keeps
// its own under its state directory.
export const DEFAULT_CONTRACTS_DIRECTORY = join(homedir(), '.refit', 'contracts');
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION_KEYS = 'bytes,commit,sha256,tag,version';

export interface StripeContractVersion {
  version: string;
  tag: string;
  commit: string;
  sha256: string;
  bytes: number;
}

let versions: StripeContractVersion[] | undefined;

export function stripeContractVersions(): StripeContractVersion[] {
  if (versions) return versions;
  const value: unknown = JSON.parse(readFileSync(STRIPE_OPENAPI_VERSIONS, 'utf8'));
  if (
    !isObject(value) ||
    value.formatVersion !== 1 ||
    !Array.isArray(value.versions) ||
    !value.versions.length ||
    !value.versions.every(
      (entry) =>
        isObject(entry) &&
        Object.keys(entry).sort().join(',') === VERSION_KEYS &&
        typeof entry.version === 'string' &&
        typeof entry.tag === 'string' &&
        typeof entry.commit === 'string' &&
        COMMIT_REVISION.test(entry.commit) &&
        typeof entry.sha256 === 'string' &&
        SHA256.test(entry.sha256) &&
        Number.isSafeInteger(entry.bytes),
    )
  )
    throw new PipelineInputError(`${STRIPE_OPENAPI_VERSIONS.pathname} is malformed.`);
  const entries = value.versions as StripeContractVersion[];
  if (entries.some((entry, index) => index > 0 && entries[index - 1].version >= entry.version))
    throw new PipelineInputError(
      `${STRIPE_OPENAPI_VERSIONS.pathname} must list each version once, oldest first.`,
    );
  versions = entries;
  return versions;
}

export function stripeContractVersion(version: string) {
  return stripeContractVersions().find((entry) => entry.version === version);
}

// The newest version Refit has a contract for: the version a generated configuration moves to.
export function latestStripeContract() {
  return stripeContractVersions().at(-1)!;
}

// The path a generated configuration names the contract by, relative to the contracts directory.
export function stripeContractFile(version: string) {
  return `refit/stripe-${version}.json`;
}

function known(version: string) {
  const entry = stripeContractVersion(version);
  if (!entry)
    throw new PipelineInputError(
      `Refit has no Stripe contract for API version ${version}; it knows ${stripeContractVersions()[0].version} to ${latestStripeContract().version}.`,
    );
  return entry;
}

// Reads a saved contract and checks it is the exact stripe/openapi commit and content the table
// names, so a generated configuration always reads the same bytes on every machine.
export async function readStripeContract(directory: string, version: string) {
  const entry = known(version);
  const path = join(resolve(directory), stripeContractFile(version));
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
    throw new PipelineInputError(
      `Stripe's ${version} contract is not saved on this machine yet. Run refit stripe-snapshot --version ${version} to save it.`,
      { cause: error },
    );
  }
  const snapshot = parseObject(content, path);
  if (
    snapshot.kind !== 'refit-snapshot' ||
    snapshot.revision !== entry.commit ||
    snapshot.hash !== entry.sha256 ||
    typeof snapshot.content !== 'string' ||
    digest(snapshot.content) !== entry.sha256
  )
    throw new PipelineInputError(
      `${path} is not stripe/openapi ${entry.tag}; delete it and run refit stripe-snapshot --version ${version} again.`,
    );
  return { path, content };
}

// Downloads the contract the table names unless it is already saved, and refuses content whose
// hash differs from the table.
export async function saveStripeContract(directory: string, version: string) {
  const entry = known(version);
  try {
    return await readStripeContract(directory, version);
  } catch (error) {
    if (!(error instanceof PipelineInputError) || !hasErrorCode(error.cause, 'ENOENT')) throw error;
  }
  const snapshot = await fetchStripeSnapshot(entry.commit);
  if (snapshot.hash !== entry.sha256)
    throw new PipelineInputError(
      `stripe/openapi ${entry.tag} no longer has the content Refit recorded for ${version}; nothing was saved.`,
    );
  const path = join(resolve(directory), stripeContractFile(version));
  await mkdir(join(resolve(directory), 'refit'), { recursive: true, mode: 0o700 });
  // Unique per attempt: a restarted worker can have the PID of one that crashed mid-write.
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, encodeSnapshot(snapshot), { flag: 'wx', mode: 0o600 });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return readStripeContract(directory, version);
}
