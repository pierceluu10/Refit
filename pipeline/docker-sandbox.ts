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
const VALIDATION_PROFILES = {
  '512m': { workspace: '512m', memory: '1g', archiveBytes: 256 * MIB },
  '1g': { workspace: '1g', memory: '2g', archiveBytes: 512 * MIB },
  '2g': { workspace: '2g', memory: '3g', archiveBytes: 1024 * MIB },
} as const;

export const MAX_VALIDATION_ARCHIVE_BYTES = Math.max(
  ...Object.values(VALIDATION_PROFILES).map((profile) => profile.archiveBytes),
);

export function validationProfile(value = process.env.REFIT_VALIDATION_WORKSPACE) {
  const name = value?.trim() || '512m';
  if (!Object.hasOwn(VALIDATION_PROFILES, name))
    throw new PipelineInputError(
      `REFIT_VALIDATION_WORKSPACE must be one of ${Object.keys(VALIDATION_PROFILES).join(', ')}.`,
    );
  return VALIDATION_PROFILES[name as keyof typeof VALIDATION_PROFILES];
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
      !error.stderr.includes('No such container')
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
  dependencies?: string;
  workspaceSize?: typeof PREPARATION_WORKSPACE_SIZE;
  readOnlyMounts?: { source: string; target: string }[];
}) {
  const mounts = options.readOnlyMounts ?? [];
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
    '--pull',
    'never',
    '--network',
    options.network,
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
    options.workspaceSize ? PREPARATION_MEMORY : validationProfile().memory,
    '--cpus',
    '1',
    '--tmpfs',
    `/workspace:rw,exec,size=${options.workspaceSize ?? validationProfile().workspace},uid=65534,gid=65534,mode=0700`,
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
    '--entrypoint',
    '/bin/sh',
    options.image,
    '-c',
    `cp -R /input/. /workspace/ && ${options.dependencies ? 'tar -xf /dependencies.tar -C /workspace/ && export PATH="/workspace/node_modules/.refit-tools/node_modules/.bin:/workspace/node_modules/.bin:$PATH" && ' : ''}exec "$@"`,
    'refit-check',
    ...options.command,
  ];
}
