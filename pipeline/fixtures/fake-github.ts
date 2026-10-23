// A local stand-in for GitHub, served over real HTTP: App JWTs are verified with the App's public
// key, installation tokens are issued and scoped per repository, repository metadata and refs come
// from local bare Git remotes served by `git http-backend`, and every write is recorded. Tests route
// Refit's api.github.com requests here with `fetch` and its managed fetches with
// `throughFakeGitHub` (fake-github-git.ts); Refit's own code runs unchanged.
import { execFile, spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { routeGitTo } from './fake-github-git.ts';

const execute = promisify(execFile);
const API_ROOT = 'https://api.github.com';
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const MILLISECONDS_PER_SECOND = 1000;
const FIRST_REPOSITORY_ID = 1000;
const ISSUE_URL = 'https://github.com';
const UPLOAD_PACK = 'git-upload-pack';
const REPOSITORY_PATH = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/;
const GIT_PATH = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)$/;
// Fixture Git commands ignore the developer's configuration; pushes into the bare remotes are local.
const FIXTURE_GIT = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

// A fetch that sends api.github.com requests to the fake at `url`; everything else is unchanged.
export function throughFakeApi(url: string, realFetch: typeof fetch = globalThis.fetch) {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const target =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return target.startsWith(API_ROOT)
      ? realFetch(`${url}${target.slice(API_ROOT.length)}`, init)
      : realFetch(input, init);
  }) as typeof fetch;
}

export interface FakeInstallation {
  id: number;
  login: string;
  repositories: string[];
  suspended: boolean;
}

interface FakeRepository {
  fullName: string;
  id: number;
  defaultBranch: string;
  archived: boolean;
  bare: string;
  // Collaborator login → role_name, as GET …/collaborators/{user}/permission answers.
  roles: Map<string, string>;
  issues: Map<number, { title: string; body: string; state: string }>;
}

interface IssuedToken {
  installation: number;
  repository: string;
  permissions: Record<string, string>;
  expires: number;
}

class Reply extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: Buffer): Record<string, unknown> {
  return body.length ? JSON.parse(body.toString('utf8')) : {};
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function bearer(authorization: string | undefined) {
  return /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
}

export async function startFakeGitHub(options: { appId: number; webhookSecret: string }) {
  const root = await mkdtemp(join(tmpdir(), 'refit-fake-github-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyFile = join(root, 'app.pem');
  await writeFile(privateKeyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }), {
    mode: 0o600,
  });
  const installations = new Map<number, FakeInstallation>();
  const repositories = new Map<string, FakeRepository>();
  const tokens = new Map<string, IssuedToken>();
  // Every request, refused ones included; `body` is the parsed JSON body of an API request.
  const requests: {
    method: string;
    path: string;
    status: number;
    body?: Record<string, unknown>;
  }[] = [];
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetches: { repository: string; installation: number }[] = [];
  const deliveries = new Map<string, { event: string; body: string }>();
  let nextRepositoryId = FIRST_REPOSITORY_ID;

  function repository(owner: string, name: string) {
    const found = repositories.get(`${owner}/${name}`.toLowerCase());
    if (!found) throw new Reply(404, 'Not Found');
    return found;
  }

  function installationOf(fullName: string) {
    return [...installations.values()].find((installation) =>
      installation.repositories.some((name) => name.toLowerCase() === fullName.toLowerCase()),
    );
  }

  function authenticateApp(authorization: string | undefined) {
    const [header, claims, signature] = bearer(authorization)?.split('.') ?? [];
    if (
      !signature ||
      !verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      )
    )
      throw new Reply(401, 'A JSON web token could not be decoded');
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
    const now = Date.now() / MILLISECONDS_PER_SECOND;
    if (String(payload.iss) !== String(options.appId) || payload.exp <= now || payload.iat > now)
      throw new Reply(401, "'Expiration time' claim ('exp') or issuer is invalid");
  }

