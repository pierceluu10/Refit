import { setTimeout as delay } from 'node:timers/promises';
import { readBoundedResponse } from './network.ts';
import { isObject } from './specifications.ts';

const API_ROOT = 'https://api.machines.dev/v1';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 250;
const MAX_RETRY_WAIT_MS = 10_000;
const MILLISECONDS_PER_SECOND = 1000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_NOT_FOUND = 404;
const FLY_APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MACHINE_ID = /^[a-z0-9]{1,64}$/;

export class FlyMachinesError extends Error {
  override name = 'FlyMachinesError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FlyMachine {
  id: string;
  state: string;
  metadata: Record<string, string>;
}

export interface FlyMachineConfig {
  image: string;
  env: Record<string, string>;
  guest: { cpu_kind: 'shared' | 'performance'; cpus: number; memory_mb: number };
  metadata: Record<string, string>;
}

function machine(value: unknown): FlyMachine {
  if (!isObject(value) || typeof value.id !== 'string' || !MACHINE_ID.test(value.id))
    throw new FlyMachinesError('Fly Machines API returned a machine without a valid ID.');
  const config = isObject(value.config) ? value.config : {};
  const metadata = isObject(config.metadata) ? config.metadata : {};
  return {
    id: value.id,
    state: typeof value.state === 'string' ? value.state : 'unknown',
    metadata: Object.fromEntries(
      Object.entries(metadata).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  };
}

function retryWait(response: Response | undefined, attempt: number) {
  const seconds = Number(response?.headers.get('retry-after'));
  const wait =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * MILLISECONDS_PER_SECOND
      : RETRY_BASE_MS * 2 ** attempt;
  return Math.min(wait, MAX_RETRY_WAIT_MS);
}

// A small Machines API client: timeouts on every request, bounded retries on 429, 5xx and network
// failures, and no retries on other 4xx responses, which repeat the same way.
export function flyMachines(options: { token: string; app: string; api?: string }) {
  if (!FLY_APP.test(options.app))
    throw new FlyMachinesError('Job machines require a Fly app name for the job app.');
  if (!options.token.trim()) throw new FlyMachinesError('Job machines require FLY_API_TOKEN.');
  const root = `${options.api ?? API_ROOT}/apps/${options.app}/machines`;

  const request = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => {
    const label = `Fly ${method} machines${path.split('?')[0]}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetch(`${root}${path}`, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${options.token}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause;
        if (attempt + 1 >= MAX_ATTEMPTS)
          throw new FlyMachinesError(
            `${label} failed after ${MAX_ATTEMPTS} attempts: ${cause.message}`,
          );
      }
      if (response?.ok) return response;
      if (response) {
        await response.body?.cancel();
        const retryable =
          response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR;
        if (!retryable || attempt + 1 >= MAX_ATTEMPTS)
          throw new FlyMachinesError(
            `${label} failed with HTTP ${response.status}.`,
            response.status,
          );
      }
      await delay(retryWait(response, attempt));
    }
  };
  const json = async (response: Response) =>
    JSON.parse(
      await readBoundedResponse(response, MAX_RESPONSE_BYTES, 'Fly Machines API'),
    ) as unknown;

  return {
    async create(config: FlyMachineConfig & { region: string }) {
      const { region, ...rest } = config;
      // The job process exits once it reports; auto_destroy then removes the machine, and it never restarts.
      return machine(
        await json(
          await request('POST', '', {
            region,
            config: { ...rest, auto_destroy: true, restart: { policy: 'no' } },
          }),
        ),
      );
    },
    async get(id: string) {
      return machine(await json(await request('GET', `/${encodeURIComponent(id)}`)));
    },
    async list(metadata: Record<string, string>) {
      const query = new URLSearchParams(
        Object.entries(metadata).map(([key, value]) => [`metadata.${key}`, value]),
      );
      const machines = await json(await request('GET', `?${query}`));
      if (!Array.isArray(machines))
        throw new FlyMachinesError('Fly Machines API did not return a machine list.');
      // The API filters by metadata; checking again keeps a filter it ignored from reaching the caller.
      return machines
        .map(machine)
        .filter((entry) =>
          Object.entries(metadata).every(([key, value]) => entry.metadata[key] === value),
        );
    },
    // Force-destroys a machine; one that is already gone counts as destroyed.
    async destroy(id: string) {
      try {
        await (await request('DELETE', `/${encodeURIComponent(id)}?force=true`)).body?.cancel();
      } catch (error) {
        if (!(error instanceof FlyMachinesError && error.status === HTTP_NOT_FOUND)) throw error;
      }
    },
  };
}

export type FlyMachines = ReturnType<typeof flyMachines>;
