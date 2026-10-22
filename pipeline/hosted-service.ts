import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { AiOptions } from './ai-budget.ts';
import { validateRepairAttempts } from './validation-options.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import { standaloneStateDirectory } from './github-checkout.ts';
import { parseWebhook, verifyWebhook, WebhookInputError } from './github-webhooks.ts';
import { GitHubRequestError } from './github.ts';
import { openHostedStore, type HostedTarget } from './hosted-store.ts';
import {
  authorized,
  DEFAULT_SERVICE_PORT,
  requestBody,
  respond,
  validateServiceSecret,
} from './local-service.ts';
import { RepositoryApprovalError } from './repository-enrollment.ts';
import { confirmRepositoryAccess, pollServiceTarget, summarizePoll } from './service-worker.ts';
import { PipelineInputError } from './types.ts';

const HOSTED_HOST = '0.0.0.0';
const GITHUB_OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 64;
const MILLISECONDS_PER_SECOND = 1000;
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86400;
const DEFAULT_LEASE_SECONDS = 300;
const MIN_LEASE_SECONDS = 3;
// Renewing three times per lease keeps one missed renewal from releasing a running job.
const RENEWALS_PER_LEASE = 3;
const NOT_FOUND = 404;

export async function runHostedService(options: {
  database: Pool;
  app: GitHubAppConfiguration;
  // Worker state and evidence: managed checkouts, job receipts and validation output.
  directory: string;
  webhookSecret: string;
  controlToken: string;
  // Single-tenant until jobs run in per-job microVMs: other accounts' installations never enroll.
  owner: string;
  // Each installation gets its own ledger under the budget directory, capped at the same limit.
  aiPatch?: AiOptions;
  repairAttempts?: number;
  publishDraft?: boolean;
  host?: string;
  port?: number;
  intervalSeconds?: number;
  leaseSeconds?: number;
  worker?: string;
  signal: AbortSignal;
  onReady?: (url: string) => void;
  onProgress?: (message: string) => void;
}) {
  const owner = options.owner.toLowerCase();
  if (!GITHUB_OWNER.test(owner))
    throw new PipelineInputError('REFIT_HOSTED_OWNER requires a GitHub account login.');
  const repairAttempts = validateRepairAttempts(
    options.repairAttempts ?? 0,
    Boolean(options.aiPatch),
  );
  validateServiceSecret(options.webhookSecret, 'REFIT_WEBHOOK_SECRET');
  validateServiceSecret(options.controlToken, 'REFIT_SERVICE_TOKEN');
  if (options.webhookSecret === options.controlToken)
    throw new PipelineInputError('Webhook and service-control secrets must be different.');
  const interval = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const lease = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (
    !Number.isInteger(interval) ||
    interval < MIN_INTERVAL_SECONDS ||
    interval > MAX_INTERVAL_SECONDS
  )
    throw new PipelineInputError('Service interval must be 30–86400 seconds.');
  if (!Number.isInteger(lease) || lease < MIN_LEASE_SECONDS)
    throw new PipelineInputError(`Worker leases must be at least ${MIN_LEASE_SECONDS} seconds.`);
  const worker = options.worker ?? `${hostname()}:${process.pid}`;
  options.signal.throwIfAborted();
  const root = resolve(options.directory);
  await standaloneStateDirectory(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await realpath(root);
  const store = await openHostedStore(options.database);
  const running = new Map<number, AbortController>();
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

  const runJob = async (job: number, target: HostedTarget, retry: boolean) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    running.set(job, controller);
    const progress = (message: string) => options.onProgress?.(`[${target.id}] ${message}`);
    const renewal = setInterval(
      () =>
        void store.renew(job, worker, lease).then(
          (active) => {
            if (!active) {
              progress('Lease lost or job cancelled; stopping.');
              controller.abort();
            }
          },
          (error: unknown) => {
            progress(`Lease renewal failed: ${error instanceof Error ? error.message : error}`);
            controller.abort();
          },
        ),
      (lease * MILLISECONDS_PER_SECOND) / RENEWALS_PER_LEASE,
    );
    try {
      const access = await confirmRepositoryAccess(options.app, target.repository).catch(
        async (error: unknown) => {
          if (error instanceof GitHubRequestError && error.status === NOT_FOUND)
            await store.retire(target.id, null);
          throw error;
        },
      );
      if (access.installationId !== target.installationId)
        throw new PipelineInputError('Repository now belongs to another App installation.');
      if (await store.retire(target.id, access.id))
        throw new PipelineInputError(
          'Repository name now belongs to a different GitHub repository; approve it again.',
        );
      const result = await pollServiceTarget({
        target: {
          id: target.id,
          ...(target.integration ? { integration: target.integration } : {}),
          repository: target.repository,
          base: target.base,
          documentationSources: [],
          approval: target.approval,
        },
        app: options.app,
        stateDirectory: join(directory, 'targets', target.id),
        signal: controller.signal,
        retry,
        aiPatch: options.aiPatch && {
          ...options.aiPatch,
          ...(options.aiPatch.budget && {
            budget: {
              ...options.aiPatch.budget,
              directory: join(
                options.aiPatch.budget.directory,
                `installation-${target.installationId}`,
              ),
            },
          }),
        },
        repairAttempts,
        publishDraft: options.publishDraft,
        inspectReadiness: true,
        onProgress: progress,
      });
      const receipt = {
        ...summarizePoll(result),
        revision: 'checkout' in result ? result.checkout.revision : null,
        readiness: 'readiness' in result && result.readiness ? result.readiness.status : null,
      };
      await store.finish(job, worker, 'finished', receipt);
      progress(`${receipt.status}: ${receipt.message}`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const approval = error instanceof RepositoryApprovalError;
      await store.finish(job, worker, approval ? 'finished' : 'failed', {
        status: controller.signal.aborted ? 'interrupted' : approval ? 'needs-review' : 'error',
        output: null,
        message: `${error.name}: ${error.message}`,
      });
      progress(`${error.name}: ${error.message}`);
    } finally {
      clearInterval(renewal);
      running.delete(job);
      options.signal.removeEventListener('abort', abort);
    }
  };

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
        // A transfer or rename away from the configured account still stops its targets.
        if (
          'owner' in change &&
          change.owner !== owner &&
          !('previousOwner' in change && change.previousOwner === owner)
        ) {
          respond(response, 202, { delivery: id, status: 'ignored', enrolled: [], cancelled: [] });
          return;
        }
        const receipt = await store.accept(id, String(event), body, change);
        if (change.kind === 'account' && change.previousOwner === owner)
          options.onProgress?.(
            `Account ${change.previousOwner} is now ${change.owner}; set REFIT_HOSTED_OWNER=${change.owner} to keep accepting its webhooks.`,
          );
        for (const job of receipt.running) running.get(job)?.abort();
        if (receipt.enrolled.length) wake();
        respond(response, 202, {
          delivery: id,
          status: receipt.status,
          enrolled: receipt.enrolled,
          cancelled: receipt.cancelled,
        });
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
    const host = options.host ?? HOSTED_HOST;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? DEFAULT_SERVICE_PORT, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new PipelineInputError('Hosted service did not acquire a network address.');
    options.onReady?.(`http://${host}:${address.port}`);
    while (!options.signal.aborted) {
      requested = false;
      await store.enqueueDue(interval);
      for (
        let claimed = await store.claim(worker, lease);
        claimed && !options.signal.aborted;
        claimed = await store.claim(worker, lease)
      )
        await runJob(claimed.job, claimed.target, claimed.retry);
      if (options.signal.aborted || requested) continue;
      waiting = new AbortController();
      try {
        await delay(interval * MILLISECONDS_PER_SECOND, undefined, { signal: waiting.signal });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error;
      } finally {
        waiting = undefined;
      }
    }
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
}
