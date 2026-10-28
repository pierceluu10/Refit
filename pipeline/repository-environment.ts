// Refit builds the validation environment itself (founder decision, 2026-10-28; see
// docs/CUSTOMER-ENVIRONMENT.md). When its own preparation refuses for a repository-side reason,
// the repository's own install (repository-install.ts) runs in a build sandbox: no secrets,
// lifecycle scripts as that install runs them, and egress only through an allowlisting proxy to
// public registries and the hosts the repository's files name. Every node_modules it leaves is
// archived in the prepared-archive format, so validation runs offline on it exactly as before.

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import {
  DependencyPreparationError,
  installTimeoutSeconds,
  prepareDependencies,
  preparationFailure,
} from './dependency-preparation.ts';
import {
  DOCKER_IMAGE_ID,
  dockerSandboxArguments,
  preparationProfile,
  removeDockerContainer,
  resolveDockerImage,
  validationProfile,
} from './docker-sandbox.ts';
import {
  INSTALL_FILES,
  installPlan,
  namedHosts,
  needsCustomerEnvironment,
  type InstallPlan,
} from './repository-install.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROXY_PORT = 3128;
const MAX_LOG_CHARACTERS = 4000;

// REFIT_REPOSITORY_INSTALL=0 keeps Refit to its own preparation; on by default.
export function repositoryInstallEnabled(value = process.env.REFIT_REPOSITORY_INSTALL) {
  return value?.trim() !== '0';
}

// An HTTP proxy that tunnels CONNECT (and forwards plain HTTP) only to allowlisted hosts on 80
// and 443, and prints each refused host as REFIT_DENIED=<host>.
export const PROXY_SCRIPT = `
const http = require("node:http"), net = require("node:net");
const allowed = new Set(JSON.parse(process.argv[1]));
const ok = (host, port) => allowed.has(String(host).toLowerCase()) && (port === 443 || port === 80);
const deny = (host) => console.error("REFIT_DENIED=" + host);
const server = http.createServer((request, response) => {
  let url; try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
  const port = Number(url.port || 80);
  if (url.protocol !== "http:" || !ok(url.hostname, port)) { deny(url.hostname); response.writeHead(403).end(); return; }
  const upstream = http.request({ host: url.hostname, port, path: url.pathname + url.search, method: request.method, headers: request.headers },
    (reply) => { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response); });
  upstream.on("error", () => response.destroy());
  request.pipe(upstream);
});
server.on("connect", (request, socket, head) => {
  const [host, portText] = String(request.url).split(":");
  const port = Number(portText);
  if (!ok(host, port)) { deny(host); socket.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); return; }
  const upstream = net.connect(port, host, () => { socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n"); upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
  upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
});
server.listen(${PROXY_PORT}, "0.0.0.0", () => console.error("REFIT_PROXY_READY"));
`;

// Runs in the install container after the committed tree is copied to /workspace: installs the
// manager tool (scripts off, like Refit's own preparation), runs the repository's install as it
// is written, and writes every node_modules as a tar to stdout.
export const INSTALL_SCRIPT = [
  'set -e',
  'export HOME=/workspace/.home npm_config_cache=/workspace/.npm-cache YARN_CACHE_FOLDER=/workspace/.yarn-cache YARN_NODE_LINKER=node-modules COREPACK_ENABLE_NETWORK=0 TMPDIR=/workspace/.tmp',
  'mkdir -p "$HOME" "$TMPDIR"',
  'tool="$1"; shift',
  'if [ -n "$tool" ]; then npm install --prefix /workspace/.refit-tools --ignore-scripts --no-audit --no-fund "$tool" >&2; export PATH="/workspace/.refit-tools/node_modules/.bin:$PATH"; fi',
  'printf "REFIT_NODE_VERSION=%s\\n" "$(node --version)" >&2',
  '"$@" >&2',
  'if [ -n "$tool" ]; then mkdir -p node_modules && mv /workspace/.refit-tools node_modules/.refit-tools; fi',
  'find . -path ./.home -prune -o -path ./.tmp -prune -o -path ./.npm-cache -prune -o -path ./.yarn-cache -prune -o -type d -name node_modules -prune -print | tar -cf - -T -',
].join('\n');

