import { timingSafeEqual } from 'node:crypto';
import { deadlineNotice, type SlackSend } from './slack.ts';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AiOptions } from './ai-budget.ts';
import {
  authenticateGitHubComment,
  authenticateGitHubIssues,
  type GitHubAppConfiguration,
} from './github-app.ts';
import { suggestAgentsForPullRequest } from './agent-suggestions.ts';
import { deadlineTitle, dueDeadlineAlerts, syncDeadlineAlert, timing } from './deadline-alerts.ts';
import { configuredIntegrations, findDeadlineExposures } from './deadline-exposure.ts';
import { readDeadlineIgnores } from './deadline-ignores.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { standaloneStateDirectory, type GitHubCheckout } from './github-checkout.ts';
import { requestGitHub } from './github.ts';
import { parseWebhook, verifyWebhook, WebhookInputError } from './github-webhooks.ts';
import type { ServiceTarget } from './service-configuration.ts';
import { openServiceStore, type PullRequestState } from './service-state.ts';
import { digest } from './specifications.ts';
import { withStateLock } from './state-files.ts';
import { PipelineInputError } from './types.ts';
import { validateRepairAttempts } from './validation-options.ts';
import { confirmRepositoryAccess, pollServiceTarget, summarizePoll } from './service-worker.ts';
import { runModelFixes, type ModelFixChecks } from './model-fixes.ts';
import { publicationConfiguration } from './publication.ts';
import { RepositoryApprovalError } from './repository-enrollment.ts';

const HOST = '127.0.0.1';
const BYTES_PER_MIB = 1024 * 1024;
const MAX_BODY_BYTES = BYTES_PER_MIB;
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

export function authorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function requestBody(request: IncomingMessage, maximumBytes = MAX_BODY_BYTES) {
  if (
    request.headers['content-type']?.split(';')[0].toLowerCase() !== 'application/json' ||
    (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
  )
    throw new WebhookInputError(415, 'Requests require uncompressed application/json.');
  const oversized = Number(request.headers['content-length']) > maximumBytes;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    // Drain oversized requests within the server timeout so clients receive HTTP 413 rather than a socket reset.
    if (!oversized && length <= maximumBytes) chunks.push(bytes);
  }
  if (oversized || length > maximumBytes)
    throw new WebhookInputError(413, `Request body exceeds ${maximumBytes / BYTES_PER_MIB} MiB.`);
  return Buffer.concat(chunks);
}

