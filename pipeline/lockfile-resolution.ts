import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  dockerSandboxArguments,
  preparationProfile,
  removeDockerContainer,
  removeExpiredSandboxContainers,
} from './docker-sandbox.ts';
import { readCommittedFile, type readCommittedRepository } from './committed-repository.ts';
import { legacyPeerDeps } from './dependency-inputs.ts';
import { dependencySources, MAX_LOCK_BYTES, MAX_PACKAGE_BYTES } from './npm-lock.ts';
import { isObject, parseJson } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Founders' decision (2026-10-27): a networked lockfile-resolution step may run before, and
// separate from, the offline validation. It writes a package-lock.json for validation only; the
// lockfile never reaches the patch. npm is the only manager with an absolute date cutoff
// (`--before`); pnpm has only a relative minimumReleaseAge and Yarn 1 has no lockfile-only mode.

const execute = promisify(execFile);
const RESOLUTION_TIMEOUT_MS = 300_000;
const MAX_LATE_PINS = 8;
// The preparation refusals a resolved lockfile can replace (dependency-preparation.ts).
export const RESOLVABLE_REFUSALS = new Set([
  'no-lockfile',
  'lockfile-out-of-sync',
  'lockfile-integrity',
]);

export class LockfileResolutionError extends PipelineInputError {
  override name = 'LockfileResolutionError';
  constructor(
    message: string,
    readonly result?: { code: number | null; signal: NodeJS.Signals | null; stderr: string },
  ) {
    super(message);
  }
}

// Off by default until the benchmark evidence is recorded; `on` enables resolution and the
// types-only peer bump that uses it.
export function lockfileResolutionEnabled(value = process.env.REFIT_LOCKFILE_RESOLUTION) {
  const mode = value?.trim() || 'on';
  if (mode !== 'on' && mode !== 'off')
    throw new PipelineInputError('REFIT_LOCKFILE_RESOLUTION must be on or off.');
  return mode === 'on';
}

// Runs in the container with only package.json (and a seed package-lock.json) in its workspace:
// no repository .npmrc, scripts or code. A declaration npm cannot satisfy as of the cutoff because
// its lowest version is newer (the stripe release a patch pins, a raised peer) is left out of a
// first pass and added back in a second, seeded with the first pass's lockfile and cut off at its
// publication time, so only those packages and what they newly need resolve later than the cutoff.
export const RESOLVE_SCRIPT = `
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [cutoff, legacy] = process.argv.slice(1);
const text = readFileSync("package.json", "utf8");
const manifest = JSON.parse(text);
const sections = ["dependencies", "devDependencies", "optionalDependencies"];
writeFileSync("/tmp/refit-user.npmrc", "");
writeFileSync("/tmp/refit-global.npmrc", "");
const env = { ...process.env, npm_config_userconfig: "/tmp/refit-user.npmrc", npm_config_globalconfig: "/tmp/refit-global.npmrc" };
function npm(before) {
  const result = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", "--cache=/workspace/.npm-cache", "--before=" + before, ...(legacy === "1" ? ["--legacy-peer-deps"] : [])], { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  process.stderr.write(result.stdout + result.stderr);
  return result;
}
async function published(name, version) {
  const response = await fetch("https://registry.npmjs.org/" + name.replace("/", "%2f"), { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new Error("The npm registry returned HTTP " + response.status + " for " + name + ".");
  const time = (await response.json()).time?.[version];
  if (typeof time !== "string") throw new Error("The npm registry records no publication time for " + name + " " + version + ".");
  return time;
}
const late = {};
for (let pass = 0; ; pass++) {
  const result = npm(cutoff);
  if (result.status === 0) break;
  const target = /No matching version found for (@?[^@\\s]+)@(\\S+?) with a date before/.exec(result.stderr);
  const section = target && sections.find((key) => manifest[key]?.[target[1]] === target[2]);
  const minimum = target && /^[~^]?(\\d+\\.\\d+\\.\\d+)$/.exec(target[2])?.[1];
  if (!section || !minimum || pass >= ${MAX_LATE_PINS}) process.exit(result.status ?? 1);
  const time = await published(target[1], minimum);
  if (Date.parse(time) <= Date.parse(cutoff)) process.exit(result.status ?? 1);
  late[target[1]] = { section, spec: target[2], published: time };
  delete manifest[section][target[1]];
  writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\\n");
}
if (Object.keys(late).length) {
  writeFileSync("package.json", text);
  const before = Object.values(late).map((entry) => entry.published).sort().at(-1);
  if (npm(before).status !== 0) process.exit(1);
}
process.stdout.write(JSON.stringify({ lockfile: readFileSync("package-lock.json", "utf8"), late }));
`;

export interface ResolvedLockfile {
  lockfile: string;
  // When Refit resolved it: the repository's last commit date, and any pins resolved later.
  before: string;
  late: Record<string, { spec: string; published: string }>;
}

