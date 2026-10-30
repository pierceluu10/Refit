import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
export const DOCKER_IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_USER = '65534:65534';
// Dependency installers hold the package cache and the unpacked tree at once. tmpfs pages count
// against the memory limit, so preparation memory covers the workspace plus the installer.
export const PREPARATION_WORKSPACE_SIZE = '2g';
export const PREPARATION_MEMORY = '3g';
const MIB = 1024 * 1024;
// Each profile keeps memory above the workspace and the dependency archive at half of it, so the
// unpacked tree still fits. Operators on a smaller Docker host select a smaller profile.
const VALIDATION_PROFILES = {
  '512m': { workspace: '512m', memory: '1g', archiveBytes: 256 * MIB },
  '1g': { workspace: '1g', memory: '2g', archiveBytes: 512 * MIB },
  '2g': { workspace: '2g', memory: '3g', archiveBytes: 1024 * MIB },
  '4g': { workspace: '4g', memory: '5g', archiveBytes: 2048 * MIB },
} as const;

// Owner decision (2026-10-24, Push 279): the 4 GiB profile is the default for preparation and
// validation, so a container may claim 5 GiB of the Docker host's memory.
const DEFAULT_VALIDATION_PROFILE = '4g';

export const MAX_VALIDATION_ARCHIVE_BYTES = Math.max(
  ...Object.values(VALIDATION_PROFILES).map((profile) => profile.archiveBytes),
);

export function validationProfile(value = process.env.REFIT_VALIDATION_WORKSPACE) {
  const name = value?.trim() || DEFAULT_VALIDATION_PROFILE;
  if (!Object.hasOwn(VALIDATION_PROFILES, name))
    throw new PipelineInputError(
      `REFIT_VALIDATION_WORKSPACE must be one of ${Object.keys(VALIDATION_PROFILES).join(', ')}.`,
    );
  return VALIDATION_PROFILES[name as keyof typeof VALIDATION_PROFILES];
}

// The installer holds the package cache and the unpacked tree, so a profile whose archive outgrows
// the default installer workspace enlarges preparation to match.
export function preparationProfile() {
  const profile = validationProfile();
  return profile.archiveBytes > 1024 * MIB
    ? { workspace: profile.workspace, memory: profile.memory }
    : { workspace: PREPARATION_WORKSPACE_SIZE, memory: PREPARATION_MEMORY };
}

export async function resolveDockerImage(image: string) {
  if (!image || image.startsWith('-') || image.includes('\0'))
    throw new PipelineInputError('An existing local Docker image is required.');
  const result = await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const id = result.stdout.trim();
  if (!DOCKER_IMAGE_ID.test(id))
    throw new PipelineInputError('Docker did not resolve a unique immutable image ID.');
  return id;
}

// Every sandbox container carries the time after which no Refit process still waits on it. A Refit
// process that is killed cannot remove its container, so the next sandbox start removes it.
export const SANDBOX_EXPIRY_LABEL = 'dev.refit.sandbox.expires';
const EXPIRY_GRACE_MS = 60_000;

