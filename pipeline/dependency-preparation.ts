import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
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

export function repositoryDependencyFailure(error: unknown) {
  if (!(error instanceof PipelineInputError)) return undefined;
  const failure = REPOSITORY_DEPENDENCY_FAILURES.find((entry) => entry.pattern.test(error.message));
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
    message: error.message,
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
  cacheDirectory?: string;
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
  const snapshot = await readCommittedRepository(options.repository);
  const { files, workspaceContents, inputs } = await readPreparationInputs(snapshot);
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
  const bundle = join(root, 'bundle');
  return withStateLock(root, 'prepare', async () => {
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
