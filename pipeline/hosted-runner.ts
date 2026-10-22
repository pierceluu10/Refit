import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AiOptions } from './ai-budget.ts';
import { FlyMachinesError, type FlyMachine, type FlyMachines } from './fly-machines.ts';
import type { GitHubAppConfiguration } from './github-app.ts';
import { WebhookInputError } from './github-webhooks.ts';
import type { HostedReceipt, HostedTarget } from './hosted-store.ts';
import { authorized, requestBody, respond } from './local-service.ts';
import { readBoundedResponse } from './network.ts';
import { RepositoryApprovalError } from './repository-enrollment.ts';
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
export const JOB_GUEST = { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 } as const;
// A job machine fetches the managed checkout itself and rebuilds approved inputs from it.
const LOCAL_ONLY = new Set(['github', 'approved-inputs']);
const EXITED = new Set(['stopped', 'destroying', 'destroyed', 'failed']);
const JOB_ROUTE = /^\/jobs\/([1-9]\d{0,15})\/(inputs|receipt)$/;
const REVISION = /^[a-f0-9]{40}$/;
const STATUS = /^[a-z][a-z-]{0,63}$/;
const TARGET_ID = /^[a-f0-9]{16}(\.[a-z][a-z0-9-]{0,63})?$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class JobChannelError extends WebhookInputError {
  override name = 'JobChannelError';
}

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

// Runs one hosted job in this process. The in-VM worker and every job machine share it.
export async function runHostedTarget(options: {
  target: HostedTarget;
  app: GitHubAppConfiguration;
  directory: string;
  retry: boolean;
  signal: AbortSignal;
  aiPatch?: AiOptions;
  repairAttempts: number;
  publishDraft?: boolean;
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
      notify: options.notify,
      inspectReadiness: true,
      onProgress: options.onProgress,
    });
    return {
      status: 'finished',
      receipt: {
        ...summarizePoll(result),
        revision: 'checkout' in result ? result.checkout.revision : null,
        readiness: 'readiness' in result && result.readiness ? result.readiness.status : null,
      },
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return failedOutcome(error, options.signal.aborted);
  }
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