export function respond(response: ServerResponse, status: number, value: unknown) {
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
  retryTargets?: readonly string[];
  aiPatch?: AiOptions;
  repairAttempts?: number;
  publishDraft?: boolean;
  // Off unless set: opens or updates one issue per enrolled repository and registry deadline.
  deadlineAlerts?: { leadDays: readonly number[]; registry?: string | URL };
  // Off unless set: replaces retiring AI models in each enrolled repository, validates the change
  // with its approved checks and, with publishDraft, opens a draft pull request. No per-change
  // approval is asked; enrollment is the approval.
  modelFixes?: { registry?: string | URL };
  notify?: SlackSend;
  now?: () => Date;
  signal: AbortSignal;
  onReady?: (url: string) => void;
  onProgress?: (message: string) => void;
}) {
  const retryTargets = new Set(options.retryTargets ?? []);
  if (retryTargets.size && !options.once)
    throw new PipelineInputError('--retry-target requires --once to avoid repeated paid retries.');
  if (
    retryTargets.size !== (options.retryTargets?.length ?? 0) ||
    [...retryTargets].some((id) => !options.targets.some((target) => target.id === id))
  )
    throw new PipelineInputError('Retry targets must be unique configured target ids.');
  const pollingTargets = retryTargets.size
    ? options.targets.filter((target) => retryTargets.has(target.id))
    : options.targets;
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
    // Comments once per pull request head on agents for newly added provider SDKs. A failure is
    // recorded and not retried until the pull request changes.
    const suggestPendingAgents = async () => {
      const pulls = Object.entries((await store.read()).pullRequests ?? {});
      for (const [key, pull] of pulls) {
        if (pull.status !== 'pending' || options.signal.aborted) continue;
        const settle = (change: (record: PullRequestState) => void) =>
          store.update((state) => {
            const record = state.pullRequests?.[key];
            if (record && record.head === pull.head) change(record);
          });
        try {
          const { token } = await authenticateGitHubComment(options.app, pull.repository);
          const result = await suggestAgentsForPullRequest({
            request: (method, path, body) => requestGitHub(token, method, path, body),
            repository: pull.repository,
            number: pull.number,
            base: pull.base,
            head: pull.head,
            alreadySuggested: pull.suggested,
          });
          await settle((record) => {
            record.status = result.status;
            record.suggested = [...new Set([...record.suggested, ...result.agents])];
            record.message = null;
          });
          options.onProgress?.(
            `[${key}] ${result.status}${result.agents.length ? `: ${result.agents.join(', ')}` : ''}`,
          );
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          await settle((record) => {
            record.status = 'failed';
            record.message = `${error.name}: ${error.message}`;
          });
          options.onProgress?.(`[${key}] ${error.name}: ${error.message}`);
        }
      }
    };
    // Matches each enrolled repository's managed checkout against the deadline registry and alerts
    // once per lead time. A failed alert is recorded and not retried until the next lead time, so a
    // partially completed GitHub request never opens a second issue.
    const alertDeadlines = async (checkouts: Map<string, GitHubCheckout>) => {
      if (!options.deadlineAlerts || !checkouts.size) return;
      const { leadDays } = options.deadlineAlerts;
      const now = options.now?.() ?? new Date();
      let registry: Awaited<ReturnType<typeof loadDeadlineRegistry>>;
      try {
        registry = await loadDeadlineRegistry(options.deadlineAlerts.registry, now);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        options.onProgress?.(`Deadline alerts skipped: ${error.name}: ${error.message}`);
        return;
      }
      for (const [repository, checkout] of checkouts) {
        if (options.signal.aborted) break;
        try {
          const [exposures, integrations] = await Promise.all([
            findDeadlineExposures(checkout.directory, registry, now),
            configuredIntegrations(checkout.directory),
          ]);
          // A committed, valid ignore file accepts exposures until its entries expire. An invalid
          // file accepts nothing, so a broken exception can never silence an alert.
          let ignores: Awaited<ReturnType<typeof readDeadlineIgnores>>['entries'] = [];
          try {
            ignores = (await readDeadlineIgnores(checkout.directory, now)).entries;
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            options.onProgress?.(
              `[${repository}] Deadline ignores not applied: ${error.name}: ${error.message}`,
            );
          }
          const known = (await store.read()).deadlineAlerts ?? {};
          const due = dueDeadlineAlerts({
            exposures,
            ignores,
            registry,
            now,
            leadDays,
            sent: (deadline) => known[`${repository}|${deadline}`]?.stage,
          });
          if (!due.length) continue;
          const { token } = await authenticateGitHubIssues(options.app, repository);
          for (const { exposure, stage } of due) {
            const key = `${repository}|${exposure.deadline.id}`;
            const previous = known[key];
            const save = (change: {
              issue: number | null;
              status: 'opened' | 'updated' | 'failed';
              message: string | null;
            }) =>
              store.update((state) => {
                (state.deadlineAlerts ??= {})[key] = {
                  repository,
                  deadline: exposure.deadline.id,
                  stage,
                  checkedAt: now.toISOString(),
                  ...change,
                };
              });
            const notifyDeadline = async (issue: number | null) => {
              const notice = deadlineNotice({
                repository,
                title: deadlineTitle(exposure),
                stage,
                timing: timing(exposure.days),
                issue,
              });
              if (notice) await options.notify?.(notice);
            };
            try {
              const result = await syncDeadlineAlert({
                request: (method, path, body) => requestGitHub(token, method, path, body),
                repository,
                issue: previous?.issue ?? null,
                exposure,
                revision: checkout.revision,
                integrations,
                leadDays,
              });
              await save({ issue: result.issue, status: result.action, message: null });
              options.onProgress?.(
                `[${repository}] Deadline ${exposure.deadline.id}: issue #${result.issue} ${result.action} (${timing(exposure.days)}).`,
              );
              await notifyDeadline(result.issue);
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              await save({
                issue: previous?.issue ?? null,
                status: 'failed',
                message: `${error.name}: ${error.message}`,
              });
              options.onProgress?.(
                `[${repository}] Deadline ${exposure.deadline.id}: ${error.name}: ${error.message}`,
              );
              await notifyDeadline(null);
            }
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          options.onProgress?.(
            `[${repository}] Deadline check failed: ${error.name}: ${error.message}`,
          );
        }
      }
    };
    // Runs model replacements for each enrolled repository whose checkout synced in this poll. A
    // revision and patch already handled are not validated again; a new base commit or a registry
    // change starts a new run.
    const fixModels = async (
      checkouts: Map<string, GitHubCheckout>,
      checks: Map<string, { checks: ModelFixChecks; base: string }>,
    ) => {
      if (!options.modelFixes || !checkouts.size) return;
      const now = options.now?.() ?? new Date();
      let registry: Awaited<ReturnType<typeof loadDeadlineRegistry>>;
      try {
        registry = await loadDeadlineRegistry(options.modelFixes.registry, now);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        options.onProgress?.(`Model fixes skipped: ${error.name}: ${error.message}`);
        return;
      }
      for (const [repository, checkout] of checkouts) {
        const approved = checks.get(repository);
        if (options.signal.aborted || !approved) continue;
        const previous = (await store.read()).modelFixes?.[repository];
        try {
          const result = await runModelFixes({
            repository: checkout.directory,
            registry,
            now,
            checks: approved.checks,
            publication: options.publishDraft
              ? publicationConfiguration(repository, approved.base, undefined, options.app)
              : undefined,
            handled:
              previous && previous.status !== 'failed'
                ? {
                    revision: previous.revision,
                    fixKey: previous.fixKey ?? null,
                    pullRequest: previous.pullRequest,
                  }
                : null,
            signal: options.signal,
            onProgress: (message) => options.onProgress?.(`[${repository}] ${message}`),
          });
          // Replacements already handled keep their recorded outcome.
          if (result.skipped) continue;
          await store.update((state) => {
            (state.modelFixes ??= {})[repository] = {
              repository,
              revision: result.revision,
              patchHash: result.patchHash,
              fixKey: result.fixKey,
              status: result.status,
              pullRequest: result.pullRequest?.number ?? null,
              message: result.reason,
              checkedAt: now.toISOString(),
            };
          });
          options.onProgress?.(`[${repository}] Model fixes ${result.status}: ${result.reason}`);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          await store.update((state) => {
            (state.modelFixes ??= {})[repository] = {
              repository,
              revision: checkout.revision,
              patchHash: null,
              status: 'failed',
              pullRequest: null,
              message: `${error.name}: ${error.message}`,
              checkedAt: now.toISOString(),
            };
          });
          options.onProgress?.(
            `[${repository}] Model fixes failed: ${error.name}: ${error.message}`,
          );
        }
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
        const checkouts = new Map<string, GitHubCheckout>();
        const approvedChecks = new Map<string, { checks: ModelFixChecks; base: string }>();
        for (const target of pollingTargets) {
          if (options.signal.aborted) break;
          const controller = new AbortController();
          const abort = () => controller.abort();
          options.signal.addEventListener('abort', abort, { once: true });
          running.set(target.id, controller);
          const startedVersion = (await store.read()).accessVersion;
          let authorized = false;
          try {
            const access = await confirmRepositoryAccess(options.app, target.repository);
            const active = await store.update((state) => {
              if (state.accessVersion !== startedVersion || controller.signal.aborted) return false;
              const record = state.targets[target.id];
              record.installationId = access.installationId;
              record.access = 'active';
              record.status = 'running';
              record.message = null;
              record.checkedAt = new Date().toISOString();
              const installation = state.installations[String(access.installationId)] ?? {
                owner: target.repository.split('/')[0].toLowerCase(),
                status: 'active' as const,
                repositories: {},
              };
              installation.status = 'active';
              installation.repositories[target.repository.toLowerCase()] = {
                id: access.id,
                name: target.repository.toLowerCase(),
              };
              state.installations[String(access.installationId)] = installation;
              return true;
            });
            if (!active) continue;
            authorized = true;
            if (retryTargets.has(target.id))
              options.onProgress?.(
                `[${target.id}] Explicit retry requested; successful jobs remain cached.`,
              );
            const result = await pollServiceTarget({
              target,
              app: options.app,
              signal: controller.signal,
              aiPatch: options.aiPatch,
              repairAttempts,
              publishDraft: options.publishDraft,
              notify: options.notify,
              retry: retryTargets.has(target.id),
              stateDirectory: join(directory, 'targets', target.id),
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
              Object.assign(record, summarizePoll(result));
            });
            // Enrolled (approved) repositories expose their managed checkout for deadline matching.
            if (target.approval && 'checkout' in result && !controller.signal.aborted) {
              checkouts.set(
                target.repository.toLowerCase(),
                (result as { checkout: GitHubCheckout }).checkout,
              );
              // The first approved integration's checks validate model fixes.
              if ('checks' in result && !approvedChecks.has(target.repository.toLowerCase()))
                approvedChecks.set(target.repository.toLowerCase(), {
                  checks: (result as { checks: ModelFixChecks }).checks,
                  base: target.base,
                });
            }
            const record = (await store.read()).targets[target.id];
            options.onProgress?.(
              `[${target.id}] ${record.status}: ${record.message ?? 'Poll completed.'}${record.output ? ` Evidence: ${record.output}` : ''}`,
            );
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            await store.update((state) => {
              const record = state.targets[target.id];
              if (!authorized) record.access = 'blocked';
              record.status = controller.signal.aborted
                ? 'interrupted'
                : error instanceof RepositoryApprovalError
                  ? 'needs-review'
                  : 'error';
              record.message = `${error.name}: ${error.message}`;
              record.checkedAt = new Date().toISOString();
            });
            options.onProgress?.(`[${target.id}] ${error.name}: ${error.message}`);
          } finally {
            running.delete(target.id);
            options.signal.removeEventListener('abort', abort);
          }
        }
        await suggestPendingAgents();
        await alertDeadlines(checkouts);
        await fixModels(checkouts, approvedChecks);
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
      return {
        directory,
        registry: await store.read(),
        ...(retryTargets.size ? { retryTargets: [...retryTargets] } : {}),
      };
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
