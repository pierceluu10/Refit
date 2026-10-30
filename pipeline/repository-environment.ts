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
import { dirname, join } from 'node:path';
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
  removeExpiredSandboxContainers,
  resolveDockerImage,
  SANDBOX_EXPIRY_LABEL,
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
const DOCKER_TIMEOUT_MS = 60_000;
const SWEEP_GRACE_MS = 10 * 60 * 1000;
// A hung daemon fails the call instead of blocking the job.
const docker = (argumentsList: string[]) =>
  execute('docker', argumentsList, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });

// Build networks a killed job left behind; containers on them go through the sandbox sweeper.
async function removeExpiredNetworks(now = Date.now()) {
  const { stdout } = await docker([
    'network',
    'ls',
    '--filter',
    `label=${SANDBOX_EXPIRY_LABEL}`,
    '--format',
    `{{.Name}}\t{{.Label "${SANDBOX_EXPIRY_LABEL}"}}`,
  ]).catch(() => ({ stdout: '' }));
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [name, expires] = line.split('\t');
    if (name.startsWith('refit-build-') && Number(expires) < now)
      await docker(['network', 'rm', name]).catch(() => undefined);
  }
}
const PROXY_PORT = 3128;
const MAX_LOG_CHARACTERS = 4000;

// REFIT_REPOSITORY_INSTALL=0 keeps Refit to its own preparation; on by default.
export function repositoryInstallEnabled(value = process.env.REFIT_REPOSITORY_INSTALL) {
  return value?.trim() !== '0';
}

// An HTTP proxy that tunnels CONNECT (and forwards plain HTTP) only to allowlisted hosts on 80
// and 443, and prints each refused host as REFIT_DENIED=<host>. A name is checked by every address
// it resolves to and the proxy connects to that checked address, so an allowlisted name that
// points at a private, loopback, link-local or metadata address (169.254.169.254) is refused too.
export const PROXY_SCRIPT = `
const http = require("node:http"), net = require("node:net"), dns = require("node:dns");
const allowed = new Set(JSON.parse(process.argv[1]));
const deny = (host) => console.error("REFIT_DENIED=" + host);
const v4 = (a) => a.split(".").map(Number);
const privateAddress = (address) => {
  const mapped = /^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/i.exec(address);
  if (mapped) address = mapped[1];
  if (net.isIPv4(address)) {
    const [a, b] = v4(address);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  const lower = address.toLowerCase();
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
};
// The public address to connect to, or undefined when the host or any address it has is refused.
const resolve = (host, port, done) => {
  host = String(host).toLowerCase().replace(/^\\[|\\]$/g, "");
  if (!allowed.has(host) || (port !== 443 && port !== 80) || net.isIP(host)) return done(undefined);
  dns.lookup(host, { all: true }, (error, addresses) => {
    if (error || !addresses.length || addresses.some((entry) => privateAddress(entry.address))) return done(undefined);
    done(addresses[0].address);
  });
};
const server = http.createServer((request, response) => {
  let url; try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
  const port = Number(url.port || 80);
  if (url.protocol !== "http:") { deny(url.hostname); response.writeHead(403).end(); return; }
  resolve(url.hostname, port, (address) => {
    if (!address) { deny(url.hostname); response.writeHead(403).end(); return; }
    const upstream = http.request({ host: address, port, path: url.pathname + url.search, method: request.method, headers: { ...request.headers, host: url.host } },
      (reply) => { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response); });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
});
server.on("connect", (request, socket, head) => {
  const match = /^(.+):(\\d+)$/.exec(String(request.url));
  const host = match ? match[1] : String(request.url);
  socket.on("error", () => socket.destroy());
  resolve(host, Number(match && match[2]), (address) => {
    if (!address) { deny(host); socket.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); return; }
    const upstream = net.connect(Number(match[2]), address, () => { socket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n"); upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
    upstream.on("error", () => socket.destroy()); socket.on("close", () => upstream.destroy());
  });
});
server.listen(Number(process.argv[2] || ${PROXY_PORT}), "0.0.0.0", () => console.error("REFIT_PROXY_READY"));
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
  signal?.throwIfAborted();
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  // An abort rejects before stdout ends; handled here so it never surfaces as unhandled.
  exited.catch(() => undefined);
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
    const { stderr } = await docker(['logs', proxy]);
    if (stderr.includes('REFIT_PROXY_READY')) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The build sandbox proxy did not start.');
}

// The lines that say why an install failed, first: progress, deprecation and proxy-agent
// warnings would otherwise fill the bounded message that drafts and benchmarks quote.
const NOISE =
  /^(?:REFIT_[A-Z_]+=|Progress: |npm warn |warning |\(node:\d+\) \[UNDICI-EHPA\]|\(Use `node --trace-warnings|added \d+ packages? in |Packages: |\s*$)/;
