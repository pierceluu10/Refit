import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authenticateGitHubIssues, authenticateGitHubRead } from './github-app.ts';
import { withGitHubCheckout } from './github-checkout.ts';
import { GitHubRequestError, requestGitHub } from './github.ts';
import { confirmRepositoryAccess } from './service-worker.ts';
import { startFakeGitHub, type FakeGitHub } from './fixtures/fake-github.ts';

vi.mock('node:child_process', async (original) =>
  (await import('./fixtures/fake-github-git.ts')).throughFakeGitHub(await original()),
);

const execute = promisify(execFile);
const APP_ID = 321;
const INSTALLATION = 654;
const REPOSITORY = 'example/application';
const isolated = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
let github: FakeGitHub;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'refit-fake-github-test-'));
  github = await startFakeGitHub({ appId: APP_ID, webhookSecret: 'unused-webhook-secret' });
  vi.stubGlobal('fetch', github.fetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await github.close();
  await rm(root, { recursive: true, force: true });
});

async function source(files: Record<string, string>) {
  const directory = join(root, `source-${Object.keys(files).join('-').replace(/\W/g, '')}`);
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content);
  const git = (args: string[]) => execute('git', ['-C', directory, ...args], { env: isolated });
  await git(['init', '--quiet', '--initial-branch=main']);
  await git(['add', '.']);
  await git([
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '--quiet',
    '-m',
    'test: fixture',
  ]);
  return directory;
}

it('issues App tokens scoped to one installed repository and serves its checkout over HTTP', async () => {
  const head = await github.publish(REPOSITORY, await source({ 'README.md': 'served\n' }), {
    id: 789,
  });
  await github.publish('example/other', await source({ 'other.txt': 'other\n' }));
  github.installations.set(INSTALLATION, {
    id: INSTALLATION,
    login: 'example',
    repositories: [REPOSITORY, 'example/other'],
    suspended: false,
  });

  // Refit's own access check and managed checkout, unchanged, against the fake.
  expect(await confirmRepositoryAccess(github.app, REPOSITORY)).toMatchObject({
    installationId: INSTALLATION,
    id: 789,
    defaultBranch: 'main',
  });
  const target = { repository: REPOSITORY, base: 'main', app: github.app };
  const state = join(root, 'state');
  for (let run = 0; run < 2; run++)
    expect(
      await withGitHubCheckout({ directory: state, target }, async (checkout) => ({
        revision: checkout.revision,
        readme: await readFile(join(checkout.directory, 'README.md'), 'utf8'),
      })),
    ).toEqual({ revision: head, readme: 'served\n' });
  expect(github.fetches).toEqual([{ repository: REPOSITORY, installation: INSTALLATION }]);

  // A token reads only the repository it was minted for, and a read token cannot open issues.
  const { token } = await authenticateGitHubRead(github.app, REPOSITORY);
  await expect(requestGitHub(token, 'GET', '/repos/example/other')).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    requestGitHub(token, 'POST', `/repos/${REPOSITORY}/issues`, { title: 'x', body: 'y' }),
  ).rejects.toMatchObject({ status: 403 });
  const issues = await authenticateGitHubIssues(github.app, REPOSITORY);
  expect(
    await requestGitHub(issues.token, 'POST', `/repos/${REPOSITORY}/issues`, {
      title: 'Approve',
      body: 'Review',
    }),
  ).toMatchObject({ number: 1 });
  // One token each for the access check, the two checkouts, the read and the issues call.
  expect(github.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    ...Array(5).fill(`POST /app/installations/${INSTALLATION}/access_tokens`),
    `POST /repos/${REPOSITORY}/issues`,
  ]);
  expect(github.writes[0].body).toEqual({
    repositories: ['application'],
    permissions: { contents: 'read' },
  });

  // Removing the repository from the installation ends access for tokens already issued.
  github.installations.get(INSTALLATION)!.repositories = ['example/other'];
  await expect(requestGitHub(token, 'GET', `/repos/${REPOSITORY}`)).rejects.toBeInstanceOf(
    GitHubRequestError,
  );
  await expect(confirmRepositoryAccess(github.app, REPOSITORY)).rejects.toMatchObject({
    status: 404,
  });
});

it('refuses another App key, Git fetches without a token and pushes', async () => {
  await github.publish(REPOSITORY, await source({ 'README.md': 'served\n' }));
  github.installations.set(INSTALLATION, {
    id: INSTALLATION,
    login: 'example',
    repositories: [REPOSITORY],
    suspended: false,
  });
  const other = join(root, 'other.pem');
  await writeFile(
    other,
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    }),
  );
  await expect(
    authenticateGitHubRead({ appId: String(APP_ID), privateKeyFile: other }, REPOSITORY),
  ).rejects.toMatchObject({ status: 401 });

  const remote = `${github.url}/git/${REPOSITORY}.git`;
  const git = (args: string[]) =>
    execute('git', ['-c', 'protocol.http.allow=always', ...args], { env: isolated });
  await expect(git(['ls-remote', remote])).rejects.toThrow(/could not read Username/);
  const { token } = await authenticateGitHubRead(github.app, REPOSITORY);
  const header = `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  expect((await git(['-c', header, 'ls-remote', remote])).stdout).toMatch(/refs\/heads\/main/);
  const clone = join(root, 'clone');
  await git(['-c', header, 'clone', '--quiet', remote, clone]);
  await expect(
    git(['-C', clone, '-c', header, 'push', '--quiet', remote, 'HEAD:refs/heads/other']),
  ).rejects.toThrow(/403/);
  expect(github.requests.filter(({ status }) => status >= 500)).toEqual([]);
});
