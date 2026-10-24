import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { AiOptions } from './ai-budget.ts';
import { FlyMachinesError, type FlyMachines } from './fly-machines.ts';
import { validateRepairAttempts } from './validation-options.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import { standaloneStateDirectory } from './github-checkout.ts';
import { parseWebhook, verifyWebhook, WebhookInputError } from './github-webhooks.ts';
import { hostedPages } from './hosted-setup.ts';
import { GitHubRequestError } from './github.ts';
import { MIN_THROTTLE_SECONDS, readCpuTimes, stealShare, THROTTLED_STEAL } from './hosted-cpu.ts';
import { isDatabaseUnavailable } from './hosted-database.ts';
import { purgeUninstalled } from './hosted-retention.ts';
import { processApprovalIssues } from './hosted-approval.ts';
import { openApprovalStore } from './hosted-approval-store.ts';
import {
  failedOutcome,
  JOB_POLL_SECONDS,
  JOB_TIMEOUT_SECONDS,
  jobChannel,
  reapJobMachines,
  runHostedTarget,
  runJobMachine,
} from './hosted-runner.ts';
import {
  failedJobNotifier,
  filterHostedStatus,
  hostedRedactor,
  type HostedLogContext,
} from './hosted-ops.ts';
import { openHostedStore, type HostedTarget } from './hosted-store.ts';
import type { HostedTenancy } from './hosted-tenancy.ts';
import {
  INVENTORY_LIMITS,
  inventorySummary,
  refreshInventory,
  registryDigest,
} from './inventory.ts';
import { openInventoryStore, type InventoryClaim } from './inventory-store.ts';
import {
  requestRescans,
  sendDeadlineAlerts,
  upcomingDeadlines,
  type HostedAlerts,
} from './monitoring.ts';
import { openMonitoringStore } from './monitoring-store.ts';
import { syncReportIssues } from './report-issues.ts';
import { openReportStore } from './report-store.ts';
import {
  authorized,
  DEFAULT_SERVICE_PORT,
  requestBody,
  respond,
  validateServiceSecret,
} from './local-service.ts';
import { confirmRepositoryAccess } from './service-worker.ts';
import type { SlackSend } from './slack.ts';
import { PipelineInputError } from './types.ts';

const HOSTED_HOST = '0.0.0.0';
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
const NOT_FOUND = 404;
// An inventory holds its lease for its whole time cap, plus this margin, without renewing it.
const INVENTORY_LEASE_MARGIN_SECONDS = 60;
// While PostgreSQL is unreachable the worker waits, doubling the wait up to the maximum.
const OUTAGE_RETRY_MS = 5_000;
const MAX_OUTAGE_RETRY_MS = 60_000;