  // An installation token reads only its own repository, only while the installation still has it.
  function authenticateInstallation(
    token: string | undefined,
    target: FakeRepository,
    permission: string,
    level: 'read' | 'write',
  ) {
    const issued = token === undefined ? undefined : tokens.get(token);
    if (!issued || issued.expires <= Date.now()) throw new Reply(401, 'Bad credentials');
    const installation = installations.get(issued.installation);
    if (
      issued.repository.toLowerCase() !== target.fullName.toLowerCase() ||
      installation?.suspended !== false ||
      installationOf(target.fullName) !== installation
    )
      throw new Reply(404, 'Not Found');
    const granted = issued.permissions[permission];
    if (granted !== 'write' && (level === 'write' || granted !== 'read'))
      throw new Reply(403, 'Resource not accessible by integration');
    return issued;
  }

  async function revision(target: FakeRepository, branch: string) {
    try {
      return (
        await execute('git', ['-C', target.bare, 'rev-parse', '--verify', `refs/heads/${branch}`], {
          env: FIXTURE_GIT,
        })
      ).stdout.trim();
    } catch {
      const empty = !(
        await execute('git', ['-C', target.bare, 'for-each-ref', '--count=1'], { env: FIXTURE_GIT })
      ).stdout.trim();
      throw new Reply(empty ? 409 : 404, empty ? 'Git Repository is empty.' : 'Not Found');
    }
  }

