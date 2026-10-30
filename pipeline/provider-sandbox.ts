import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { SANDBOX_EXPIRY_LABEL } from './docker-sandbox.ts';
import { PipelineInputError } from './types.ts';

// Behaviour tests against a provider's own test environment. Everything here is provider-neutral:
// an adapter per provider declares its hosts, its test keys, how the API version is
// pinned, how stand-in objects are created and removed, and its rate limit.
//
// The test containers run on an internal Docker network with no route out and no DNS. The only
// thing they reach is a proxy container that Refit starts on that network and on the default
// bridge. The proxy forwards only to the adapter's hosts, puts the test key on each request (the
// code under test never holds it), pins the side's API version where the code sends none, tags
// every object the run creates, retries rate-limited requests with the next key of the pool, and
// prints one record per request: method, path, version and status, and for a refused request the
// provider's error message (redacted, after stand-in IDs are swapped back), never a body.

export type SandboxTarget = 'test-environment' | 'mock';

export interface ProviderObject {
  id: string;
  object: string;
}

export interface ProviderCall {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  form?: Record<string, string>;
  // Adds the run tag; only for operations that accept it, such as creating a stand-in.
  tag?: boolean;
}

// An account-specific object the code names, and what the adapter creates in its place.
export interface StandInWanted {
  id: string;
  kind: string;
}

export interface StandIn extends StandInWanted {
  standIn: string;
  // The shape Refit assumed, which the draft names.
  assumption: string;
}

export type Caller = (call: ProviderCall) => Promise<Record<string, unknown>>;

export interface SandboxAdapter {
  name: string;
  hosts: readonly string[];
  // The environment variable holding one or more test keys (comma or whitespace separated).
  keyVariable: string;
  testKey: RegExp;
  // Every credential of this provider, test or live, redacted from captured output (global flag).
  secret: RegExp;
  // The Authorization header, with {key} for the key.
  authorization: string;
  versionHeader: string;
  rateLimit: { status: number; retries: number; backoffMs: number };
  tagField: string;
  // Regular expressions over `METHOD /path` for the operations that accept the run tag.
  taggable(contract: unknown): string[];
  // Account-specific identifiers in the code under test: those the adapter can stand in for, and
  // those it cannot reproduce.
  standIns(sources: readonly { path: string; content: string }[]): {
    wanted: StandInWanted[];
    unreproducible: string[];
  };
  createStandIn(
    wanted: StandInWanted,
    call: Caller,
    sources: readonly { content: string }[],
  ): Promise<{ id: string; assumption: string }>;
  // How to delete, expire or deactivate an object the run created; undefined leaves it, tagged.
  cleanup(object: ProviderObject): ProviderCall | undefined;
  // The operation a request stands for, with identifiers replaced, to compare errors across sides.
  operation(method: string, path: string): string;
}

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const PROXY_PORT = 8080;
const REDACTED = '[redacted]';
const NETWORK = /^refit-sandbox-[a-f0-9-]{36}$/;

// The keys come only from the adapter's environment variable, and only test keys are accepted.
export function providerKeys(adapter: SandboxAdapter, environment: NodeJS.ProcessEnv) {
  const keys = (environment[adapter.keyVariable] ?? '').split(/[\s,]+/).filter(Boolean);
  if (!keys.length)
    throw new PipelineInputError(
      `${adapter.name} test mode needs ${adapter.keyVariable}, which is not set.`,
    );
  // The message says which check failed, never any part of the value.
  const refused = keys.flatMap((key, index) => {
    if (adapter.testKey.test(key)) return [];
    const why = new RegExp(`^(?:${adapter.secret.source})$`).test(key)
      ? 'is a live or other non-test credential'
      : /[^A-Za-z0-9_]/.test(key)
        ? 'holds characters other than letters, digits and underscores (quotes or a NAME= prefix?)'
        : 'does not have the shape of a test key';
    return [`value ${index + 1} of ${keys.length} (${key.length} characters) ${why}`];
  });
  if (refused.length)
    throw new PipelineInputError(
      `${adapter.keyVariable} must hold only ${adapter.name} test keys; a live or malformed key is refused: ${refused.join('; ')}.`,
    );
  return keys;
}