// Resolves package-lock.json for a root npm project in its own networked container, as of `before`.
// `seed` is the committed lockfile npm starts from, so versions it locks that still satisfy
// package.json are kept. Every resolved package is then checked by the ordinary preparation.
export async function resolveNpmLockfile(options: {
  manifest: string;
  seed?: string;
  before: string;
  legacyPeerDeps?: boolean;
  image: string;
  signal?: AbortSignal;
}): Promise<ResolvedLockfile> {
  if (Number.isNaN(Date.parse(options.before)))
    throw new PipelineInputError(`Lockfile resolution needs a date; ${options.before} is not one.`);
  const manifest = parseJson(options.manifest);
  if (!isObject(manifest)) throw new PipelineInputError('package.json is not an object.');
  if (manifest.workspaces !== undefined)
    throw new PipelineInputError('Refit resolves lockfiles only for projects without workspaces.');
  const input = await mkdtemp(join(tmpdir(), 'refit-lock-input-'));
  const name = `refit-lockfile-${randomUUID()}`;
  try {
    await chmod(input, 0o755);
    await writeFile(join(input, 'package.json'), options.manifest, { mode: 0o644 });
    if (options.seed !== undefined)
      await writeFile(join(input, 'package-lock.json'), options.seed, { mode: 0o644 });
    await removeExpiredSandboxContainers();
    const argumentsList = dockerSandboxArguments({
      name,
      directory: input,
      image: options.image,
      command: [
        'node',
        '--input-type=module',
        '-e',
        RESOLVE_SCRIPT,
        new Date(options.before).toISOString(),
        options.legacyPeerDeps ? '1' : '0',
      ],
      network: 'bridge',
      timeoutMs: RESOLUTION_TIMEOUT_MS,
      preparation: preparationProfile(),
    });
    let stdout: string;
    try {
      ({ stdout } = await execute('docker', argumentsList, {
        maxBuffer: 2 * MAX_LOCK_BYTES,
        timeout: RESOLUTION_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        signal: options.signal,
      }));
    } catch (error) {
      options.signal?.throwIfAborted();
      const failed = error as { code?: unknown; signal?: NodeJS.Signals; stderr?: string };
      const stderr = String(failed.stderr ?? '');
      throw new LockfileResolutionError(
        `npm could not resolve a lockfile as of ${options.before} (${failed.code ?? failed.signal}). ${stderr.slice(-2048)}`,
        {
          code: typeof failed.code === 'number' ? failed.code : null,
          signal: failed.signal ?? null,
          stderr,
        },
      );
    }
    const output = parseJson(stdout);
    if (!isObject(output) || typeof output.lockfile !== 'string' || !isObject(output.late))
      throw new LockfileResolutionError('Lockfile resolution did not produce a lockfile.');
    return {
      lockfile:
        options.seed === undefined ? output.lockfile : keepSeedNames(options.seed, output.lockfile),
      before: options.before,
      late: output.late as ResolvedLockfile['late'],
    };
  } finally {
    const cleanup = await Promise.allSettled([
      removeDockerContainer(name),
      rm(input, { recursive: true, force: true }),
    ]);
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }
}

type Snapshot = Awaited<ReturnType<typeof readCommittedRepository>>;
// Lockfiles of other managers: their projects are not resolved through npm.
const OTHER_LOCKFILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
];

// The committed snapshot with a resolved package-lock.json in place of the refused or missing one,
// for a root npm project whose preparation refused for `reason`; undefined when resolution does not
// apply. An out-of-sync lockfile seeds the resolution; one without integrity does not, because
// its versions cannot be verified. `before` defaults to the snapshot's own commit date.
export async function resolvedLockfileSnapshot(
  snapshot: Snapshot,
  reason: string,
  options: {
    image: string;
    before?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  },
) {
  const paths = snapshot.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  if (
    !RESOLVABLE_REFUSALS.has(reason) ||
    !lockfileResolutionEnabled() ||
    !paths.includes('package.json') ||
    OTHER_LOCKFILES.some((file) => paths.includes(file))
  )
    return undefined;
  const manifest = await readCommittedFile(snapshot, 'package.json', MAX_PACKAGE_BYTES);
  const parsed = parseJson(manifest);
  if (!isObject(parsed)) throw new PipelineInputError('package.json is not an object.');
  // Git, local and URL dependencies keep their named stop (non-registry-dependency).
  dependencySources(parsed, 'package.json');
  // Only the .npmrc settings that change resolution are read; the file never reaches npm.
  const npmrc = paths.includes('.npmrc')
    ? await readCommittedFile(snapshot, '.npmrc', MAX_PACKAGE_BYTES)
    : '';
  if (/^\s*(?:@[^:\s]+:)?registry\s*=|_auth/m.test(npmrc))
    throw new PipelineInputError(
      'Automatic preparation supports public npm registry dependencies only; .npmrc configures another registry or registry credentials. Private registry dependencies require a custom image.',
    );
  const before = new Date(
    options.before ??
      (await snapshot.git(['show', '-s', '--format=%cI', snapshot.revision])).stdout.trim(),
  ).toISOString();
  options.onProgress?.(
    `Resolving package-lock.json as of ${before} in networked Docker, for validation only; lifecycle scripts are disabled...`,
  );
  const resolved = await resolveNpmLockfile({
    manifest,
    seed:
      reason === 'lockfile-out-of-sync'
        ? await readCommittedFile(snapshot, 'package-lock.json', MAX_LOCK_BYTES)
        : undefined,
    before,
    legacyPeerDeps: legacyPeerDeps(npmrc),
    image: options.image,
    signal: options.signal,
  });
  return {
    snapshot: {
      ...snapshot,
      entries: [
        ...snapshot.entries.filter((entry) => !entry.endsWith('\tpackage-lock.json')),
        '100644 blob 0000000000000000000000000000000000000000\tpackage-lock.json',
      ],
      replaced: new Map([['package-lock.json', resolved.lockfile]]),
    },
    record: {
      reason,
      before,
      ...(Object.keys(resolved.late).length ? { late: resolved.late } : {}),
    },
  };
}

