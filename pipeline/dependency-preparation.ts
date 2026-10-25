import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { readCommittedRepository } from './committed-repository.ts';
import {
  DOCKER_IMAGE_ID,
  dockerSandboxArguments,
  MAX_VALIDATION_ARCHIVE_BYTES,
  preparationProfile,
  validationProfile,
  removeDockerContainer,
  removeExpiredSandboxContainers,
  resolveDockerImage,
} from './docker-sandbox.ts';
import { standaloneStateDirectory } from './github-checkout.ts';
import { readPreparationInputs, type PreparationIdentity } from './dependency-inputs.ts';
import {
  NPM_TOOL_INSTALL_COMMAND,
  PNPM_INSTALL_COMMAND,
  YARN_BERRY_INSTALL_COMMAND,
  YARN_INSTALL_COMMAND,
  YARN_SKIP_PLATFORM_PACKAGES,
} from './manager-install.ts';
import { hasStrongIntegrity } from './npm-lock.ts';
import { digest, parseObject } from './specifications.ts';
import { hasErrorCode, withStateLock, writeState } from './state-files.ts';
import { packageSnapshot } from './preparation-packages.ts';
import { preparationStop } from './preparation-stops.ts';
import { PipelineInputError } from './types.ts';
import { verifyArtifacts } from './verification.ts';

const RECIPE_VERSION = 5;
const LEGACY_PEER_DEPS_MARKER = 'REFIT_LEGACY_PEER_DEPS=1';
// --replace-registry-host=always fetches every locked tarball from registry.npmjs.org, including
// ones a lockfile resolved through a public mirror (npm-lock.ts); integrity still decides.
const npmCi = (binary: string) =>
  `${binary} ci --ignore-scripts --include=dev --engine-strict --no-audit --no-fund ` +
  '--registry=https://registry.npmjs.org --replace-registry-host=always --cache=/workspace/.npm-cache';