export async function removeExpiredSandboxContainers(now = Date.now()) {
  const result = await execute(
    'docker',
    [
      'ps',
      '--all',
      '--no-trunc',
      '--filter',
      `label=${SANDBOX_EXPIRY_LABEL}`,
      '--format',
      `{{.ID}} {{.Label "${SANDBOX_EXPIRY_LABEL}"}}`,
    ],
    { timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
  );
  const expired = result.stdout
    .split('\n')
    .map((line) => /^([a-f0-9]{64}) (\d+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && Number(match[2]) < now)
    .map((match) => match[1]);
  for (const id of expired) await removeDockerContainer(id);
  return expired;
}

export async function removeDockerContainer(name: string) {
  try {
    await execute('docker', ['rm', '--force', name], {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('stderr' in error) ||
      typeof error.stderr !== 'string' ||
      // Another Refit process may be removing the same expired container.
      !/No such container|removal of container \S+ is already in progress/.test(error.stderr)
    )
      throw error;
  }
}

// Package managers that keep a cache beside the unpacked tree (Yarn) write it here instead of the
// tmpfs workspace: a host directory on the disk that holds Refit's temporary files (the Fly volume
// in production, through TMPDIR), so the cache counts against neither the workspace nor memory.
export const INSTALLER_CACHE = '/installer-cache';

// The installer writes its cache as the sandbox user, so the host may not be able to remove what it
// left; the same user empties it, offline, before the host removes the directory.
export async function emptyInstallerCache(image: string, directory: string) {
  if (directory.includes(','))
    throw new PipelineInputError('Docker bind-mount paths must not contain commas.');
  await execute(
    'docker',
    [
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--log-driver',
      'none',
      '--read-only',
      '--user',
      CONTAINER_USER,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--mount',
      `type=bind,src=${directory},dst=${INSTALLER_CACHE}`,
      '--entrypoint',
      '/bin/sh',
      image,
      '-c',
      `chmod -R u+w ${INSTALLER_CACHE} 2>/dev/null; find ${INSTALLER_CACHE} -mindepth 1 -delete`,
    ],
    { timeout: 10 * PROCESS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
  );
}

export function dockerSandboxArguments(options: {
  name: string;
  directory: string;
  image: string;
  command: string[];
  network: 'none' | 'bridge';
  // How long the caller waits before it kills the Docker client and removes the container.
  timeoutMs: number;
  dependencies?: string;
  preparation?: ReturnType<typeof preparationProfile>;
  readOnlyMounts?: { source: string; target: string }[];
  // A nested package's checks run in its directory, where its own dependencies unpack.
  packageDirectory?: string;
  // A host directory mounted writable at INSTALLER_CACHE (dependency preparation only).
  installerCache?: string;
}) {
  const mounts = options.readOnlyMounts ?? [];
  const { memory, workspace } = options.preparation ?? validationProfile();
  if (
    [
      options.directory,
      options.dependencies,
      options.installerCache,
      ...mounts.flatMap((mount) => [mount.source, mount.target]),
    ].some((path) => path?.includes(','))
  )
    throw new PipelineInputError('Docker bind-mount paths must not contain commas.');
  if (
    options.packageDirectory !== undefined &&
    !options.packageDirectory
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && !part.includes('\0'))
  )
    throw new PipelineInputError(
      'A package directory must be a relative path inside the repository.',
    );
  const unpack = options.packageDirectory
    ? `cd "./$1" && shift && ${options.dependencies ? 'tar -xf /dependencies.tar && export PATH="$PWD/node_modules/.refit-tools/node_modules/.bin:$PWD/node_modules/.bin:$PATH" && ' : ''}`
    : options.dependencies
      ? 'tar -xf /dependencies.tar -C /workspace/ && export PATH="/workspace/node_modules/.refit-tools/node_modules/.bin:/workspace/node_modules/.bin:$PATH" && '
      : '';
  return [
    'run',
    '--name',
    options.name,
    '--label',
    `${SANDBOX_EXPIRY_LABEL}=${Date.now() + options.timeoutMs + EXPIRY_GRACE_MS}`,
    '--pull',
    'never',
    '--network',
    options.network,
    // Output reaches Refit through the attached client only; the daemon keeps no copy on disk.
    '--log-driver',
    'none',
    '--read-only',
    '--user',
    CONTAINER_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    memory,
    '--cpus',
    '1',
    // A host whose core pattern pipes to a crash handler would otherwise process the dump outside
    // the container's limits.
    '--ulimit',
    'core=0',
    '--tmpfs',
    `/workspace:rw,exec,size=${workspace},uid=65534,gid=65534,mode=0700`,
    '--tmpfs',
    '/tmp:rw,noexec,size=64m,mode=1777',
    '--mount',
    `type=bind,src=${options.directory},dst=/input,readonly`,
    ...(options.dependencies
      ? ['--mount', `type=bind,src=${options.dependencies},dst=/dependencies.tar,readonly`]
      : []),
    ...mounts.flatMap((mount) => [
      '--mount',
      `type=bind,src=${mount.source},dst=${mount.target},readonly`,
    ]),
    ...(options.installerCache
      ? ['--mount', `type=bind,src=${options.installerCache},dst=${INSTALLER_CACHE}`]
      : []),
    '--workdir',
    '/workspace',
    // Test runners such as vitest and jest default to watch mode without CI and never exit.
    '--env',
    'CI=true',
    '--entrypoint',
    '/bin/sh',
    options.image,
    '-c',
    `cp -R /input/. /workspace/ && ${unpack}exec "$@"`,
    'refit-check',
    ...(options.packageDirectory ? [options.packageDirectory] : []),
    ...options.command,
  ];
}