export async function repositoryInstallFiles(repository: string) {
  const { stdout } = await execute('git', ['-C', repository, 'ls-files', '-z'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Map<string, string>();
  for (const file of stdout.split('\0').filter((path) => INSTALL_FILES.test(path)))
    files.set(
      file,
      (
        await execute('git', ['-C', repository, 'show', `HEAD:${file}`], {
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout,
    );
  return files;
}

// The committed tree, as git archive writes it (submodules and untracked files left out).
async function committedTree(repository: string, directory: string) {
  const archive = join(directory, '..', `${randomUUID()}.tar`);
  await execute('git', ['-C', repository, 'archive', '--format=tar', '-o', archive, 'HEAD']);
  await execute('tar', ['-xf', archive, '-C', directory]);
  await rm(archive, { force: true });
}

// The install container joins only an internal network, so the proxy is its only way out.
function installArguments(options: {
  name: string;
  directory: string;
  image: string;
  network: string;
  proxy: string;
  plan: InstallPlan;
  timeoutMs: number;
}) {
  const argumentsList = dockerSandboxArguments({
    name: options.name,
    directory: options.directory,
    image: options.image,
    command: [
      '/bin/sh',
      '-c',
      INSTALL_SCRIPT,
      'refit-repository-install',
      options.plan.tool ?? '',
      ...options.plan.command,
    ],
    network: 'bridge',
    timeoutMs: options.timeoutMs,
    preparation: preparationProfile(),
  });
  argumentsList[argumentsList.indexOf('--network') + 1] = options.network;
  const proxy = `http://${options.proxy}:${PROXY_PORT}`;
  const environment = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'npm_config_proxy',
    'npm_config_https_proxy',
  ]
    .flatMap((name) => ['--env', `${name}=${proxy}`])
    // Node's own fetch in an install script honours the proxy variables only with this set.
    .concat(['--env', 'NODE_USE_ENV_PROXY=1']);
  argumentsList.splice(argumentsList.indexOf('--entrypoint'), 0, ...environment);
  return argumentsList;
}

async function runInstall(
  argumentsList: string[],
  output: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
) {
  const child = spawn('docker', argumentsList, { stdio: ['ignore', 'pipe', 'pipe'], signal });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutSeconds * 1000);
  const { archiveBytes } = validationProfile();
  const hash = createHash('sha256');
  let bytes = 0;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024);
  });
  try {
    await pipeline(
      child.stdout,
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > archiveBytes)
            throw new DependencyPreparationError(
              `Dependency archive exceeds ${archiveBytes / 1024 / 1024} MiB.`,
            );
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(output, { flags: 'wx', mode: 0o644 }),
    );
    const code = await exited;
    return { code, bytes, sha256: hash.digest('hex'), stderr };
  } catch (error) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyReady(proxy: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { stderr } = await execute('docker', ['logs', proxy]);
    if (stderr.includes('REFIT_PROXY_READY')) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The build sandbox proxy did not start.');
}

export class RepositoryInstallError extends DependencyPreparationError {
  override name = 'RepositoryInstallError';
  // True when the install needs something only the customer has (a token, a blocked host).
  readonly customerOnly: boolean;
  constructor(message: string, customerOnly: boolean) {
    super(message);
    this.customerOnly = customerOnly;
  }
}

