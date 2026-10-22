import { createHmac, timingSafeEqual } from 'node:crypto';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const DELIVERY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+$/;
const INSTALLATION_ACTIONS = new Set([
  'created',
  'deleted',
  'suspend',
  'unsuspend',
  'new_permissions_accepted',
]);
const REPOSITORY_ACTIONS = new Set(['added', 'removed']);
const REPOSITORY_EVENT_ACTIONS = new Set(['renamed', 'transferred', 'archived', 'unarchived']);
const LIFECYCLE_EVENTS = new Set([
  'installation',
  'installation_repositories',
  'installation_target',
  'repository',
]);
const MILLISECONDS_PER_SECOND = 1000;
const MAX_EVENT_REPOSITORIES = 10_000;

export class WebhookInputError extends PipelineInputError {
  override name = 'WebhookInputError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface WebhookRepository {
  id: number;
  name: string;
}
export type GitHubWebhook =
  | { kind: 'ping' | 'ignored' }
  | {
      kind: 'pull_request';
      installation: number;
      repository: string;
      number: number;
      base: string;
      head: string;
    }
  | {
      kind: 'installation' | 'repositories';
      installationId: number;
      owner: string;
      action: string;
      added: WebhookRepository[];
      removed: WebhookRepository[];
      // installation.updated_at in milliseconds, which orders installation status changes.
      updatedAt?: number | null;
    }
  | {
      kind: 'repository';
      installationId: number;
      owner: string;
      // The owner before a transfer; the current owner for every other action.
      previousOwner: string;
      action: string;
      repository: WebhookRepository;
      // The full name before a rename; null for every other action.
      previous: string | null;
    }
  | {
      kind: 'account';
      installationId: number;
      owner: string;
      previousOwner: string;
      action: 'renamed';
    };

export function verifyWebhook(
  body: Uint8Array,
  signature: unknown,
  delivery: unknown,
  secret: string,
) {
  if (typeof signature !== 'string' || !SIGNATURE.test(signature))
    throw new WebhookInputError(401, 'A valid SHA-256 webhook signature is required.');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice('sha256='.length), 'hex')))
    throw new WebhookInputError(401, 'Webhook signature did not match.');
  if (typeof delivery !== 'string' || !DELIVERY_ID.test(delivery))
    throw new WebhookInputError(400, 'A valid GitHub delivery GUID is required.');
  return delivery.toLowerCase();
}

// Reads a nested payload property, or undefined when any level is not an object.
function nested(value: unknown, ...keys: string[]) {
  return keys.reduce<unknown>(
    (current, key) => (isObject(current) ? current[key] : undefined),
    value,
  );
}

function positiveIdentifier(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new WebhookInputError(422, 'Webhook identifiers must be positive integers.');
  return Number(value);
}

function repositories(value: unknown, owner: string): WebhookRepository[] {
  if (!Array.isArray(value) || value.length > MAX_EVENT_REPOSITORIES)
    throw new WebhookInputError(
      422,
      'Webhook repository list is missing or exceeds the supported limit.',
    );
  const names = new Set<string>();
  return value.map((repository) => {
    if (
      !isObject(repository) ||
      typeof repository.full_name !== 'string' ||
      !REPOSITORY.test(repository.full_name) ||
      repository.full_name.split('/')[0].toLowerCase() !== owner.toLowerCase()
    )
      throw new WebhookInputError(422, 'Webhook repository owner does not match its installation.');
    const name = repository.full_name.toLowerCase();
    if (names.has(name))
      throw new WebhookInputError(422, 'Webhook contains duplicate repositories.');
    names.add(name);
    return { id: positiveIdentifier(repository.id), name };
  });
}

const PULL_REQUEST_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);
const COMMIT = /^[a-f0-9]{40}$/;

// Pull request events carry only the installation ID; the service acts on configured repositories.
function pullRequest(payload: Record<string, unknown>): GitHubWebhook {
  if (typeof payload.action !== 'string' || !PULL_REQUEST_ACTIONS.has(payload.action))
    return { kind: 'ignored' };
  const request = payload.pull_request;
  const repository = payload.repository;
  if (
    !isObject(payload.installation) ||
    !isObject(request) ||
    !isObject(repository) ||
    typeof repository.full_name !== 'string' ||
    !REPOSITORY.test(repository.full_name) ||
    !isObject(request.base) ||
    !isObject(request.head) ||
    typeof request.base.sha !== 'string' ||
    !COMMIT.test(request.base.sha) ||
    typeof request.head.sha !== 'string' ||
    !COMMIT.test(request.head.sha)
  )
    throw new WebhookInputError(422, 'Pull request webhook is incomplete.');
  return {
    kind: 'pull_request',
    installation: positiveIdentifier(payload.installation.id),
    repository: repository.full_name.toLowerCase(),
    number: positiveIdentifier(request.number),
    base: request.base.sha,
    head: request.head.sha,
  };
}