const DEFAULT_INSTALL_TIMEOUT_SECONDS = 300;
const MIN_INSTALL_TIMEOUT_SECONDS = 60;
const MAX_INSTALL_TIMEOUT_SECONDS = 1800;
const DEFAULT_CACHE_GIB = 8;
const MIN_CACHE_GIB = 1;
const MAX_CACHE_GIB = 1024;
const GIB = 1024 ** 3;
const CACHE_ENTRY = /^[0-9a-f]{64}$/;
const PREPARE_LOCK = 'prepare';
const BUNDLE = 'bundle';
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_ERROR_CHARACTERS = 4096;
const ARCHIVE = 'dependencies.tar';
const ENVIRONMENT = 'environment.json';
export const DEPENDENCY_TREE_CHECK = `
import { lstat, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
const workspace = await realpath(".");
const { links = {}, optionalLinks = {}, directories = [], hashes = {} } = JSON.parse(process.argv[1] ?? "{}");
const { readFile } = await import("node:fs/promises");
const { createHash } = await import("node:crypto");
for (const [file, hash] of Object.entries(hashes)) {
  if (createHash("sha256").update(await readFile(file)).digest("hex") !== hash)
    throw new Error("The installer changed a committed dependency input");
}
const roots = [resolve(workspace, "node_modules")];
for (const directory of directories) {
  const root = resolve(workspace, directory, "node_modules");
  try { await lstat(root); roots.push(root); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
for (const root of roots) {
  const entry = await lstat(root);
  if (!entry.isDirectory() || (await realpath(root)) !== root) throw new Error("node_modules must be a physical directory");
}
async function verify(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    const name = relative(workspace, path).split(sep).join("/");
    if (Object.hasOwn(links, name) || Object.hasOwn(optionalLinks, name)) {
      const target = resolve(workspace, links[name] ?? optionalLinks[name]);
      if (await realpath(path) !== target || await realpath(target) !== target || !(await lstat(target)).isDirectory())
        throw new Error("Workspace link differs from the committed lockfile");
    } else {
      const physical = await realpath(path);
      if (!roots.some((root) => physical.startsWith(root + sep)))
        throw new Error("Dependency link escapes node_modules");
    }
  } else if (entry.isDirectory()) {
    for (const child of await readdir(path)) await verify(resolve(path, child));
  } else if (!entry.isFile()) {
    throw new Error("Dependency tree contains a special file");
  }
}
for (const root of roots) await verify(root);
for (const name of Object.keys(links)) {
  if (!(await lstat(resolve(workspace, name))).isSymbolicLink()) throw new Error("Missing workspace dependency link");
}
`;
function installCommand(
  { manager, managerVersion, legacyPeerDeps, platformPackages }: PreparationIdentity,
  platformPackageMode?: 'skip' | 'install',
) {
  const NPM_CI = npmCi(managerVersion ? '"$refit_tool"' : 'npm');
  return [
    'sh',
    '-c',
    'set -eu; : > /tmp/refit-user.npmrc; : > /tmp/refit-global.npmrc; ' +
      'export NPM_CONFIG_USERCONFIG=/tmp/refit-user.npmrc NPM_CONFIG_GLOBALCONFIG=/tmp/refit-global.npmrc; ' +
      'node -p \'"REFIT_NODE_VERSION=" + process.version\' >&2; ' +
      'printf "REFIT_NPM_VERSION=" >&2; npm --version >&2; ' +
      (manager === 'pnpm'
        ? PNPM_INSTALL_COMMAND
        : manager === 'yarn'
          ? managerVersion?.startsWith('1.')
            ? YARN_INSTALL_COMMAND
            : (platformPackages && platformPackageMode !== 'install'
                ? YARN_SKIP_PLATFORM_PACKAGES
                : '') + YARN_BERRY_INSTALL_COMMAND
          : (managerVersion ? NPM_TOOL_INSTALL_COMMAND : '') +
            (legacyPeerDeps
              ? // The repository's own .npmrc asks for it, so there is nothing to retry.
                `${NPM_CI} --legacy-peer-deps >&2; `
              : // A peer dependency conflict (ERESOLVE) is retried once with the same exact lockfile
                // and --legacy-peer-deps (owner decision, 2026-10-20); the marker records it.
                `if ${NPM_CI} > /workspace/.refit-npm-ci.log 2>&1; then cat /workspace/.refit-npm-ci.log >&2; ` +
                "elif grep -Eq '^npm (ERR!|error) code ERESOLVE$' /workspace/.refit-npm-ci.log; then " +
                `printf "${LEGACY_PEER_DEPS_MARKER}\\n" >&2; ${NPM_CI} --legacy-peer-deps >&2; cat /workspace/.refit-npm-ci.log >&2; ` +
                'else cat /workspace/.refit-npm-ci.log >&2; exit 1; fi; ') +
            'mkdir -p node_modules; ' +
            (managerVersion ? 'mv /workspace/.refit-tools node_modules/.refit-tools; ' : '')) +
      `node --input-type=module -e '${DEPENDENCY_TREE_CHECK}' "$1"; shift; ` +
      'printf "node_modules\\n" > /workspace/.refit-dependency-paths; ' +
      'for directory do if [ -d "$directory/node_modules" ]; then printf "%s\\n" "$directory/node_modules" >> /workspace/.refit-dependency-paths; fi; done; ' +
      'tar -cf - -T /workspace/.refit-dependency-paths',
  ];
}

// The environment keys that record the pinned manager: npmVersion is the image's own npm.
const managerKey = (inputs: PreparationIdentity) =>
  inputs.manager === 'npm' ? 'npmTool' : inputs.manager;

function matchesManager(inputs: PreparationIdentity, version: unknown, integrity: unknown) {
  return (
    version === inputs.managerVersion &&
    hasStrongIntegrity(integrity) &&
    (!inputs.managerIntegrity || integrity === inputs.managerIntegrity)
  );
}

// Operators can extend the installer deadline for large dependency trees; it stays bounded.
export function installTimeoutSeconds(value = process.env.REFIT_DEPENDENCY_TIMEOUT_SECONDS) {
  if (!value?.trim()) return DEFAULT_INSTALL_TIMEOUT_SECONDS;
  const seconds = Number(value);
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_INSTALL_TIMEOUT_SECONDS ||
    seconds > MAX_INSTALL_TIMEOUT_SECONDS
  )
    throw new PipelineInputError(
      `REFIT_DEPENDENCY_TIMEOUT_SECONDS must be a whole number from ${MIN_INSTALL_TIMEOUT_SECONDS} to ${MAX_INSTALL_TIMEOUT_SECONDS}.`,
    );
  return seconds;
}

