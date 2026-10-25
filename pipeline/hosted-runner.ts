import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AiOptions } from './ai-budget.ts';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { FlyMachinesError, type FlyMachine, type FlyMachines } from './fly-machines.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import { WebhookInputError } from './github-webhooks.ts';
import type { HostedReceipt, HostedTarget } from './hosted-store.ts';
import { authorized, requestBody, respond } from './local-service.ts';
import { readBoundedResponse } from './network.ts';
import { RepositoryApprovalError } from './repository-enrollment.ts';
import { INVENTORY_LIMITS, type InventoryResult } from './inventory.ts';
import { pollServiceTarget, summarizePoll } from './service-worker.ts';
import { isObject } from './specifications.ts';
import { hasErrorCode } from './state-files.ts';
import type { SlackSend } from './slack.ts';
import { PipelineInputError } from './types.ts';
import { watchCarryOver } from './watch.ts';

const FORMAT_VERSION = 1;
const BYTES_PER_MIB = 1024 * 1024;
// Inputs and returned evidence each travel as one JSON document of base64-encoded files.
export const MAX_JOB_TRANSFER_BYTES = 64 * BYTES_PER_MIB;
const MAX_JOB_FILES = 10_000;
const MAX_JOB_PATH_LENGTH = 1024;
const MAX_RECEIPT_MESSAGE_LENGTH = 16_384;
const TRANSFER_TIMEOUT_MS = 120_000;
const SECRET_BYTES = 32;
const MILLISECONDS_PER_SECOND = 1000;
const HTTP_NOT_FOUND = 404;
export const JOB_TIMEOUT_SECONDS = 3600;
export const JOB_POLL_SECONDS = 15;
// Validation runs in a 3 GiB container beside dockerd and the job process, as on the control VM.
// The default 4 GiB validation profile gives its container 5 GiB beside dockerd and the Node worker.
export const JOB_GUEST = { cpu_kind: 'shared', cpus: 4, memory_mb: 8192 } as const;
// A job machine fetches the managed checkout itself and rebuilds approved inputs from it.
const LOCAL_ONLY = new Set(['github', 'approved-inputs']);
const EXITED = new Set(['stopped', 'destroying', 'destroyed', 'failed']);
const JOB_ROUTE = /^\/jobs\/([1-9]\d{0,15})\/(inputs|receipt)$/;
const REVISION = /^[a-f0-9]{40}$/;
const STATUS = /^[a-z][a-z-]{0,63}$/;
const TARGET_ID = /^[a-f0-9]{16}(\.[a-z][a-z0-9-]{0,63})?$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// A forked job process: the CLI, its heap capped below the VM's memory, which several job
// processes and their validation containers share.
const JOB_PROCESS_ENTRY = new URL('../bin/refit.mjs', import.meta.url);
const JOB_PROCESS_HEAP_MB = 1536;
// The worker's own secrets; a job never needs them.
const WORKER_SECRETS = ['REFIT_WEBHOOK_SECRET', 'REFIT_SERVICE_TOKEN', 'FLY_API_TOKEN'];
const JOB_PROCESS_GRACE_SECONDS = 30;
// Between an inventory's own time cap and its SIGTERM, and again before SIGKILL: both fit in the
// inventory lease's margin.
const INVENTORY_PROCESS_GRACE_SECONDS = 10;

export class JobChannelError extends WebhookInputError {
  override name = 'JobChannelError';
}

export class JobProcessError extends Error {
  override name = 'JobProcessError';
}

// What the worker sends a forked job process: runHostedTarget's options except credentials, which
// the process reads from its own environment, as it builds the AI options when `aiPatch` is set.
export interface JobProcessInputs {
  target: HostedTarget;
  directory: string;
  retry: boolean;
  repairAttempts: number;
  publishDraft: boolean;
  publishUnresolved: boolean;
  supersedeDrafts: boolean;
  aiPatch: boolean;
  aiTotalUsd?: number;
}

