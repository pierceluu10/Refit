import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handleWebhook, verifySignature } from './webhooks.ts';
import type { WebhookDeps } from './webhooks.ts';
import type { ComparedCommit } from './github.ts';
import type { AppJob, HumanVerdict } from './types.ts';

// GitHub's published test vector: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
const VECTOR_SECRET = "It's a Secret to Everybody";
const VECTOR_BODY = 'Hello, World!';
const VECTOR_SIGNATURE = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
const INSTALLATION_ID = 70000001;
const INSTALL_TOKEN = 'ghs_test_installation_token';
const API_REPOS = [
  'refit-example-org/billing-api',
  'refit-example-org/storefront',
  'refit-example-org/ops-scripts',
];

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown;

const PERSON = { type: 'User' };
const BOT = { type: 'Bot' };
const commit = (author: { type: string } | null, parents = 1): ComparedCommit => ({
  author,
  parents: Array.from({ length: parents }, (_, index) => ({ sha: `parent-${index}` })),
});

function fakeDeps(compared: ComparedCommit[] = []) {
  const jobs: AppJob[] = [];
  const comparisons: string[][] = [];
  const verdicts: [string, HumanVerdict][] = [];
  const tokenRequests: number[] = [];
  const listedWith: string[] = [];
  const deps: WebhookDeps = {
    queue: { enqueue: async (job) => void jobs.push(job) },
    recordVerdict: async (pr, verdict) => void verdicts.push([pr, verdict]),
    tokens: {
      token: async (id) => {
        tokenRequests.push(id);
        return INSTALL_TOKEN;
      },
    },
    listRepos: async (token) => {
      listedWith.push(token);
      return API_REPOS;
    },
    compareCommits: async (token, repo, base, head) => {
      comparisons.push([token, repo, base, head]);
      return compared;
    },
  };
  return { deps, jobs, verdicts, tokenRequests, listedWith, comparisons };
}

describe('verifySignature', () => {
  it("accepts GitHub's test vector", () => {
    expect(verifySignature(VECTOR_SECRET, VECTOR_BODY, VECTOR_SIGNATURE)).toBe(true);
    expect(verifySignature(VECTOR_SECRET, Buffer.from(VECTOR_BODY), VECTOR_SIGNATURE)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifySignature('wrong secret', VECTOR_BODY, VECTOR_SIGNATURE)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifySignature(VECTOR_SECRET, 'Hello, World?', VECTOR_SIGNATURE)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(VECTOR_SECRET, VECTOR_BODY, undefined)).toBe(false);
    expect(verifySignature(VECTOR_SECRET, VECTOR_BODY, '')).toBe(false);
  });

  it('rejects a wrong prefix', () => {
    const sha1 = VECTOR_SIGNATURE.replace('sha256=', 'sha1=');
    expect(verifySignature(VECTOR_SECRET, VECTOR_BODY, sha1)).toBe(false);
  });

  it('rejects a wrong length without throwing', () => {
    expect(verifySignature(VECTOR_SECRET, VECTOR_BODY, VECTOR_SIGNATURE.slice(0, -2))).toBe(false);
    expect(verifySignature(VECTOR_SECRET, VECTOR_BODY, `${VECTOR_SIGNATURE}00`)).toBe(false);
    expect(verifySignature(VECTOR_SECRET, VECTOR_BODY, 'sha256=not-hex')).toBe(false);
  });
});

