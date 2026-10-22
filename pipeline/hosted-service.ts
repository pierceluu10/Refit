import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { AiOptions } from './ai-budget.ts';
import { FlyMachinesError, type FlyMachines } from './fly-machines.ts';
import { validateRepairAttempts } from './validation-options.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import { standaloneStateDirectory } from './github-checkout.ts';
import { parseWebhook, verifyWebhook, WebhookInputError } from './github-webhooks.ts';
import {
  failedOutcome,
  JOB_POLL_SECONDS,
  JOB_TIMEOUT_SECONDS,
  jobChannel,
  reapJobMachines,
  runHostedTarget,
  runJobMachine,
} from './hosted-runner.ts';
import { openHostedStore, type HostedTarget } from './hosted-store.ts';
import {
  authorized,
  DEFAULT_SERVICE_PORT,
  requestBody,
  respond,
  validateServiceSecret,
} from './local-service.ts';
import { confirmRepositoryAccess } from './service-worker.ts';
import { PipelineInputError } from './types.ts';

const HOSTED_HOST = '0.0.0.0';
const GITHUB_OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/;
const REQUEST_TIMEOUT_MS = 10_000;
// Job machines upload up to 64 MiB of evidence over the private network.
const JOB_REQUEST_TIMEOUT_MS = 120_000;
const JOB_CHANNEL_HOST = 'fly-local-6pn';
const JOB_CHANNEL_PORT = 8081;
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
  // Runs each job on its own short-lived Fly Machine in a separate app that holds no secrets,
  // instead of on this VM's Docker daemon. The job channel listens on the private network only.
  jobMachines?: {
    machines: FlyMachines;
    image: string;
    region: string;
    images: string[];
    host?: string;
    port?: number;
    timeoutSeconds?: number;
    pollSeconds?: number;
  };
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
  if (options.jobMachines && (options.aiPatch || options.publishDraft))
    throw new PipelineInputError(
      '--job-machines does not support --ai-patch or --publish-draft: a job machine never holds the per-installation AI ledger or a GitHub token that can write.',
    );
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
  let jobs:
    | Omit<
        Parameters<typeof runJobMachine>[0],
        'job' | 'target' | 'retry' | 'directory' | 'github' | 'signal' | 'onProgress'
      >
    | undefined;
  // A job machine whose job no live worker holds was left by a crash; destroy it before claiming.
  const reap = async ({ machines, channel }: NonNullable<typeof jobs>) => {
    try {
      const leases = await store.leases();
      for (const id of await reapJobMachines(
        machines,
        (job) => channel.has(job) || (leases.has(job) && leases.get(job) !== worker),
      ))
        options.onProgress?.(`Destroyed orphaned job machine ${id}.`);
    } catch (error) {
      if (!(error instanceof FlyMachinesError)) throw error;
      options.onProgress?.(`Job machine reaper failed: ${error.message}`);
    }
  };

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
      const access = await confirmRepositoryAccess(options.app, target.repository);
      if (access.installationId !== target.installationId)
        throw new PipelineInputError('Repository now belongs to another App installation.');
      const outcome = jobs
        ? await runJobMachine({
            ...jobs,
            job,
            target,
            retry,
            directory,
            github: {
              appId: options.app.appId,
              installationId: access.installationId,
              token: access.token,
            },
            signal: controller.signal,
            onProgress: progress,
          })
        : await runHostedTarget({
            target,
            app: options.app,
            directory,
            retry,
            signal: controller.signal,
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
            onProgress: progress,
          });
      await store.finish(job, worker, outcome.status, outcome.receipt);
      progress(`${outcome.receipt.status}: ${outcome.receipt.message}`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const outcome = failedOutcome(error, controller.signal.aborted);
      await store.finish(job, worker, outcome.status, outcome.receipt);
      progress(`${error.name}: ${error.message}`);
    } finally {
      clearInterval(renewal);
      running.delete(job);
      options.signal.removeEventListener('abort', abort);
    }
  };

  const handlers = new Set<Promise<void>>();
  const servers: Server[] = [];
  // Serves one router with the worker's limits; open handlers settle before the service returns.
  const listen = async (
    router: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
    address: { host: string; port: number; requestTimeout: number; label: string },
  ) => {
    const server = createServer(
      { requestTimeout: address.requestTimeout, headersTimeout: HEADERS_TIMEOUT_MS },
      (request, response) => {
        const handler = router(request, response).catch((error: unknown) => {
          if (error instanceof WebhookInputError)
            respond(response, error.status, { error: error.message });
          else {
            options.onProgress?.(
              `${address.label} processing failed: ${error instanceof Error ? error.message : 'Unknown storage failure.'}`,
            );
            respond(response, 500, {
              error: `${address.label} was not accepted. Inspect service logs before redelivery.`,
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
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address.port, address.host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const bound = server.address();
    if (!bound || typeof bound === 'string')
      throw new PipelineInputError('Hosted service did not acquire a network address.');
    return bound;
  };
  try {
    const host = options.host ?? HOSTED_HOST;
    const address = await listen(
      async (request, response) => {
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
        if ('owner' in change && change.owner !== owner) {
          respond(response, 202, { delivery: id, status: 'ignored', enrolled: [], cancelled: [] });
          return;
        }
        const receipt = await store.accept(id, String(event), body, change);
        for (const job of receipt.running) running.get(job)?.abort();
        if (receipt.enrolled.length) wake();
        respond(response, 202, {
          delivery: id,
          status: receipt.status,
          enrolled: receipt.enrolled,
          cancelled: receipt.cancelled,
        });
      },
      {
        host,
        port: options.port ?? DEFAULT_SERVICE_PORT,
        requestTimeout: REQUEST_TIMEOUT_MS,
        label: 'Webhook',
      },
    );
    if (options.jobMachines) {
      const channel = jobChannel();
      const bound = await listen(channel.handle, {
        host: options.jobMachines.host ?? JOB_CHANNEL_HOST,
        port: options.jobMachines.port ?? JOB_CHANNEL_PORT,
        requestTimeout: JOB_REQUEST_TIMEOUT_MS,
        label: 'Job channel request',
      });
      jobs = {
        machines: options.jobMachines.machines,
        channel,
        callback: `http://${bound.family === 'IPv6' ? `[${bound.address}]` : bound.address}:${bound.port}`,
        image: options.jobMachines.image,
        region: options.jobMachines.region,
        images: options.jobMachines.images,
        timeoutSeconds: options.jobMachines.timeoutSeconds ?? JOB_TIMEOUT_SECONDS,
        pollSeconds: options.jobMachines.pollSeconds ?? JOB_POLL_SECONDS,
      };
      options.onProgress?.(`Job channel listening at ${jobs.callback}; jobs run on Fly Machines.`);
    }
    options.onReady?.(`http://${host}:${address.port}`);
    while (!options.signal.aborted) {
      requested = false;
      if (jobs) await reap(jobs);
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
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (!error || ('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) resolve();
              else reject(error);
            });
            server.closeAllConnections();
          }),
      ),
    );
    await Promise.all(handlers);
  }
}