  async function api(method: string, path: string, body: Buffer, authorization?: string) {
    if (method === 'GET' && path === '/app') {
      authenticateApp(authorization);
      return [200, { id: options.appId, slug: 'refit-acceptance', name: 'Refit Acceptance' }];
    }
    const access = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === 'POST' && access) {
      authenticateApp(authorization);
      const installation = installations.get(Number(access[1]));
      if (!installation) throw new Reply(404, 'Not Found');
      if (installation.suspended) throw new Reply(403, 'This installation has been suspended');
      const request = json(body);
      const names = request.repositories as string[];
      const targets = names.map((name) => repository(installation.login, name));
      if (targets.length !== 1 || installationOf(targets[0].fullName) !== installation)
        throw new Reply(
          422,
          'There is at least one repository that does not exist or is not accessible to the parent installation.',
        );
      const permissions = { ...(request.permissions as Record<string, string>), metadata: 'read' };
      const token = `ghs_${randomBytes(18).toString('base64url')}`;
      const expires = Date.now() + TOKEN_LIFETIME_MS;
      tokens.set(token, {
        installation: installation.id,
        repository: targets[0].fullName,
        permissions,
        expires,
      });
      return [
        201,
        {
          token,
          expires_at: new Date(expires).toISOString(),
          permissions,
          repository_selection: 'selected',
          repositories: targets.map((target) => ({ id: target.id, full_name: target.fullName })),
        },
      ];
    }
    const match = REPOSITORY_PATH.exec(path);
    if (!match) throw new Reply(404, 'Not Found');
    const target = repository(match[1], match[2]);
    const rest = match[3] ?? '';
    if (method === 'GET' && rest === '/installation') {
      authenticateApp(authorization);
      const installation = installationOf(target.fullName);
      if (!installation) throw new Reply(404, 'Not Found');
      return [
        200,
        {
          id: installation.id,
          app_id: options.appId,
          account: { login: installation.login, type: 'Organization' },
          suspended_at: installation.suspended ? new Date().toISOString() : null,
        },
      ];
    }
    const token = bearer(authorization);
    if (method === 'GET' && rest === '') {
      authenticateInstallation(token, target, 'metadata', 'read');
      return [
        200,
        {
          id: target.id,
          full_name: target.fullName,
          private: true,
          archived: target.archived,
          disabled: false,
          default_branch: target.defaultBranch,
          size: 1,
        },
      ];
    }
    const reference = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (method === 'GET' && reference) {
      authenticateInstallation(token, target, 'contents', 'read');
      const sha = await revision(target, decodeURIComponent(reference[1]));
      return [200, { ref: `refs/heads/${reference[1]}`, object: { type: 'commit', sha } }];
    }
    const permission = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
    if (method === 'GET' && permission) {
      authenticateInstallation(token, target, 'metadata', 'read');
      const role = target.roles.get(decodeURIComponent(permission[1]));
      if (!role) throw new Reply(404, 'Not Found');
      return [200, { permission: role === 'maintain' ? 'write' : role, role_name: role }];
    }
    const issue = /^\/issues(?:\/(\d+)(\/comments)?)?$/.exec(rest);
    if (issue && (method === 'POST' || method === 'PATCH')) {
      authenticateInstallation(token, target, 'issues', 'write');
      const request = json(body);
      if (method === 'POST' && !issue[1]) {
        const number = target.issues.size + 1;
        target.issues.set(number, {
          title: String(request.title),
          body: String(request.body),
          state: 'open',
        });
        return [
          201,
          { number, html_url: `${ISSUE_URL}/${target.fullName}/issues/${number}`, state: 'open' },
        ];
      }
      const existing = target.issues.get(Number(issue[1]));
      if (!existing) throw new Reply(404, 'Not Found');
      if (method === 'PATCH' && !issue[2]) {
        target.issues.set(Number(issue[1]), { ...existing, ...(request as object) });
        return [
          200,
          { number: Number(issue[1]), state: target.issues.get(Number(issue[1]))!.state },
        ];
      }
      if (method === 'POST' && issue[2]) return [201, { id: writes.length + 1 }];
    }
    throw new Reply(404, 'Not Found');
  }

  // Serves only upload-pack (fetch and clone) through git http-backend, after the token check.
  async function serveGit(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    body: Buffer,
  ) {
    const [, owner, name, rest] = GIT_PATH.exec(url.pathname) ?? [];
    if (!rest) throw new Reply(404, 'Not Found');
    const target = repository(owner, name);
    const credentials = /^Basic (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const [user, token] = Buffer.from(credentials ?? '', 'base64')
      .toString('utf8')
      .split(':');
    if (user !== 'x-access-token') throw new Reply(401, 'Authentication required');
    const issued = authenticateInstallation(token, target, 'contents', 'read');
    const service = url.searchParams.get('service') ?? rest.slice(1);
    if (service !== UPLOAD_PACK) throw new Reply(403, 'Only fetches are served');
    if (rest === `/${UPLOAD_PACK}`)
      fetches.push({ repository: target.fullName, installation: issued.installation });
    const child = spawn('git', ['http-backend'], {
      env: {
        ...FIXTURE_GIT,
        GIT_PROJECT_ROOT: join(root, 'git'),
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname.slice('/git'.length),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
      },
    });
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stdin.end(body);
    const [code] = await once(child, 'close');
    const cgi = Buffer.concat(output);
    const split = cgi.indexOf('\r\n\r\n');
    if (code !== 0 || split < 0) throw new Reply(500, `git http-backend exited with ${code}`);
    let status = 200;
    for (const line of cgi.subarray(0, split).toString('latin1').split('\r\n')) {
      const [header, ...value] = line.split(': ');
      if (header.toLowerCase() === 'status') status = Number.parseInt(value.join(': '), 10);
      else response.setHeader(header, value.join(': '));
    }
    response.writeHead(status).end(cgi.subarray(split + 4));
    return status;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake-github');
    const method = request.method ?? 'GET';
    let status: number;
    let parsed: Record<string, unknown> | undefined;
    try {
      const body = await readBody(request);
      if (!url.pathname.startsWith('/git/') && body.length) parsed = json(body);
      if (url.pathname.startsWith('/git/')) status = await serveGit(request, response, url, body);
      else {
        const [code, payload] = await api(
          method,
          url.pathname,
          body,
          request.headers.authorization,
        );
        status = code as number;
        if (method !== 'GET') writes.push({ method, path: url.pathname, body: json(body) });
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      }
    } catch (error) {
      status = error instanceof Reply ? error.status : 500;
      if (!response.headersSent) {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: (error as Error).message }));
      }
    }
    requests.push({ method, path: url.pathname, status, ...(parsed && { body: parsed }) });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  routeGitTo(`${url}/git`);
  const realFetch = globalThis.fetch;

  function repositoryRecord(fullName: string) {
    const target = repositories.get(fullName.toLowerCase())!;
    return {
      id: target.id,
      node_id: `R_${target.id}`,
      name: fullName.split('/')[1],
      full_name: target.fullName,
      private: true,
    };
  }

  function installationRecord(installation: FakeInstallation) {
    return {
      id: installation.id,
      app_id: options.appId,
      account: { login: installation.login, id: installation.id, type: 'Organization' },
      repository_selection: 'selected',
      suspended_at: installation.suspended ? new Date().toISOString() : null,
    };
  }

  async function deliver(
    service: string,
    event: string,
    payload: unknown,
    delivery: string = randomUUID(),
  ) {
    const body = JSON.stringify(payload);
    deliveries.set(delivery, { event, body });
    const response = await realFetch(`${service}/github/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': delivery,
        'X-Hub-Signature-256': `sha256=${createHmac('sha256', options.webhookSecret).update(body).digest('hex')}`,
      },
      body,
    });
    return { status: response.status, body: await response.json(), delivery };
  }

  return {
    url,
    app: { appId: String(options.appId), privateKeyFile },
    installations,
    requests,
    writes,
    fetches,
    // Every installation token issued so far, to check none leaks into logs or arguments.
    issued: () => [...tokens.keys()],
    issues: (fullName: string) => repositories.get(fullName.toLowerCase())?.issues,
    roles: (fullName: string) => repositories.get(fullName.toLowerCase())!.roles,
    // Pass to vi.stubGlobal('fetch', …).
    fetch: throughFakeApi(url, realFetch),

    // Creates the repository's bare remote on first use and pushes the source's HEAD to its default
    // branch; returns the pushed commit.
    async publish(
      fullName: string,
      source: string,
      settings: { id?: number; defaultBranch?: string; archived?: boolean } = {},
    ) {
      const key = fullName.toLowerCase();
      if (!repositories.has(key)) {
        const bare = join(root, 'git', `${fullName}.git`);
        const defaultBranch = settings.defaultBranch ?? 'main';
        await mkdir(bare, { recursive: true });
        await execute(
          'git',
          ['init', '--quiet', '--bare', `--initial-branch=${defaultBranch}`, bare],
          {
            env: FIXTURE_GIT,
          },
        );
        repositories.set(key, {
          fullName,
          id: settings.id ?? nextRepositoryId++,
          defaultBranch,
          archived: false,
          bare,
          roles: new Map(),
          issues: new Map(),
        });
      }
      const target = repositories.get(key)!;
      if (settings.archived !== undefined) target.archived = settings.archived;
      await execute(
        'git',
        [
          '-C',
          source,
          '-c',
          'protocol.file.allow=always',
          'push',
          '--quiet',
          '--force',
          target.bare,
          `HEAD:refs/heads/${target.defaultBranch}`,
        ],
        { env: FIXTURE_GIT },
      );
      return revision(target, target.defaultBranch);
    },

    // Customer actions: each changes what GitHub serves, then delivers the webhook GitHub sends.
    async install(service: string, installation: Omit<FakeInstallation, 'suspended'>) {
      const created = { ...installation, suspended: false };
      installations.set(created.id, created);
      return deliver(service, 'installation', {
        action: 'created',
        installation: installationRecord(created),
        repositories: created.repositories.map(repositoryRecord),
        sender: { login: installation.login, type: 'User' },
      });
    },
    async changeRepositories(
      service: string,
      id: number,
      action: 'added' | 'removed',
      names: string[],
    ) {
      const installation = installations.get(id)!;
      installation.repositories =
        action === 'added'
          ? [...installation.repositories, ...names]
          : installation.repositories.filter((name) => !names.includes(name));
      return deliver(service, 'installation_repositories', {
        action,
        installation: installationRecord(installation),
        repository_selection: 'selected',
        repositories_added: action === 'added' ? names.map(repositoryRecord) : [],
        repositories_removed: action === 'removed' ? names.map(repositoryRecord) : [],
        sender: { login: installation.login, type: 'User' },
      });
    },
    async uninstall(service: string, id: number) {
      const installation = installations.get(id)!;
      installations.delete(id);
      for (const [token, issued] of tokens) if (issued.installation === id) tokens.delete(token);
      return deliver(service, 'installation', {
        action: 'deleted',
        installation: installationRecord(installation),
        repositories: installation.repositories.map(repositoryRecord),
        sender: { login: installation.login, type: 'User' },
      });
    },
    deliver,
    // GitHub keeps the delivery ID and body when a delivery is redelivered.
    async redeliver(service: string, delivery: string) {
      const original = deliveries.get(delivery)!;
      return deliver(service, original.event, JSON.parse(original.body), delivery);
    },

    async close() {
      routeGitTo(undefined);
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type FakeGitHub = Awaited<ReturnType<typeof startFakeGitHub>>;
