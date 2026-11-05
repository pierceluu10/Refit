import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ComparedCommit } from './github.ts';
import { BRANCH_PREFIX } from './types.ts';
import type { AppJob, ForgetJob, InstallationTokens, JobQueue, RecordVerdict } from './types.ts';

const SIGNATURE_PREFIX = 'sha256=';

export type WebhookDeps = {
  queue: JobQueue;
  forgetRepo: (job: ForgetJob) => Promise<void>;
  recordVerdict: RecordVerdict;
  tokens: InstallationTokens;
  listRepos: (token: string) => Promise<string[]>;
  compareCommits: (
    token: string,
    repo: string,
    base: string,
    head: string,
  ) => Promise<ComparedCommit[]>;
};

type Repository = { full_name: string };

// Only the fields Aptitude reads; GitHub sends many more.
type InstallationEvent = {
  action: string;
  installation: { id: number };
  repositories?: Repository[];
};
type InstallationRepositoriesEvent = {
  action: string;
  installation: { id: number };
  repositories_added: Repository[];
  repositories_removed: Repository[];
};
type PushEvent = {
  ref: string;
  after: string;
  deleted: boolean;
  installation: { id: number };
  repository: Repository & { default_branch: string };
};
type PullRequestEvent = {
  action: string;
  pull_request: { html_url: string; merged: boolean; head: { ref: string } };
  before?: string;
  after?: string;
  sender: { type: string };
  installation: { id: number };
  repository: Repository;
};

const BOT = 'Bot';

export function verifySignature(
  secret: string,
  rawBody: string | Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith(SIGNATURE_PREFIX)) return false;
  const received = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

const understand = (
  installationId: number,
  repos: string[],
  reason: 'install' | 'repos-added',
): AppJob[] => repos.map((repo) => ({ kind: 'understand', installationId, repo, reason }));

const forget = (installationId: number, repos: Repository[]): AppJob[] =>
  repos.map((repo) => ({ kind: 'forget', installationId, repo: repo.full_name }));

async function jobsFor(event: string, payload: unknown, deps: WebhookDeps): Promise<AppJob[]> {
  if (event === 'installation') {
    const { action, installation, repositories = [] } = payload as InstallationEvent;
    if (action === 'created') {
      // The payload's repository list can be truncated, so ask the API for all of them.
      const repos = await deps.listRepos(await deps.tokens.token(installation.id));
      return understand(installation.id, repos, 'install');
    }
    if (action === 'deleted') return forget(installation.id, repositories);
  }
  if (event === 'installation_repositories') {
    const body = payload as InstallationRepositoriesEvent;
    const id = body.installation.id;
    if (body.action === 'added') {
      return understand(
        id,
        body.repositories_added.map((repo) => repo.full_name),
        'repos-added',
      );
    }
    if (body.action === 'removed') return forget(id, body.repositories_removed);
  }
  if (event === 'push') {
    const push = payload as PushEvent;
    // The API usage map describes the default branch, so other branches don't change it.
    if (push.deleted || push.ref !== `refs/heads/${push.repository.default_branch}`) return [];
    return [
      {
        kind: 'understand',
        installationId: push.installation.id,
        repo: push.repository.full_name,
        reason: 'push',
        sha: push.after,
      },
    ];
  }
  return [];
}

// memory/README.md: a person's own commit is a non-merge commit, not authored by a bot, pushed by a
// non-bot. That leaves out Aptitude's pushes, other bots and the Update branch button.
async function pushedByPerson(event: PullRequestEvent, deps: WebhookDeps): Promise<boolean> {
  if (event.sender.type === BOT || !event.before || !event.after) return false;
  const token = await deps.tokens.token(event.installation.id);
  const commits = await deps.compareCommits(
    token,
    event.repository.full_name,
    event.before,
    event.after,
  );
  return commits.some((commit) => commit.parents.length < 2 && commit.author?.type !== BOT);
}

async function verdictFor(event: PullRequestEvent, deps: WebhookDeps): Promise<void> {
  const pr = event.pull_request;
  if (!pr.head.ref.startsWith(BRANCH_PREFIX)) return;
  if (event.action === 'closed')
    await deps.recordVerdict(pr.html_url, pr.merged ? 'merged' : 'closed');
  if (event.action === 'synchronize' && (await pushedByPerson(event, deps))) {
    await deps.recordVerdict(pr.html_url, 'edited');
  }
}

export async function handleWebhook(
  event: string,
  payload: unknown,
  deps: WebhookDeps,
): Promise<AppJob[]> {
  if (event === 'pull_request') {
    await verdictFor(payload as PullRequestEvent, deps);
    return [];
  }
  const jobs = await jobsFor(event, payload, deps);
  for (const job of jobs) {
    await deps.queue.enqueue(job);
    if (job.kind === 'forget') await deps.forgetRepo(job);
  }
  return jobs;
}
