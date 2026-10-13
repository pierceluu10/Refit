import { timingSafeEqual } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AiOptions } from './ai-budget.ts';
import { authenticateGitHubRead, type GitHubAppConfiguration } from './github-app.ts';
import { standaloneStateDirectory } from './github-checkout.ts';
import { requestGitHub } from './github.ts';
import { parseWebhook, verifyWebhook, WebhookInputError } from './github-webhooks.ts';
import { publicationConfiguration } from './publication.ts';
import type { ServiceTarget } from './service-configuration.ts';
import { openServiceStore } from './service-state.ts';
import { digest, isObject } from './specifications.ts';
import { withStateLock } from './state-files.ts';
import { PipelineInputError } from './types.ts';
import { validateRepairAttempts } from './validation-options.ts';
import { watchOnce } from './watch.ts';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 5_000;
const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 256;
const MAX_CONNECTIONS = 64;
const MILLISECONDS_PER_SECOND = 1000;
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86400;
const MAX_PORT = 65535;
export const DEFAULT_SERVICE_PORT = 8787;

export function validateServiceSecret(value: string | undefined, name: string) {
  if (
    !value ||
    value.length < MIN_SECRET_LENGTH ||
    value.length > MAX_SECRET_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new PipelineInputError(
      `${name} requires a separate 32–256 character random secret using letters, digits, underscores or hyphens.`,
    );
  return value;
}

function authorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function requestBody(request: IncomingMessage) {
  if (
    request.headers['content-type']?.split(';')[0].toLowerCase() !== 'application/json' ||
    (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
  )
    throw new WebhookInputError(415, 'Webhook requests require uncompressed application/json.');
  const oversized = Number(request.headers['content-length']) > MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    // Drain oversized requests within the server timeout so clients receive HTTP 413 rather than a socket reset.
    if (!oversized && length <= MAX_BODY_BYTES) chunks.push(bytes);
  }
  if (oversized || length > MAX_BODY_BYTES)
    throw new WebhookInputError(413, 'Webhook payload exceeds 1 MiB.');
  return Buffer.concat(chunks);
}

function respond(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

export async function runLocalService(options: {
  targets: ServiceTarget[];
  app: GitHubAppConfiguration;
  directory: string;
  webhookSecret: string;
  controlToken: string;
  port?: number;
  intervalSeconds?: number;
  once?: boolean;
  aiPatch?: AiOptions;
  repairAttempts?: number;
  publishDraft?: boolean;
  signal: AbortSignal;
  onReady?: (url: string) => void;
  onProgress?: (message: string) => void;
}) {
  validateServiceSecret(options.webhookSecret, 'REFIT_WEBHOOK_SECRET');
  validateServiceSecret(options.controlToken, 'REFIT_SERVICE_TOKEN');
  if (options.webhookSecret === options.controlToken)
    throw new PipelineInputError('Webhook and service-control secrets must be different.');
  const repairAttempts = validateRepairAttempts(
    options.repairAttempts ?? 0,
    Boolean(options.aiPatch),
  );
  const interval = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const port = options.port ?? DEFAULT_SERVICE_PORT;
  if (
    !Number.isInteger(interval) ||
    interval < MIN_INTERVAL_SECONDS ||
    interval > MAX_INTERVAL_SECONDS
  )
    throw new PipelineInputError('Service interval must be 30–86400 seconds.');
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT)
    throw new PipelineInputError('Service port must be 0–65535.');
  options.signal.throwIfAborted();
  const root = resolve(options.directory);
  await standaloneStateDirectory(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await realpath(root);
  await standaloneStateDirectory(directory);
  return withStateLock(directory, 'service', async () => {
    const signature = digest(
      JSON.stringify({
        appId: options.app.appId,
        targets: options.targets,
        publication: Boolean(options.publishDraft),
        aiModel: options.aiPatch?.model ?? null,
        repairAttempts,
      }),
    );
    const store = await openServiceStore(
      directory,
      signature,
      Number(options.app.appId),
      options.targets,
    );
    const running = new Map<string, AbortController>();
    let waiting: AbortController | undefined;
    let requested = false;
    const wake = () => {
      requested = true;
      waiting?.abort();
    };
    const stop = () => {
      for (const controller of running.values()) controller.abort();
      waiting?.abort();
    };
    options.signal.addEventListener('abort', stop, { once: true });
    const handlers = new Set<Promise<void>>();
    const server = createServer(
      { requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: HEADERS_TIMEOUT_MS },
      (request, response) => {
        const handler = (async () => {
          if (request.method === 'GET' && request.url === '/health') {
            respond(response, 200, { status: 'listening' });
            return;
          }
          if (request.method === 'GET' && request.url === '/status') {
            if (!authorized(request, options.controlToken))
              throw new WebhookInputError(401, 'Service authorization is required.');
            respond(response, 200, await store.read());
            return;
          }
          if (request.method !== 'POST' || request.url !== '/github/webhook') {
            respond(response, 404, { error: 'Route not found.' });
            return;
          }
          const body = await requestBody(request);
          const id = verifyWebhook(
            body,
            request.headers['x-hub-signature-256'],
            request.headers['x-github-delivery'],
            options.webhookSecret,
          );
          const event = request.headers['x-github-event'];
          const change = parseWebhook(body, event, Number(options.app.appId));
          const receipt = await store.accept(id, String(event), body, change);
          for (const target of receipt.disabled) running.get(target)?.abort();
          if (receipt.wake) wake();
          respond(response, 202, { delivery: id, status: receipt.status });
        })().catch((error: unknown) => {
          if (error instanceof WebhookInputError)
            respond(response, error.status, { error: error.message });
          else {
            options.onProgress?.(
              `Webhook processing failed: ${error instanceof Error ? error.message : 'Unknown storage failure.'}`,
            );
            respond(response, 500, {
              error: 'Webhook was not accepted. Inspect service logs before redelivery.',
            });
          }
          request.resume();
        });
        handlers.add(handler);
        void handler.then(
          () => handlers.delete(handler),
          () => handlers.delete(handler),
        );
      },
    );
    server.maxConnections = MAX_CONNECTIONS;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new PipelineInputError('Service did not acquire a loopback address.');
      options.onReady?.(`http://${HOST}:${address.port}`);
      do {
        requested = false;
        for (const target of options.targets) {
          if (options.signal.aborted) break;
          const controller = new AbortController();
          const abort = () => controller.abort();
          options.signal.addEventListener('abort', abort, { once: true });
          running.set(target.id, controller);
          const startedVersion = (await store.read()).accessVersion;
          let authorized = false;
          try {
            const authentication = await authenticateGitHubRead(options.app, target.repository);
            const repository = await requestGitHub(
              authentication.token,
              'GET',
              `/repos/${target.repository}`,
            );
            if (
              !isObject(repository) ||
              typeof repository.full_name !== 'string' ||
              repository.full_name.toLowerCase() !== target.repository.toLowerCase() ||
              !Number.isSafeInteger(repository.id) ||
              Number(repository.id) <= 0 ||
              repository.archived !== false ||
              repository.disabled !== false
            )
              throw new PipelineInputError(
                'Configured repository is unavailable, archived, disabled or has mismatched identity.',
              );
            const active = await store.update((state) => {
              if (state.accessVersion !== startedVersion || controller.signal.aborted) return false;
              const record = state.targets[target.id];
              record.installationId = authentication.installationId;
              record.access = 'active';
              record.status = 'running';
              record.message = null;
              record.checkedAt = new Date().toISOString();
              const installation = state.installations[String(authentication.installationId)] ?? {
                owner: target.repository.split('/')[0].toLowerCase(),
                status: 'active' as const,
                repositories: {},
              };
              installation.status = 'active';
              installation.repositories[target.repository.toLowerCase()] = {
                id: Number(repository.id),
                name: target.repository.toLowerCase(),
              };
              state.installations[String(authentication.installationId)] = installation;
              return true;
            });
            if (!active) continue;
            authorized = true;
            const result = await watchOnce({
              configuration: {
                ...target.workflow,
                repository: undefined,
                signal: controller.signal,
                aiPatch: options.aiPatch,
                repairAttempts,
                publication: options.publishDraft
                  ? publicationConfiguration(target.repository, target.base, undefined, options.app)
                  : undefined,
              },
              source: target.source,
              documentationSources: target.documentationSources,
              stateDirectory: join(directory, 'targets', target.id),
              syncGitHub: { repository: target.repository, base: target.base, app: options.app },
              onProgress: (message) => options.onProgress?.(`[${target.id}] ${message}`),
            });
            await store.update((state) => {
              const record = state.targets[target.id];
              if (controller.signal.aborted) {
                record.status = 'interrupted';
                record.output = result.output;
                record.message =
                  'Worker stopped after service shutdown or installation access changed.';
                return;
              }
              record.status =
                result.status === 'processed'
                  ? result.result.manifest.status
                  : result.status === 'documentation-changed'
                    ? result.status
                    : result.previousStatus;
              record.output = result.output;
              record.message =
                result.status === 'processed'
                  ? [
                      result.result.manifest.reason,
                      ...(result.documentationBaselines?.length
                        ? [
                            `Now monitoring ${result.documentationBaselines.length} documentation source${result.documentationBaselines.length === 1 ? '' : 's'}.`,
                          ]
                        : []),
                      ...(result.documentationChanges?.length
                        ? [
                            `${result.documentationChanges.length} provider documentation change${result.documentationChanges.length === 1 ? '' : 's'} saved for review.`,
                          ]
                        : []),
                    ].join(' ')
                  : result.status === 'documentation-changed'
                    ? `Provider documentation changed. Refit saved a unified diff and did not start a migration. The prior API workflow status remains ${result.previousStatus}.`
                    : 'Saved worker result reused; checks were not rerun.';
            });
            const record = (await store.read()).targets[target.id];
            options.onProgress?.(
              `[${target.id}] ${record.status}: ${record.message ?? 'Poll completed.'}${record.output ? ` Evidence: ${record.output}` : ''}`,
            );
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            await store.update((state) => {
              const record = state.targets[target.id];
              if (!authorized) record.access = 'blocked';
              record.status = controller.signal.aborted ? 'interrupted' : 'error';
              record.message = `${error.name}: ${error.message}`;
              record.checkedAt = new Date().toISOString();
            });
            options.onProgress?.(`[${target.id}] ${error.name}: ${error.message}`);
          } finally {
            running.delete(target.id);
            options.signal.removeEventListener('abort', abort);
          }
        }
        if (options.once || options.signal.aborted) break;
        if (!requested) {
          waiting = new AbortController();
          try {
            await delay(interval * MILLISECONDS_PER_SECOND, undefined, { signal: waiting.signal });
          } catch (error) {
            if (!(error instanceof Error && error.name === 'AbortError')) throw error;
          } finally {
            waiting = undefined;
          }
        }
      } while (!options.signal.aborted);
      return { directory, registry: await store.read() };
    } finally {
      options.signal.removeEventListener('abort', stop);
      stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (!error || ('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) resolve();
          else reject(error);
        });
        server.closeAllConnections();
      });
      await Promise.all(handlers);
    }
  });
}
