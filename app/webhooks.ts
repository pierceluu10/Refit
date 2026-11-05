import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConsentStore } from './consent.ts';
import type { Evidence, PullEvent, PushEvent as EvidencePushEvent } from './evidence.ts';
import { BOT, isPersonCommit } from './github.ts';
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
  evidence: Pick<Evidence, 'closed' | 'edited' | 'revertMerged' | 'pushed'>;
  consent: Pick<ConsentStore, 'recordInstall' | 'forget'>;
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
type PushEvent = EvidencePushEvent & { after: string };
type PullRequestEvent = PullEvent & { action: string; before?: string; after?: string };

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
      await deps.consent.recordInstall(installation.id);
      // The payload's repository list can be truncated, so ask the API for all of them.
      const repos = await deps.listRepos(await deps.tokens.token(installation.id));
      return understand(installation.id, repos, 'install');
    }
    if (action === 'deleted') {
      await deps.consent.forget(installation.id);
      return forget(installation.id, repositories);
    }
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

// A person's own commit, pushed by a non-bot, which also leaves out other bots' pushes.
async function pushedByPerson(event: PullRequestEvent, deps: WebhookDeps): Promise<boolean> {
  if (event.sender.type === BOT || !event.before || !event.after) return false;
  const token = await deps.tokens.token(event.installation.id);
  const commits = await deps.compareCommits(
    token,
    event.repository.full_name,
    event.before,
    event.after,
  );
  return commits.some(isPersonCommit);
}

// We only ever push to the repo itself. GitHub names a fork's head repo, or null once it's deleted.
const fromFork = ({ pull_request: { head }, repository }: PullEvent) =>
  head.repo !== undefined && head.repo?.full_name !== repository.full_name;

// The verdict goes first, and its failure must not cost the evidence: they go to separate stores.
async function verdictThenEvidence(verdict: () => Promise<void>, evidence: () => Promise<void>) {
  try {
    await verdict();
  } finally {
    await evidence();
  }
}

async function verdictFor(event: PullRequestEvent, deps: WebhookDeps): Promise<void> {
  const pr = event.pull_request;
  if (!pr.head.ref.startsWith(BRANCH_PREFIX) || fromFork(event)) {
    if (event.action === 'closed') await deps.evidence.revertMerged(event);
    return;
  }
  // The verdict goes first: memory's recordVerdict overwrites `merged` and `closed`, and the evidence
  // sent after it puts the diff and the comment back.
  if (event.action === 'closed') {
    await verdictThenEvidence(
      () => deps.recordVerdict(pr.html_url, pr.merged ? 'merged' : 'closed'),
      () => deps.evidence.closed(event),
    );
  }
  if (event.action === 'synchronize' && (await pushedByPerson(event, deps))) {
    await verdictThenEvidence(
      () => deps.recordVerdict(pr.html_url, 'edited'),
      () => deps.evidence.edited(event),
    );
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
  if (event === 'push') await deps.evidence.pushed(payload as PushEvent);
  return jobs;
}