// Bounds the dependency cache; least recently used bundles are evicted after a new one is written.
export function cacheLimitBytes(value = process.env.REFIT_DEPENDENCY_CACHE_GIB) {
  if (!value?.trim()) return DEFAULT_CACHE_GIB * GIB;
  const gib = Number(value);
  // Number() also reads hex and exponents ("0x10", "1e1"); only decimal digits are accepted.
  if (!/^\s*\d+\s*$/.test(value) || gib < MIN_CACHE_GIB || gib > MAX_CACHE_GIB)
    throw new PipelineInputError(
      `REFIT_DEPENDENCY_CACHE_GIB must be a whole number of GiB from ${MIN_CACHE_GIB} to ${MAX_CACHE_GIB}.`,
    );
  return gib * GIB;
}

function unlessMissing(error: unknown) {
  if (hasErrorCode(error, 'ENOENT')) return undefined;
  throw error;
}

async function entryBytes(root: string) {
  const entries =
    (await readdir(root, { recursive: true, withFileTypes: true }).catch(unlessMissing)) ?? [];
  let bytes = 0;
  for (const entry of entries)
    if (entry.isFile())
      bytes += (await lstat(join(entry.parentPath, entry.name)).catch(unlessMissing))?.size ?? 0;
  return bytes;
}

// The bundle directory's mtime records its last use: it is written once, then touched on reuse.
const lastUse = async (root: string) =>
  (await lstat(join(root, BUNDLE)).catch(unlessMissing))?.mtimeMs ?? 0;

// Evicts one entry under its preparation lock, so a process preparing, reusing or copying it is
// never disturbed. Returns false when the entry is in use or was used since it was listed.
async function evictEntry(root: string, used: number) {
  let names: string[] | undefined;
  try {
    names = await withStateLock(root, PREPARE_LOCK, async () => {
      if ((await lastUse(root)) !== used) return undefined;
      // One rename unpublishes the bundle, so a reader never sees a partly removed one.
      if (used) await rename(join(root, BUNDLE), join(root, `evicted-${randomUUID()}`));
      return (await readdir(root)).filter((name) => !name.startsWith(`${PREPARE_LOCK}.lock`));
    });
  } catch (error) {
    // Every lock refusal (held by a live process, unverifiable, recovering) leaves the entry alone.
    if (error instanceof PipelineInputError) return false;
    throw error;
  }
  if (!names) return false;
  // Outside the lock: these names are unpublished, and a new preparation uses fresh staging names.
  // The empty entry directory stays, since a preparation may already have resolved it.
  await Promise.all(
    names.map((name) => rm(join(root, name), { recursive: true, force: true, maxRetries: 3 })),
  );
  return true;
}

export async function evictDependencies(cache: string, keep: string, limit: number) {
  const entries = [];
  for (const name of await readdir(cache)) {
    if (!CACHE_ENTRY.test(name)) continue;
    const root = join(cache, name);
    entries.push({ root, used: await lastUse(root), bytes: await entryBytes(root) });
  }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const evicted = [];
  for (const entry of entries
    .filter((candidate) => candidate.root !== keep && candidate.bytes > 0)
    .sort((a, b) => a.used - b.used)) {
    if (total <= limit) break;
    if (!(await evictEntry(entry.root, entry.used))) continue;
    total -= entry.bytes;
    evicted.push(entry.root);
  }
  return { evicted, bytes: total };
}

// Yarn records platform-specific packages without checksums. Refit skips them unless an operator
// accepts installing them unverified for this host (Needs owner decision; off by default).
export function yarnPlatformPackageMode(value = process.env.REFIT_YARN_PLATFORM_PACKAGES) {
  const mode = value?.trim() || 'skip';
  if (mode !== 'skip' && mode !== 'install')
    throw new PipelineInputError('REFIT_YARN_PLATFORM_PACKAGES must be skip or install.');
  return mode;
}