// Removes the run's keys, and anything shaped like one of the provider's credentials, from text.
export function redactor(adapter: SandboxAdapter, keys: readonly string[]) {
  return (text: string) =>
    keys
      .reduce((value, key) => value.split(key).join(REDACTED), text)
      .replace(new RegExp(adapter.secret.source, 'g'), REDACTED);
}

export interface SandboxRequest {
  method: string;
  path: string;
  host: string;
  status: number;
  attempts?: number;
  version?: string | null;
  versionSent?: boolean;
  tagged?: boolean;
  created?: ProviderObject;
  rateLimited?: true;
  denied?: true;
  error?: string;
  // The provider's own error message for a request it refused, which the test writer reads.
  message?: string;
}

// The proxy, written into the sandbox's tool directory and run by node in its own container.
const PROXY = `import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const keys = String(process.env.REFIT_PROVIDER_KEYS ?? '').split('\\n').filter(Boolean);
delete process.env.REFIT_PROVIDER_KEYS;
let next = 0;
const operations = config.tag.operations.map((source) => new RegExp(source));
const forward = Object.entries(config.ids);
const backward = forward.map(([from, to]) => [to, from]);
const swap = (text, pairs) => pairs.reduce((value, [from, to]) => value.split(from).join(to), text);
const redact = (text) => keys.reduce((value, key) => value.split(key).join('${REDACTED}'), text);
const upstream = config.upstream ? new URL(config.upstream) : undefined;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const print = (record) => process.stdout.write('REFIT_SANDBOX_REQUEST=' + JSON.stringify(record) + '\\n');
const DROP = new Set(['host', 'authorization', 'content-length', 'connection', 'accept-encoding', 'proxy-authorization', 'proxy-connection', 'transfer-encoding']);
const send = (options, body) => new Promise((resolve, reject) => {
  const request = (upstream?.protocol === 'http:' ? http : https).request(options, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    response.on('error', reject);
  });
  request.on('error', reject);
  request.setTimeout(60000, () => request.destroy(new Error('upstream timeout')));
  request.end(body);
});
http.createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => { size += chunk.length; if (size > 1048576) req.destroy(); else chunks.push(chunk); });
  req.on('end', async () => {
    const host = String(req.headers.host ?? '').replace(/:\\d+$/, '').toLowerCase();
    const record = { method: String(req.method), path: String(req.url).split('?')[0], host };
    if (!config.hosts.includes(host)) {
      print({ ...record, status: 403, denied: true });
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Refit sandbox: egress to this host is not allowed.');
      return;
    }
    const target = swap(String(req.url), forward);
    let body = swap(Buffer.concat(chunks).toString(), forward);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!DROP.has(name)) headers[name] = value;
    const sent = headers[config.versionHeader];
    if (!sent && config.version) headers[config.versionHeader] = config.version;
    record.version = headers[config.versionHeader] ?? null;
    record.versionSent = Boolean(sent);
    record.tagged = operations.some((pattern) => pattern.test(record.method + ' ' + target.split('?')[0]));
    if (record.tagged) body = (body ? body + '&' : '') + encodeURIComponent(config.tag.field) + '=' + encodeURIComponent(config.tag.value);
    let response;
    let attempts = 0;
    for (;;) {
      headers.authorization = config.authorization.replace('{key}', keys[next % keys.length]);
      headers['content-length'] = String(Buffer.byteLength(body));
      attempts++;
      try {
        response = await send({ hostname: upstream?.hostname ?? host, port: upstream?.port || 443, path: target, method: record.method, headers, servername: host }, body);
      } catch (error) {
        print({ ...record, attempts, status: 502, error: redact(String(error?.message ?? error)).slice(0, 200) });
        res.writeHead(502, { 'content-type': 'text/plain' }).end('Refit sandbox: the provider could not be reached.');
        return;
      }
      if (response.status !== config.rateLimit.status || attempts > config.rateLimit.retries) break;
      // The next key of the pool, after an exponential backoff with jitter.
      next++;
      await sleep(Math.min(30000, config.rateLimit.backoffMs * 2 ** (attempts - 1) * (1 + Math.random())));
    }
    let text = redact(response.body.toString());
    if (record.tagged && response.status < 300)
      try {
        const value = JSON.parse(text);
        if (typeof value?.id === 'string' && typeof value?.object === 'string') record.created = { id: value.id, object: value.object };
      } catch {}
    text = swap(text, backward);
    let message;
    if (response.status >= 400)
      try {
        // Not cut here: a cut credential could escape the host's redaction, which runs on all of it.
        const value = JSON.parse(text)?.error?.message;
        if (typeof value === 'string') message = value;
      } catch {}
    print({ ...record, attempts, status: response.status, ...(response.status === config.rateLimit.status ? { rateLimited: true } : {}), ...(message ? { message } : {}) });
    const out = {};
    for (const [name, value] of Object.entries(response.headers))
      if (!['content-length', 'transfer-encoding', 'connection', 'content-encoding', 'set-cookie'].includes(name)) out[name] = value;
    res.writeHead(response.status, out).end(text);
  });
}).listen(config.port, '0.0.0.0', () => process.stdout.write('REFIT_SANDBOX_READY\\n'));
`;