// The package name an npm lockfile key installs (`node_modules/a/node_modules/@b/c` is `@b/c`).
const packageName = (key: string) => key.slice(key.lastIndexOf('node_modules/') + 13);

// Lockfile keys Node reaches from the root without passing through `skip`, resolving each
// dependency to the nearest node_modules directory up the tree, as Node does.
function reachedWithout(packages: Record<string, unknown>, skip: Set<string>) {
  const seen = new Set<string>(['']);
  const pending = [''];
  while (pending.length) {
    const key = pending.pop()!;
    const entry = packages[key];
    if (!isObject(entry)) continue;
    const names = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
      .filter((section) => section !== 'devDependencies' || key === '')
      .flatMap((section) => (isObject(entry[section]) ? Object.keys(entry[section]) : []));
    for (const name of names) {
      if (skip.has(name)) continue;
      for (
        let base = key;
        ;
        base = base.slice(0, Math.max(0, base.lastIndexOf('/node_modules/')))
      ) {
        const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
        if (packages[candidate] !== undefined) {
          if (!seen.has(candidate)) {
            seen.add(candidate);
            pending.push(candidate);
          }
          break;
        }
        if (!base) break;
      }
    }
  }
  return seen;
}

// npm names a lockfile after the directory it resolved in when package.json has no name; keep the
// names the committed lockfile records, in npm's own layout, so the shipped lockfile renames nothing.
export function keepSeedNames(seed: string, lockfile: string) {
  const [old, lock] = [parseJson(seed), parseJson(lockfile)];
  if (!isObject(old) || !isObject(lock) || !isObject(lock.packages)) return lockfile;
  const root = isObject(lock.packages['']) ? lock.packages[''] : undefined;
  const oldRoot = isObject(old.packages) && isObject(old.packages['']) ? old.packages[''] : {};
  if (lock.name === old.name && (!root || root.name === oldRoot.name)) return lockfile;
  const named = (entry: Record<string, unknown>, name: unknown) => {
    const { name: _, ...rest } = entry;
    return name === undefined ? rest : { name, ...rest };
  };
  const kept = {
    ...named(lock, old.name),
    packages: root ? { ...lock.packages, '': named(root, oldRoot.name) } : lock.packages,
  };
  const indent = /^\{\r?\n([ \t]+)"/.exec(lockfile)?.[1] ?? '  ';
  const eol = lockfile.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(kept, null, indent).replace(/\n/g, eol) + eol;
}

// The lockfile keys that change between two npm lockfiles outside `names` and the packages only
// they reach; empty when the change stays inside them.
export function changesOutside(before: string, after: string, names: string[]) {
  const packages = (text: string) => {
    const lock = parseJson(text);
    return isObject(lock) && isObject(lock.packages) ? lock.packages : {};
  };
  const [old, changed] = [packages(before), packages(after)];
  const skip = new Set(names);
  const shared = new Set([...reachedWithout(old, skip), ...reachedWithout(changed, skip)]);
  // The root record's own declarations of `names` are the upgrade itself.
  const root = (entry: unknown) =>
    JSON.stringify(
      isObject(entry)
        ? Object.fromEntries(
            Object.entries(entry).map(([key, value]) => [
              key,
              isObject(value)
                ? Object.fromEntries(Object.entries(value).filter(([name]) => !skip.has(name)))
                : value,
            ]),
          )
        : entry,
    );
  return [...new Set([...Object.keys(old), ...Object.keys(changed)])].filter((key) => {
    if (key === '') return root(old[key]) !== root(changed[key]);
    if (JSON.stringify(old[key]) === JSON.stringify(changed[key])) return false;
    return !skip.has(packageName(key)) && shared.has(key);
  });
}