describe('handleWebhook', () => {
  it('installation.created queues every repo from the API, not the partial payload list', async () => {
    const fake = fakeDeps();
    const jobs = await handleWebhook('installation', fixture('installation.created'), fake.deps);
    const expected = API_REPOS.map((repo) => ({
      kind: 'understand',
      installationId: INSTALLATION_ID,
      repo,
      reason: 'install',
    }));
    expect(fake.tokenRequests).toEqual([INSTALLATION_ID]);
    expect(fake.listedWith).toEqual([INSTALL_TOKEN]);
    expect(fake.jobs).toEqual(expected);
    expect(jobs).toEqual(expected);
  });

  it('installation.deleted forgets the payload repos without calling the API', async () => {
    const fake = fakeDeps();
    await handleWebhook('installation', fixture('installation.deleted'), fake.deps);
    expect(fake.tokenRequests).toEqual([]);
    expect(fake.jobs).toEqual(
      ['billing-api', 'storefront', 'ops-scripts'].map((name) => ({
        kind: 'forget',
        installationId: INSTALLATION_ID,
        repo: `refit-example-org/${name}`,
      })),
    );
  });

  it('installation_repositories.added queues the added repos', async () => {
    const fake = fakeDeps();
    await handleWebhook(
      'installation_repositories',
      fixture('installation_repositories.added'),
      fake.deps,
    );
    expect(fake.jobs).toEqual(
      ['checkout-service', 'webhooks-relay'].map((name) => ({
        kind: 'understand',
        installationId: INSTALLATION_ID,
        repo: `refit-example-org/${name}`,
        reason: 'repos-added',
      })),
    );
  });

  it('installation_repositories.removed forgets the removed repos', async () => {
    const fake = fakeDeps();
    await handleWebhook(
      'installation_repositories',
      fixture('installation_repositories.removed'),
      fake.deps,
    );
    expect(fake.jobs).toEqual([
      { kind: 'forget', installationId: INSTALLATION_ID, repo: 'refit-example-org/storefront' },
    ]);
  });

  it('push to the default branch queues a re-read at the pushed sha', async () => {
    const fake = fakeDeps();
    await handleWebhook('push', fixture('push.default-branch'), fake.deps);
    expect(fake.jobs).toEqual([
      {
        kind: 'understand',
        installationId: INSTALLATION_ID,
        repo: 'refit-example-org/billing-api',
        reason: 'push',
        sha: 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432',
      },
    ]);
  });

  it('push to another branch queues nothing', async () => {
    const fake = fakeDeps();
    expect(await handleWebhook('push', fixture('push.other-branch'), fake.deps)).toEqual([]);
    expect(fake.jobs).toEqual([]);
  });

  it('deleting the default branch queues nothing', async () => {
    const fake = fakeDeps();
    const deletion = {
      ...(fixture('push.default-branch') as object),
      deleted: true,
      after: '0000000000000000000000000000000000000000',
    };
    await handleWebhook('push', deletion, fake.deps);
    expect(fake.jobs).toEqual([]);
  });

  it('a merged Refit PR records merged', async () => {
    const fake = fakeDeps();
    await handleWebhook('pull_request', fixture('pull_request.closed.merged'), fake.deps);
    expect(fake.verdicts).toEqual([
      ['https://github.com/refit-example-org/billing-api/pull/41', 'merged'],
    ]);
    expect(fake.jobs).toEqual([]);
  });

  it('a closed unmerged Refit PR records closed', async () => {
    const fake = fakeDeps();
    await handleWebhook('pull_request', fixture('pull_request.closed.unmerged'), fake.deps);
    expect(fake.verdicts).toEqual([
      ['https://github.com/refit-example-org/billing-api/pull/42', 'closed'],
    ]);
  });

  it("a human branch's PR records nothing", async () => {
    const fake = fakeDeps();
    await handleWebhook('pull_request', fixture('pull_request.closed.human-branch'), fake.deps);
    expect(fake.verdicts).toEqual([]);
  });

  it('ping and unknown events are no-ops', async () => {
    const fake = fakeDeps();
    expect(await handleWebhook('ping', { zen: 'Keep it logically awesome.' }, fake.deps)).toEqual(
      [],
    );
    expect(await handleWebhook('issues', { action: 'opened' }, fake.deps)).toEqual([]);
    expect(fake.jobs).toEqual([]);
    expect(fake.verdicts).toEqual([]);
  });
});

describe('synchronize verdicts', () => {
  const PR_URL = 'https://github.com/refit-example-org/billing-api/pull/41';
  const synchronize = (sender = PERSON) => ({
    ...(fixture('pull_request.closed.merged') as object),
    action: 'synchronize',
    before: 'before-sha',
    after: 'after-sha',
    sender,
  });

  it("records edited when a person pushes their own commit, comparing the push's range", async () => {
    const fake = fakeDeps([commit(BOT), commit(PERSON)]);
    await handleWebhook('pull_request', synchronize(), fake.deps);
    expect(fake.comparisons).toEqual([
      [INSTALL_TOKEN, 'refit-example-org/billing-api', 'before-sha', 'after-sha'],
    ]);
    expect(fake.verdicts).toEqual([[PR_URL, 'edited']]);
  });

  it('counts a commit whose author has no GitHub account as a person', async () => {
    const fake = fakeDeps([commit(null)]);
    await handleWebhook('pull_request', synchronize(), fake.deps);
    expect(fake.verdicts).toEqual([[PR_URL, 'edited']]);
  });

  it('records nothing for a bot push, without asking GitHub', async () => {
    const fake = fakeDeps([commit(PERSON)]);
    await handleWebhook('pull_request', synchronize(BOT), fake.deps);
    expect(fake.comparisons).toEqual([]);
    expect(fake.verdicts).toEqual([]);
  });

  it('records nothing for Update branch: a merge commit, or rebased Refit commits', async () => {
    for (const compared of [[commit(PERSON, 2)], [commit(BOT), commit(BOT)]]) {
      const fake = fakeDeps(compared);
      await handleWebhook('pull_request', synchronize(), fake.deps);
      expect(fake.verdicts).toEqual([]);
    }
  });

  it("records nothing for a push to a human branch's PR", async () => {
    const fake = fakeDeps([commit(PERSON)]);
    const human = {
      ...(fixture('pull_request.closed.human-branch') as object),
      action: 'synchronize',
    };
    await handleWebhook(
      'pull_request',
      { ...human, before: 'a', after: 'b', sender: PERSON },
      fake.deps,
    );
    expect(fake.verdicts).toEqual([]);
  });
});
