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
// Operators can enlarge offline validation for large dependency trees. Each profile keeps memory
// above the workspace and the dependency archive at half of it, so the unpacked tree still fits.
// The committed source shares the workspace; from 2g it may take a sixteenth of it.
const VALIDATION_PROFILES = {
  '512m': { workspace: '512m', memory: '1g', archiveBytes: 256 * MIB, sourceBytes: 50 * MIB },
  '1g': { workspace: '1g', memory: '2g', archiveBytes: 512 * MIB, sourceBytes: 50 * MIB },
  '2g': { workspace: '2g', memory: '3g', archiveBytes: 1024 * MIB, sourceBytes: 128 * MIB },
  // Opt-in only: it raises the memory a container may claim on the Docker host.
  '4g': { workspace: '4g', memory: '5g', archiveBytes: 2048 * MIB, sourceBytes: 256 * MIB },
} as const;

export const MAX_VALIDATION_ARCHIVE_BYTES = Math.max(
  ...Object.values(VALIDATION_PROFILES).map((profile) => profile.archiveBytes),
);

export function validationProfile(value = process.env.REFIT_VALIDATION_WORKSPACE) {
  const name = value?.trim() || '2g';
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
}) {
  const mounts = options.readOnlyMounts ?? [];
  const { memory, workspace } = options.preparation ?? validationProfile();
  if (
    [
      options.directory,
      options.dependencies,
      ...mounts.flatMap((mount) => [mount.source, mount.target]),
    ].some((path) => path?.includes(','))
  )
    throw new PipelineInputError('Docker bind-mount paths must not contain commas.');
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
    '--workdir',
    '/workspace',
    // Test runners such as vitest and jest default to watch mode without CI and never exit.
    '--env',
    'CI=true',
    '--entrypoint',
    '/bin/sh',
    options.image,
    '-c',
    `cp -R /input/. /workspace/ && ${options.dependencies ? 'tar -xf /dependencies.tar -C /workspace/ && export PATH="/workspace/node_modules/.refit-tools/node_modules/.bin:/workspace/node_modules/.bin:$PATH" && ' : ''}exec "$@"`,
    'refit-check',
    ...options.command,
  ];
}
