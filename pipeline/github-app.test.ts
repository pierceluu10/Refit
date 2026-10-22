import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  authenticateGitHubApp,
  authenticateGitHubRead,
  githubAppConfiguration,
} from './github-app.ts';

const APP_ID = 12345;
const INSTALLATION_ID = 23456;
const BOT_ID = 34567;
const RSA_KEY_BITS = 2048;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const JWT_VALIDITY_SECONDS = 600;
const TOKEN_VALIDITY_MS = 60 * 60 * 1000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: RSA_KEY_BITS });
const roots: string[] = [];

async function configuration() {
  const root = await mkdtemp(join(tmpdir(), 'refit-app-auth-'));
  roots.push(root);
  const privateKeyFile = join(root, 'key.pem');
  await writeFile(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  return { appId: String(APP_ID), privateKeyFile };
}

function github() {
  const responses = {
    app: { id: APP_ID, name: 'Refit Agent', slug: 'refit-agent' },
    installation: {
      id: INSTALLATION_ID,
      app_id: APP_ID,
      suspended_at: null as string | null,
      account: { login: 'example' },
    },
    access: {
      token: 'installation-test-token',
      expires_at: new Date(Date.now() + TOKEN_VALIDITY_MS).toISOString(),
      permissions: { contents: 'write', pull_requests: 'write' },
      repositories: [{ full_name: 'example/application' }],
    },
    bot: { id: BOT_ID, login: 'refit-agent[bot]', type: 'Bot' },
  };
  const requests: { path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname;
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const authorization = (options.headers as Record<string, string>).Authorization;
    if (path.startsWith('/users/')) expect(authorization).toBe('Bearer installation-test-token');
    else {
      const [header, payload, signature] = authorization.slice('Bearer '.length).split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
        alg: 'RS256',
        typ: 'JWT',
      });
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      expect(claims.iss).toBe(String(APP_ID));
      expect(claims.exp - claims.iat).toBe(JWT_VALIDITY_SECONDS);
      expect(claims.iat).toBeLessThan(Math.floor(Date.now() / 1000));
      expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          publicKey,
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
    }
    requests.push({ path, body: options.body ? JSON.parse(String(options.body)) : null });
    const response =
      path === '/app'
        ? responses.app
        : path === '/repos/example/application/installation'
          ? responses.installation
          : path === `/app/installations/${INSTALLATION_ID}/access_tokens`
            ? responses.access
            : path === '/users/refit-agent%5Bbot%5D'
              ? responses.bot
              : undefined;
    if (!response) throw new Error(`Unexpected GitHub auth endpoint: ${path}`);
    return new Response(JSON.stringify(response));
  });
  vi.stubGlobal('fetch', fetch);
  return { responses, requests, fetch };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('signs a real RSA JWT, discovers the installation and requests only the target repository permissions', async () => {
  const remote = github();
  const result = await authenticateGitHubApp(await configuration(), 'example/application');
  expect(remote.requests.find((request) => request.path.endsWith('/access_tokens'))?.body).toEqual({
    repositories: ['application'],
    permissions: { contents: 'write', pull_requests: 'write' },
  });
  expect(result).toEqual({
    token: 'installation-test-token',
    author: { name: 'Refit Agent', email: `${BOT_ID}+refit-agent[bot]@users.noreply.github.com` },
    publisher: {
      kind: 'github-app',
      appId: APP_ID,
      name: 'Refit Agent',
      login: 'refit-agent[bot]',
    },
  });
  expect(JSON.stringify(result.publisher)).not.toContain('token');
});