// What the worker sends a forked inventory process: refreshInventory's options except the App
// credentials, which the process reads from its environment. JSON carries no Date, so `now` is in
// epoch milliseconds.
export interface InventoryProcessInputs {
  directory: string;
  installationId: number;
  repository: string;
  registry: DeadlineRegistry;
  previous: { revision: string | null; registry: string | null } | null;
  now: number;
}

// An error is recorded as `Name: message`, as an in-process inventory's is.
export type InventoryProcessOutcome = { result: InventoryResult } | { error: string };

// A forked process asks for its inputs once it listens for them, reports progress, then one outcome.
type ProcessMessage<Outcome> = { ready: true } | { progress: string } | { outcome: Outcome };

export interface HostedOutcome {
  status: 'finished' | 'failed';
  receipt: HostedReceipt;
}

interface JobFile {
  path: string;
  // Base64.
  content: string;
}

interface JobInputs {
  formatVersion: typeof FORMAT_VERSION;
  job: number;
  // Epoch milliseconds after which the job machine stops the job by itself.
  deadline: number;
  // The control process's state root, mirrored on the machine so watch state paths stay valid.
  directory: string;
  target: HostedTarget;
  retry: boolean;
  github: { appId: string; installationId: number; token: string };
  files: JobFile[];
}

export function failedOutcome(error: Error, aborted: boolean): HostedOutcome {
  const approval = error instanceof RepositoryApprovalError;
  return {
    status: approval ? 'finished' : 'failed',
    receipt: {
      status: aborted ? 'interrupted' : approval ? 'needs-review' : 'error',
      output: null,
      message: `${error.name}: ${error.message}`,
    },
  };
}

// The Stripe contracts of generated configurations, shared by every target and the approval issues:
// each file is one pinned stripe/openapi version, checked on read.
export const hostedContracts = (directory: string) => join(directory, 'contracts');

// The receipt a scheduled poll stores instead of running, or null when the job must run. Only a
// finished, ready job on the same commit, approval and worker build, with no fetched contract or
// documentation, is reused. Job-machine receipts never carry liveContract, so they always run.
export function unchangedReceipt(
  previous: { job: number; status: string; receipt: HostedReceipt | null } | null,
  current: { revision: string; fingerprint: string; build: string },
): HostedReceipt | null {
  const receipt = previous?.receipt;
  if (
    previous?.status !== 'finished' ||
    !receipt ||
    receipt.revision !== current.revision ||
    receipt.fingerprint !== current.fingerprint ||
    receipt.build !== current.build ||
    receipt.liveContract !== false ||
    receipt.readiness !== 'ready-for-validation'
  )
    return null;
  // Nothing ran, so no CPU was measured: the earlier job's steal is not this job's.
  const { cpuSteal, ...work } = receipt;
  if (work.unchangedSince) return work;
  // The CLI prints the message, so it says which job did the work rather than repeating its claim.
  return {
    ...work,
    message:
      `Reused the receipt of job ${previous.job}: same commit, approval and worker build, so nothing ran. ${receipt.message ?? ''}`.trim(),
    unchangedSince: previous.job,
  };
}