// Builds the environment from the repository's own install. Returns the shape prepareDependencies
// returns, so validation consumes it unchanged.
export async function buildRepositoryEnvironment(options: {
  repository: string;
  image: string;
  copyArchiveTo?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const files = await repositoryInstallFiles(options.repository);
  const plan = installPlan(files);
  if (!plan)
    throw new RepositoryInstallError(
      'The repository commits no install Refit recognises (a Dockerfile, devcontainer or CI install step, or a lockfile).',
      false,
    );
  const hosts = namedHosts(files);
  const image = DOCKER_IMAGE_ID.test(options.image)
    ? options.image
    : await resolveDockerImage(options.image);
  const timeoutSeconds = installTimeoutSeconds();
  const id = randomUUID();
  const network = `refit-build-${id}`;
  const proxy = `refit-proxy-${id}`;
  const name = `refit-install-${id}`;
  const scratch = await mkdtemp(join(tmpdir(), 'refit-repository-install-'));
  const input = join(scratch, 'input');
  const archive = options.copyArchiveTo ?? join(scratch, 'dependencies.tar');
  options.onProgress?.(
    `Running the repository's own install (${plan.command.join(' ')}, from ${plan.file}) in Refit's build sandbox; egress is limited to ${hosts.length} named hosts...`,
  );
  try {
    await mkdir(input, { mode: 0o755 });
    await chmod(scratch, 0o755);
    await committedTree(options.repository, input);
    await execute('docker', ['network', 'create', '--internal', network]);
    await execute('docker', [
      'run',
      '-d',
      '--name',
      proxy,
      '--network',
      'bridge',
      '--pull',
      'never',
      '--read-only',
      '--user',
      '65534',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '256m',
      '--pids-limit',
      '64',
      '--entrypoint',
      'node',
      image,
      '-e',
      PROXY_SCRIPT,
      JSON.stringify(hosts),
    ]);
    await execute('docker', ['network', 'connect', network, proxy]);
    await proxyReady(proxy);
    const result = await runInstall(
      installArguments({
        name,
        directory: input,
        image,
        network,
        proxy,
        plan,
        timeoutMs: timeoutSeconds * 1000,
      }),
      archive,
      timeoutSeconds,
      options.signal,
    );
    const proxyLog = await execute('docker', ['logs', proxy]).then(
      (output) => output.stderr,
      () => '',
    );
    const denied = [
      ...new Set([...proxyLog.matchAll(/^REFIT_DENIED=(\S+)$/gm)].map((match) => match[1])),
    ];
    const nodeVersion = /^REFIT_NODE_VERSION=(v\d+\.\d+\.\d+)$/m.exec(result.stderr)?.[1];
    if (result.code !== 0 || !result.bytes || !nodeVersion) {
      const tail = result.stderr.replace(/^REFIT_[A-Z_]+=.*\n?/gm, '').slice(-MAX_LOG_CHARACTERS);
      throw new RepositoryInstallError(
        `The repository's own install (${plan.command.join(' ')}, from ${plan.file}) failed in Refit's build sandbox (${result.code ?? 'killed'})${denied.length ? `; the proxy refused ${denied.join(', ')}, which no committed file names` : ''}. ${tail}`,
        denied.length > 0 || needsCustomerEnvironment(result.stderr),
      );
    }
    const environment: Record<string, unknown> = {
      formatVersion: 1,
      kind: 'refit-repository-environment',
      image,
      manager: plan.manager,
      nodeVersion,
      archiveHash: result.sha256,
      archiveBytes: result.bytes,
      installation: {
        source: plan.source,
        file: plan.file,
        command: plan.command,
        ...(plan.tool ? { tool: plan.tool } : {}),
        skipped: plan.skipped,
        lifecycleScripts: !plan.command.includes('--ignore-scripts'),
        secrets: false,
        egress: hosts,
        timeoutMs: timeoutSeconds * 1000,
      },
      validation: { network: 'none' },
    };
    return { directory: scratch, archive, environment, reused: false };
  } finally {
    const cleanup = await Promise.allSettled([
      removeDockerContainer(name),
      removeDockerContainer(proxy),
      rm(options.copyArchiveTo ? scratch : input, { recursive: true, force: true }),
    ]);
    await execute('docker', ['network', 'rm', network]).catch(() => undefined);
    for (const entry of cleanup) if (entry.status === 'rejected') throw entry.reason;
  }
}

// Refit's own preparation first; where it refuses for a repository-side reason, the
// repository's own install. A nested package keeps Refit's preparation only.
export async function prepareEnvironment(options: Parameters<typeof prepareDependencies>[0]) {
  try {
    return await prepareDependencies(options);
  } catch (error) {
    const failure = preparationFailure(error);
    if (
      !failure ||
      failure.reason === 'dependency-archive-limit' ||
      options.packageDirectory ||
      !repositoryInstallEnabled() ||
      !(error instanceof Error)
    )
      throw error;
    options.onProgress?.(
      `Refit's preparation refused (${failure.summary}); trying the repository's own install.`,
    );
    try {
      return await buildRepositoryEnvironment(options);
    } catch (built) {
      options.signal?.throwIfAborted();
      // Docker could not build the sandbox (no network support, the host): the refusal stands.
      if (!(built instanceof PipelineInputError)) {
        options.onProgress?.(
          `The build sandbox did not run: ${built instanceof Error ? built.message : String(built)}`,
        );
        throw error;
      }
      const combined = new RepositoryInstallError(
        `${error.message} Refit's build of the repository's own install also failed: ${built.message}`,
        built instanceof RepositoryInstallError && built.customerOnly,
      );
      throw combined;
    }
  }
}