it.each(['app', 'owner', 'suspended', 'permissions', 'expired', 'repository', 'bot'] as const)(
  'rejects mismatched or unusable app credentials: %s',
  async (scenario) => {
    const remote = github();
    if (scenario === 'app') remote.responses.app.id++;
    if (scenario === 'owner') remote.responses.installation.account.login = 'someone-else';
    if (scenario === 'suspended')
      remote.responses.installation.suspended_at = new Date().toISOString();
    if (scenario === 'permissions') remote.responses.access.permissions.contents = 'read';
    if (scenario === 'expired') remote.responses.access.expires_at = new Date(0).toISOString();
    if (scenario === 'repository')
      remote.responses.access.repositories[0].full_name = 'example/other';
    if (scenario === 'bot') remote.responses.bot.type = 'User';
    await expect(
      authenticateGitHubApp(await configuration(), 'example/application'),
    ).rejects.toThrow(/GitHub/);
    if (['app', 'owner', 'suspended'].includes(scenario))
      expect(remote.requests.some((request) => request.path.endsWith('/access_tokens'))).toBe(
        false,
      );
  },
);

it('rejects invalid or oversized private keys before making a request', async () => {
  const remote = github();
  const input = await configuration();
  await writeFile(input.privateKeyFile, 'invalid-private-key-test');
  await expect(authenticateGitHubApp(input, 'example/application')).rejects.toThrow(
    'valid RSA PEM',
  );
  await writeFile(input.privateKeyFile, 'x'.repeat(MAX_PRIVATE_KEY_BYTES + 1));
  await expect(authenticateGitHubApp(input, 'example/application')).rejects.toThrow(
    'exceeds 64 KiB',
  );
  const elliptic = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(
    input.privateKeyFile,
    elliptic.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  await expect(authenticateGitHubApp(input, 'example/application')).rejects.toThrow('must use RSA');
  expect(remote.fetch).not.toHaveBeenCalled();
});

it('does not leak server response details or JWTs on authentication errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('private-token-and-key-details', { status: 403 })),
  );
  const failure = authenticateGitHubApp(await configuration(), 'example/application');
  await expect(failure).rejects.toThrow('HTTP 403');
  await expect(failure).rejects.not.toThrow('private-token-and-key-details');
});

it('requires explicit app identifiers and a private key file without accepting an inline secret', () => {
  for (const environment of [
    {},
    { GITHUB_APP_ID: '12345' },
    { GITHUB_APP_ID: 'abc', GITHUB_APP_PRIVATE_KEY_FILE: 'key.pem' },
  ])
    expect(() => githubAppConfiguration(environment)).toThrow('GITHUB_APP_ID');
  expect(
    githubAppConfiguration({
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY_FILE: '/private/key.pem',
    }),
  ).toEqual({ appId: '12345', privateKeyFile: '/private/key.pem' });
});

it('uses a repository-scoped Contents read token for managed checkout without publisher permissions', async () => {
  const remote = github();
  remote.responses.access.permissions = {
    contents: 'read',
  } as typeof remote.responses.access.permissions;
  const result = await authenticateGitHubRead(await configuration(), 'example/application');
  expect(result).toMatchObject({
    token: 'installation-test-token',
    appId: APP_ID,
    installationId: INSTALLATION_ID,
  });
  expect(remote.requests.find((request) => request.path.endsWith('/access_tokens'))?.body).toEqual({
    repositories: ['application'],
    permissions: { contents: 'read' },
  });
  expect(remote.requests.some((request) => request.path.startsWith('/users/'))).toBe(false);
  remote.responses.access.permissions.pull_requests = 'write';
  await expect(
    authenticateGitHubRead(await configuration(), 'example/application'),
  ).rejects.toThrow(/requested permissions/);
});

it('uses a job machine installation token for reads and refuses every write without the key', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const configuration = {
    appId: String(APP_ID),
    installationToken: { installationId: INSTALLATION_ID, token: 'job-read-token' },
  };
  expect(await authenticateGitHubRead(configuration, 'example/application')).toEqual({
    token: 'job-read-token',
    appId: APP_ID,
    installationId: INSTALLATION_ID,
  });
  await expect(authenticateGitHubApp(configuration, 'example/application')).rejects.toThrow(
    'A job machine holds only a read-only installation token; this step needs the GitHub App private key.',
  );
  expect(fetch).not.toHaveBeenCalled();
});