export class DependencyPreparationError extends PipelineInputError {
  override name = 'DependencyPreparationError';
  // A named stop from preparation-stops.ts, when the cause is one the repository owner fixes.
  stop?: string;
}

// Adds the named stop's next step to a preparation refusal, keeping the original message first.
function withPreparationStop(error: unknown) {
  if (!(error instanceof PipelineInputError)) return error;
  const stop = preparationStop(error.message);
  if (!stop) return error;
  const named = new DependencyPreparationError(`${error.message} ${stop.action}`, { cause: error });
  named.stop = stop.reason;
  return named;
}

// Preparation failures the repository owner fixes in the repository. Each pattern matches a
// message Refit or the package manager raises; anything else (Docker, network, sandbox) is not one.
const REPOSITORY_DEPENDENCY_FAILURES = [
  {
    reason: 'no-lockfile',
    pattern: /^The repository commits package\.json without a lockfile/,
    summary: 'the repository has no committed lockfile',
    action: () =>
      'Commit a lockfile (for npm, run `npm install` and commit `package-lock.json`), then rerun your checks on this branch.',
  },
  {
    reason: 'lockfile-out-of-sync',
    pattern:
      /differ from the committed package-lock\.json|^Workspaces must match the committed root lockfile|^Workspace names and versions must match their committed lockfile records|^pnpm lockfile importers must exactly match|^npm dependency preparation failed[\s\S]*\bin sync\b|ERR_PNPM_OUTDATED_LOCKFILE|Your lockfile needs to be updated/,
    summary: 'the committed lockfile is out of sync with package.json',
    action: (lockfile: string) =>
      `Update \`${lockfile}\` so it matches \`package.json\` (run your package manager's install), commit it, then rerun your checks on this branch.`,
  },
  {
    reason: 'lockfile-integrity',
    pattern:
      /^Every npm package requires a registry URL, version and SHA-256-or-stronger integrity|^package-lock\.json records .+ without a version, registry "resolved" URL and SHA-256-or-stronger "integrity"|^Every pnpm package needs a registry name\/version and SHA-256-or-stronger integrity|^Every yarn\.lock entry must resolve an exact version to a public registry tarball/,
    summary: 'lockfile entries have no registry integrity hash',
    action: (lockfile: string) =>
      `Regenerate \`${lockfile}\` from the public npm registry so every entry records its tarball URL and integrity hash, commit it, then rerun your checks on this branch.`,
  },
  {
    reason: 'peer-dependency-conflict',
    pattern: /^npm dependency preparation failed[\s\S]*\bERESOLVE\b/,
    summary: "npm rejects the committed lockfile's conflicting peer dependencies",
    action: (lockfile: string) =>
      `Resolve the peer dependency conflict npm reports (\`npm ci\` fails with ERESOLVE even with \`--legacy-peer-deps\`), commit the updated \`${lockfile}\`, then rerun your checks on this branch.`,
  },
  {
    reason: 'dependency-archive-limit',
    pattern: /^Dependency archive exceeds \d+ MiB/,
    summary: "the installed dependencies exceed Refit's validation sandbox limit",
    action: () =>
      "Run your own tests and type check on this branch before merging; Refit's sandbox could not hold this dependency tree.",
  },
] as const;
export const OTHER_DEPENDENCY_FAILURE = {
  reason: 'preparation-failed',
  summary: 'Refit could not install them in its sandbox',
  action: () =>
    'Install the dependencies and run your own tests and type check on this branch before merging; Refit ran none.',
};

// An absolute path in a refusal names the host or container layout, never the repository's files:
// alone, after `unix://` or `file://`, in a `:`-separated list, or with spaces before a further `/`.
// A `/` inside a word, a URL, base64 (`sha512-…+/…`) or an alias (`@/lib`) is not one.
const ABSOLUTE_PATH = /(?:(?<![\w.~/@+-])|(?<=:\/\/))\/[\w.@+~-](?:[\w.@+~/-]| (?=[\w.@+~-]+\/))*/g;