// Runs one hosted job in this process. The in-VM worker, its job processes and every job machine
// share it.
export async function runHostedTarget(options: {
  target: HostedTarget;
  app: GitHubAppConfiguration;
  directory: string;
  retry: boolean;
  signal: AbortSignal;
  aiPatch?: AiOptions;
  repairAttempts: number;
  publishDraft?: boolean;
  publishUnresolved?: boolean;
  supersedeDrafts?: boolean;
  notify?: SlackSend;
  onProgress?: (message: string) => void;
}): Promise<HostedOutcome> {
  const { target } = options;
  try {
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
      stateDirectory: join(options.directory, 'targets', target.id),
      signal: options.signal,
      retry: options.retry,
      aiPatch: options.aiPatch,
      repairAttempts: options.repairAttempts,
      publishDraft: options.publishDraft,
      publishUnresolved: options.publishUnresolved,
      supersedeDrafts: options.supersedeDrafts,
      notify: options.notify,
      inspectReadiness: true,
      contracts: hostedContracts(options.directory),
      onProgress: options.onProgress,
    });
    const outcome: HostedOutcome = {
      status: 'finished',
      receipt: {
        ...summarizePoll(result),
        revision: 'checkout' in result ? result.checkout.revision : null,
        readiness: 'readiness' in result && result.readiness ? result.readiness.status : null,
        ...('liveContract' in result ? { liveContract: result.liveContract !== false } : {}),
      },
    };
    // A workflow error fails the job, so the failed-job notice reports it. A stop or lost lease
    // during the workflow is an interruption, as it is before the workflow starts.
    if (result.status !== 'processed' || result.result.manifest.status !== 'error') return outcome;
    return {
      status: 'failed',
      receipt: { ...outcome.receipt, status: options.signal.aborted ? 'interrupted' : 'error' },
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return failedOutcome(error, options.signal.aborted);
  }
}

