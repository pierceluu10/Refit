import { createHmac, timingSafeEqual } from 'node:crypto';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const DELIVERY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const INSTALLATION_ACTIONS = new Set([
  'created',
  'deleted',
  'suspend',
  'unsuspend',
  'new_permissions_accepted',
]);
const REPOSITORY_ACTIONS = new Set(['added', 'removed']);
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
      kind: 'installation' | 'repositories';
      installationId: number;
      owner: string;
      action: string;
      added: WebhookRepository[];
      removed: WebhookRepository[];
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
  if (!['installation', 'installation_repositories'].includes(event)) return { kind: 'ignored' };
  const installation = payload.installation;
  if (
    !isObject(installation) ||
    installation.app_id !== appId ||
    !isObject(installation.account) ||
    typeof installation.account.login !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(installation.account.login)
  )
    throw new WebhookInputError(422, 'Webhook installation does not match this App.');
  const installationId = positiveIdentifier(installation.id);
  const owner = installation.account.login.toLowerCase();
  if (
    typeof payload.action !== 'string' ||
    !(event === 'installation' ? INSTALLATION_ACTIONS : REPOSITORY_ACTIONS).has(payload.action)
  )
    throw new WebhookInputError(422, 'Unsupported installation action.');
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
  };
}