// Docker or the network failed, not the repository's install: the job fails and is retried. 125
// is `docker run` itself failing (a name conflict, denied mounts, the host out of space); 137 and
// 143 are kills from outside the container.
const HOST_EXIT_CODES = new Set([125, 137, 143]);
const HOST_FAILURE =
  /Cannot connect to the Docker daemon|error during connect|Mounts denied|overlay[\s\S]*(?:ENOSPC|no space left)/i;
const REGISTRY_UNREACHABLE =
  /\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ERR_SOCKET_TIMEOUT)\b|socket hang up/;

export class PreparationHostError extends PipelineInputError {
  override name = 'PreparationHostError';
}

// The error a failed install raises when Refit's host, not the repository, caused it.
export function hostInstallFailure(
  manager: string,
  result: { code: number | null; signal: NodeJS.Signals | null },
  stderr: string,
) {
  const tail = stderr.slice(-MAX_ERROR_CHARACTERS);
  if (
    HOST_EXIT_CODES.has(result.code ?? 0) ||
    result.signal === 'SIGKILL' ||
    result.signal === 'SIGTERM' ||
    HOST_FAILURE.test(stderr)
  )
    return new PreparationHostError(
      `Docker could not run ${manager} dependency preparation (${result.code ?? result.signal}). ${tail}`,
    );
  if (REGISTRY_UNREACHABLE.test(stderr))
    return new PreparationHostError(
      `${manager} could not reach the package registry during dependency preparation. ${tail}`,
    );
  return undefined;
}

// A refusal of the repository's committed inputs is the repository's to fix, so a patch can be
// published untested beside it.
function repositoryRefusal(error: unknown): never {
  throw error instanceof PipelineInputError && !(error instanceof DependencyPreparationError)
    ? new DependencyPreparationError(error.message, { cause: error })
    : error;
}

// Why preparation refused, for a patch published untested (owner decision 1, 2026-10-24): a named
// repository-side cause with its fix, or any other refusal of the repository's inputs or install.
// Refit's own errors (state locks, the dependency cache, Docker, settings, cancellation) return
// undefined, so the job fails and is retried instead of publishing an untested patch.
export function preparationFailure(error: unknown) {
  if (!(error instanceof PipelineInputError)) return undefined;
  const failure =
    REPOSITORY_DEPENDENCY_FAILURES.find((entry) => entry.pattern.test(error.message)) ??
    (error instanceof DependencyPreparationError ? OTHER_DEPENDENCY_FAILURE : undefined);
  if (!failure) return undefined;
  const lockfile = /pnpm/i.test(error.message)
    ? 'pnpm-lock.yaml'
    : /yarn/i.test(error.message)
      ? 'yarn.lock'
      : 'package-lock.json';
  return {
    reason: failure.reason,
    summary: failure.summary,
    action: failure.action(lockfile),
    message: error.message.replace(ABSOLUTE_PATH, '[path]'),
  };
}

