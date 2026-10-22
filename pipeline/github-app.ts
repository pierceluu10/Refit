import { createPrivateKey, sign } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { requestGitHub } from './github.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const JWT_CLOCK_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 9 * 60;
const MILLISECONDS_PER_SECOND = 1000;
const APP_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface GitHubAppConfiguration {
  appId: string;
  privateKeyFile: string;
}

export function githubAppConfiguration(environment: NodeJS.ProcessEnv): GitHubAppConfiguration {
  const appId = environment.GITHUB_APP_ID?.trim();
  const privateKeyFile = environment.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (
    !appId ||
    !/^[1-9]\d*$/.test(appId) ||
    !Number.isSafeInteger(Number(appId)) ||
    !privateKeyFile ||
    privateKeyFile.includes('\0')
  )
    throw new PipelineInputError(
      '--github-app requires a numeric GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE.',
    );
  return { appId, privateKeyFile };
}

async function installationAccess(
  configuration: GitHubAppConfiguration,
  repository: string,
  permissions: { contents: 'read' | 'write'; pull_requests?: 'write'; issues?: 'write' },
) {
  if ((await stat(configuration.privateKeyFile)).size > MAX_PRIVATE_KEY_BYTES)
    throw new PipelineInputError('GitHub App private key exceeds 64 KiB.');
  const content = await readFile(configuration.privateKeyFile);
  if (content.byteLength > MAX_PRIVATE_KEY_BYTES)
    throw new PipelineInputError('GitHub App private key exceeds 64 KiB.');
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(content);
  } catch (cause) {
    throw new PipelineInputError('GitHub App private key must be a valid RSA PEM file.', { cause });
  }
  if (key.asymmetricKeyType !== 'rsa')
    throw new PipelineInputError('GitHub App private key must use RSA.');
  const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - JWT_CLOCK_SKEW_SECONDS,
    exp: now + JWT_LIFETIME_SECONDS,
    iss: configuration.appId,
  })}`;
  const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  const app = await requestGitHub(jwt, 'GET', '/app');
  if (
    !isObject(app) ||
    app.id !== Number(configuration.appId) ||
    typeof app.slug !== 'string' ||
    !APP_SLUG.test(app.slug) ||
    typeof app.name !== 'string' ||
    !app.name.trim()
  )
    throw new PipelineInputError('GitHub App identity does not match the configured app ID.');
  const installation = await requestGitHub(jwt, 'GET', `/repos/${repository}/installation`);
  const [owner, name] = repository.split('/');
  if (
    !isObject(installation) ||
    !Number.isSafeInteger(installation.id) ||
    Number(installation.id) <= 0 ||
    installation.app_id !== app.id ||
    installation.suspended_at !== null ||
    !isObject(installation.account) ||
    typeof installation.account.login !== 'string' ||
    installation.account.login.toLowerCase() !== owner.toLowerCase()
  )
    throw new PipelineInputError(
      'GitHub App installation does not match the target repository owner or is suspended.',
    );
  const access = await requestGitHub(
    jwt,
    'POST',
    `/app/installations/${installation.id}/access_tokens`,
    {
      repositories: [name],
      permissions,
    },
  );
  const granted = isObject(access) && isObject(access.permissions) ? access.permissions : undefined;
  if (
    !isObject(access) ||
    typeof access.token !== 'string' ||
    !access.token.trim() ||
    typeof access.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(access.expires_at)) ||
    Date.parse(access.expires_at) <= Date.now() ||
    !granted ||
    !Object.entries(permissions).every(([name, value]) => granted[name] === value) ||
    Object.entries(granted).some(
      ([name, value]) => name !== 'metadata' && !(name in permissions) && value !== 'none',
    ) ||
    !Array.isArray(access.repositories) ||
    access.repositories.length !== 1 ||
    !isObject(access.repositories[0]) ||
    typeof access.repositories[0].full_name !== 'string' ||
    access.repositories[0].full_name.toLowerCase() !== repository.toLowerCase()
  )
    throw new PipelineInputError(
      'GitHub App token must be unexpired and scoped to the target repository with exactly the requested permissions.',
    );
  return { token: access.token, app, installationId: installation.id as number };
}

export async function authenticateGitHubRead(
  configuration: GitHubAppConfiguration,
  repository: string,
) {
  const access = await installationAccess(configuration, repository, { contents: 'read' });
  return {
    token: access.token,
    appId: access.app.id as number,
    installationId: access.installationId,
  };
}

// Reads repository files and comments on pull requests; it cannot push or open pull requests.
export async function authenticateGitHubComment(
  configuration: GitHubAppConfiguration,
  repository: string,
) {
  const access = await installationAccess(configuration, repository, {
    contents: 'read',
    pull_requests: 'write',
  });
  return { token: access.token };
}

// Reads repository files and opens or updates issues; it cannot push, comment on pull requests or
// open pull requests.
export async function authenticateGitHubIssues(
  configuration: GitHubAppConfiguration,
  repository: string,
) {
  const access = await installationAccess(configuration, repository, {
    contents: 'read',
    issues: 'write',
  });
  return { token: access.token, login: `${access.app.slug}[bot]` };
}

export async function authenticateGitHubApp(
  configuration: GitHubAppConfiguration,
  repository: string,
) {
  const { token, app } = await installationAccess(configuration, repository, {
    contents: 'write',
    pull_requests: 'write',
  });
  const login = `${app.slug}[bot]`;
  const bot = await requestGitHub(token, 'GET', `/users/${encodeURIComponent(login)}`);
  if (
    !isObject(bot) ||
    bot.login !== login ||
    bot.type !== 'Bot' ||
    !Number.isSafeInteger(bot.id) ||
    Number(bot.id) <= 0
  )
    throw new PipelineInputError('GitHub did not return the expected App bot identity.');
  return {
    token,
    author: { name: app.name, email: `${bot.id}+${login}@users.noreply.github.com` },
    publisher: { kind: 'github-app' as const, appId: app.id, name: app.name, login },
  };
}