export async function runHostedService(options: {
  database: Pool;
  app: GitHubAppConfiguration;
  // Worker state and evidence: managed checkouts, job receipts and validation output.
  directory: string;
  webhookSecret: string;
  controlToken: string;
  // Allowed accounts and per-installation caps; other accounts' installations never enroll.
  tenancy: HostedTenancy;
  // Each installation gets its own PostgreSQL ledger, capped at the same limit, and every request
  // also reserves against one ledger across all installations, capped at aiTotalUsd (default: the
  // per-installation limit).
  aiPatch?: AiOptions;
  aiTotalUsd?: number;
  repairAttempts?: number;
  publishDraft?: boolean;
  // Where customers ask for data deletion and report security issues (REFIT_HOSTED_CONTACT).
  contact?: string;
  // Off by default: re-scans inventories on push, registry change and age, and opens or updates
  // deadline issues at the lead times. Needs the App's Issues write permission.
  alerts?: HostedAlerts;
  // Off by default: keeps one report issue per inventoried repository, re-scanned like alerts.
  // Needs the App's Issues write permission.
  reports?: boolean;
  // The deadline registry file, by default the bundled one.
  registry?: string | URL;
  now?: () => Date;
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
  // Owner decision (2026-10-22): deleting uninstalled installations' data is opt-in.
  purgeUninstalled?: boolean;
  // Opens an approval issue on installed repositories without an approval and handles
  // `/refit approve` and `/refit revoke` comments (REFIT_HOSTED_APPROVAL_ISSUES).
  approvalIssues?: boolean;
  // Off by default (owner decision, 2026-10-22): follows repository renames, transfers and
  // archiving, account renames, and repositories GitHub no longer serves (REFIT_HOSTED_LIFECYCLE).
  lifecycle?: boolean;
  // The workflow's own notices, plus failed jobs at most once per target per hour.
  notify?: SlackSend;
  // Applied to job fields before a failure notice cuts them to length.
  redact?: (text: string) => string;
  host?: string;
  port?: number;
  intervalSeconds?: number;
  leaseSeconds?: number;
  worker?: string;
  signal: AbortSignal;
  onReady?: (url: string) => void;
  onProgress?: (message: string, context?: HostedLogContext) => void;
}) {
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
  // Logs, stored receipts and error responses never carry a credential, whatever produced the text.
  // `refit hosted serve` passes a redactor built from its whole environment; otherwise the
  // service's own secrets are redacted.
  const redact =
    options.redact ??
    hostedRedactor({
      REFIT_WEBHOOK_SECRET: options.webhookSecret,
      REFIT_SERVICE_TOKEN: options.controlToken,
      OPENAI_API_KEY: options.aiPatch?.apiKey,
      REFIT_DATABASE_URL: options.database.options?.connectionString,
    });
  const redactReceipt = <Receipt extends { message: string | null }>(receipt: Receipt) => ({
    ...receipt,
    message: receipt.message && redact(receipt.message),
  });
  const onProgress: typeof options.onProgress =
    options.onProgress &&
    ((message: string, context?: HostedLogContext) =>
      options.onProgress?.(redact(message), context));
  options.signal.throwIfAborted();
  const root = resolve(options.directory);
  await standaloneStateDirectory(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await realpath(root);
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
  // Waits until the time passes, a webhook wakes the worker or the service stops.
  const pause = async (milliseconds: number) => {
    waiting = new AbortController();
    try {
      await delay(milliseconds, undefined, { signal: waiting.signal });
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    } finally {
      waiting = undefined;
    }
  };
  let outage = OUTAGE_RETRY_MS;
  const unavailable = async (error: Error) => {
    onProgress?.(
      `PostgreSQL is unavailable (${error.message}); retrying in ${outage / MILLISECONDS_PER_SECOND} s.`,
    );
    await pause(outage);
    outage = Math.min(outage * 2, MAX_OUTAGE_RETRY_MS);
  };
  options.signal.addEventListener('abort', stop, { once: true });
  const openStore = async () => {
    for (;;)
      try {
        const store = await openHostedStore(options.database, options.tenancy);
        const allowed = await store.allow();
        if (allowed.enrolled.length || allowed.cancelled.length)
          onProgress?.(
            `Allowed accounts ${options.tenancy.accounts.join(', ')}: enrolled ${allowed.enrolled.length}, cancelled ${allowed.cancelled.length} targets.`,
          );
        return store;
      } catch (error) {
        if (!isDatabaseUnavailable(error)) throw error;
        await unavailable(error);
        options.signal.throwIfAborted();
      }
  };
  const store = await openStore();
  outage = OUTAGE_RETRY_MS;
  const inventories = openInventoryStore(options.database, options.tenancy.limits);
  const monitoring = openMonitoringStore(options.database);
  const reports = openReportStore(options.database);
  const now = () => options.now?.() ?? new Date();
  const approvals = openApprovalStore(options.database);
  const notifyFailures =
    options.notify && failedJobNotifier(options.database, options.notify, options.redact);
  await notifyFailures?.();

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
        onProgress?.(`Destroyed orphaned job machine ${id}.`);
    } catch (error) {
      if (!(error instanceof FlyMachinesError)) throw error;
      onProgress?.(`Job machine reaper failed: ${error.message}`);
    }
  };

  const runJob = async (job: number, target: HostedTarget, retry: boolean) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    running.set(job, controller);
    const progress = (message: string, level?: 'error') =>
      onProgress?.(message, {
        job,
        target: target.id,
        installation: target.installationId,
        ...(level && { level }),
      });
    // A job machine's CPU is not this machine's, so only in-VM jobs are measured.
    const cpu = jobs ? null : await readCpuTimes();
    const started = Date.now();
    // Throttled installs and checks hit their time limits, which reads as the repository's failure.
    const cpuSteal = async () => {
      const after = cpu && (await readCpuTimes());
      if (!cpu || !after || Date.now() - started < MIN_THROTTLE_SECONDS * MILLISECONDS_PER_SECOND)
        return {};
      const steal = stealShare(cpu, after);
      if (steal >= THROTTLED_STEAL)
        progress(
          `CPU throttled: the host took ${Math.round(steal * 100)}% of this machine's CPU time during the job, so installs and checks ran slower and may have hit their time limits.`,
          'error',
        );
      return { cpuSteal: Math.round(steal * 100) / 100 };
    };
    const leaseMilliseconds = lease * MILLISECONDS_PER_SECOND;
    const renewEvery = leaseMilliseconds / RENEWALS_PER_LEASE;
    // The claim set the lease just before this job started.
    let leased = Date.now();
    const renewal = setInterval(() => {
      const sent = Date.now();
      void store.renew(job, worker, lease).then(
        (active) => {
          if (active) leased = Math.max(leased, sent);
          else {
            progress('Lease lost or job cancelled; stopping.');
            controller.abort();
          }
        },
        (error: unknown) => {
          const failure = `Lease renewal failed: ${error instanceof Error ? error.message : error}`;
          // The lease still holds while PostgreSQL is down. The job stops only once the next
          // renewal could land after it expires, so no other worker can claim it while it runs.
          if (isDatabaseUnavailable(error) && Date.now() - leased + renewEvery < leaseMilliseconds)
            progress(`${failure}; retrying.`);
          else {
            progress(`${failure}; stopping.`, 'error');
            controller.abort();
          }
        },
      );
    }, renewEvery);
    try {
      const access = await confirmRepositoryAccess(options.app, target.repository).catch(
        async (error: unknown) => {
          if (
            options.lifecycle &&
            error instanceof GitHubRequestError &&
            error.status === NOT_FOUND
          )
            await store.retire(target.id, null);
          throw error;
        },
      );
      if (access.installationId !== target.installationId)
        throw new PipelineInputError('Repository now belongs to another App installation.');
      if (options.lifecycle && (await store.retire(target.id, access.id)))
        throw new PipelineInputError(
          'Repository name now belongs to a different GitHub repository; approve it again.',
        );
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
                  // Earlier workers kept a file ledger per installation under the budget directory.
                  ledger: store.aiLedger(
                    target.installationId,
                    join(
                      options.aiPatch.budget.directory,
                      `installation-${target.installationId}`,
                      'budget.json',
                    ),
                  ),
                  parent: {
                    ...options.aiPatch.budget,
                    limitUsd: options.aiTotalUsd ?? options.aiPatch.budget.limitUsd,
                    ledger: store.aiTotalLedger(),
                  },
                },
              }),
            },
            repairAttempts,
            publishDraft: options.publishDraft,
            notify: options.notify,
            onProgress: progress,
          });
      await store.finish(
        job,
        worker,
        outcome.status,
        redactReceipt({ ...outcome.receipt, ...(await cpuSteal()) }),
      );
      // The receipt carries the error name from both runners, so a job machine's refusal counts too.
      if (options.approvalIssues && outcome.receipt.message?.startsWith('RepositoryApprovalError:'))
        await approvals.changed(target.repository);
      progress(
        `${outcome.receipt.status}: ${outcome.receipt.message}`,
        outcome.status === 'failed' ? 'error' : undefined,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const outcome = failedOutcome(error, controller.signal.aborted);
      await store.finish(
        job,
        worker,
        outcome.status,
        redactReceipt({ ...outcome.receipt, ...(await cpuSteal()) }),
      );
      progress(`${error.name}: ${error.message}`, 'error');
    } finally {
      clearInterval(renewal);
      running.delete(job);
      options.signal.removeEventListener('abort', abort);
    }
  };

  // A read-only inventory of an installed repository, approved or not; it never enrolls anything.
  const runInventory = async (claimed: InventoryClaim) => {
    const progress = (message: string) =>
      onProgress?.(`[inventory ${claimed.repository}] ${message}`);
    const started = Date.now();
    try {
      const registry = await loadDeadlineRegistry(options.registry, now());
      const result = await refreshInventory({
        app: options.app,
        directory: join(directory, 'inventory', randomUUID()),
        installationId: claimed.installationId,
        repository: claimed.repository,
        registry,
        previous: claimed.previous,
        now: now(),
        signal: options.signal,
        onProgress: progress,
      });
      const recorded = await inventories.finish(claimed, worker, {
        result,
        registry: registryDigest(registry),
        durationMs: Date.now() - started,
      });
      progress(
        !recorded
          ? 'Repository removed or lease lost; the result was dropped.'
          : result.outcome === 'stopped'
            ? `Stopped (${result.stop}): ${result.message}`
            : `Inventory ${result.outcome} at ${result.revision.slice(0, 12)}.`,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // On shutdown the lease is left to expire, so another worker takes the inventory again.
      if (options.signal.aborted) return;
      await inventories.finish(claimed, worker, { error: `${error.name}: ${error.message}` });
      progress(`${error.name}: ${error.message}`);
    }
  };

  const pages = hostedPages({
    app: options.app,
    tenancy: options.tenancy,
    publishDraft: Boolean(options.publishDraft),
    aiPatch: Boolean(options.aiPatch),
    contact: options.contact,
    onProgress: options.onProgress,
  });
  // A registry that does not load skips monitoring for this pass, as it does locally.
  const monitoringRegistry = async () => {
    try {
      return await loadDeadlineRegistry(options.registry, now());
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      onProgress?.(`Deadline monitoring skipped: ${error.name}: ${error.message}`);
      return null;
    }
  };

  const handlers = new Set<Promise<void>>();
  const servers: Server[] = [];
  // Serves one router with the worker's limits; open handlers settle before the service returns.
  const listen = async (
    router: (
      request: IncomingMessage,
      response: ServerResponse,
      context: HostedLogContext,
    ) => Promise<void>,
    address: { host: string; port: number; requestTimeout: number; label: string },
  ) => {
    const server = createServer(
      { requestTimeout: address.requestTimeout, headersTimeout: HEADERS_TIMEOUT_MS },
      (request, response) => {
        const context: HostedLogContext = { level: 'error' };
        const handler = router(request, response, context).catch((error: unknown) => {
          if (error instanceof WebhookInputError)
            respond(response, error.status, { error: redact(error.message) });
          else {
            onProgress?.(
              `${address.label} processing failed: ${error instanceof Error ? error.message : 'Unknown storage failure.'}`,
              context,
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
      async (request, response, context) => {
        if (await pages(request, response)) return;
        if (request.method === 'GET' && request.url === '/health') {
          respond(response, 200, { status: 'listening' });
          return;
        }
        const url = new URL(request.url ?? '/', 'http://refit.invalid');
        if (request.method === 'GET' && url.pathname === '/status') {
          if (!authorized(request, options.controlToken))
            throw new WebhookInputError(401, 'Service authorization is required.');
          const status = filterHostedStatus(await store.read(), url.searchParams);
          // A target's view shows only its repository's inventory, and no installation-wide
          // monitoring.
          const repository = url.searchParams.has('target')
            ? status.targets[0].repository
            : undefined;
          respond(response, 200, {
            ...status,
            ...(options.approvalIssues && { approvals: await approvals.read() }),
            inventories: (await inventories.read(repository)).map(({ inventory, ...row }) => ({
              ...row,
              summary: inventory && inventorySummary(inventory),
            })),
            ...(repository === undefined && {
              monitoring: {
                alerts: Boolean(options.alerts),
                installations: await upcomingDeadlines(monitoring, now()),
              },
              reports: { enabled: Boolean(options.reports), issues: await reports.read() },
            }),
          });
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
        context.delivery = id;
        const event = request.headers['x-github-event'];
        const parsed = parseWebhook(body, event, Number(options.app.appId));
        if ('installationId' in parsed) context.installation = parsed.installationId;
        const change =
          (parsed.kind === 'issue_comment' && !options.approvalIssues) ||
          ((parsed.kind === 'repository' || parsed.kind === 'account') && !options.lifecycle)
            ? { kind: 'ignored' as const }
            : parsed;
        const receipt = await store.accept(id, String(event), body, change);
        if (
          change.kind === 'account' &&
          options.tenancy.accounts.includes(change.previousOwner) &&
          !options.tenancy.accounts.includes(change.owner)
        )
          options.onProgress?.(
            `Account ${change.previousOwner} is now ${change.owner}, which REFIT_HOSTED_ACCOUNTS does not list; its targets stopped. Add ${change.owner} to allow it again.`,
          );
        for (const job of receipt.running) running.get(job)?.abort();
        const inventoried =
          receipt.status === 'accepted' && 'added' in change && change.added.length
            ? await inventories.request(
                change.installationId,
                change.added.map((repository) => repository.name),
              )
            : 0;
        const pushed =
          (options.alerts || options.reports) &&
          receipt.status === 'accepted' &&
          change.kind === 'push'
            ? await monitoring.pushed(change.installation, change.repository, now())
            : false;
        // With approval issues on, new installations and comments are handled without waiting.
        if (
          receipt.enrolled.length ||
          inventoried ||
          pushed ||
          (options.approvalIssues && ['accepted', 'queued'].includes(receipt.status))
        )
          wake();
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
      onProgress?.(`Job channel listening at ${jobs.callback}; jobs run on Fly Machines.`);
    }
    options.onReady?.(`http://${host}:${address.port}`);
    while (!options.signal.aborted) {
      requested = false;
      try {
        if (jobs) await reap(jobs);
        if (options.approvalIssues)
          await processApprovalIssues({
            app: options.app,
            directory: join(directory, 'approvals'),
            store,
            approvals,
            signal: options.signal,
            onCancelled: (jobs) => {
              for (const job of jobs) running.get(job)?.abort();
            },
            onProgress,
          });
        await store.enqueueDue(interval);
        if (options.purgeUninstalled) {
          const purged = await purgeUninstalled(options.database, directory);
          if (purged.targets.length)
            onProgress?.(
              `Deleted ${purged.targets.length} target(s) and ${purged.jobs} job(s) of installation(s) ${purged.installations.join(', ')}, uninstalled more than the grace period ago.`,
            );
          for (const { target, reason } of purged.kept)
            onProgress?.(`[${target}] Kept after the grace period: ${reason}`);
        }
        await inventories.requestMissing();
        const registry = (options.alerts || options.reports) && (await monitoringRegistry());
        if (registry) {
          const due = await requestRescans({ monitoring, inventories, registry, now: now() });
          for (const item of due)
            onProgress?.(`[monitoring ${item.repository}] Inventory requested (${item.reason}).`);
        }
        // Inventories are short and read-only, so a queued one goes before the next validation job.
        while (!options.signal.aborted) {
          const inventory = await inventories.claim(
            worker,
            Math.max(lease, INVENTORY_LIMITS.seconds + INVENTORY_LEASE_MARGIN_SECONDS),
          );
          if (inventory) {
            await runInventory(inventory);
            continue;
          }
          const claimed = await store.claim(worker, lease);
          if (!claimed) break;
          await runJob(claimed.job, claimed.target, claimed.retry);
          await notifyFailures?.();
        }
        // A claim can also fail a job whose lease expired too often.
        await notifyFailures?.();
        if (registry && options.alerts && !options.signal.aborted)
          await sendDeadlineAlerts({
            app: options.app,
            monitoring,
            registry,
            now: now(),
            leadDays: options.alerts.leadDays,
            digest: options.alerts.digest,
            signal: options.signal,
            onProgress,
          });
        if (registry && options.reports && !options.signal.aborted)
          await syncReportIssues({
            app: options.app,
            reports,
            registry,
            now: now(),
            signal: options.signal,
            onProgress: options.onProgress,
          });
        outage = OUTAGE_RETRY_MS;
      } catch (error) {
        // A job whose receipt could not be stored keeps its lease until it expires and is reclaimed.
        if (!isDatabaseUnavailable(error)) throw error;
        await unavailable(error);
        continue;
      }
      if (options.signal.aborted || requested) continue;
      await pause(interval * MILLISECONDS_PER_SECOND);
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
