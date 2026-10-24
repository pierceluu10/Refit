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
const APP_SLUG = 'refit-acceptance';
// Installation tokens act as the App's bot user, which writes commits and opens pull requests.
const BOT_LOGIN = `${APP_SLUG}[bot]`;
const BOT_ID = 7000;
const CUSTOMER = { name: 'Customer', email: 'customer@example.test' };
const PERSON = /^\w+ (.*) <([^>]*)> (\d+) [+-]\d{4}$/;
const PERSON_LOGIN = 'customer';
const COMPARE_PATH = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/;
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
  pulls: Map<number, FakePull>;
  comments: { issue: number; body: string; user: string }[];
  // Issues and pull requests share one number sequence, as on GitHub.
  next: number;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  // The base branch commit when the head last changed.
  baseSha: string;
  // The head commit when the branch last existed, kept after the branch is deleted.
  headSha: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  user: string;
  // Who last closed or merged it, as GET …/issues/{number} reports in closed_by.
  closedBy?: string;
  reviews?: { user: string; commit: string }[];
  // The head GitHub still reports for a moment after a push.
  reportedHead?: string;
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
  // Runs once, just before the next matching request is handled: a person acting between two of
  // Refit's requests.
  const interceptions: { method: string; path: string; action: () => Promise<void> }[] = [];
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

  // The Git data API (trees, commits, refs) writes straight into the bare remote.
  function git(target: FakeRepository, args: string[], env: NodeJS.ProcessEnv = FIXTURE_GIT) {
    return execute('git', ['-C', target.bare, ...args], { env });
  }

  async function branchTip(target: FakeRepository, branch: string) {
    try {
      return await revision(target, branch);
    } catch (error) {
      if (error instanceof Reply && error.status === 404) return undefined;
      throw error;
    }
  }

  async function isAncestor(target: FakeRepository, ancestor: string, descendant: string) {
    try {
      await git(target, ['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  async function readCommit(target: FakeRepository, sha: string) {
    let raw: string;
    try {
      raw = (await git(target, ['cat-file', 'commit', sha])).stdout;
    } catch {
      throw new Reply(404, 'Not Found');
    }
    const split = raw.indexOf('\n\n');
    const lines = raw.slice(0, split).split('\n');
    const person = (kind: string) => {
      const [, name, email, seconds] = PERSON.exec(
        lines.find((line) => line.startsWith(`${kind} `))!,
      )!;
      return {
        name,
        email,
        date: new Date(Number(seconds) * MILLISECONDS_PER_SECOND).toISOString(),
      };
    };
    return {
      sha,
      tree: { sha: lines[0].slice('tree '.length) },
      parents: lines
        .filter((line) => line.startsWith('parent '))
        .map((line) => ({ sha: line.slice('parent '.length) })),
      author: person('author'),
      committer: person('committer'),
      message: raw.slice(split + 2).replace(/\n$/, ''),
    };
  }

  async function writeTree(target: FakeRepository, request: Record<string, unknown>) {
    const index = join(root, `index-${randomUUID()}`);
    const env = { ...FIXTURE_GIT, GIT_INDEX_FILE: index };
    try {
      if (request.base_tree) await git(target, ['read-tree', String(request.base_tree)], env);
      for (const entry of request.tree as Record<string, unknown>[]) {
        const path = String(entry.path);
        if (entry.sha === null) {
          await git(target, ['update-index', '--force-remove', '--', path], env);
          continue;
        }
        let blob = String(entry.sha);
        if (typeof entry.content === 'string') {
          const file = join(root, `blob-${randomUUID()}`);
          await writeFile(file, entry.content);
          try {
            blob = (
              await git(target, ['hash-object', '-w', '--no-filters', '--', file])
            ).stdout.trim();
          } finally {
            await rm(file, { force: true });
          }
        }
        await git(
          target,
          ['update-index', '--add', '--cacheinfo', `${entry.mode},${blob},${path}`],
          env,
        );
      }
      return (await git(target, ['write-tree'], env)).stdout.trim();
    } catch (error) {
      if (error instanceof Reply) throw error;
      throw new Reply(422, 'Invalid tree entries');
    } finally {
      await rm(index, { force: true });
    }
  }

  async function writeCommit(
    target: FakeRepository,
    request: {
      message: string;
      tree: string;
      parents: string[];
      author?: { name: string; email: string };
      committer?: { name: string; email: string };
    },
  ) {
    const author = request.author ?? {
      name: BOT_LOGIN,
      email: `${BOT_ID}+${BOT_LOGIN}@users.noreply.github.com`,
    };
    const committer = request.committer ?? author;
    const { stdout } = await git(
      target,
      [
        'commit-tree',
        request.tree,
        ...request.parents.flatMap((parent) => ['-p', parent]),
        '-m',
        request.message,
      ],
      {
        ...FIXTURE_GIT,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
      },
    );
    return readCommit(target, stdout.trim());
  }

  // Moves a branch and, as GitHub does on a push, refreshes each open pull request it heads.
  async function moveBranch(target: FakeRepository, branch: string, sha: string) {
    try {
      await git(target, ['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      throw new Reply(422, 'Object does not exist');
    }
    await git(target, ['update-ref', `refs/heads/${branch}`, sha]);
    for (const pull of target.pulls.values())
      if (pull.head === branch && pull.state === 'open') {
        pull.headSha = sha;
        pull.baseSha = await revision(target, pull.base);
      }
  }

  async function pullRecord(target: FakeRepository, pull: FakePull, single = false) {
    const head = pull.reportedHead ?? (await branchTip(target, pull.head)) ?? pull.headSha;
    const repository = { full_name: target.fullName };
    return {
      number: pull.number,
      html_url: `${ISSUE_URL}/${target.fullName}/pull/${pull.number}`,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      draft: pull.draft,
      merged_at: pull.merged ? new Date().toISOString() : null,
      user: { login: pull.user, type: pull.user === BOT_LOGIN ? 'Bot' : 'User' },
      head: { ref: pull.head, sha: head, repo: repository },
      base: { ref: pull.base, sha: pull.baseSha, repo: repository },
      ...(single
        ? {
            merged: pull.merged,
            commits: Number(
              (await git(target, ['rev-list', '--count', `${pull.baseSha}..${head}`])).stdout,
            ),
          }
        : {}),
    };
  }

  function pullOf(target: FakeRepository, number: number) {
    const pull = target.pulls.get(number);
    if (!pull) throw new Reply(404, 'Not Found');
    return pull;
  }

  // GraphQL's updateRefs: every update's beforeOid is checked before any ref moves, so a lease
  // either holds for all of them or none moves.
  async function updateRefs(request: Record<string, unknown>, authorization?: string) {
    const variables = request.variables as {
      repositoryId: string;
      refUpdates: { name: string; beforeOid?: string; afterOid: string; force?: boolean }[];
    };
    if (!String(request.query).includes('updateRefs'))
      throw new Reply(400, 'Only the updateRefs mutation is simulated');
    const target = [...repositories.values()].find(
      (candidate) => `R_${candidate.id}` === variables.repositoryId,
    );
    if (!target)
      return { data: { updateRefs: null }, errors: [{ message: 'Could not resolve to a node' }] };
    authenticateInstallation(bearer(authorization), target, 'contents', 'write');
    for (const update of variables.refUpdates) {
      const branch = update.name.replace(/^refs\/heads\//, '');
      const current = await branchTip(target, branch);
      const refused =
        !update.name.startsWith('refs/heads/') ||
        !current ||
        (update.beforeOid !== undefined && update.beforeOid !== current) ||
        (!update.force && !(await isAncestor(target, current, update.afterOid)));
      if (refused)
        return {
          data: { updateRefs: null },
          errors: [{ message: `${update.name} does not point to ${update.beforeOid}` }],
        };
    }
    for (const update of variables.refUpdates)
      await moveBranch(target, update.name.replace(/^refs\/heads\//, ''), update.afterOid);
    return { data: { updateRefs: { clientMutationId: null } } };
  }

  async function api(
    method: string,
    path: string,
    body: Buffer,
    authorization?: string,
    query = new URLSearchParams(),
  ) {
    if (method === 'GET' && path === '/app') {
      authenticateApp(authorization);
      return [200, { id: options.appId, slug: APP_SLUG, name: 'Refit Acceptance' }];
    }
    const user = /^\/users\/([^/]+)$/.exec(path);
    if (method === 'GET' && user) {
      if (decodeURIComponent(user[1]) !== BOT_LOGIN) throw new Reply(404, 'Not Found');
      return [200, { login: BOT_LOGIN, id: BOT_ID, type: 'Bot' }];
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
    if (method === 'POST' && path === '/graphql')
      return [200, await updateRefs(json(body), authorization)];
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
          node_id: `R_${target.id}`,
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
    const commit = /^\/git\/commits\/([a-f0-9]{40})$/.exec(rest);
    if (method === 'GET' && commit) {
      authenticateInstallation(token, target, 'contents', 'read');
      return [200, await readCommit(target, commit[1])];
    }
    if (method === 'POST' && rest === '/git/trees') {
      authenticateInstallation(token, target, 'contents', 'write');
      return [201, { sha: await writeTree(target, json(body)) }];
    }
    if (method === 'POST' && rest === '/git/commits') {
      authenticateInstallation(token, target, 'contents', 'write');
      return [201, await writeCommit(target, json(body) as Parameters<typeof writeCommit>[1])];
    }
    if (method === 'POST' && rest === '/git/refs') {
      authenticateInstallation(token, target, 'contents', 'write');
      const request = json(body);
      const name = String(request.ref);
      if (!name.startsWith('refs/heads/')) throw new Reply(422, 'Reference name is invalid');
      const branch = name.slice('refs/heads/'.length);
      if (await branchTip(target, branch)) throw new Reply(422, 'Reference already exists');
      await moveBranch(target, branch, String(request.sha));
      return [201, { ref: name, object: { type: 'commit', sha: request.sha } }];
    }
    const update = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (method === 'PATCH' && update) {
      authenticateInstallation(token, target, 'contents', 'write');
      const branch = decodeURIComponent(update[1]);
      const request = json(body);
      const current = await branchTip(target, branch);
      if (!current) throw new Reply(422, 'Reference does not exist');
      if (request.force !== true && !(await isAncestor(target, current, String(request.sha))))
        throw new Reply(422, 'Update is not a fast forward');
      await moveBranch(target, branch, String(request.sha));
      return [200, { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: request.sha } }];
    }
    if (rest === '/pulls' && method === 'GET') {
      authenticateInstallation(token, target, 'pull_requests', 'read');
      const state = query.get('state') ?? 'open';
      const head = query.get('head');
      const base = query.get('base');
      const owner = target.fullName.split('/')[0].toLowerCase();
      const pulls = [...target.pulls.values()]
        .filter(
          (pull) =>
            (state === 'all' || pull.state === state) &&
            (!base || pull.base === base) &&
            (!head || head.toLowerCase() === `${owner}:${pull.head.toLowerCase()}`),
        )
        .sort((left, right) => right.number - left.number);
      return [200, await Promise.all(pulls.map((pull) => pullRecord(target, pull)))];
    }
    if (rest === '/pulls' && method === 'POST') {
      authenticateInstallation(token, target, 'pull_requests', 'write');
      const request = json(body);
      const head = String(request.head);
      const base = String(request.base);
      const headSha = await branchTip(target, head);
      if (!headSha) throw new Reply(422, 'Validation Failed: head is invalid');
      if (
        [...target.pulls.values()].some(
          (pull) => pull.state === 'open' && pull.head === head && pull.base === base,
        )
      )
        throw new Reply(422, `A pull request already exists for ${head}.`);
      const pull: FakePull = {
        number: target.next++,
        title: String(request.title),
        body: String(request.body ?? ''),
        head,
        base,
        baseSha: await revision(target, base),
        headSha,
        draft: request.draft === true,
        state: 'open',
        merged: false,
        user: BOT_LOGIN,
      };
      target.pulls.set(pull.number, pull);
      return [201, await pullRecord(target, pull, true)];
    }
    const pullPath = /^\/pulls\/(\d+)$/.exec(rest);
    if (pullPath && method === 'GET') {
      authenticateInstallation(token, target, 'pull_requests', 'read');
      return [200, await pullRecord(target, pullOf(target, Number(pullPath[1])), true)];
    }
    if (pullPath && method === 'PATCH') {
      authenticateInstallation(token, target, 'pull_requests', 'write');
      const pull = pullOf(target, Number(pullPath[1]));
      const request = json(body);
      if (typeof request.title === 'string') pull.title = request.title;
      if (typeof request.body === 'string') pull.body = request.body;
      if (request.state === 'closed') Object.assign(pull, { state: 'closed', closedBy: BOT_LOGIN });
      if (request.state === 'open') {
        if (pull.merged || !(await branchTip(target, pull.head)))
          throw new Reply(422, 'Validation Failed: state cannot be changed');
        pull.state = 'open';
      }
      return [200, await pullRecord(target, pull, true)];
    }
    const comparison = COMPARE_PATH.exec(rest);
    if (method === 'GET' && comparison) {
      authenticateInstallation(token, target, 'contents', 'read');
      const [, base, head] = comparison;
      const status =
        base === head
          ? 'identical'
          : (await isAncestor(target, base, head))
            ? 'ahead'
            : (await isAncestor(target, head, base))
              ? 'behind'
              : 'diverged';
      return [200, { status }];
    }
    const reviews = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (method === 'GET' && reviews) {
      authenticateInstallation(token, target, 'pull_requests', 'read');
      const pull = pullOf(target, Number(reviews[1]));
      return [
        200,
        (pull.reviews ?? []).map((review, index) => ({
          id: index + 1,
          user: { login: review.user },
          state: 'COMMENTED',
          commit_id: review.commit,
        })),
      ];
    }
    const comment = /^\/issues\/comments\/(\d+)$/.exec(rest);
    if (method === 'PATCH' && comment) {
      const existing = target.comments[Number(comment[1]) - 1];
      if (!existing) throw new Reply(404, 'Not Found');
      authenticateInstallation(token, target, 'pull_requests', 'write');
      if (existing.user !== BOT_LOGIN)
        throw new Reply(403, 'Resource not accessible by integration');
      existing.body = String(json(body).body);
      return [200, { id: Number(comment[1]), body: existing.body }];
    }
    const permission = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
    if (method === 'GET' && permission) {
      authenticateInstallation(token, target, 'metadata', 'read');
      const role = target.roles.get(decodeURIComponent(permission[1]));
      if (!role) throw new Reply(404, 'Not Found');
      return [200, { permission: role === 'maintain' ? 'write' : role, role_name: role }];
    }
    const issue = /^\/issues(?:\/(\d+)(\/comments)?)?$/.exec(rest);
    // A pull request's conversation is its issue; pull request access may read and comment on it.
    if (issue?.[1] && method === 'GET' && target.pulls.has(Number(issue[1]))) {
      authenticateInstallation(token, target, 'pull_requests', 'read');
      const pull = pullOf(target, Number(issue[1]));
      if (!issue[2])
        return [
          200,
          {
            number: pull.number,
            state: pull.state,
            closed_by: pull.closedBy ? { login: pull.closedBy } : null,
            pull_request: { url: `${ISSUE_URL}/${target.fullName}/pull/${pull.number}` },
          },
        ];
      // One page of the conversation, as GitHub serves it (30 per page by default).
      const size = Number(query.get('per_page') ?? 30);
      const page = Number(query.get('page') ?? 1);
      return [
        200,
        target.comments
          .flatMap((entry, index) =>
            entry.issue === pull.number
              ? [
                  {
                    id: index + 1,
                    body: entry.body,
                    user: { login: entry.user, type: entry.user === BOT_LOGIN ? 'Bot' : 'User' },
                  },
                ]
              : [],
          )
          .slice((page - 1) * size, page * size),
      ];
    }
    if (issue?.[2] && method === 'POST' && target.pulls.has(Number(issue[1]))) {
      authenticateInstallation(token, target, 'pull_requests', 'write');
      target.comments.push({
        issue: Number(issue[1]),
        body: String(json(body).body),
        user: BOT_LOGIN,
      });
      return [201, { id: target.comments.length }];
    }
    if (issue && (method === 'POST' || method === 'PATCH')) {
      authenticateInstallation(token, target, 'issues', 'write');
      const request = json(body);
      if (method === 'POST' && !issue[1]) {
        const number = target.next++;
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
      const interception = interceptions.findIndex(
        (entry) => entry.method === method && entry.path === url.pathname,
      );
      if (interception >= 0) await interceptions.splice(interception, 1)[0].action();
      if (!url.pathname.startsWith('/git/') && body.length) parsed = json(body);
      if (url.pathname.startsWith('/git/')) status = await serveGit(request, response, url, body);
      else {
        const [code, payload] = await api(
          method,
          url.pathname,
          body,
          request.headers.authorization,
          url.searchParams,
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
          pulls: new Map(),
          comments: [],
          next: 1,
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

    // Pull requests and their comments, as GitHub holds them now.
    pulls: (fullName: string) => [...repositories.get(fullName.toLowerCase())!.pulls.values()],
    comments: (fullName: string) => repositories.get(fullName.toLowerCase())!.comments,
    // The bare remote, for cloning what GitHub serves.
    remote: (fullName: string) => repositories.get(fullName.toLowerCase())!.bare,
    branch: (fullName: string, name: string) =>
      branchTip(repositories.get(fullName.toLowerCase())!, name),

    // A person merges a pull request into its base: a merge commit, or one squashed commit.
    async merge(fullName: string, number: number, method: 'merge' | 'squash' = 'merge') {
      const target = repositories.get(fullName.toLowerCase())!;
      const pull = pullOf(target, number);
      const base = await revision(target, pull.base);
      const head = await revision(target, pull.head);
      const { stdout } = await git(target, ['merge-tree', '--write-tree', base, head]);
      const merged = await writeCommit(target, {
        message:
          method === 'squash' ? `${pull.title} (#${number})` : `Merge pull request #${number}`,
        tree: stdout.trim().split('\n')[0],
        parents: method === 'squash' ? [base] : [base, head],
        author: CUSTOMER,
      });
      await git(target, ['update-ref', `refs/heads/${pull.base}`, merged.sha]);
      Object.assign(pull, { state: 'closed', merged: true, headSha: head, closedBy: PERSON_LOGIN });
      return merged.sha;
    },
    // A person closes a pull request without merging it, or reopens it.
    closePull(fullName: string, number: number) {
      Object.assign(pullOf(repositories.get(fullName.toLowerCase())!, number), {
        state: 'closed',
        closedBy: PERSON_LOGIN,
      });
    },
    // GitHub keeps reporting `sha` as the pull request's head, as it may just after a push.
    lagHead(fullName: string, number: number, sha: string | undefined) {
      pullOf(repositories.get(fullName.toLowerCase())!, number).reportedHead = sha;
    },
    reopenPull(fullName: string, number: number) {
      pullOf(repositories.get(fullName.toLowerCase())!, number).state = 'open';
    },
    // A person reviews the pull request's current head.
    review(fullName: string, number: number) {
      const pull = pullOf(repositories.get(fullName.toLowerCase())!, number);
      pull.reviews = [...(pull.reviews ?? []), { user: PERSON_LOGIN, commit: pull.headSha }];
    },
    // A person opens a pull request from an existing branch.
    async openPull(fullName: string, head: string, base: string) {
      const target = repositories.get(fullName.toLowerCase())!;
      const pull: FakePull = {
        number: target.next++,
        title: 'A person opened this',
        body: '',
        head,
        base,
        baseSha: await revision(target, base),
        headSha: await revision(target, head),
        draft: false,
        state: 'open',
        merged: false,
        user: PERSON_LOGIN,
      };
      target.pulls.set(pull.number, pull);
      return pull.number;
    },
    beforeNext(method: string, path: string, action: () => Promise<void>) {
      interceptions.push({ method, path, action });
    },
    // A person pushes the source's HEAD to a branch, as a customer adding commits to a draft does.
    async pushBranch(fullName: string, branch: string, source: string) {
      const target = repositories.get(fullName.toLowerCase())!;
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
          `HEAD:refs/heads/${branch}`,
        ],
        { env: FIXTURE_GIT },
      );
      await moveBranch(target, branch, await revision(target, branch));
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