// GitHub's schema allows an ISO timestamp or Unix seconds.
function timestamp(value: unknown) {
  if (value === undefined || value === null) return null;
  const time =
    typeof value === 'string'
      ? Date.parse(value)
      : Number.isSafeInteger(value)
        ? Number(value) * MILLISECONDS_PER_SECOND
        : NaN;
  if (!Number.isFinite(time) || time <= 0)
    throw new WebhookInputError(422, 'Webhook installation timestamp is invalid.');
  return time;
}

// Repository events carry only the installation ID; the repository ID identifies what moved.
function repositoryEvent(payload: Record<string, unknown>, action: string): GitHubWebhook {
  if (!REPOSITORY_EVENT_ACTIONS.has(action)) return { kind: 'ignored' };
  const repository = payload.repository;
  if (
    !isObject(repository) ||
    typeof repository.full_name !== 'string' ||
    !REPOSITORY.test(repository.full_name)
  )
    throw new WebhookInputError(422, 'Repository webhook is incomplete.');
  const name = repository.full_name.toLowerCase();
  const owner = name.split('/')[0];
  let previousOwner = owner;
  let previous: string | null = null;
  if (action === 'renamed') {
    const from = nested(payload, 'changes', 'repository', 'name', 'from');
    if (typeof from !== 'string' || !REPOSITORY_NAME.test(from))
      throw new WebhookInputError(422, 'Repository rename does not name the previous repository.');
    previous = `${owner}/${from.toLowerCase()}`;
  }
  if (action === 'transferred') {
    const from =
      nested(payload, 'changes', 'owner', 'from', 'user', 'login') ??
      nested(payload, 'changes', 'owner', 'from', 'organization', 'login');
    if (typeof from !== 'string' || !LOGIN.test(from))
      throw new WebhookInputError(422, 'Repository transfer does not name the previous owner.');
    previousOwner = from.toLowerCase();
  }
  return {
    kind: 'repository',
    installationId: positiveIdentifier(nested(payload, 'installation', 'id')),
    owner,
    previousOwner,
    action,
    repository: { id: positiveIdentifier(repository.id), name },
    previous,
  };
}

// installation_target reports a renamed account; a change without a login change moves nothing.
function accountEvent(payload: Record<string, unknown>, action: string): GitHubWebhook {
  const from = nested(payload, 'changes', 'login', 'from');
  if (action !== 'renamed' || from === undefined) return { kind: 'ignored' };
  const login = nested(payload, 'account', 'login');
  if (
    typeof login !== 'string' ||
    !LOGIN.test(login) ||
    typeof from !== 'string' ||
    !LOGIN.test(from)
  )
    throw new WebhookInputError(422, 'Account rename webhook is incomplete.');
  return {
    kind: 'account',
    installationId: positiveIdentifier(nested(payload, 'installation', 'id')),
    owner: login.toLowerCase(),
    previousOwner: from.toLowerCase(),
    action: 'renamed',
  };
}

export function parseWebhook(body: Uint8Array, event: unknown, appId: number): GitHubWebhook {
  if (typeof event !== 'string' || !/^[a-z_]+$/.test(event))
    throw new WebhookInputError(400, 'A GitHub event name is required.');
  let payload;
  try {
    payload = parseObject(new TextDecoder('utf-8', { fatal: true }).decode(body), 'Webhook');
  } catch (cause) {
    throw new WebhookInputError(
      400,
      cause instanceof Error ? cause.message : 'Invalid webhook body.',
    );
  }
  if (event === 'ping') return { kind: 'ping' };
  if (event === 'pull_request') return pullRequest(payload);
  if (!LIFECYCLE_EVENTS.has(event)) return { kind: 'ignored' };
  if (typeof payload.action !== 'string')
    throw new WebhookInputError(422, 'Lifecycle webhooks require an action.');
  if (event === 'repository') return repositoryEvent(payload, payload.action);
  if (event === 'installation_target') return accountEvent(payload, payload.action);
  // Actions GitHub adds later are acknowledged rather than refused, so they are never redelivered.
  if (!(event === 'installation' ? INSTALLATION_ACTIONS : REPOSITORY_ACTIONS).has(payload.action))
    return { kind: 'ignored' };
  const installation = payload.installation;
  if (
    !isObject(installation) ||
    installation.app_id !== appId ||
    !isObject(installation.account) ||
    typeof installation.account.login !== 'string' ||
    !LOGIN.test(installation.account.login)
  )
    throw new WebhookInputError(422, 'Webhook installation does not match this App.');
  const installationId = positiveIdentifier(installation.id);
  const owner = installation.account.login.toLowerCase();
  const added =
    event === 'installation_repositories'
      ? repositories(payload.repositories_added, owner)
      : payload.repositories === undefined
        ? []
        : repositories(payload.repositories, owner);
  const removed =
    event === 'installation_repositories' ? repositories(payload.repositories_removed, owner) : [];
  if (removed.some((repository) => added.some((item) => item.name === repository.name)))
    throw new WebhookInputError(
      422,
      'A repository cannot be added and removed by the same delivery.',
    );
  return {
    kind: event === 'installation' ? 'installation' : 'repositories',
    installationId,
    owner,
    action: payload.action,
    added,
    removed,
    updatedAt: timestamp(installation.updated_at),
  };
}