export interface ProxyConfig {
  port: number;
  hosts: readonly string[];
  upstream?: string;
  authorization: string;
  versionHeader: string;
  version: string | null;
  tag: { field: string; value: string; operations: string[] };
  ids: Record<string, string>;
  rateLimit: SandboxAdapter['rateLimit'];
}

export function proxyConfig(
  adapter: SandboxAdapter,
  options: {
    runId: string;
    version: string | null;
    contract: unknown;
    standIns: readonly StandIn[];
    upstream?: string;
    port?: number;
  },
): ProxyConfig {
  return {
    port: options.port ?? PROXY_PORT,
    hosts: adapter.hosts,
    ...(options.upstream ? { upstream: options.upstream } : {}),
    authorization: adapter.authorization,
    versionHeader: adapter.versionHeader.toLowerCase(),
    version: options.version,
    tag: {
      field: adapter.tagField,
      value: options.runId,
      operations: adapter.taggable(options.contract),
    },
    ids: Object.fromEntries(options.standIns.map((item) => [item.id, item.standIn])),
    rateLimit: adapter.rateLimit,
  };
}

export async function writeProxy(directory: string, side: string, config: ProxyConfig) {
  // Both sides share the read-only script; each has its own configuration.
  await writeFile(join(directory, 'proxy.mjs'), PROXY, { mode: 0o444, flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );
  await writeFile(join(directory, `proxy-${side}.json`), JSON.stringify(config), { mode: 0o444 });
}

// The records a proxy printed, and whether it started.
export function proxyRecords(stdout: string) {
  const requests: SandboxRequest[] = [];
  for (const line of stdout.split('\n'))
    if (line.startsWith('REFIT_SANDBOX_REQUEST='))
      requests.push(JSON.parse(line.slice('REFIT_SANDBOX_REQUEST='.length)) as SandboxRequest);
  return requests;
}

// Host-side requests (stand-ins and cleanup) go straight to the provider with the same key pool,
// tag and backoff as the proxy.
export function providerCaller(
  adapter: SandboxAdapter,
  keys: readonly string[],
  options: { runId: string; upstream?: string; fetch?: typeof fetch },
): Caller {
  const request = options.fetch ?? fetch;
  let next = 0;
  return async (call) => {
    const form = new URLSearchParams(call.form ?? {});
    if (call.tag) form.set(adapter.tagField, options.runId);
    const base = options.upstream ?? `https://${adapter.hosts[0]}`;
    for (let attempt = 1; ; attempt++) {
      const response = await request(`${base}${call.path}`, {
        method: call.method,
        headers: {
          authorization: adapter.authorization.replace('{key}', keys[next % keys.length]),
          ...(call.method === 'POST'
            ? { 'content-type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        ...(call.method === 'POST' ? { body: form.toString() } : {}),
      });
      if (response.status === adapter.rateLimit.status && attempt <= adapter.rateLimit.retries) {
        next++;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            adapter.rateLimit.backoffMs * 2 ** (attempt - 1) * (1 + Math.random()),
          ),
        );
        continue;
      }
      const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          redactor(
            adapter,
            keys,
          )(
            `${call.method} ${call.path} returned ${response.status}: ${String((value.error as { message?: unknown } | undefined)?.message ?? 'no message')}`,
          ),
        );
      return value;
    }
  };
}

export async function createStandIns(
  adapter: SandboxAdapter,
  call: Caller,
  sources: readonly { path: string; content: string }[],
) {
  const { wanted, unreproducible } = adapter.standIns(sources);
  const standIns: StandIn[] = [];
  const failed: string[] = [];
  // Everything created here, a stand-in price's product included, is removed with the run.
  const objects: ProviderObject[] = [];
  const recording: Caller = async (request) => {
    const value = await call(request);
    if (request.tag && typeof value.id === 'string' && typeof value.object === 'string')
      objects.push({ id: value.id, object: value.object });
    return value;
  };
  for (const item of wanted)
    try {
      const created = await adapter.createStandIn(item, recording, sources);
      standIns.push({ ...item, standIn: created.id, assumption: created.assumption });
    } catch (error) {
      failed.push(`${item.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  return { standIns, unreproducible: [...unreproducible, ...failed], objects };
}

// Deletes, expires or deactivates every object the run created, newest first. A failure is
// recorded and never stops the others; what the adapter cannot remove stays tagged.
export async function cleanupObjects(
  adapter: SandboxAdapter,
  call: Caller,
  objects: readonly ProviderObject[],
) {
  const result = { removed: [] as string[], left: [] as string[], failed: [] as string[] };
  const seen = new Set<string>();
  for (const object of [...objects].reverse()) {
    if (seen.has(object.id)) continue;
    seen.add(object.id);
    const request = adapter.cleanup(object);
    if (!request) {
      result.left.push(`${object.object} ${object.id}`);
      continue;
    }
    try {
      await call(request);
      result.removed.push(`${object.object} ${object.id}`);
    } catch (error) {
      result.failed.push(
        `${object.object} ${object.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

// Errors the provider returned on the patched side for an operation and status it never returned
// on the original side. Requests the proxy denied never reached it (sandboxBlockers names them).
export function newProviderErrors(
  adapter: SandboxAdapter,
  original: readonly SandboxRequest[],
  patched: readonly SandboxRequest[],
) {
  const key = (request: SandboxRequest) =>
    `${adapter.operation(request.method, request.path)} ${request.status}`;
  const before = new Set(original.filter((request) => request.status >= 400).map(key));
  return [
    ...new Set(
      patched
        .filter((request) => !request.denied && request.status >= 400 && !before.has(key(request)))
        .map(key),
    ),
  ];
}

// Why a side's provider evidence is unavailable: rate limits that outlasted the retries, a provider
// that could not be reached, or a server error on its side. Neither ever counts as a regression.
export function unavailableSide(requests: readonly SandboxRequest[]) {
  const limited = requests.filter((request) => request.rateLimited).length;
  const unreachable = requests.filter((request) => request.status >= 500).length;
  return limited
    ? `${limited} request(s) stayed rate-limited after every retry.`
    : unreachable
      ? `${unreachable} request(s) could not reach the provider or failed on its side.`
      : undefined;
}

// What keeps provider evidence from grade A, beyond the tests themselves.
export function sandboxBlockers(
  adapter: SandboxAdapter,
  evidence: {
    versions: { original: string | null; patched: string | null };
    requests: { original: readonly SandboxRequest[]; patched: readonly SandboxRequest[] };
    unreproducible: readonly string[];
  },
) {
  const blockers: string[] = [];
  for (const side of ['original', 'patched'] as const) {
    const requests = evidence.requests[side];
    if (!requests.length) blockers.push(`No ${adapter.name} request was made on the ${side} side.`);
    const denied = requests.filter((request) => request.denied);
    if (denied.length)
      blockers.push(
        `The ${side} side tried to reach ${[...new Set(denied.map((request) => request.host))].join(', ')}, which the sandbox denies.`,
      );
    const expected = evidence.versions[side];
    const mismatched = requests.filter(
      (request) => !request.denied && expected && request.version !== expected,
    );
    if (mismatched.length)
      blockers.push(
        `The ${side} side sent ${[...new Set(mismatched.map((request) => request.version ?? 'no version'))].join(', ')} instead of ${expected}.`,
      );
  }
  for (const error of newProviderErrors(
    adapter,
    evidence.requests.original,
    evidence.requests.patched,
  ))
    blockers.push(`${adapter.name} returned ${error} on the patched side only.`);
  for (const item of evidence.unreproducible)
    blockers.push(`${item} cannot be reproduced in Refit's test account.`);
  return blockers;
}

// The grade A rule: only a provider's own test environment can grant it, never a mock, and only
// when the tests passed on both sides with nothing missing (every changed line ran, no blocker).
export function sandboxGrade(evidence: {
  target: SandboxTarget;
  passed: boolean;
  missing: readonly string[];
}) {
  return evidence.target === 'test-environment' && evidence.passed && !evidence.missing.length
    ? ('A' as const)
    : null;
}

const docker = (args: string[]) =>
  execute('docker', args, { timeout: PROCESS_TIMEOUT_MS, encoding: 'utf8' });

// Networks a killed Refit process left behind, past their expiry.
async function removeExpiredNetworks(now = Date.now()) {
  const { stdout } = await docker([
    'network',
    'ls',
    '--filter',
    `label=${SANDBOX_EXPIRY_LABEL}`,
    '--format',
    `{{.Name}} {{.Label "${SANDBOX_EXPIRY_LABEL}"}}`,
  ]);
  for (const line of stdout.split('\n')) {
    const [name, expiry] = line.trim().split(' ');
    if (name && NETWORK.test(name) && Number(expiry) < now)
      await docker(['network', 'rm', name]).catch(() => undefined);
  }
}

export async function createSandboxNetwork(timeoutMs: number) {
  await removeExpiredNetworks();
  const name = `refit-sandbox-${randomUUID()}`;
  await docker([
    'network',
    'create',
    '--internal',
    '--label',
    `${SANDBOX_EXPIRY_LABEL}=${Date.now() + timeoutMs + 60_000}`,
    name,
  ]);
  return name;
}

export async function removeSandboxNetwork(name: string) {
  if (NETWORK.test(name)) await docker(['network', 'rm', name]).catch(() => undefined);
}

// Starts the proxy container for one side, on the internal network and the default bridge, with
// the keys in its environment only. Returns its address on the internal network and a stop that
// returns every record it printed.
export async function startProxy(options: {
  network: string;
  image: string;
  tools: string;
  side: string;
  keys: readonly string[];
  timeoutMs: number;
}) {
  if (!NETWORK.test(options.network)) throw new PipelineInputError('Not a Refit sandbox network.');
  const name = `refit-proxy-${randomUUID()}`;
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      '--label',
      `${SANDBOX_EXPIRY_LABEL}=${Date.now() + options.timeoutMs + 60_000}`,
      '--pull',
      'never',
      '--network',
      options.network,
      '--log-driver',
      'none',
      '--read-only',
      '--user',
      '65534:65534',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '32',
      '--memory',
      '256m',
      '--env',
      'REFIT_PROVIDER_KEYS',
      '--mount',
      `type=bind,src=${options.tools},dst=/refit/sandbox,readonly`,
      '--entrypoint',
      'node',
      options.image,
      '/refit/sandbox/proxy.mjs',
      `/refit/sandbox/proxy-${options.side}.json`,
    ],
    {
      env: { ...process.env, REFIT_PROVIDER_KEYS: options.keys.join('\n') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stderr.on(
    'data',
    (chunk) => (stderr += String(chunk)).length > 8192 && (stderr = stderr.slice(-8192)),
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      stdout += `${line}\n`;
      if (line === 'REFIT_SANDBOX_READY') resolve();
    });
    void closed.then(() => reject(new Error(`The sandbox proxy exited: ${stderr.slice(-500)}`)));
    setTimeout(
      () => reject(new Error('The sandbox proxy did not start in 30 seconds.')),
      30_000,
    ).unref();
  });
  const stop = async () => {
    await docker(['rm', '--force', name]).catch(() => undefined);
    await closed;
    return proxyRecords(stdout);
  };
  try {
    await ready;
    await docker(['network', 'connect', 'bridge', name]);
    const { stdout: address } = await docker([
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks "${options.network}").IPAddress}}`,
      name,
    ]);
    return { host: address.trim(), port: PROXY_PORT, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
