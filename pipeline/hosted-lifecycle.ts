import type { PoolClient } from 'pg';
import { WebhookInputError, type GitHubWebhook } from './github-webhooks.ts';

type RepositoryChange = Extract<GitHubWebhook, { kind: 'repository' }>;
type AccountChange = Extract<GitHubWebhook, { kind: 'account' }>;

// Targets to stop and repositories to enroll after a lifecycle change. The store applies both in
// the same transaction, so a change either moves everything or nothing.
export interface LifecyclePlan {
  cancel: { installationId: number; repository: string; message: string }[];
  enroll: string[];
}

interface Installation {
  owner: string;
  status: string;
}

// Moves an installed repository to a new name in the same account. Owner decision (2026-10-22):
// approvals never follow a rename, so the new name enrolls only once it is approved again.
async function rename(
  client: PoolClient,
  installationId: number,
  githubId: number,
  from: string,
  to: string,
  plan: LifecyclePlan,
) {
  // A row left by a deleted repository that used the new name cannot block the move.
  await client.query(
    `DELETE FROM refit_installation_repositories
     WHERE installation_id = $1 AND repository = $2 AND github_id <> $3`,
    [installationId, to, githubId],
  );
  await client.query(
    `UPDATE refit_installation_repositories SET repository = $3
     WHERE installation_id = $1 AND repository = $2`,
    [installationId, from, to],
  );
  plan.cancel.push({
    installationId,
    repository: from,
    message: `Repository renamed to ${to}; approve it under its new name to resume.`,
  });
  plan.enroll.push(to);
}

async function followRepository(
  client: PoolClient,
  change: RepositoryChange,
  installation: Installation | undefined,
  plan: LifecyclePlan,
) {
  const { rows } = await client.query<{ installation_id: string; repository: string }>(
    `SELECT installation_id, repository FROM refit_installation_repositories
     WHERE github_id = $1 FOR UPDATE`,
    [change.repository.id],
  );
  const name = change.repository.name;
  const here = rows.filter((row) => Number(row.installation_id) === change.installationId);
  if (change.action === 'renamed') {
    for (const row of here) {
      if (row.repository === name) continue;
      if (row.repository !== change.previous)
        throw new WebhookInputError(
          409,
          `Rename from ${change.previous} does not match the stored name ${row.repository}; redeliver earlier repository events first.`,
        );
      await rename(client, change.installationId, change.repository.id, row.repository, name, plan);
    }
    return;
  }
  if (change.action === 'transferred') {
    // GitHub sends the transfer only to the new owner's installation; every other row is stale.
    for (const row of rows) {
      if (Number(row.installation_id) === change.installationId && row.repository === name)
        continue;
      await client.query(
        'DELETE FROM refit_installation_repositories WHERE installation_id = $1 AND repository = $2',
        [row.installation_id, row.repository],
      );
      plan.cancel.push({
        installationId: Number(row.installation_id),
        repository: row.repository,
        message: `Repository transferred to ${name}; approve it under its new name to resume.`,
      });
    }
    // Only an installation this service already accepted records the arrival.
    if (installation?.owner === change.owner) {
      await client.query(
        `INSERT INTO refit_installation_repositories (installation_id, repository, github_id)
         VALUES ($1, $2, $3) ON CONFLICT (installation_id, repository) DO UPDATE SET github_id = $3`,
        [change.installationId, name, change.repository.id],
      );
      plan.enroll.push(name);
    }
    return;
  }
  for (const row of here)
    if (change.action === 'archived')
      plan.cancel.push({
        installationId: change.installationId,
        repository: row.repository,
        message: 'Repository archived; unarchive it to resume.',
      });
    else plan.enroll.push(row.repository);
}

async function followAccount(
  client: PoolClient,
  change: AccountChange,
  installation: Installation | undefined,
  allowed: boolean,
  plan: LifecyclePlan,
) {
  if (!installation || installation.owner === change.owner) return;
  if (installation.owner !== change.previousOwner)
    throw new WebhookInputError(
      409,
      `Rename of account ${change.previousOwner} does not match the stored login ${installation.owner}; redeliver earlier account events first.`,
    );
  await client.query(
    'UPDATE refit_installations SET owner = $2, allowed = $3, updated_at = now() WHERE id = $1',
    [change.installationId, change.owner, allowed],
  );
  const { rows } = await client.query<{ repository: string; github_id: string }>(
    'SELECT repository, github_id FROM refit_installation_repositories WHERE installation_id = $1',
    [change.installationId],
  );
  for (const row of rows)
    await rename(
      client,
      change.installationId,
      Number(row.github_id),
      row.repository,
      `${change.owner}/${row.repository.split('/')[1]}`,
      plan,
    );
}

// Repository events and account renames find stored repositories by GitHub ID, never by name.
// `allowed` says whether the account, by its login after the change, is on the allowlist; a
// renamed account keeps its targets only if its new login is listed.
export async function followLifecycle(
  client: PoolClient,
  change: RepositoryChange | AccountChange,
  allowed: boolean,
): Promise<LifecyclePlan> {
  const plan: LifecyclePlan = { cancel: [], enroll: [] };
  const { rows } = await client.query<Installation>(
    'SELECT owner, status FROM refit_installations WHERE id = $1 FOR UPDATE',
    [change.installationId],
  );
  if (change.kind === 'account') await followAccount(client, change, rows[0], allowed, plan);
  else await followRepository(client, change, rows[0], plan);
  if (rows[0]?.status !== 'active' || !allowed) plan.enroll = [];
  return plan;
}

// Checks a target's repository against what GitHub served before a job. githubId is null when
// GitHub answered 404: the repository was deleted or the installation lost it, and GitHub Apps
// never receive repository.deleted. A different ID means the name now belongs to a new
// repository, so its approval is dropped and the owner must approve it again.
export async function confirmRepositoryIdentity(
  client: PoolClient,
  targetId: string,
  githubId: number | null,
): Promise<LifecyclePlan> {
  const plan: LifecyclePlan = { cancel: [], enroll: [] };
  const { rows } = await client.query<{
    installation_id: string;
    repository: string;
    github_id: string | null;
  }>(
    `SELECT t.installation_id, t.repository, r.github_id FROM refit_targets t
     LEFT JOIN refit_installation_repositories r
       ON r.installation_id = t.installation_id AND r.repository = t.repository
     WHERE t.id = $1 FOR UPDATE OF t`,
    [targetId],
  );
  const target = rows[0];
  if (!target) return plan;
  const installationId = Number(target.installation_id);
  if (githubId === null) {
    plan.cancel.push({
      installationId,
      repository: target.repository,
      message: `GitHub no longer serves ${target.repository} to this installation: it was deleted or removed from the installation.`,
    });
    return plan;
  }
  if (target.github_id === null || Number(target.github_id) === githubId) return plan;
  await client.query(
    `UPDATE refit_installation_repositories SET github_id = $3
     WHERE installation_id = $1 AND repository = $2`,
    [installationId, target.repository, githubId],
  );
  await client.query('DELETE FROM refit_approvals WHERE repository = $1', [target.repository]);
  plan.cancel.push({
    installationId,
    repository: target.repository,
    message: `${target.repository} now names a different GitHub repository than the one approved; approve it again.`,
  });
  return plan;
}