async function installDependencies(
  argumentsList: string[],
  output: string,
  inputs: PreparationIdentity,
  timeoutSeconds: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = spawn('docker', argumentsList, { stdio: ['ignore', 'pipe', 'pipe'], signal });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutSeconds * 1000);
  let bytes = 0;
  const { archiveBytes } = validationProfile();
  const hash = createHash('sha256');
  const archive = pipeline(
    child.stdout,
    async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > archiveBytes)
          throw new DependencyPreparationError(
            `Dependency archive exceeds ${archiveBytes / 1024 / 1024} MiB. ${archiveBytes < MAX_VALIDATION_ARCHIVE_BYTES ? 'An operator can set REFIT_VALIDATION_WORKSPACE=4g (up to a 2 GiB archive and 5 GiB container memory) for a larger tree.' : 'This exceeds the largest validation profile; use a custom validation image.'}`,
          );
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(output, { flags: 'wx', mode: 0o644 }),
    { signal },
  );
  const logs = (async () => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of child.stderr) {
      size += chunk.length;
      if (size > MAX_LOG_BYTES)
        throw new DependencyPreparationError('Dependency preparation output exceeds 1 MiB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  })();
  const tasks = [archive, logs, exited] as const;
  try {
    const [, stderr, result] = await Promise.all(tasks);
    if (timedOut)
      throw new DependencyPreparationError(
        `Dependency preparation exceeded ${timeoutSeconds} seconds. Set REFIT_DEPENDENCY_TIMEOUT_SECONDS (up to ${MAX_INSTALL_TIMEOUT_SECONDS}) for a larger dependency tree.`,
      );
    const host = result.code !== 0 ? hostInstallFailure(inputs.manager, result, stderr) : undefined;
    if (host) throw host;
    const { workspace } = preparationProfile();
    if (result.code !== 0 && /\bENOSPC\b/.test(stderr))
      throw new DependencyPreparationError(
        `${inputs.manager} dependency preparation ran out of space in its ${workspace} workspace (ENOSPC).${
          inputs.manager !== 'yarn'
            ? ''
            : inputs.managerVersion?.startsWith('1.')
              ? " Yarn 1 also downloads other platforms' optional binaries."
              : ' Yarn 2+ keeps a zip of every package in its cache beside the unpacked tree.'
        }${
          workspace === '4g'
            ? ''
            : ' An operator can set REFIT_VALIDATION_WORKSPACE=4g (4 GiB workspace, 5 GiB container memory) on a host with memory to spare.'
        }`,
      );
    if (result.code !== 0)
      throw new DependencyPreparationError(
        // Refit's own version markers are left out so the installer's error leads the message.
        `${inputs.manager} dependency preparation failed (${result.code ?? result.signal}). ${stderr
          .replace(/^REFIT_[A-Z_]+=.*\n?/gm, '')
          .slice(-MAX_ERROR_CHARACTERS)}`,
      );
    const nodeVersion = /^REFIT_NODE_VERSION=(v\d+\.\d+\.\d+)$/m.exec(stderr)?.[1];
    const npmVersion = /^REFIT_NPM_VERSION=(\d+\.\d+\.\d+)$/m.exec(stderr)?.[1];
    const tool = inputs.manager === 'npm' && !inputs.managerVersion ? undefined : inputs.manager;
    // The image's npm already reports REFIT_NPM_VERSION, so a pinned npm reports as NPM_TOOL.
    const marker = tool === 'npm' ? 'NPM_TOOL' : tool?.toUpperCase();
    const toolVersion = new RegExp(`^REFIT_${marker}_VERSION=(\\d+\\.\\d+\\.\\d+)$`, 'm').exec(
      stderr,
    )?.[1];
    const toolIntegrity = new RegExp(`^REFIT_${marker}_INTEGRITY=(\\S+)$`, 'm').exec(stderr)?.[1];
    if (!nodeVersion || !npmVersion || !bytes)
      throw new DependencyPreparationError(
        'Dependency preparation did not produce an archive and runtime version evidence.',
      );
    if (tool && !matchesManager(inputs, toolVersion, toolIntegrity))
      throw new DependencyPreparationError(
        `${tool} did not provide the expected pinned manager version and integrity evidence.`,
      );
    return {
      bytes,
      sha256: hash.digest('hex'),
      legacyPeerDeps: stderr.split('\n').includes(LEGACY_PEER_DEPS_MARKER),
      stderr,
      nodeVersion,
      npmVersion,
      toolVersion,
      toolIntegrity,
    };
  } catch (error) {
    child.kill('SIGKILL');
    await Promise.allSettled(tasks);
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function prepareDependencies(options: {
  repository: string;
  image: string;
  // Prepare the committed root without its submodules, as validation checks it (owner decision 1).
  submodules?: boolean;
  cacheDirectory?: string;
  // A nested package (preparation-packages.ts) installs from its own manifest and lockfile.
  packageDirectory?: string;
  // Copied under the cache lock, so eviction cannot remove the bundle mid-copy.
  copyArchiveTo?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  try {
    return await prepare(options);
  } catch (error) {
    throw withPreparationStop(error);
  }
}

async function prepare(options: Parameters<typeof prepareDependencies>[0]) {
  options.signal?.throwIfAborted();
  const timeoutSeconds = installTimeoutSeconds();
  const cacheLimit = cacheLimitBytes();
  const { files, workspaceContents, inputs } = await readCommittedRepository(options.repository, {
    submodules: options.submodules,
  })
    .then(async (snapshot) =>
      readPreparationInputs(
        options.packageDirectory
          ? await packageSnapshot(snapshot, options.packageDirectory)
          : snapshot,
        snapshot.entries,
      ),
    )
    .catch(repositoryRefusal);
  const kind = `refit-${inputs.manager}-environment`;
  const image = DOCKER_IMAGE_ID.test(options.image)
    ? options.image
    : await resolveDockerImage(options.image);
  const platformPackageMode = inputs.platformPackages ? yarnPlatformPackageMode() : undefined;
  const signature = digest(
    JSON.stringify({
      recipeVersion: RECIPE_VERSION,
      image,
      ...inputs,
      ...(platformPackageMode ? { platformPackageMode } : {}),
    }),
  );
  const cacheDirectory = resolve(
    options.cacheDirectory ??
      (process.env.REFIT_DEPENDENCY_CACHE_DIRECTORY?.trim() || undefined) ??
      join(homedir(), '.refit', 'dependencies'),
  );
  await standaloneStateDirectory(cacheDirectory);
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const physicalCache = await realpath(cacheDirectory);
  await standaloneStateDirectory(physicalCache);
  const root = join(physicalCache, signature);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  const physicalRoot = await realpath(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || physicalRoot !== root)
    throw new PipelineInputError('Dependency cache entries must be private physical directories.');
  await chmod(root, 0o700);
  await standaloneStateDirectory(root);
  const bundle = join(root, BUNDLE);
  return withStateLock(root, PREPARE_LOCK, async () => {
    let exists = false;
    try {
      const metadata = await lstat(bundle);
      exists = true;
      if (!metadata.isDirectory())
        throw new PipelineInputError('Dependency cache bundle must be a regular directory.');
      const verification = await verifyArtifacts(bundle);
      const environment = parseObject(
        await readFile(join(bundle, ENVIRONMENT), 'utf8'),
        ENVIRONMENT,
      );
      const manifest = parseObject(
        await readFile(join(bundle, 'manifest.json'), 'utf8'),
        'Dependency manifest',
      );
      const archiveEntry = Array.isArray(manifest.files)
        ? manifest.files.find((entry) => entry.path === ARCHIVE)
        : undefined;
      if (
        verification.kind !== kind ||
        environment.formatVersion !== 1 ||
        environment.kind !== kind ||
        environment.signature !== signature ||
        environment.image !== image ||
        environment.recipeVersion !== RECIPE_VERSION ||
        Object.entries(inputs).some(
          ([key, value]) => JSON.stringify(environment[key]) !== JSON.stringify(value),
        ) ||
        (inputs.managerVersion !== undefined &&
          !matchesManager(
            inputs,
            environment[`${managerKey(inputs)}Version`],
            environment[`${managerKey(inputs)}Integrity`],
          )) ||
        !archiveEntry ||
        environment.archiveHash !== archiveEntry.sha256 ||
        environment.archiveBytes !== archiveEntry.bytes ||
        typeof environment.nodeVersion !== 'string' ||
        typeof environment.npmVersion !== 'string'
      )
        throw new PipelineInputError(
          'Prepared dependency cache does not match its committed inputs.',
        );
      options.signal?.throwIfAborted();
      const now = new Date();
      await utimes(bundle, now, now);
      if (options.copyArchiveTo) await copyFile(join(bundle, ARCHIVE), options.copyArchiveTo);
      options.onProgress?.(
        `Reusing verified ${inputs.manager} dependencies; installation was not rerun.`,
      );
      return { directory: bundle, archive: join(bundle, ARCHIVE), environment, reused: true };
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
      if (exists)
        throw new PipelineInputError(
          'Prepared dependency cache is incomplete. Inspect it before rebuilding.',
        );
    }
    const staging = join(root, `staging-${randomUUID()}`);
    const input = await mkdtemp(join(tmpdir(), 'refit-npm-input-'));
    const name = `refit-dependencies-${randomUUID()}`;
    const preparation = preparationProfile();
    try {
      await mkdir(staging, { mode: 0o700 });
      await chmod(input, 0o755);
      for (const [file, content] of files) {
        await mkdir(resolve(input, file, '..'), { recursive: true, mode: 0o755 });
        await writeFile(join(input, file), content, { mode: 0o444 });
      }
      options.onProgress?.(
        `Installing locked public ${inputs.manager} dependencies in restricted Docker; lifecycle scripts are disabled...`,
      );
      await removeExpiredSandboxContainers();
      const result = await installDependencies(
        dockerSandboxArguments({
          name,
          directory: input,
          image,
          command: [
            ...installCommand(inputs, platformPackageMode),
            'refit-npm-install',
            JSON.stringify({
              links: inputs.workspaceLinks ?? {},
              optionalLinks: inputs.workspaceOptionalLinks ?? {},
              directories: [...workspaceContents.keys()],
              hashes: Object.fromEntries(
                [...files].map(([file, content]) => [file, digest(content)]),
              ),
              managerVersion: inputs.managerVersion,
              managerIntegrity: inputs.managerIntegrity,
              managerBundleSha512: inputs.managerBundleSha512,
            }),
            ...workspaceContents.keys(),
          ],
          network: 'bridge',
          timeoutMs: timeoutSeconds * 1000,
          preparation,
        }),
        join(staging, ARCHIVE),
        inputs,
        timeoutSeconds,
        options.signal,
      );
      options.signal?.throwIfAborted();
      const environment = {
        formatVersion: 1,
        kind,
        signature,
        recipeVersion: RECIPE_VERSION,
        image,
        ...inputs,
        nodeVersion: result.nodeVersion,
        npmVersion: result.npmVersion,
        ...(inputs.manager === 'pnpm'
          ? { pnpmVersion: result.toolVersion, pnpmIntegrity: result.toolIntegrity }
          : {}),
        ...(inputs.manager === 'yarn'
          ? { yarnVersion: result.toolVersion, yarnIntegrity: result.toolIntegrity }
          : {}),
        ...(platformPackageMode ? { platformPackageMode } : {}),
        ...(inputs.manager === 'npm' && inputs.managerVersion
          ? { npmToolVersion: result.toolVersion, npmToolIntegrity: result.toolIntegrity }
          : {}),
        archiveHash: result.sha256,
        archiveBytes: result.bytes,
        installation: {
          network: 'bridge',
          lifecycleScripts: false,
          ...(result.legacyPeerDeps ? { legacyPeerDeps: true } : {}),
          registry: 'https://registry.npmjs.org',
          timeoutMs: timeoutSeconds * 1000,
          ...preparation,
        },
        validation: { network: 'none' },
      };
      await writeState(join(staging, ENVIRONMENT), environment);
      await writeFile(join(staging, 'install.log'), result.stderr, { mode: 0o600 });
      const environmentContent = await readFile(join(staging, ENVIRONMENT));
      await writeState(join(staging, 'manifest.json'), {
        formatVersion: 1,
        kind,
        status: 'prepared',
        files: [
          { path: ARCHIVE, sha256: result.sha256, bytes: result.bytes },
          {
            path: ENVIRONMENT,
            sha256: digest(environmentContent),
            bytes: environmentContent.length,
          },
          {
            path: 'install.log',
            sha256: digest(result.stderr),
            bytes: Buffer.byteLength(result.stderr),
          },
        ],
      });
      await verifyArtifacts(staging);
      await rename(staging, bundle);
      if (options.copyArchiveTo) await copyFile(join(bundle, ARCHIVE), options.copyArchiveTo);
      const { evicted, bytes } = await evictDependencies(physicalCache, root, cacheLimit);
      if (evicted.length)
        options.onProgress?.(
          `Evicted ${evicted.length} least recently used dependency bundles; the cache holds ${(bytes / GIB).toFixed(1)} GiB.`,
        );
      return { directory: bundle, archive: join(bundle, ARCHIVE), environment, reused: false };
    } finally {
      const cleanup = await Promise.allSettled([
        removeDockerContainer(name),
        rm(input, { recursive: true, force: true }),
        rm(staging, { recursive: true, force: true }),
      ]);
      for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
    }
  });
}