const ERROR_LINE = /\b(?:ERR!?|ERR_PNPM_\w+|error|Error|E\d{3}|ENOENT|EACCES|refused|denied)\b/;

export function installFailure(stderr: string) {
  const lines = stderr.split('\n').filter((line) => !NOISE.test(line));
  const errors = lines.filter((line) => ERROR_LINE.test(line)).slice(-6);
  const rest = lines.slice(-12).filter((line) => !errors.includes(line));
  return [...errors, ...rest].join('\n').slice(0, MAX_LOG_CHARACTERS);
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
  let built = false;
  await removeExpiredSandboxContainers();
  await removeExpiredNetworks();
  try {
    await mkdir(input, { mode: 0o755 });
    await chmod(scratch, 0o755);
    await committedTree(options.repository, input);
    const expires = `${SANDBOX_EXPIRY_LABEL}=${Date.now() + timeoutSeconds * 1000 + SWEEP_GRACE_MS}`;
    await docker(['network', 'create', '--internal', '--label', expires, network]);
    await docker([
      'run',
      '-d',
      '--name',
      proxy,
      // The existing sweeper removes it after a crash or SIGKILL skipped this function's cleanup.
      '--label',
      expires,
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
    await docker(['network', 'connect', network, proxy]);
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
    const proxyLog = await docker(['logs', proxy]).then(
      (output) => output.stderr,
      () => '',
    );
    const denied = [
      ...new Set([...proxyLog.matchAll(/^REFIT_DENIED=(\S+)$/gm)].map((match) => match[1])),
    ];
    const nodeVersion = /^REFIT_NODE_VERSION=(v\d+\.\d+\.\d+)$/m.exec(result.stderr)?.[1];
    if (result.code !== 0 || !result.bytes || !nodeVersion) {
      const tail = installFailure(result.stderr);
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
    built = true;
    return { directory: dirname(archive), archive, environment, reused: false };
  } finally {
    const cleanup = await Promise.allSettled([
      removeDockerContainer(name),
      removeDockerContainer(proxy),
      rm(options.copyArchiveTo ? scratch : input, { recursive: true, force: true }),
      // A failed build leaves no partial archive behind (it can be up to the archive limit).
      built ? Promise.resolve() : rm(archive, { force: true }),
    ]);
    await docker(['network', 'rm', network]).catch(() => undefined);
    for (const entry of cleanup) if (entry.status === 'rejected') throw entry.reason;
  }
}

// Stops the repository's own install must not get around: a lockfile that is missing, out of
// sync, unverifiable or rejected by npm would install versions the repository never committed
// (owner decisions on lockfile drift), and the archive limit binds the build sandbox too.
const KEPT_STOPS = new Set([
  'dependency-archive-limit',
  'no-lockfile',
  'lockfile-out-of-sync',
  'lockfile-integrity',
  'peer-dependency-conflict',
]);

// Whether a refusal with this message falls back to the repository's own install (refit doctor).
export function fallsBackToRepositoryInstall(message: string) {
  const failure = preparationFailure(new DependencyPreparationError(message));
  return Boolean(failure) && !KEPT_STOPS.has(failure!.reason) && repositoryInstallEnabled();
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
      KEPT_STOPS.has(failure.reason) ||
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
