import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, isObject, parseObject } from './specifications.ts';
import { hasErrorCode, withStateLock, writeState } from './state-files.ts';
import type { GitHubWebhook } from './github-webhooks.ts';
import { WebhookInputError } from './github-webhooks.ts';
import type { ServiceTarget } from './service-configuration.ts';
import { PipelineInputError } from './types.ts';

const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const MAX_DELIVERIES = 10_000;
const MAX_INSTALLATIONS = 1_000;
const HASH = /^[a-f0-9]{64}$/;
const ACCESS_STATES = new Set(['unknown', 'active', 'blocked']);

export interface ServiceTargetState {
  repository: string;
  installationId: number | null;
  access: 'unknown' | 'active' | 'blocked';
  status: string;
  output: string | null;
  message: string | null;
  checkedAt: string | null;
}
export interface InstallationState {
  owner: string;
  status: 'pending' | 'active' | 'suspended' | 'deleted';
  repositories: Record<string, { id: number; name: string }>;
}
export interface ServiceRegistry {
  formatVersion: 1;
  signature: string;
  appId: number;
  accessVersion: number;
  targets: Record<string, ServiceTargetState>;
  installations: Record<string, InstallationState>;
  deliveries: Record<string, { hash: string; event: string; receivedAt: string }>;
}

export async function openServiceStore(
  directory: string,
  signature: string,
  appId: number,
  targets: ServiceTarget[],
) {
  const path = join(directory, 'registry.json');
  const initial: ServiceRegistry = {
    formatVersion: 1,
    signature,
    appId,
    accessVersion: 0,
    installations: {},
    deliveries: {},
    targets: Object.fromEntries(
      targets.map((target) => [
        target.id,
        {
          repository: target.repository.toLowerCase(),
          installationId: null,
          access: 'unknown',
          status: 'not-run',
          output: null,
          message: null,
          checkedAt: null,
        },
      ]),
    ),
  };
  const read = async (): Promise<ServiceRegistry> => {
    try {
      if ((await stat(path)).size > MAX_REGISTRY_BYTES)
        throw new PipelineInputError('Service registry exceeds its size limit.');
      const text = await readFile(path, 'utf8');
      if (Buffer.byteLength(text) > MAX_REGISTRY_BYTES)
        throw new PipelineInputError('Service registry exceeds its size limit.');
      const value = parseObject(text, 'Service registry');
      if (
        value.formatVersion !== 1 ||
        value.signature !== signature ||
        value.appId !== appId ||
        !Number.isSafeInteger(value.accessVersion) ||
        Number(value.accessVersion) < 0 ||
        !isObject(value.targets) ||
        !isObject(value.installations) ||
        !isObject(value.deliveries) ||
        Object.keys(value.targets).sort().join(',') !==
          targets
            .map((target) => target.id)
            .sort()
            .join(',')
      )
        throw new PipelineInputError(
          'Service registry belongs to another configuration or is invalid. Choose fresh state.',
        );
      for (const target of targets) {
        const record = value.targets[target.id];
        if (
          !isObject(record) ||
          record.repository !== target.repository.toLowerCase() ||
          !ACCESS_STATES.has(String(record.access)) ||
          typeof record.status !== 'string' ||
          !(
            record.installationId === null ||
            (Number.isSafeInteger(record.installationId) && Number(record.installationId) > 0)
          )
        )
          throw new PipelineInputError('Service target state is invalid.');
      }
      for (const record of Object.values(value.deliveries))
        if (
          !isObject(record) ||
          typeof record.hash !== 'string' ||
          !HASH.test(record.hash) ||
          typeof record.event !== 'string'
        )
          throw new PipelineInputError('Service delivery receipt is invalid.');
      for (const record of Object.values(value.installations))
        if (
          !isObject(record) ||
          typeof record.owner !== 'string' ||
          !isObject(record.repositories) ||
          !['pending', 'active', 'suspended', 'deleted'].includes(String(record.status))
        )
          throw new PipelineInputError('Service installation state is invalid.');
      return value as unknown as ServiceRegistry;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return structuredClone(initial);
      throw error;
    }
  };
  let pending: Promise<void> = Promise.resolve();
  const update = <T>(operation: (state: ServiceRegistry) => T): Promise<T> => {
    const result = pending.then(() =>
      withStateLock(directory, 'registry', async () => {
        const state = await read();
        const result = operation(state);
        if (
          Buffer.byteLength(JSON.stringify(state, null, 2)) + 1 > MAX_REGISTRY_BYTES ||
          Object.keys(state.installations).length > MAX_INSTALLATIONS
        )
          throw new PipelineInputError(
            'Service registry capacity reached. Archive state before accepting more events.',
          );
        await writeState(path, state);
        return result;
      }),
    );
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  await update(() => undefined);
  const accept = async (delivery: string, event: string, body: Uint8Array, change: GitHubWebhook) =>
    update((state) => {
      const hash = digest(body);
      const previous = state.deliveries[delivery];
      if (previous) {
        if (previous.hash !== hash || previous.event !== event)
          throw new WebhookInputError(
            409,
            'This delivery GUID already belongs to another payload.',
          );
        return { status: 'duplicate' as const, disabled: [] as string[], wake: false };
      }
      if (Object.keys(state.deliveries).length >= MAX_DELIVERIES)
        throw new WebhookInputError(
          503,
          'Delivery receipt capacity reached. Archive service state before accepting more events.',
        );
      const disabled: string[] = [];
      if ('installationId' in change) {
        state.accessVersion += 1;
        const id = String(change.installationId);
        const prior = state.installations[id];
        if (prior && prior.owner !== change.owner)
          throw new WebhookInputError(409, 'Installation owner changed unexpectedly.');
        const installation: InstallationState = prior ?? {
          owner: change.owner,
          status: 'pending',
          repositories: {},
        };
        installation.status =
          change.action === 'deleted'
            ? 'deleted'
            : change.action === 'suspend'
              ? 'suspended'
              : 'pending';
        for (const repository of change.added)
          installation.repositories[repository.name] = repository;
        for (const repository of change.removed) delete installation.repositories[repository.name];
        state.installations[id] = installation;
        for (const target of targets) {
          const record = state.targets[target.id];
          const removed =
            record.installationId === change.installationId &&
            change.removed.some((repository) => repository.name === record.repository);
          const revoked =
            record.installationId === change.installationId &&
            ['deleted', 'suspend'].includes(change.action);
          if (removed || revoked) {
            record.access = 'blocked';
            record.message = `Installation access ${change.action}; waiting for API confirmation.`;
            disabled.push(target.id);
          } else if (
            change.added.some((repository) => repository.name === record.repository) ||
            record.installationId === change.installationId
          ) {
            record.access = 'unknown';
            record.message = 'Installation changed; waiting for API confirmation.';
          }
        }
      }
      state.deliveries[delivery] = { hash, event, receivedAt: new Date().toISOString() };
      return { status: 'accepted' as const, disabled, wake: 'installationId' in change };
    });
  return { read, update, accept };
}