// Forks `refit hosted <command>`, hands it `inputs` once it listens and returns the one outcome it
// reports. A stop sends SIGTERM, then SIGKILL once the grace period passes. Throws the stop's reason,
// or a JobProcessError when the process exits without an outcome.
async function runProcess<Outcome>(options: {
  command: 'job' | 'inventory';
  inputs: object;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
  entry?: string | URL;
  graceSeconds?: number;
}): Promise<Outcome> {
  const env = { ...process.env };
  for (const name of WORKER_SECRETS) delete env[name];
  const child = fork(options.entry ?? JOB_PROCESS_ENTRY, ['hosted', options.command], {
    env,
    execArgv: [`--max-old-space-size=${JOB_PROCESS_HEAP_MB}`],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const label = `${options.command === 'job' ? 'Job' : 'Inventory'} process ${child.pid}`;
  // Unlike 'exit', 'close' comes after the last message.
  const closed = once(child, 'close');
  let outcome: { value: Outcome } | undefined;
  child.on('message', (message: ProcessMessage<Outcome>) => {
    if ('ready' in message) child.send(options.inputs);
    else if ('progress' in message) options.onProgress?.(message.progress);
    // After a stop the worker's reason is the outcome, as in process.
    else if (!options.signal.aborted) outcome = { value: message.outcome };
  });
  const grace = options.graceSeconds ?? JOB_PROCESS_GRACE_SECONDS;
  let kill: NodeJS.Timeout | undefined;
  const stop = () => {
    child.kill('SIGTERM');
    kill = setTimeout(() => {
      options.onProgress?.(`${label} did not stop within ${grace} s; killing it.`);
      child.kill('SIGKILL');
    }, grace * MILLISECONDS_PER_SECOND);
  };
  if (options.signal.aborted) stop();
  else options.signal.addEventListener('abort', stop, { once: true });
  try {
    const [code, signal] = (await closed) as [number | null, NodeJS.Signals | null];
    if (outcome) return outcome.value;
    const { reason } = options.signal;
    throw options.signal.aborted && reason instanceof Error
      ? reason
      : new JobProcessError(
          `${label} exited with ${signal ?? `code ${code}`} before reporting an outcome.`,
        );
  } finally {
    clearTimeout(kill);
    options.signal.removeEventListener('abort', stop);
    // A process the worker lost track of, after a failed send, would otherwise wait forever.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

// Runs one job in a forked `refit hosted job` process. A scan can hold the CPU for minutes; in its
// own process it never blocks the worker's health check, webhooks or lease renewals.
export async function runJobProcess(options: {
  inputs: JobProcessInputs;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
  // The script forked with `hosted job`, by default the CLI.
  entry?: string | URL;
  graceSeconds?: number;
}): Promise<HostedOutcome> {
  try {
    return await runProcess<HostedOutcome>({ command: 'job', ...options });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return failedOutcome(error, options.signal.aborted);
  }
}

// Runs one inventory in a forked `refit hosted inventory` process, for the same reason as a job: its
// TypeScript analysis can hold the CPU for minutes, where its own time cap never fires. The worker
// stops the process `graceSeconds` after the cap and kills it as long again later, so a stuck
// inventory ends with an error well within its lease. Throws only when `signal` stops it.
export async function runInventoryProcess(options: {
  inputs: InventoryProcessInputs;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
  // The script forked with `hosted inventory`, by default the CLI.
  entry?: string | URL;
  seconds?: number;
  graceSeconds?: number;
}): Promise<InventoryProcessOutcome> {
  const seconds = options.seconds ?? INVENTORY_LIMITS.seconds;
  const grace = options.graceSeconds ?? INVENTORY_PROCESS_GRACE_SECONDS;
  const cap = new AbortController();
  const timer = setTimeout(
    () =>
      cap.abort(
        new JobProcessError(
          `Inventory took longer than ${seconds} seconds and did not stop by itself; its process was stopped.`,
        ),
      ),
    (seconds + grace) * MILLISECONDS_PER_SECOND,
  );
  try {
    return await runProcess<InventoryProcessOutcome>({
      command: 'inventory',
      inputs: options.inputs,
      signal: AbortSignal.any([options.signal, cap.signal]),
      onProgress: options.onProgress,
      entry: options.entry,
      graceSeconds: grace,
    });
  } catch (error) {
    if (!(error instanceof Error) || options.signal.aborted) throw error;
    return { error: `${error.name}: ${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// The forked process's side of runProcess: it takes its inputs over IPC, runs `run` and reports
// back, turning an error into an outcome with `failed`. SIGTERM stops it. The process exits when the
// channel closes: after its report, or when the worker is gone and nothing could store the outcome.
export async function runForkedProcess<Inputs, Outcome>(
  run: (
    inputs: Inputs,
    signal: AbortSignal,
    onProgress: (message: string) => void,
  ) => Promise<Outcome>,
  failed: (error: Error, aborted: boolean) => Outcome,
) {
  if (!process.send || !process.disconnect)
    throw new JobProcessError(
      'refit hosted job and inventory have no IPC channel; serve --job-processes forks them.',
    );
  const channel = process.send.bind(process);
  const disconnect = process.disconnect.bind(process);
  const send = (message: ProcessMessage<Outcome>) =>
    new Promise<void>((resolve, reject) =>
      channel(message, undefined, undefined, (error) => (error ? reject(error) : resolve())),
    );
  const controller = new AbortController();
  // Fly may signal the whole process group; when a process stops is the worker's decision.
  process.on('SIGINT', () => undefined);
  process.once('SIGTERM', () => controller.abort());
  process.once('disconnect', () => process.exit());
  const received = once(process, 'message') as Promise<[Inputs]>;
  await send({ ready: true });
  const [inputs] = await received;
  // A configuration error fails the work with its own message, not as an early exit.
  const outcome = await run(inputs, controller.signal, (progress) => void send({ progress })).catch(
    (error: unknown) => {
      if (!(error instanceof Error)) throw error;
      return failed(error, controller.signal.aborted);
    },
  );
  await send({ outcome });
  disconnect();
}

function jobFiles(value: unknown): JobFile[] {
  if (!Array.isArray(value) || value.length > MAX_JOB_FILES)
    throw new JobChannelError(422, `Job files must be a list of at most ${MAX_JOB_FILES}.`);
  const seen = new Set<string>();
  return value.map((file) => {
    if (
      !isObject(file) ||
      typeof file.path !== 'string' ||
      file.path.length > MAX_JOB_PATH_LENGTH ||
      /[\\\x00-\x1f\x7f]/.test(file.path) ||
      isAbsolute(file.path) ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      LOCAL_ONLY.has(file.path.split('/')[0]) ||
      seen.has(file.path) ||
      typeof file.content !== 'string' ||
      !BASE64.test(file.content)
    )
      throw new JobChannelError(
        422,
        'Job files need unique relative paths inside the target state and base64 content.',
      );
    seen.add(file.path);
    return { path: file.path, content: file.content };
  });
}

// Reads the named files, or every regular file except local-only state, below a target directory.
async function readJobFiles(directory: string, paths?: string[]) {
  const files: JobFile[] = [];
  const read = async (path: string) =>
    files.push({ path, content: (await readFile(join(directory, path))).toString('base64') });
  const visit = async (parent: string) => {
    for (const entry of await readdir(join(directory, parent), { withFileTypes: true })) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (!parent && LOCAL_ONLY.has(entry.name)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) await read(path);
    }
  };
  if (paths) for (const path of paths) await read(path);
  else await visit('');
  return files;
}

async function writeJobFiles(directory: string, files: JobFile[]) {
  for (const file of files) {
    const path = join(directory, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function targetDirectory(inputs: Pick<JobInputs, 'directory' | 'target'>) {
  return join(inputs.directory, 'targets', inputs.target.id);
}

async function isDirectory(path: string) {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function optional(value: unknown, pattern: RegExp) {
  return (
    value === undefined || value === null || (typeof value === 'string' && pattern.test(value))
  );
}

// A job machine runs customer code, so everything it returns is checked before it is stored.
async function receivedOutcome(value: unknown, inputs: JobInputs): Promise<HostedOutcome> {
  if (
    !isObject(value) ||
    value.formatVersion !== FORMAT_VERSION ||
    value.job !== inputs.job ||
    (value.status !== 'finished' && value.status !== 'failed') ||
    !isObject(value.receipt)
  )
    throw new JobChannelError(422, 'Job report does not match this job.');
  const { receipt } = value;
  const directory = targetDirectory(inputs);
  if (
    typeof receipt.status !== 'string' ||
    !STATUS.test(receipt.status) ||
    (receipt.message !== null && typeof receipt.message !== 'string') ||
    (receipt.output !== null &&
      (typeof receipt.output !== 'string' ||
        !receipt.output.startsWith(`${directory}/`) ||
        receipt.output.split('/').includes('..'))) ||
    !optional(receipt.revision, REVISION) ||
    !optional(receipt.readiness, STATUS)
  )
    throw new JobChannelError(422, 'Job receipt is malformed.');
  await writeJobFiles(directory, jobFiles(value.files));
  if (receipt.output !== null && !(await isDirectory(receipt.output)))
    throw new JobChannelError(422, 'Job receipt names evidence the machine did not send.');
  return {
    status: value.status,
    receipt: {
      status: receipt.status,
      output: receipt.output,
      message: receipt.message?.slice(0, MAX_RECEIPT_MESSAGE_LENGTH) ?? null,
      ...(receipt.revision !== undefined ? { revision: receipt.revision as string | null } : {}),
      ...(receipt.readiness !== undefined ? { readiness: receipt.readiness as string | null } : {}),
    },
  };
}

// The control process's side of the job channel: each running job's inputs, its secret and the
// one report it accepts. Job machines reach it over Fly's private network.
export function jobChannel() {
  const jobs = new Map<
    number,
    {
      secret: string;
      inputs: JobInputs;
      reported: boolean;
      settle: (outcome: HostedOutcome) => void;
    }
  >();
  const open = (inputs: JobInputs) => {
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    let settle!: (outcome: HostedOutcome) => void;
    const report = new Promise<HostedOutcome>((resolve) => (settle = resolve));
    jobs.set(inputs.job, { secret, inputs, reported: false, settle });
    return { secret, report, close: () => jobs.delete(inputs.job) };
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const route = JOB_ROUTE.exec(request.url ?? '');
    if (!route) {
      respond(response, 404, { error: 'Route not found.' });
      return;
    }
    const job = jobs.get(Number(route[1]));
    // Unknown jobs and wrong secrets answer alike, so the channel never confirms which jobs run.
    if (!job || !authorized(request, job.secret))
      throw new JobChannelError(401, 'Job authorization is required.');
    if (route[2] === 'inputs') {
      if (request.method !== 'GET') throw new JobChannelError(405, 'Job inputs are read with GET.');
      respond(response, 200, job.inputs);
      return;
    }
    if (request.method !== 'POST')
      throw new JobChannelError(405, 'Job reports are sent with POST.');
    if (job.reported) throw new JobChannelError(409, 'This job already reported.');
    job.reported = true;
    try {
      job.settle(
        await receivedOutcome(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              await requestBody(request, MAX_JOB_TRANSFER_BYTES),
            ),
          ),
          job.inputs,
        ),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // An authenticated machine that sends unusable evidence fails its job; nothing retries it.
      job.settle({
        status: 'failed',
        receipt: {
          status: 'error',
          output: null,
          message: `Job machine evidence was refused: ${error.message}`,
        },
      });
      throw error instanceof WebhookInputError ? error : new JobChannelError(422, error.message);
    }
    respond(response, 202, { job: job.inputs.job, status: 'accepted' });
  };
  return { open, handle, has: (job: number) => jobs.has(job) };
}

export type JobChannel = ReturnType<typeof jobChannel>;

// Runs one job on its own Fly Machine and returns its outcome. The machine is destroyed when the
// job reports, fails, is cancelled or times out.
export async function runJobMachine(options: {
  machines: FlyMachines;
  channel: JobChannel;
  // Base URL of the job channel as job machines reach it.
  callback: string;
  job: number;
  target: HostedTarget;
  retry: boolean;
  directory: string;
  github: JobInputs['github'];
  image: string;
  region: string;
  // Validation images the machine pulls before the job; the approved checks use no others.
  images: string[];
  timeoutSeconds: number;
  pollSeconds: number;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<HostedOutcome> {
  options.signal.throwIfAborted();
  const directory = targetDirectory(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = await readJobFiles(directory, await watchCarryOver(directory));
  if (files.reduce((total, file) => total + file.content.length, 0) > MAX_JOB_TRANSFER_BYTES)
    throw new PipelineInputError(
      `Target state exceeds ${MAX_JOB_TRANSFER_BYTES / BYTES_PER_MIB} MiB, more than a job machine accepts. Inspect ${directory}.`,
    );
  const timeout = options.timeoutSeconds * MILLISECONDS_PER_SECOND;
  const session = options.channel.open({
    formatVersion: FORMAT_VERSION,
    job: options.job,
    deadline: Date.now() + timeout,
    directory: options.directory,
    target: options.target,
    retry: options.retry,
    github: options.github,
    files,
  });
  const stop = new AbortController();
  let machine: FlyMachine | undefined;
  try {
    machine = await options.machines.create({
      region: options.region,
      image: options.image,
      guest: { ...JOB_GUEST },
      env: {
        REFIT_JOB_URL: options.callback,
        REFIT_JOB_ID: String(options.job),
        REFIT_JOB_SECRET: session.secret,
        REFIT_HOSTED_IMAGES: options.images.join(' '),
      },
      metadata: { refit: 'job', refit_job: String(options.job) },
    });
    const { id } = machine;
    options.onProgress?.(`Job machine ${id} created in ${options.region}.`);
    const failed = (status: string, message: string): HostedOutcome => ({
      status: 'failed',
      receipt: { status, output: null, message },
    });
    // A machine that exits without reporting (a crash, out of memory) fails the job at once.
    const exited = async () => {
      for (;;) {
        await delay(options.pollSeconds * MILLISECONDS_PER_SECOND, undefined, {
          signal: stop.signal,
        });
        let state: string;
        try {
          state = (await options.machines.get(id)).state;
        } catch (error) {
          if (!(error instanceof FlyMachinesError && error.status === HTTP_NOT_FOUND)) throw error;
          state = 'destroyed';
        }
        if (EXITED.has(state))
          return failed('error', `Job machine ${id} ${state} without a report.`);
      }
    };
    const cancelled = options.signal.aborted
      ? Promise.resolve()
      : once(options.signal, 'abort', { signal: stop.signal });
    return await Promise.race([
      session.report,
      exited(),
      delay(timeout, undefined, { signal: stop.signal }).then(() =>
        failed(
          'error',
          `Job machine ${id} exceeded the ${options.timeoutSeconds}-second job timeout.`,
        ),
      ),
      cancelled.then(() =>
        failed(
          'interrupted',
          `Job machine ${id} stopped: the job was cancelled or the worker is stopping.`,
        ),
      ),
    ]);
  } finally {
    stop.abort();
    session.close();
    if (machine)
      try {
        await options.machines.destroy(machine.id);
        options.onProgress?.(`Job machine ${machine.id} destroyed.`);
      } catch (error) {
        if (!(error instanceof FlyMachinesError)) throw error;
        options.onProgress?.(
          `Could not destroy job machine ${machine.id}: ${error.message} The reaper retries on its next pass.`,
        );
      }
  }
}

// Destroys job machines that no live job owns, such as those a crashed control process left.
export async function reapJobMachines(machines: FlyMachines, live: (job: number) => boolean) {
  const destroyed: string[] = [];
  for (const machine of await machines.list({ refit: 'job' })) {
    if (live(Number(machine.metadata.refit_job))) continue;
    await machines.destroy(machine.id);
    destroyed.push(machine.id);
  }
  return destroyed;
}

function jobInputs(value: unknown, job: number): JobInputs {
  if (
    !isObject(value) ||
    value.formatVersion !== FORMAT_VERSION ||
    value.job !== job ||
    !Number.isSafeInteger(value.deadline) ||
    typeof value.directory !== 'string' ||
    !isAbsolute(value.directory) ||
    !isObject(value.target) ||
    typeof value.target.id !== 'string' ||
    !TARGET_ID.test(value.target.id) ||
    typeof value.retry !== 'boolean' ||
    !isObject(value.github) ||
    typeof value.github.appId !== 'string' ||
    !Number.isSafeInteger(value.github.installationId) ||
    typeof value.github.token !== 'string'
  )
    throw new JobChannelError(422, 'Job inputs do not match this job.');
  return { ...(value as unknown as JobInputs), files: jobFiles(value.files) };
}

// The job machine's side: fetch this job's inputs, run it, and send the receipt with every file
// the run created or changed. The machine holds no database credentials and no App private key.
export async function runHostedJob(options: {
  url: string;
  job: number;
  secret: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const request = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await fetch(`${options.url}/jobs/${options.job}/${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)]),
      headers: { Authorization: `Bearer ${options.secret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new JobChannelError(
        response.status,
        `The control process refused job ${path} with HTTP ${response.status}.`,
      );
    }
    return JSON.parse(await readBoundedResponse(response, MAX_JOB_TRANSFER_BYTES, 'Job channel'));
  };
  const inputs = jobInputs(await request('GET', 'inputs'), options.job);
  const directory = targetDirectory(inputs);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJobFiles(directory, inputs.files);
  const carried = new Map(inputs.files.map((file) => [file.path, file.content]));
  const outcome = await runHostedTarget({
    target: inputs.target,
    app: {
      appId: inputs.github.appId,
      installationToken: {
        installationId: inputs.github.installationId,
        token: inputs.github.token,
      },
    },
    directory: inputs.directory,
    retry: inputs.retry,
    signal: AbortSignal.any([
      options.signal,
      AbortSignal.timeout(Math.max(0, inputs.deadline - Date.now())),
    ]),
    repairAttempts: 0,
    onProgress: options.onProgress,
  });
  await request('POST', 'receipt', {
    formatVersion: FORMAT_VERSION,
    job: options.job,
    ...outcome,
    files: (await readJobFiles(directory)).filter(
      (file) => carried.get(file.path) !== file.content,
    ),
  });
  return outcome;
}
