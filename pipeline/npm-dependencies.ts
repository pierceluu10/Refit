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
  removeDockerContainer,
  resolveDockerImage,
} from './docker-sandbox.ts';
import { standaloneStateDirectory } from './github-checkout.ts';
import { validateNpmLock } from './npm-lock.ts';
import { digest, parseObject } from './specifications.ts';
import { hasErrorCode, withStateLock, writeState } from './state-files.ts';
import { PipelineInputError } from './types.ts';
import { verifyArtifacts } from './verification.ts';

const RECIPE_VERSION = 1;
const INSTALL_TIMEOUT_MS = 300_000;
export const MAX_DEPENDENCY_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_ERROR_CHARACTERS = 4096;
const ARCHIVE = 'dependencies.tar';
const ENVIRONMENT = 'environment.json';
const INSTALL_COMMAND = [
  'sh',
  '-c',
  'set -eu; : > /tmp/refit-user.npmrc; : > /tmp/refit-global.npmrc; ' +
    'export NPM_CONFIG_USERCONFIG=/tmp/refit-user.npmrc NPM_CONFIG_GLOBALCONFIG=/tmp/refit-global.npmrc; ' +
    'node -p \'"REFIT_NODE_VERSION=" + process.version\' >&2; ' +
    'printf "REFIT_NPM_VERSION=" >&2; npm --version >&2; ' +
    'npm ci --ignore-scripts --include=dev --engine-strict --no-audit --no-fund ' +
    '--registry=https://registry.npmjs.org --cache=/workspace/.npm-cache >&2; ' +
    'mkdir -p node_modules; tar -cf - node_modules',
];

export class DependencyPreparationError extends PipelineInputError {
  override name = 'DependencyPreparationError';
}

async function installDependencies(argumentsList: string[], output: string, signal?: AbortSignal) {
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
  }, INSTALL_TIMEOUT_MS);
  let bytes = 0;
  const hash = createHash('sha256');
  const archive = pipeline(
    child.stdout,
    async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > MAX_DEPENDENCY_ARCHIVE_BYTES)
          throw new DependencyPreparationError('Dependency archive exceeds 256 MiB.');
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
      throw new DependencyPreparationError('Dependency preparation exceeded 300 seconds.');
    if (result.code !== 0)
      throw new DependencyPreparationError(
        `npm dependency preparation failed (${result.code ?? result.signal}). ${stderr.slice(-MAX_ERROR_CHARACTERS)}`,
      );
    const nodeVersion = /^REFIT_NODE_VERSION=(v\d+\.\d+\.\d+)$/m.exec(stderr)?.[1];
    const npmVersion = /^REFIT_NPM_VERSION=(\d+\.\d+\.\d+)$/m.exec(stderr)?.[1];
    if (!nodeVersion || !npmVersion || !bytes)
      throw new DependencyPreparationError(
        'Dependency preparation did not produce an archive and runtime version evidence.',
      );
    return { bytes, sha256: hash.digest('hex'), stderr, nodeVersion, npmVersion };
  } catch (error) {
    child.kill('SIGKILL');
    await Promise.allSettled(tasks);
    if (signal?.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function prepareNpmDependencies(options: {
  repository: string;
  image: string;
  cacheDirectory?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  options.signal?.throwIfAborted();
  const snapshot = await readCommittedRepository(options.repository);
  const paths = snapshot.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  if (!paths.includes('package.json') || !paths.includes('package-lock.json'))
    throw new PipelineInputError(
      'Automatic preparation requires committed root package.json and package-lock.json.',
    );
  if (
    paths.includes('npm-shrinkwrap.json') ||
    paths.some((path) => path.startsWith('node_modules/'))
  )
    throw new PipelineInputError(
      'Tracked node_modules or npm-shrinkwrap.json require a custom validation image.',
    );
  const packageContent = (await snapshot.git(['show', `${snapshot.revision}:package.json`])).stdout;
  const lockContent = (await snapshot.git(['show', `${snapshot.revision}:package-lock.json`]))
    .stdout;
  const inputs = validateNpmLock(packageContent, lockContent);
  const image = DOCKER_IMAGE_ID.test(options.image)
    ? options.image
    : await resolveDockerImage(options.image);
  const signature = digest(JSON.stringify({ recipeVersion: RECIPE_VERSION, image, ...inputs }));
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
        verification.kind !== 'refit-npm-environment' ||
        environment.formatVersion !== 1 ||
        environment.kind !== 'refit-npm-environment' ||
        environment.signature !== signature ||
        environment.image !== image ||
        environment.recipeVersion !== RECIPE_VERSION ||
        environment.packageHash !== inputs.packageHash ||
        environment.lockHash !== inputs.lockHash ||
        environment.packages !== inputs.packages ||
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
      options.onProgress?.('Reusing verified npm dependencies; installation was not rerun.');
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
    try {
      await mkdir(staging, { mode: 0o700 });
      await chmod(input, 0o755);
      await writeFile(join(input, 'package.json'), packageContent, { mode: 0o444 });
      await writeFile(join(input, 'package-lock.json'), lockContent, { mode: 0o444 });
      options.onProgress?.(
        'Installing locked public npm dependencies in restricted Docker; lifecycle scripts are disabled...',
      );
      const result = await installDependencies(
        dockerSandboxArguments({
          name,
          directory: input,
          image,
          command: INSTALL_COMMAND,
          network: 'bridge',
        }),
        join(staging, ARCHIVE),
        options.signal,
      );
      options.signal?.throwIfAborted();
      const environment = {
        formatVersion: 1,
        kind: 'refit-npm-environment',
        signature,
        recipeVersion: RECIPE_VERSION,
        image,
        ...inputs,
        nodeVersion: result.nodeVersion,
        npmVersion: result.npmVersion,
        archiveHash: result.sha256,
        archiveBytes: result.bytes,
        installation: {
          network: 'bridge',
          lifecycleScripts: false,
          registry: 'https://registry.npmjs.org',
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
        validation: { network: 'none' },
      };
      await writeState(join(staging, ENVIRONMENT), environment);
      await writeFile(join(staging, 'install.log'), result.stderr, { mode: 0o600 });
      const environmentContent = await readFile(join(staging, ENVIRONMENT));
      await writeState(join(staging, 'manifest.json'), {
        formatVersion: 1,
        kind: 'refit-npm-environment',
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
